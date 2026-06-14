// Text formatters for board state. Pure functions over Board — no I/O,
// no daemon calls — so they're directly unit-testable.

import { resolveAgent, resolveModel, shortProjectId, shortSessionId, type Board, type Task, type TaskArtifacts, type WorkerUsage } from "./board.js";
import {
  buildReviewsByParent,
  isMultiRevieweeReview,
  renderReviewTask,
  reviewTargetsOf,
} from "./render-reviews.js";

// Format a cost amount with the worker's reported currency. Falls back
// to a bare numeric when no currency is known; treats "USD" specially
// to render as `$1.23` (the common case). Returns "-" for missing data.
export function formatCost(amount: number | undefined, currency: string | undefined): string {
  if (typeof amount !== "number") return "-";
  if (currency === "USD" || currency === undefined) {
    return `$${amount.toFixed(2)}`;
  }
  return `${amount.toFixed(2)} ${currency}`;
}

// Format a task's elapsed time. For done/failed tasks uses
// finishedAt - startedAt; for in-flight tasks uses now - startedAt
// (and suffixes with "+"). Returns "" when the task hasn't started.
export function formatTaskDuration(task: Task, now: number = Date.now()): string {
  if (!task.startedAt) return "";
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start)) return "";
  const endIso = task.finishedAt;
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(end)) return "";
  const ms = Math.max(0, end - start);
  const live = !endIso;
  return formatDurationMs(ms) + (live ? "+" : "");
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

