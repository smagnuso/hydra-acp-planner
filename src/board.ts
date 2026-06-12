import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  boardPath,
  orchestratorPointerPath,
  projectDir,
  projectsDir,
} from "./paths.js";

export const BOARD_SCHEMA_VERSION = 2;

export type TaskStatus =
  | "pending"
  | "assigned"
  | "awaiting_review"
  | "done"
  | "superseded"
  | "failed"
  | "blocked";
// Board state machine:
//
//   decomposing → ready → running → done
//                     ↘        ↘ ↗ ↓
//                       running   failed
//                         ↕
//                       paused
//
//   * decomposing: asked the agent to break the description into a
//     DAG; awaiting the response.
//   * ready: decomposition done, plan rendered to the user. No workers
//     spawned. Awaiting a `/hydra planner start` call to kick off.
//     This is the resting state after `create`.
//   * running: scheduler is dispatching workers and reaping completions.
//   * paused: scheduling halted by the user; in-flight workers run
//     to completion but no new tasks dispatch.
//   * done: every task is in a terminal status, all succeeded.
//   * failed: every task is in a terminal status, at least one failed
//     (including user-cancel).
//
// `create` produces a `ready` board (decompose + show, no start).
// `start` finds the ready board and transitions it to running, OR
// decomposes-from-conversation when no board exists and runs in one
// step (the original start behavior).
export type BoardState =
  | "decomposing"
  | "ready"
  | "running"
  | "paused"
  | "stopped" // user-initiated halt; resumable via start/set_plan. Workers killed; in-flight tasks reverted to pending.
  | "done"
  | "failed"; // hard failure (e.g. worker failed to launch); distinct from user stop. NOT auto-resumable.

export interface TaskArtifacts {
  files_changed?: string[];
  summary?: string;
  decisions?: string[];
  assumptions?: string[];
  follow_ups?: string[];
  // Filesystem-level audit of the worker session's actual edits,
  // fetched from the daemon's GET /v1/sessions/:id/diff endpoint at
  // task completion. files = unique paths from the diff; hunkCount =
  // sum across files; sample = a compact human-readable preview
  // (paths + first hunk) for reviewer prompts. Undefined when the
  // audit was skipped (orchestrator-lane review) or the fetch failed
  // (older daemon, network error). Renders through
  // formatDependencyContext (JSON.stringify) so downstream reviewers
  // see it without prompt changes.
  verified_diff?: {
    files: string[];
    hunkCount: number;
    sample?: string;
  };
}

export interface Task {
  id: string;
  title: string;
  why?: string;
  what?: string;
  constraints?: string;
  deps: string[];
  agent?: string | null;
  model?: string | null;
  // Per-task override for the synthesized review task's agent/model.
  // applyReviewPolicy copies these onto the review it generates for this
  // work task. Independent of `agent`/`model` (which configure the work
  // task itself). Falls through to fleetDefaults.review.{agent,model}
  // when unset. Ignored on tasks with kind="review".
  reviewAgent?: string | null;
  reviewModel?: string | null;
  status: TaskStatus;
  assignedTo?: string | null;
  attemptCount: number;
  artifacts?: TaskArtifacts | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  kind?: "work" | "review";
  reviews?: string | string[];
  runOn?: "orchestrator" | "worker";
  reviewFeedback?: string[];
  riskLevel?: "low" | "medium" | "high";
  reviewHint?: "skip" | "optional" | "recommended" | "required";
  onReject?: {
    strategy?: "fresh" | "continue" | "escalate";
    maxAttempts?: number;
    agent?: string;
    model?: string;
    escalateTo?: {
      agent: string;
      model: string;
    };
  };
  // Whether the reviewer is allowed to apply fixes directly (decision='fix').
  // Defaults to true when runOn='orchestrator', false otherwise. Only
  // relevant for orchestrator-lane reviews where the host session can
  // patch artifacts without spawning a new worker.
  canApplyFixes?: boolean;
}

