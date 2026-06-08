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
//     spawned. Awaiting a `/hydra planner execute` call to kick off.
//     This is the resting state after `create`.
//   * running: scheduler is dispatching workers and reaping completions.
//   * paused: scheduling halted by the user; in-flight workers run
//     to completion but no new tasks dispatch.
//   * done: every task is in a terminal status, all succeeded.
//   * failed: every task is in a terminal status, at least one failed
//     (including user-cancel).
//
// `create` produces a `ready` board (decompose + show, no execute).
// `execute` finds the ready board and transitions it to running, OR
// decomposes-from-conversation when no board exists and runs in one
// step (the original execute behavior).
export type BoardState =
  | "decomposing"
  | "ready"
  | "running"
  | "paused"
  | "stopped" // user-initiated halt; resumable via execute/set_plan. Workers killed; in-flight tasks reverted to pending.
  | "done"
  | "failed"; // hard failure (e.g. worker failed to launch); distinct from user stop. NOT auto-resumable.

export interface TaskArtifacts {
  files_changed?: string[];
  summary?: string;
  decisions?: string[];
  assumptions?: string[];
  follow_ups?: string[];
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

export function resolveAgent(task: Task, fleetDefaults: FleetDefaults): string | null {
  if (task.agent) return task.agent;
  const kind = task.kind ?? "work";
  const kindAgent = kind === "review" ? fleetDefaults.review?.agent : fleetDefaults.work?.agent;
  if (kindAgent) return kindAgent;
  if (fleetDefaults.agent) return fleetDefaults.agent;
  return null;
}

export function resolveModel(task: Task, fleetDefaults: FleetDefaults): string | null {
  if (task.model) return task.model;
  const kind = task.kind ?? "work";
  const kindModel = kind === "review" ? fleetDefaults.review?.model : fleetDefaults.work?.model;
  if (kindModel) return kindModel;
  if (fleetDefaults.model) return fleetDefaults.model;
  return null;
}

export function resolveRunOn(task: Task, fleetDefaults: FleetDefaults): "orchestrator" | "worker" {
  if (task.runOn) return task.runOn;
  const runOn = fleetDefaults.review?.runOn;
  if (runOn) return runOn;
  return "orchestrator";
}

// Project-level attachments supplied by the user at create/execute
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
  state: BoardState;
  createdAt: string;
  updatedAt: string;
  fleetDefaults: FleetDefaults;
  reviewPolicy?: {
    mode?: "off" | "hints" | "all" | "high-only";
    overrideHint?: boolean;
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
  }>;
  concurrencyCap: number;
  // When true, decomposition won't recompute concurrencyCap from the
  // DAG shape — the user pinned it explicitly via `--workers N`.
  concurrencyCapLocked?: boolean;
  // Determines what finishDecomposition does once parsing completes:
  //   - `true`: transition state to `running` and start scheduling
  //     workers. The execute verb sets this (decompose-from-
  //     conversation flow), as does anything else that wants the
  //     project to begin running immediately after decomposition.
  //   - `false` / unset: transition state to `ready`, emit the plan
  //     panel and a "run execute to start" message, and stop.
  //     This is what `create` does: form the plan, show it, and
  //     wait for the user to opt into kickoff via `/hydra planner
  //     execute` once they've reviewed (and optionally re-issued
  //     `/hydra planner create` to revise).
  // Persisted so a daemon restart mid-decomposition preserves the
  // user's original intent.
  pendingExecute?: boolean;
  // When true, the decomposer system prompt includes competition
  // pattern instructions (N sibling work tasks + a review task that
  // picks a winner). Set by the --compete CLI flag on create/execute.
  compete?: boolean;
  // Last-observed usage_update snapshot for the orchestrator session
  // itself. Captured the same way as worker usage; rendered on the
  // orchestrator row of the sessions table.
  orchestratorUsage?: WorkerUsage;
  // Last-observed agent/model on the orchestrator session, captured
  // from session_info_update (agentId under _meta["hydra-acp"]) and
  // current_model_update (currentModel).
  orchestratorAgent?: string | null;
  orchestratorModel?: string | null;
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

export function newBoard(opts: {
  description: string;
  fleetDefaults?: FleetDefaults;
  concurrencyCap?: number;
  attachments?: Attachment[];
}): Board {
  const now = nowIso();
  return {
    version: BOARD_SCHEMA_VERSION,
    projectId: newProjectId(),
    description: opts.description,
    attachments: opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined,
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
    const blocked = task.deps.some((d) => {
      const s = byId.get(d)?.status;
      return s !== "done" && s !== "superseded";
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