// Compact token count: 12345 → "12.3k". Returns "-" for missing data.
export function formatTokens(n: number | undefined): string {
  if (typeof n !== "number") return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Orchestrator usage with the plan-creation baseline subtracted, so
// the reported value is just the cost/tokens accrued on the
// orchestrator session since plan start — not whatever it had already
// spent on prior turns. Returns undefined if there's no orchestrator
// usage to report.
export function orchestratorUsageSincePlan(board: Board): WorkerUsage | undefined {
  const isTerminal = board.state === "done" || board.state === "failed";
  const u = isTerminal && board.orchestratorUsageAtCompletion
    ? board.orchestratorUsageAtCompletion
    : board.orchestratorUsage;
  if (!u) return undefined;
  const b = board.orchestratorUsageBaseline;
  if (!b) return u;
  const out: WorkerUsage = { ...u };
  if (typeof u.costAmount === "number" && typeof b.costAmount === "number") {
    out.costAmount = Math.max(0, u.costAmount - b.costAmount);
  }
  if (typeof u.used === "number" && typeof b.used === "number") {
    out.used = Math.max(0, u.used - b.used);
  }
  return out;
}

// Sum cumulative cost across all workers for the project total. Each
// worker reports a session-cumulative amount, so summing across
// distinct worker sessions gives the project-wide total. The
// orchestrator contribution is baseline-adjusted so it counts only
// plan-relevant spend (see orchestratorUsageSincePlan).
export function totalUsage(board: Board): {
  cost: number;
  currency: string | undefined;
  tokensUsed: number;
  hasTokens: boolean;
} {
  let cost = 0;
  let currency: string | undefined;
  let tokensUsed = 0;
  let hasTokens = false;
  const sources: Array<WorkerUsage | undefined> = [
    orchestratorUsageSincePlan(board),
    ...Object.values(board.workers).map((w) => w.usage),
  ];
  for (const u of sources) {
    if (!u) continue;
    if (typeof u.costAmount === "number") {
      cost += u.costAmount;
      if (!currency && u.costCurrency) currency = u.costCurrency;
    }
    if (typeof u.used === "number") {
      tokensUsed += u.used;
      hasTokens = true;
    }
  }
  return { cost, currency, tokensUsed, hasTokens };
}

// Sum of per-task durations (finished - started, or now - started for
// in-flight tasks). Returns 0 if no tasks have started yet. This is
// "compute time" — distinct from wall-clock, since tasks can run in
// parallel.
export function totalTaskDurationMs(board: Board, now: number = Date.now()): number {
  let sum = 0;
  for (const t of board.tasks) {
    if (!t.startedAt) continue;
    const start = Date.parse(t.startedAt);
    if (!Number.isFinite(start)) continue;
    const end = t.finishedAt ? Date.parse(t.finishedAt) : now;
    if (!Number.isFinite(end)) continue;
    sum += Math.max(0, end - start);
  }
  return sum;
}

// Wall-clock elapsed from project creation to either the last task's
// finishedAt (terminal projects) or now (live projects). Returns 0 if
// createdAt is missing/unparseable.
export function wallClockMs(board: Board, now: number = Date.now()): number {
  const start = Date.parse(board.createdAt);
  if (!Number.isFinite(start)) return 0;
  let end = now;
  if (board.state === "done" || board.state === "failed") {
    let latest = 0;
    for (const t of board.tasks) {
      if (!t.finishedAt) continue;
      const f = Date.parse(t.finishedAt);
      if (Number.isFinite(f) && f > latest) latest = f;
    }
    if (latest > 0) end = latest;
  }
  return Math.max(0, end - start);
}

// Inline agent/model tag for a task: " {agent}", " {agent·model}",
// " {model}", or "" when neither can be determined. Resolves the
// effective values through fleetDefaults so the rendered tag shows the
// agent/model the task will actually execute with — not just the
// per-task override. Same shape across the board-context preamble,
// the /status view, and the plan panel.
export function formatTaskTag(task: Task, board?: Board): string {
  const a = board ? resolveAgent(task, board) : (task.agent ?? null);
  const m = board ? resolveModel(task, board) : (task.model ?? null);
  if (!a && !m) return "";
  const inner = a && m ? `${a}·${m}` : (a ?? m);
  return ` {${inner}}`;
}

// Execution-time accounting. Counts only the time the project has
// spent in `running` state across all execute/retry cycles. Excludes
// time in ready/decomposing/paused/stopped — i.e. amend/review pauses
// and the pre-execute window don't accrue.
export function executionTimeMs(board: Board, now: number = Date.now()): number {
  let total = board.executionMs ?? 0;
  if (board.state === "running" && board.executionStartedAt) {
    const start = Date.parse(board.executionStartedAt);
    if (Number.isFinite(start)) {
      total += Math.max(0, now - start);
    }
  }
  return total;
}

// Tabular render of the sessions involved in a project: the
// orchestrator (the conversation session the user is in) plus one row
// per worker session. Used by both `/hydra planner status` (slash) and
// `hydra-acp planner info` (CLI). Disk-only — works without a daemon
// connection. Columns:
//   ROLE         orchestrator | worker
//   SESSION      short session id (prefix stripped)
//   TASK         task id assigned to that worker, or "-"
//   STATE        task status, or "-" for the orchestrator
//   AGENT|MODEL  agent·model the worker was actually spawned with, or "-"
//   DONE         tasksCompleted count from board.workers, or "-"
//   TITLE        truncated task title
export function formatSessionsTable(
  board: Board,
  orchestratorSessionId: string | undefined,
  options: { indent?: string; titleMaxWidth?: number } = {},
): string {
  const indent = options.indent ?? "";
  const titleMax = options.titleMaxWidth ?? 60;

  type Row = {
    role: string;
    session: string;
    task: string;
    state: string;
    agent: string;
    done: string;
    cost: string;
    tokens: string;
    title: string;
  };

  const rows: Row[] = [];
  if (orchestratorSessionId) {
    const ou = orchestratorUsageSincePlan(board);
    const oa = board.orchestratorAgent;
    const om = board.orchestratorModel;
    const orchAgentCell = oa || om
      ? (oa && om ? `${oa}·${om}` : (oa ?? om ?? "-"))
      : "-";
    // The orchestrator session does double duty: it's the user's chat
    // session AND it runs orchestrator-lane reviews (runOn="orchestrator",
    // single-flight). Reflect the review-lane activity in the row so it
    // doesn't read as idle when reviews are actually running on it.
    const orchLaneReviews = board.tasks.filter(
      (t) => t.kind === "review" && t.assignedTo === "orchestrator",
    );
    const orchReviewDone = board.tasks.filter(
      (t) => t.kind === "review" && t.status === "done",
    ).length;
    const orchReviewTotal = board.tasks.filter(
      (t) => t.kind === "review",
    ).length;
    const inFlight = orchLaneReviews.find((t) => t.status === "assigned");
    rows.push({
      role: "orchestrator",
      session: shortSessionId(orchestratorSessionId),
      task: inFlight?.id ?? "-",
      state: inFlight?.status ?? board.state,
      agent: orchAgentCell,
      done: orchReviewTotal > 0 ? `${orchReviewDone}/${orchReviewTotal} reviews` : "-",
      cost: formatCost(ou?.costAmount, ou?.costCurrency),
      tokens: ou?.used !== undefined
        ? (ou.size !== undefined
            ? `${formatTokens(ou.used)}/${formatTokens(ou.size)}`
            : formatTokens(ou.used))
        : "-",
      title: inFlight?.title ?? board.description,
    });
  }

  // Index tasks by worker id so we can attach task metadata to each
  // worker row. A worker may have completed past tasks; we render the
  // CURRENT assignment (if any), else the most recent completed task.
  const taskByWorker = new Map<string, Task>();
  for (const t of board.tasks) {
    if (t.assignedTo) taskByWorker.set(t.assignedTo, t);
  }
  const taskById = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
  for (const [workerId, w] of Object.entries(board.workers)) {
    let t = taskByWorker.get(workerId);
    if (!t && w.tasksCompleted.length > 0) {
      const lastId = w.tasksCompleted[w.tasksCompleted.length - 1];
      t = lastId ? taskById.get(lastId) : undefined;
    }
    const workerTag = w.agent || w.model
      ? (w.agent && w.model ? `${w.agent}·${w.model}` : (w.agent ?? w.model ?? ""))
      : "";
    const taskTag = t ? formatTaskTag(t, board).trim().replace(/^\{|\}$/g, "") : "";
    const agentCell = workerTag.length > 0 ? workerTag : taskTag;
    const totalTasks = w.tasksCompleted.length + (w.currentTaskId ? 1 : 0);
    rows.push({
      role: "worker",
      session: shortSessionId(workerId),
      task: t?.id ?? "-",
      state: t?.status ?? "-",
      agent: agentCell.length > 0 ? agentCell : "-",
      done: totalTasks > 0 ? `${w.tasksCompleted.length}/${totalTasks}` : "-",
      cost: formatCost(w.usage?.costAmount, w.usage?.costCurrency),
      tokens: w.usage?.used !== undefined
        ? (w.usage.size !== undefined
            ? `${formatTokens(w.usage.used)}/${formatTokens(w.usage.size)}`
            : formatTokens(w.usage.used))
        : "-",
      title: t?.title ?? "-",
    });
  }

  if (rows.length === 0) return "";

  const header: Row = {
    role: "ROLE",
    session: "SESSION",
    task: "TASK",
    state: "STATE",
    agent: "AGENT·MODEL",
    done: "DONE",
    cost: "COST",
    tokens: "TOKENS",
    title: "TITLE",
  };

  const cols: Array<keyof Row> = ["role", "session", "task", "state", "agent", "done", "cost", "tokens", "title"];
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(header[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof Row, number>;

  const renderRow = (r: Row): string =>
    cols
      .map((c, i) => {
        if (c === "title") {
          const t = r[c].length > titleMax ? r[c].slice(0, titleMax - 1) + "…" : r[c];
          return i === cols.length - 1 ? t : t.padEnd(widths[c]);
        }
        return r[c].padEnd(widths[c]);
      })
      .join("  ");

  const lines = [renderRow(header), ...rows.map(renderRow)];
  return lines.map((l) => indent + l).join("\n");
}

export const TASK_STATUS_GLYPH: Record<string, string> = {
  done: "[x]",
  assigned: "[~]",
  failed: "[!]",
  blocked: "[-]",
  pending: "[ ]",
  awaiting_review: "[*]",
  superseded: "(~)",
};

// Render a board as a context preamble injected into the user's prompts
// to the orchestrator agent. Different consumer than formatStatus:
//
//   - formatStatus is for the human (terse glyphs, scannable).
//   - formatBoardContext is for the AGENT (named fields, full artifact
//     bodies, explicit "you may answer questions using this context"
//     instruction so the agent doesn't echo the data verbatim).
//
// The agent receives this immediately before the user's actual prompt
// on every non-slash turn, so it always has fresh project state. Keep
// it reasonably compact — every conversational turn pays the token
// cost.
export function formatBoardContext(board: Board): string {
  const lines: string[] = [];
  lines.push("[hydra-acp-planner: this session is the orchestrator for a multi-agent project.");
  lines.push(`Project ID: ${shortProjectId(board.projectId)} (state: ${board.state})`);
  lines.push(`Description: ${board.description}`);
  lines.push(`Concurrency cap: ${board.concurrencyCap}`);
  if (board.tasks.length === 0) {
    lines.push("Tasks: none yet (decomposition pending).");
  } else {
    const done = board.tasks.filter((t) => t.status === "done").length;
    const total = board.tasks.length;
    lines.push(`Tasks (${done}/${total} done):`);
    for (const task of board.tasks) {
      const glyph = TASK_STATUS_GLYPH[task.status] ?? "?";
      const deps = task.deps.length === 0 ? "" : `, deps: ${task.deps.join(", ")}`;
      const worker =
        task.status === "assigned" && task.assignedTo
          ? `, worker: ${shortSessionId(task.assignedTo)}`
          : "";
      const tag = formatTaskTag(task, board);
      const dur = formatTaskDuration(task);
      const durTag = dur ? `, duration: ${dur}` : "";
      lines.push(`  ${glyph} ${task.id} ${task.title}${tag} [${task.status}${deps}${worker}${durTag}]`);
      if (task.what) lines.push(`     what: ${task.what}`);
      if (task.constraints) lines.push(`     constraints: ${task.constraints}`);
      if (task.artifacts?.summary) lines.push(`     result: ${task.artifacts.summary}`);
      if (task.artifacts?.decisions && task.artifacts.decisions.length > 0) {
        lines.push(`     decisions: ${task.artifacts.decisions.join("; ")}`);
      }
      if (task.artifacts?.files_changed && task.artifacts.files_changed.length > 0) {
        lines.push(`     files: ${task.artifacts.files_changed.join(", ")}`);
      }
    }
  }
  lines.push("");
  lines.push("Answer the user's question or follow their instruction using this context. Do NOT echo the context block verbatim. To take action on the project (cancel, add tasks, etc.) suggest the relevant /hydra planner <verb> command.");
  lines.push("]");
  lines.push("");
  lines.push("User's prompt follows:");
  return lines.join("\n");
}

// ANSI escape sequences for inline styling. The renderer is CLI-only,
// so these codes work in any terminal that supports them.
const ESC_STRIKETHROUGH = "\u{001B}[9m";  // strikethrough on
const ESC_RESET = "\u{001B}[0m";          // reset all attributes

function applyStatusStyle(text: string, status: string): string {
  if (status === "superseded") return `${ESC_STRIKETHROUGH}${text}${ESC_RESET}`;
  return text;
}

// Render the body of a `/hydra planner status` reply, excluding the
// attached-marker line. Multi-line plain text; gets emitted as a
// synthetic agent_message_chunk by hydra's emitExtensionReply, so it
// lands cleanly in any client's transcript renderer.
export function formatStatusBody(
  board: Board,
  orchestratorSessionId?: string,
  attachedMarker?: string,
): string {
  const lines: string[] = [];
  const done = board.tasks.filter((t) => t.status === "done").length;
  const inFlight = board.tasks.filter((t) => t.status === "assigned").length;
  const failed = board.tasks.filter((t) => t.status === "failed").length;
  lines.push(`${shortProjectId(board.projectId)}  (${board.state})`);
  lines.push(`   ${board.description}`);
  lines.push("");
  const counts = [`${board.tasks.length} total`, `${done} done`];
  if (inFlight > 0) counts.push(`${inFlight} in flight`);
  if (failed > 0) counts.push(`${failed} failed`);
  lines.push(`   Tasks: ${counts.join(", ")}`);
  lines.push(`   Concurrency cap: ${board.concurrencyCap}`);
  const reviewsPending = board.tasks.filter(
    (t) => t.kind === "review" && (t.status === "pending" || t.status === "assigned"),
  ).length;
  const awaitingReview = board.tasks.filter((t) => t.status === "awaiting_review").length;
  if (reviewsPending > 0 || awaitingReview > 0) {
    const reviewParts: string[] = [];
    if (reviewsPending > 0) reviewParts.push(`${reviewsPending} reviews pending`);
    if (awaitingReview > 0) reviewParts.push(`${awaitingReview} awaiting review`);
    lines.push(`   Reviews: ${reviewParts.join(", ")}`);
  }
  const totals = totalUsage(board);
  const usageParts: string[] = [];
  if (totals.cost > 0) usageParts.push(formatCost(totals.cost, totals.currency));
  if (totals.hasTokens) usageParts.push(`${formatTokens(totals.tokensUsed)} tokens`);
  if (usageParts.length > 0) {
    const n = Object.keys(board.workers).length;
    lines.push(`   Usage: ${usageParts.join(", ")} (orchestrator + ${n} worker${n === 1 ? "" : "s"})`);
  }
  const exec = executionTimeMs(board);
  const compute = totalTaskDurationMs(board);
  if (exec > 0 || compute > 0) {
    const parts: string[] = [];
    if (exec > 0) {
      const live = board.state === "running" ? "+" : "";
      parts.push(`exec ${formatDurationMs(exec)}${live}`);
    }
    if (compute > 0) parts.push(`task ${formatDurationMs(compute)}`);
    lines.push(`   Duration: ${parts.join(", ")}`);
  }
  if (attachedMarker) {
    lines.push(attachedMarker);
  }
  if (board.tasks.length === 0) {
    return lines.join("\n");
  }
  lines.push("");

  const reviewsByParent = buildReviewsByParent(board.tasks);
  const renderedReviews = new Set<string>();
  const renderedTaskIds = new Set<string>();
  const pendingPeerReviews: Task[] = [];

  const flushPendingPeers = () => {
    for (let i = pendingPeerReviews.length - 1; i >= 0; i--) {
      const t = pendingPeerReviews[i];
      if (!t) continue;
      const targets = reviewTargetsOf(t);
      if (targets.every((id) => renderedTaskIds.has(id))) {
        const line = renderReviewTask(t, renderedReviews, {
          indent: "   ",
          renderTaskTag: (x) => formatTaskTag(x, board),
        });
        if (line) lines.push(line);
        pendingPeerReviews.splice(i, 1);
      }
    }
  };

  for (const task of board.tasks) {
    if (task.kind === "review" || task.kind === "distill") {
      if (isMultiRevieweeReview(task)) {
        pendingPeerReviews.push(task);
        flushPendingPeers();
      }
      // single-reviewee reviews render nested under their parent (below)
      continue;
    }
    const glyph = TASK_STATUS_GLYPH[task.status] ?? "?";
    const deps = task.deps.length === 0 ? "" : `  ← ${task.deps.join(", ")}`;
    const worker =
      task.status === "assigned" && task.assignedTo
        ? `  → ${shortSessionId(task.assignedTo)}`
        : "";
    const tag = formatTaskTag(task, board);
    const dur = formatTaskDuration(task);
    const durStr = dur ? `  (${dur})` : "";
    lines.push(`   ${glyph} ${task.id}  ${task.title}${tag}${deps}${worker}${durStr}`);
    renderedTaskIds.add(task.id);
    const childReviews = reviewsByParent.get(task.id);
    if (childReviews) {
      for (const r of childReviews) {
        const line = renderReviewTask(r, renderedReviews, {
          indent: "    ",
          renderTaskTag: (t) => formatTaskTag(t, board),
        });
        if (line) lines.push(line);
      }
    }
    flushPendingPeers();
  }
  // Any peer reviews whose reviewees never rendered (missing targets) — emit
  // at peer indent so they're not lost.
  for (const t of pendingPeerReviews) {
    const line = renderReviewTask(t, renderedReviews, {
      indent: "   ",
      renderTaskTag: (x) => formatTaskTag(x, board),
    });
    if (line) lines.push(line);
  }

  const sessionsTable = formatSessionsTable(board, orchestratorSessionId, {
    indent: "   ",
  });
  if (sessionsTable.length > 0) {
    lines.push("");
    lines.push("   Sessions:");
    lines.push(sessionsTable);
  }
  return lines.join("\n");
}

// Render a board as the body of a `/hydra planner status` reply.
// Multi-line plain text; gets emitted as a synthetic agent_message_chunk
// by hydra's emitExtensionReply, so it lands cleanly in any client's
// transcript renderer. The `attached` flag is the planner's
// best-effort belief about whether it's currently in this session's
// transformer chain — true if we've called transformer/attach this
// process lifetime and haven't dropped it.
export function formatStatus(
  board: Board,
  attached: boolean,
  orchestratorSessionId?: string,
): string {
  return formatStatusBody(board, orchestratorSessionId, `   Planner: ${attached ? "attached (intercepts active)" : "not currently attached — next /hydra planner command will re-attach"}`);
}

// A structured finding the orchestrator agent should act on after a
// project completes (or while one is running, for already-finished
// tasks). Returned by collectFindings and the get_findings MCP tool.
export type FindingCategory =
  | "failed"
  | "review_reject"
  | "review_amend"
  | "review_fix"
  | "follow_ups"
  | "distill";

export interface DistillReport {
  summary: string;
  findings: Array<{ claim: string; sources: string[]; verdict: string; evidence: string }>;
  recommendedAction: string;
  appliedWinner?: string;
  reworkBrief?: string;
  unresolved?: string[];
}

export interface Finding {
  taskId: string;
  title: string;
  kind: "work" | "review" | "distill";
  status: Task["status"];
  category: FindingCategory;
  summary: string | null;
  notes: string | null;
  followUps: string[];
  decision: string | null;
  attemptCount: number;
  verifiedDiff: TaskArtifacts["verified_diff"] | null;
  distillReport?: DistillReport;
}

export interface CollectFindingsOptions {
  taskId?: string;
  includeApproved?: boolean;
}

const APPROVED_DECISIONS = new Set(["approve", "winner", "synthesize"]);

// Walk a board's tasks and return the subset that need attention,
// pre-categorized for downstream consumers. Pure: same input → same
// output, no I/O. Used by both formatCompletionFindings (inline text
// in the project-complete summary) and the get_findings MCP tool
// (structured payload the agent can iterate over).
export function collectFindings(
  board: Board,
  opts: CollectFindingsOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const needle = opts.taskId ? opts.taskId.toLowerCase() : undefined;
  for (const t of board.tasks) {
    if (needle !== undefined && t.id.toLowerCase() !== needle) continue;
    const a = (t.artifacts ?? {}) as Record<string, unknown>;
    const summary = typeof a.summary === "string" ? a.summary : null;
    const notes = typeof a.notes === "string" ? a.notes : null;
    const followUps = Array.isArray(a.follow_ups)
      ? a.follow_ups.filter((v): v is string => typeof v === "string")
      : [];
    const decision =
      typeof a.review_decision === "string" ? a.review_decision : null;
    const verifiedDiff =
      (a.verified_diff as TaskArtifacts["verified_diff"] | undefined) ?? null;
    const kind: "work" | "review" | "distill" =
      t.kind === "review" ? "review" : t.kind === "distill" ? "distill" : "work";

    let category: FindingCategory | null = null;
    let distillReport: DistillReport | undefined;
    if (t.status === "failed") {
      category = "failed";
    } else if (t.status === "done" && kind === "distill") {
      category = "distill";
      const dFindingsRaw = Array.isArray(a.findings) ? a.findings : [];
      const dFindings: DistillReport["findings"] = [];
      for (const fr of dFindingsRaw) {
        if (!fr || typeof fr !== "object") continue;
        const r = fr as Record<string, unknown>;
        const claim = typeof r.claim === "string" ? r.claim : "";
        const verdict = typeof r.verdict === "string" ? r.verdict : "";
        const evidence = typeof r.evidence === "string" ? r.evidence : "";
        const sources = Array.isArray(r.sources)
          ? r.sources.filter((v): v is string => typeof v === "string")
          : [];
        dFindings.push({ claim, sources, verdict, evidence });
      }
      const recommendedAction =
        typeof a.recommended_action === "string" ? a.recommended_action : "";
      const appliedWinner =
        typeof a.applied_winner === "string" ? a.applied_winner : undefined;
      const reworkBrief =
        typeof a.rework_brief === "string" ? a.rework_brief : undefined;
      const unresolved = Array.isArray(a.unresolved)
        ? a.unresolved.filter((v): v is string => typeof v === "string")
        : undefined;
      distillReport = {
        summary: summary ?? "",
        findings: dFindings,
        recommendedAction,
        ...(appliedWinner ? { appliedWinner } : {}),
        ...(reworkBrief ? { reworkBrief } : {}),
        ...(unresolved && unresolved.length > 0 ? { unresolved } : {}),
      };
    } else if (t.status === "done" && kind === "review" && decision) {
      if (decision === "reject") category = "review_reject";
      else if (decision === "amend") category = "review_amend";
      else if (decision === "fix") category = "review_fix";
      else if (opts.includeApproved && APPROVED_DECISIONS.has(decision)) {
        category = "follow_ups";
      }
    } else if (t.status === "done" && kind === "work" && followUps.length > 0) {
      category = "follow_ups";
    }
    if (!category) continue;

    out.push({
      taskId: t.id,
      title: t.title,
      kind,
      status: t.status,
      category,
      summary,
      notes,
      followUps,
      decision,
      attemptCount: t.attemptCount,
      verifiedDiff,
      ...(distillReport ? { distillReport } : {}),
    });
  }
  return out;
}

// Render the findings list as plain text for the project-complete
// summary. Returns "" when nothing surfaces.
export const NOTES_MAX = 600;

export function truncateNotes(s: string): string {
  return s.length > NOTES_MAX ? `${s.slice(0, NOTES_MAX)}…` : s;
}

// Render a single finding as the multi-line block used by both the
// get_findings MCP drill-down (content[0].text) and the
// /hydra planner findings <taskId> slash command. Shape is stable —
// both surfaces depend on it.
export function formatFindingBlock(f: Finding): string {
  const statusSuffix = f.status === "failed" ? " (failed)" : "";
  const lines = [
    `=== ${f.taskId} [${f.category}] ${f.title}${statusSuffix}`,
  ];
  if (f.decision) {
    lines.push(`decision: ${f.decision}`);
  }
  if (f.summary) {
    lines.push(`summary: ${truncateNotes(f.summary)}`);
  }
  if (f.notes) {
    const indented = truncateNotes(f.notes).split("\n").join("\n  ");
    lines.push(`notes:\n  ${indented}`);
  }
  if (f.followUps.length > 0) {
    const fuLines = f.followUps.map((fu) => `  - ${fu}`).join("\n");
    lines.push(`follow_ups:\n${fuLines}`);
  }
  if (f.verifiedDiff) {
    const vd = f.verifiedDiff;
    const fileCount = vd.files.length;
    const sampleFile = vd.files[0] ?? "n/a";
    lines.push(
      `verified_diff: ${fileCount} file(s), ${vd.hunkCount} hunk(s) (sample: ${sampleFile})`,
    );
  }
  return lines.join("\n");
}

export interface FindingsListCounts {
  total: number;
  failed: number;
  reviewIssues: number;
  followUps: number;
  distill: number;
}

export function countFindings(findings: Finding[]): FindingsListCounts {
  const failed = findings.filter((f) => f.category === "failed").length;
  const reviewIssues = findings.filter(
    (f) =>
      f.category === "review_reject" ||
      f.category === "review_amend" ||
      f.category === "review_fix",
  ).length;
  const followUps = findings.filter((f) => f.category === "follow_ups").length;
  const distill = findings.filter((f) => f.category === "distill").length;
  return { total: findings.length, failed, reviewIssues, followUps, distill };
}

// Build the headline used by both the get_findings MCP text and the
// /hydra planner findings slash command. `forkNote` is appended after
// the projectId for cross-session reads.
export function formatFindingsHeadline(
  board: Board,
  findings: Finding[],
  forkNote = "",
): string {
  const c = countFindings(findings);
  if (findings.length === 0) {
    return `No findings on project ${shortProjectId(board.projectId)}${forkNote}.`;
  }
  const parts = [
    c.failed ? `${c.failed} failed` : null,
    c.reviewIssues
      ? `${c.reviewIssues} review issue${c.reviewIssues === 1 ? "" : "s"}`
      : null,
    c.followUps ? `${c.followUps} with follow-ups` : null,
  ].filter(Boolean).join(", ");
  return `${findings.length} finding${findings.length === 1 ? "" : "s"} on project ${shortProjectId(board.projectId)}${forkNote}: ${parts}.`;
}

// One-line bullet per finding for the list-all view. No footer —
// callers append a context-specific drill-down hint.
export function formatFindingsBullets(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `  - ${f.taskId} [${f.category}] ${f.title}${
          f.followUps.length > 0
            ? ` (${f.followUps.length} follow-up${f.followUps.length === 1 ? "" : "s"})`
            : ""
        }`,
    )
    .join("\n");
}

export function formatCompletionFindings(board: Board): string {
  const findings = collectFindings(board);
  if (findings.length === 0) return "";
  const truncate = truncateNotes;
  const sections: string[] = [];
  for (const f of findings) {
    const tag =
      f.category === "failed"
        ? "[!]"
        : f.kind === "distill"
          ? "[distill]"
          : f.kind === "review"
            ? `[${f.decision ?? "review"}]`
            : "[x]";
    const headSuffix =
      f.category === "failed"
        ? " — failed"
        : f.kind === "work" && f.summary
          ? ` — ${truncate(f.summary)}`
          : "";
    const lines = [`   ${tag} ${f.taskId}  ${f.title}${headSuffix}`];
    if (f.category === "failed" && f.summary) {
      lines.push(`       ${truncate(f.summary)}`);
    }
    if (f.kind === "distill" && f.distillReport) {
      const dr = f.distillReport;
      if (dr.summary) {
        lines.push(`       ${truncate(dr.summary)}`);
      }
      lines.push(`       recommended_action: ${dr.recommendedAction}`);
      if (dr.appliedWinner) {
        lines.push(`       applied_winner: ${dr.appliedWinner}`);
      }
      if (dr.reworkBrief) {
        lines.push(`       rework_brief: ${truncate(dr.reworkBrief)}`);
      }
      for (const df of dr.findings) {
        const srcs = df.sources.join(",");
        const line = `       • [${df.verdict}] ${df.claim} (sources: ${srcs})`;
        lines.push(truncate(line));
      }
      if (dr.unresolved && dr.unresolved.length > 0) {
        for (const u of dr.unresolved) {
          lines.push(`       ? ${u}`);
        }
      }
    }
    if (f.notes) {
      lines.push(`       ${truncate(f.notes).split("\n").join("\n       ")}`);
    }
    for (const fu of f.followUps) {
      lines.push(`       • ${fu}`);
    }
    sections.push(lines.join("\n"));
  }
  return `Findings:\n${sections.join("\n")}`;
}