// A single entry in a worker's internal todolist as observed by the
// orchestrator. Mirrors the ACP plan-entry shape (content + status)
// minus the priority field, which we don't surface in the merged
// board view. Status maps directly to ACP statuses.
export interface WorkerSubtodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface WorkerUsage {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface FleetDefaults {
  agent: string | null;
  model: string | null;
  work?: { agent?: string; model?: string };
  review?: { agent?: string; model?: string; runOn?: "orchestrator" | "worker" };
}

// Resolution chain:
//   task.agent  >  fleet.{work|review}.agent  >  fleet.agent (--agent)
//                                            >  board.orchestratorAgent
//                                            >  null (→ daemon default)
//
// The orchestratorAgent fallback exists because the daemon's own
// `defaultAgent` (set in its config) may not match what the user
// launched `hydra tui --agent X` with. The daemon is long-lived and
// can't track per-client launch flags, so we mirror the orchestrator
// session's agent onto workers when nothing more specific applies.
export function resolveAgent(
  task: Task,
  board: { fleetDefaults: FleetDefaults; orchestratorAgent?: string | null },
): string | null {
  if (task.agent) return task.agent;
  const kind = task.kind ?? "work";
  const fleet = board.fleetDefaults;
  const kindAgent = kind === "review" ? fleet.review?.agent : fleet.work?.agent;
  if (kindAgent) return kindAgent;
  if (fleet.agent) return fleet.agent;
  if (board.orchestratorAgent) return board.orchestratorAgent;
  return null;
}

export function resolveModel(
  task: Task,
  board: { fleetDefaults: FleetDefaults; orchestratorModel?: string | null },
): string | null {
  if (task.model) return task.model;
  const kind = task.kind ?? "work";
  const fleet = board.fleetDefaults;
  const kindModel = kind === "review" ? fleet.review?.model : fleet.work?.model;
  if (kindModel) return kindModel;
  if (fleet.model) return fleet.model;
  if (board.orchestratorModel) return board.orchestratorModel;
  return null;
}

export function resolveRunOn(task: Task, fleetDefaults: FleetDefaults): "orchestrator" | "worker" {
  if (task.runOn) return task.runOn;
  const runOn = fleetDefaults.review?.runOn;
  if (runOn) return runOn;
  return "orchestrator";
}

// Decide where a review task should actually run.
//
// Rules, in priority order:
//   1. Explicit task.runOn → honored.
//   2. Explicit fleetDefaults.review.runOn → honored.
//   3. Any configured review agent or model (per-task OR in
//      fleetDefaults.review/.agent/.model) → worker lane. The configured
//      values are only honored on the worker lane; orchestrator-lane
//      reviews run on the host session with the host's agent/model.
//      Treating any explicit config as "use worker" makes the configured
//      values a hard contract instead of "use them only if they happen
//      to match the host" (which would silently change behavior any
//      time the host model changes).
//   4. Default → orchestrator lane.
//
// Returns: { lane, reason } so callers can log/explain the routing.
export function resolveReviewLane(
  task: Task,
  board: { fleetDefaults: FleetDefaults; orchestratorAgent?: string | null; orchestratorModel?: string | null },
): { lane: "orchestrator" | "worker"; reason: "explicit-task" | "explicit-fleet" | "configured-agent" | "configured-model" | "default" } {
  if (task.runOn) {
    return { lane: task.runOn, reason: "explicit-task" };
  }
  if (board.fleetDefaults.review?.runOn) {
    return { lane: board.fleetDefaults.review.runOn, reason: "explicit-fleet" };
  }
  // Any review-specific or per-task agent/model configuration → worker
  // lane. We only consult sources that meaningfully target reviews:
  // per-task overrides, fleetDefaults.review.{agent,model}. We do NOT
  // consult fleetDefaults.{agent,model} (the global default that
  // applies to work tasks too) — those are not review-targeted.
  const reviewAgent = task.agent ?? board.fleetDefaults.review?.agent;
  const reviewModel = task.model ?? board.fleetDefaults.review?.model;
  if (reviewAgent) {
    return { lane: "worker", reason: "configured-agent" };
  }
  if (reviewModel) {
    return { lane: "worker", reason: "configured-model" };
  }
  return { lane: "orchestrator", reason: "default" };
}

// Project-level attachments supplied by the user at create/start
// time via `--attach <path>` (repeatable). Each entry holds the
// resolved path (for display) and the file contents read at command
// time. Inlined into every task's prompt by the prompt builders so
// workers don't have to read the source file themselves — useful for
// spec / plan docs that live outside the project's worker permission
// scope (e.g. `~/.claude/plans/*`).
export interface Attachment {
  path: string;
  content: string;
}

export interface Board {
  version: number;
  projectId: string;
  description: string;
  attachments?: Attachment[];
  // User-authored block of contracts that apply to every task in the
  // project. Rendered into both work and review prompts above any
  // per-task context, so every worker (and every reviewer) is checking
  // against the same set of invariants. Use for cross-cutting facts
  // that are not visible from the diff alone: daemon protocol
  // contracts, wire-shape constraints, "this method requires `this`
  // binding", etc. Free-form markdown.
  contractBrief?: string;
  state: BoardState;
  createdAt: string;
  updatedAt: string;
  fleetDefaults: FleetDefaults;
  reviewPolicy?: {
    mode?: "off" | "hints" | "all" | "high-only";
    overrideHint?: boolean;
    maxAttempts?: number;
  };
  tasks: Task[];
  workers: Record<string, {
    currentTaskId: string | null;
    tasksCompleted: string[];
    // Effective agent/model the worker session was spawned with —
    // captured at spawn time so the sessions table can render
    // AGENT|MODEL even after assignedTo has been cleared on completion.
    // Distinct from per-task overrides (task.agent / task.model): these
    // record what was actually applied (after fleet-default fallback).
    agent?: string | null;
    model?: string | null;
    // Last-observed usage_update snapshot for this worker session.
    // Cost is cumulative within the worker's lifetime; we aggregate
    // across workers for the project total in formatStatus.
    usage?: WorkerUsage;
    // Last-observed worker-internal todolist, captured from the
    // worker's ACP `plan` updates and/or `TodoWrite` tool calls.
    // Surfaced in the orchestrator board panel as indented sub-rows
    // beneath the parent task (capped at the first N incomplete by
    // worker order — see plan-update.ts). Ephemeral: not persisted
    // across daemon restarts; the next worker emit rebuilds them.
    subtodos?: WorkerSubtodo[];
  }>;
  concurrencyCap: number;
  // When true, decomposition won't recompute concurrencyCap from the
  // DAG shape — the user pinned it explicitly via `--workers N`.
  concurrencyCapLocked?: boolean;
  // Determines what finishDecomposition does once parsing completes:
  //   - `true`: transition state to `running` and start scheduling
  //     workers. The start verb sets this (decompose-from-
  //     conversation flow), as does anything else that wants the
  //     project to begin running immediately after decomposition.
  //   - `false` / unset: transition state to `ready`, emit the plan
  //     panel and a "run start to begin" message, and stop.
  //     This is what `create` does: form the plan, show it, and
  //     wait for the user to opt into kickoff via `/hydra planner
  //     start` once they've reviewed (and optionally re-issued
  //     `/hydra planner create` to revise).
  // Persisted so a daemon restart mid-decomposition preserves the
  // user's original intent.
  pendingExecute?: boolean;
  // When true, the decomposer system prompt includes competition
  // pattern instructions (N sibling work tasks + a review task that
  // picks a winner). Set by the --compete CLI flag on create/start.
  compete?: boolean;
  // Last-observed usage_update snapshot for the orchestrator session
  // itself. Captured the same way as worker usage; rendered on the
  // orchestrator row of the sessions table.
  orchestratorUsage?: WorkerUsage;
  // Snapshot of the orchestrator session's cumulative usage at the
  // moment this board was created. Subtracted from orchestratorUsage at
  // render time so a project's reported cost/tokens start at 0 and only
  // reflect spend accrued after plan creation — excluding whatever the
  // orchestrator session had already spent on prior turns.
  orchestratorUsageBaseline?: WorkerUsage;
  // Last-observed agent/model on the orchestrator session, captured
  // from session_info_update (agentId under _meta["hydra-acp"]) and
  // current_model_update (currentModel).
  orchestratorAgent?: string | null;
  orchestratorModel?: string | null;
  // Accumulated wall-clock time the project has spent in the `running`
  // state across all start/retry cycles. Excludes time spent in
  // `ready`, `decomposing` (initial plan + amends), `paused`, and
  // `stopped`. Updated only when transitioning OUT of `running` via
  // setBoardState; the live "currently running" delta is added on top
  // at render time via executionTimeMs.
  executionMs?: number;
  // ISO timestamp of when the project most recently entered `running`.
  // Set on transition into running, cleared on transition out. When
  // set, the project is actively accruing execution time.
  executionStartedAt?: string | null;
}

// Centralize state transitions so we can maintain the execution timer
// (executionMs / executionStartedAt) without having to remember at each
// call site. Use this instead of assigning board.state directly.
export function setBoardState(board: Board, next: BoardState): void {
  const prev = board.state;
  if (prev === next) return;
  if (prev === "running" && board.executionStartedAt) {
    const start = Date.parse(board.executionStartedAt);
    if (Number.isFinite(start)) {
      board.executionMs = (board.executionMs ?? 0) + Math.max(0, Date.now() - start);
    }
    board.executionStartedAt = null;
  }
  if (next === "running") {
    board.executionStartedAt = nowIso();
  }
  board.state = next;
}

export const PROJECT_ID_PREFIX = "hydra_plan_";

// Project identifiers prefix with `hydra_plan_` to match the sibling
// `hydra_session_` convention. A short random suffix avoids human-name
// collisions; we don't slugify the description because the description
// may contain anything and slugification is lossy.
export function newProjectId(): string {
  return `${PROJECT_ID_PREFIX}${randomBytes(6).toString("hex")}`;
}

// Accept either the full id (`hydra_plan_abc123`) or the bare suffix
// (`abc123`) and return the full form. Mirrors how `hydra-acp session
// <id>` accepts both forms.
export function canonicalProjectId(input: string): string {
  return input.startsWith(PROJECT_ID_PREFIX)
    ? input
    : `${PROJECT_ID_PREFIX}${input}`;
}

// Render a project id for user-visible output (CLI lists, agent
// messages) by stripping the prefix. Symmetric with hydra's session
// listings which show the short form.
export function shortProjectId(id: string): string {
  return id.startsWith(PROJECT_ID_PREFIX)
    ? id.slice(PROJECT_ID_PREFIX.length)
    : id;
}

const HYDRA_SESSION_PREFIX = "hydra_session_";

// Strip the `hydra_session_` prefix for user-visible output. Hydra's
// own resolveCanonicalId accepts both forms as input, and `hydra-acp
// session` (the table-list view) renders the short form — so showing
// the short form in planner output is both scannable and still
// paste-able into `hydra-acp --session <id>`.
export function shortSessionId(id: string): string {
  return id.startsWith(HYDRA_SESSION_PREFIX)
    ? id.slice(HYDRA_SESSION_PREFIX.length)
    : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Make a fresh ready-to-run copy of an existing board.
//
// Use case: `/hydra planner fork <projectId>` — the user lost the
// session that owned the original plan (or just wants to re-run the
// same DAG from scratch) and wants a new project that mirrors the
// source's structure but is owned by the current session.
//
// Copy semantics, not move: the source board is left untouched on
// disk. The fork mints a new projectId, deep-copies the task
// structure (id/title/deps/what/why/constraints/agent/model/kind/
// reviews/onReject/risk/hint/runOn/canApplyFixes), resets every
// task to `pending` with empty artifacts/feedback, and clears all
// workers + execution timing. Board state lands at `ready` so the
// user reviews and explicitly issues `/hydra planner start`.
//
// `concurrencyCap` and `concurrencyCapLocked` carry over. Review
// policy, fleet defaults, contract brief, and attachments are
// preserved. orchestratorAgent/Model are dropped — they'll be re-
// seeded from the new owning session.
export function forkBoard(opts: {
  source: Board;
  description?: string;
}): Board {
  const now = nowIso();
  const src = opts.source;
  return {
    version: BOARD_SCHEMA_VERSION,
    projectId: newProjectId(),
    description: opts.description?.trim() || src.description,
    attachments: src.attachments ? src.attachments.map((a) => ({ ...a })) : undefined,
    contractBrief: src.contractBrief,
    state: "ready",
    createdAt: now,
    updatedAt: now,
    fleetDefaults: {
      agent: src.fleetDefaults.agent,
      model: src.fleetDefaults.model,
      work: src.fleetDefaults.work ? { ...src.fleetDefaults.work } : undefined,
      review: src.fleetDefaults.review ? { ...src.fleetDefaults.review } : undefined,
    },
    reviewPolicy: src.reviewPolicy ? { ...src.reviewPolicy } : undefined,
    tasks: src.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      why: t.why,
      what: t.what,
      constraints: t.constraints,
      deps: [...t.deps],
      agent: t.agent ?? null,
      model: t.model ?? null,
      reviewAgent: t.reviewAgent ?? null,
      reviewModel: t.reviewModel ?? null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
      kind: t.kind ?? "work",
      reviews: Array.isArray(t.reviews) ? [...t.reviews] : t.reviews,
      runOn: t.runOn,
      reviewFeedback: undefined,
      riskLevel: t.riskLevel,
      reviewHint: t.reviewHint,
      onReject: t.onReject ? { ...t.onReject } : undefined,
      canApplyFixes: t.canApplyFixes,
    })),
    workers: {},
    concurrencyCap: src.concurrencyCap,
    concurrencyCapLocked: src.concurrencyCapLocked,
    pendingExecute: false,
    compete: src.compete,
    executionMs: undefined,
    executionStartedAt: null,
  };
}

export function newBoard(opts: {
  description: string;
  fleetDefaults?: FleetDefaults;
  concurrencyCap?: number;
  attachments?: Attachment[];
  contractBrief?: string;
}): Board {
  const now = nowIso();
  const brief = opts.contractBrief?.trim();
  return {
    version: BOARD_SCHEMA_VERSION,
    projectId: newProjectId(),
    description: opts.description,
    attachments: opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined,
    contractBrief: brief && brief.length > 0 ? brief : undefined,
    state: "decomposing",
    createdAt: now,
    updatedAt: now,
    fleetDefaults: opts.fleetDefaults ?? { agent: null, model: null },
    tasks: [],
    workers: {},
    concurrencyCap: opts.concurrencyCap ?? 1,
    concurrencyCapLocked: opts.concurrencyCap !== undefined ? true : undefined,
  };
}

function migrateBoard(b: Board): void {
  // Schema v1 → v2: add new optional fields that don't have defaults.
  if (b.version < 2) {
    for (const t of b.tasks) {
      t.kind ??= "work";
    }
    b.version = 2;
  }
}

export function loadBoard(projectId: string): Board | undefined {
  try {
    const raw = readFileSync(boardPath(projectId), "utf8");
    const parsed = JSON.parse(raw) as Board;
    migrateBoard(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

// Atomic write: temp file → rename. Avoids partial-write corruption
// if the process is killed mid-save. Crash safety is the only
// invariant we maintain here; in-process ordering is the transformer's
// single event loop (single writer, no concurrency).
export function saveBoard(board: Board, orchestratorSessionId: string): void {
  board.updatedAt = nowIso();
  const dir = projectDir(board.projectId);
  mkdirSync(dir, { recursive: true });
  const target = boardPath(board.projectId);
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(board, null, 2));
  renameSync(tmp, target);
  // Persist the orchestrator session pointer so cold-start recovery can
  // reverse-map projectId -> session without scanning every session.
  writeFileSync(orchestratorPointerPath(board.projectId), `${orchestratorSessionId}\n`);
}

export interface ProjectIndexEntry {
  projectId: string;
  orchestratorSessionId: string | undefined;
  description: string;
  state: BoardState;
  tasksTotal: number;
  tasksDone: number;
  createdAt: string;
  updatedAt: string;
}

// Walk the projects directory, load each board summary. Used by the
// CLI `list` verb and by transformer cold-start recovery. Returns
// nothing about archived projects — those live under archive/ and have
// their own walk routine when needed.
// Pick the next task that's ready to be assigned: status === "pending"
// AND every dep is "done". Returns undefined when nothing is eligible
// (could be because everything's done, blocked, or in flight). Walks in
// declaration order — first eligible wins, which is deterministic.
export function pickEligible(board: Board): Task | undefined {
  const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
  for (const task of board.tasks) {
    if (task.status !== "pending") continue;
    // A review task whose `reviews` target is parked in awaiting_review
    // is eligible — that holding state exists precisely so the review
    // can run. Non-review dependents wait for the dep to reach a
    // terminal state (done / superseded) so they don't race ahead of
    // any reviewer-requested fixes.
    const reviewsSet =
      task.kind === "review"
        ? new Set(
            Array.isArray(task.reviews)
              ? task.reviews
              : task.reviews
                ? [task.reviews]
                : [],
          )
        : null;
    const blocked = task.deps.some((d) => {
      const s = byId.get(d)?.status;
      if (s === "done" || s === "superseded") return false;
      if (s === "awaiting_review" && reviewsSet?.has(d)) return false;
      return true;
    });
    if (blocked) continue;
    return task;
  }
  return undefined;
}

// All tasks are terminal (done, superseded, or failed). Used to decide
// when to emit the project-complete message and to stop spawning workers.
// `awaiting_review` is NOT terminal — it's a holding state pending a
// reviewer decision. `superseded` is terminal: the task was retired in
// favor of a replacement and won't run again.
export function allTerminal(board: Board): boolean {
  if (board.tasks.length === 0) return false;
  return board.tasks.every(
    (t) => t.status === "done" || t.status === "failed" || t.status === "superseded",
  );
}

// Number of tasks currently in `assigned` state — i.e. workers
// actively running. The scheduler uses this against board.concurrencyCap
// to decide whether to spawn another worker. `awaiting_review` is
// deliberately NOT counted: the worker has exited and the task is
// parked waiting for a reviewer; it doesn't consume a concurrency slot.
export function inFlightCount(board: Board): number {
  let n = 0;
  for (const t of board.tasks) {
    if (t.status === "assigned") n += 1;
  }
  return n;
}

// Revert all in-flight (assigned) tasks back to pending and clear their
// worker assignments. This is the bookkeeping half of a user-initiated stop:
// it resets task state so that a subsequent `start` can re-dispatch them,
// and it clears stale currentTaskId pointers on workers (the root cause of
// the orphan "task=- state=-" rows the user originally reported after ^C).
//
// Only tasks with status === 'assigned' AND assignedTo set are reverted.
// Tasks in awaiting_review are deliberately NOT touched: those represent
// completed worker output parked for a reviewer; a user stop is "I'll come
// back to this" rather than "something broke", so the review pipeline must
// survive stop→resume intact.
//
// This helper does NOT call setBoardState or saveBoard — it mutates tasks
// and workers in-place only. The caller is responsible for updating
// board.state (typically to 'stopped') and persisting the board.
export function stopBoardBookkeeping(board: Board): { inFlightWorkerIds: string[] } {
  const ids = new Set<string>();

  // Primary: tasks currently in `assigned` state. Revert to pending and
  // collect the worker each references via task.assignedTo.
  for (const task of board.tasks) {
    if (task.status !== "assigned") continue;
    if (task.assignedTo) ids.add(task.assignedTo);
    task.status = "pending";
    task.assignedTo = null;
    task.startedAt = null;
    task.finishedAt = null;
  }

  // Secondary: workers with currentTaskId set but no task points back
  // to them. This catches orphaned/shadow workers — e.g. a duplicate-
  // spawn race where two workers were assigned to the same task and
  // only the second's id ended up on task.assignedTo, leaving the
  // first invisible to the task-level pass above. Without this they'd
  // keep running on the daemon after a user-initiated stop.
  for (const [workerId, worker] of Object.entries(board.workers)) {
    if (worker.currentTaskId) {
      ids.add(workerId);
      worker.currentTaskId = null;
    }
  }

  return { inFlightWorkerIds: [...ids] };
}

export function listProjects(): ProjectIndexEntry[] {
  const dir = projectsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ProjectIndexEntry[] = [];
  for (const projectId of entries) {
    const board = loadBoard(projectId);
    if (!board) continue;
    let orchestratorSessionId: string | undefined;
    try {
      orchestratorSessionId = readFileSync(orchestratorPointerPath(projectId), "utf8")
        .trim();
    } catch {
      orchestratorSessionId = undefined;
    }
    out.push({
      projectId: board.projectId,
      orchestratorSessionId,
      description: board.description,
      state: board.state,
      tasksTotal: board.tasks.length,
      tasksDone: board.tasks.filter((t) => t.status === "done").length,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    });
  }
  // Most-recent-first matches `hydra-acp session` and aligns with how
  // people scan project lists ("what was I working on?").
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
