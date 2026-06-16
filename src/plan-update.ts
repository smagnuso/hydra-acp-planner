// ACP plan session/update envelope + ASCII fallback for rendering the
// board as a live, in-place-updating panel inside the held turn.
//
// ACP defines a `plan` sessionUpdate kind whose `entries` array lists
// checklist items with priority + status. Spec-compliant clients (Zed,
// modern hydra TUI) render this as a self-updating panel anchored to
// the active turn; successive `plan` updates replace the panel in
// place rather than appending.
//
// We provide an ASCII fallback for clients that don't render plan
// updates well (or at all) outside of an agent's own turn — emit the
// same checklist as an agent_message_chunk with an ASCII rule header
// so successive emits visually separate. The env var PLANNER_RENDER
// controls which path is used (default `plan`, `ascii` for the
// fallback). Both paths take the same Board and produce conceptually
// identical content; the wire shape is the only difference, so we
// can flip without retesting board logic.

import type { Board, Task, WorkerSubtodo } from "./board.js";
import {
  buildAgentMessageChunkEnvelope,
  type UpdateEnvelope,
} from "./util/text.js";
import { shortProjectId } from "./board.js";
import { formatTaskTag } from "./format.js";
import {
  buildReviewsByParent,
  isMultiRevieweeReview,
  renderReviewTask,
  reviewTargetsOf,
} from "./render-reviews.js";

// Maximum number of a worker's incomplete subtodos to surface in the
// orchestrator's merged plan panel. Caps growth: 3 workers × this many
// is the worst-case extra row count beyond the task list. Tunable via
// PLANNER_WORKER_SUBTODO_CAP env var; default 3 trades peek-ahead value
// against panel real estate on a 30-row terminal.
export function workerSubtodoCap(): number {
  const raw = process.env.PLANNER_WORKER_SUBTODO_CAP;
  if (raw === undefined || raw === "") return 3;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 3;
  return n;
}

// Normalize a raw entries array (from an ACP plan envelope or a
// TodoWrite tool input) into our internal WorkerSubtodo shape.
// Tolerates missing/extra fields: unknown statuses collapse to
// "pending", non-string content is dropped. Returns [] for non-array
// input so callers can pass straight through without pre-checking.
export function normalizeSubtodoEntries(raw: unknown): WorkerSubtodo[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkerSubtodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { content?: unknown; status?: unknown };
    if (typeof obj.content !== "string") continue;
    const status =
      obj.status === "in_progress" || obj.status === "completed"
        ? obj.status
        : "pending";
    out.push({ content: obj.content, status });
  }
  return out;
}

// Pick the first N incomplete subtodos in worker-emit order. Completed
// items drop off so the panel always shows what's NEXT, never what was
// — the tool-call stream already covered completed work. Returns
// {visible, hiddenCount} so the renderer can show a "… +N more" hint
// when truncated.
export function pickVisibleSubtodos(
  subtodos: WorkerSubtodo[] | undefined,
  cap: number,
): { visible: WorkerSubtodo[]; hiddenCount: number } {
  if (!subtodos || subtodos.length === 0 || cap === 0) {
    return { visible: [], hiddenCount: 0 };
  }
  const incomplete = subtodos.filter((s) => s.status !== "completed");
  if (incomplete.length <= cap) {
    return { visible: incomplete, hiddenCount: 0 };
  }
  return {
    visible: incomplete.slice(0, cap),
    hiddenCount: incomplete.length - cap,
  };
}

export type PlanRenderMode = "plan" | "ascii";

export function getPlanRenderMode(): PlanRenderMode {
  const v = (process.env.PLANNER_RENDER ?? "").toLowerCase();
  return v === "ascii" ? "ascii" : "plan";
}

// Map our internal TaskStatus → the ACP plan entry status enum.
// assigned and awaiting_review → "in_progress" (the task is mid-cycle
// even when awaiting_review — the work just finished and a review is
// queued behind it; the user expects the todo to show it as active,
// not pending); done/failed/superseded → "completed"; pending/blocked
// → "pending". (ACP plan has no "failed" status; we surface failure
// in the entry's content text via a "[FAILED] " prefix.)
function mapStatus(task: Task): "pending" | "in_progress" | "completed" {
  if (task.status === "assigned" || task.status === "awaiting_review") return "in_progress";
  if (task.status === "done" || task.status === "failed" || task.status === "superseded") return "completed";
  return "pending";
}

// Priority hint. We don't have a real priority on tasks today, so this
// is a simple rule of thumb: tasks with no dependencies are "high"
// (they're the project's entry points), tasks blocking many others are
// "high", everything else is "medium". Spec-compliant clients use
// priority for visual emphasis only.
function taskPriority(task: Task, blockedByCount: Map<string, number>): "high" | "medium" | "low" {
  const dependents = blockedByCount.get(task.id) ?? 0;
  if (task.deps.length === 0 || dependents >= 2) return "high";
  return "medium";
}

// Build a plan session/update envelope from the board's task list.
// Suitable for `hydra-acp/message/emit` with method:"session/update"
// and route:"chain". The daemon broadcasts plan updates via the same
// recordAndBroadcast pipeline as agent_message_chunk, so attached
// clients receive them with the in-flight turn id and group them
// under that turn's UI region.
export function buildPlanUpdateEnvelope(opts: {
  sessionId: string;
  board: Board;
}): UpdateEnvelope {
  const board = opts.board;
  // Pre-compute dependent counts so taskPriority is O(1) per task.
  const blockedByCount = new Map<string, number>();
  for (const t of board.tasks) {
    for (const dep of t.deps) {
      blockedByCount.set(dep, (blockedByCount.get(dep) ?? 0) + 1);
    }
  }
  const cap = workerSubtodoCap();
  // Pre-index: for each assigned task, the worker session id running it.
  // Lets us look up subtodos by task without scanning board.workers each time.
  const workerByTask = new Map<string, string>();
  for (const [wid, w] of Object.entries(board.workers)) {
    if (w.currentTaskId) workerByTask.set(w.currentTaskId, wid);
  }
  const entries: { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }[] = [];
  for (const t of board.tasks) {
    const failedPrefix = t.status === "failed" ? "[FAILED] " : "";
    entries.push({
      content: `${failedPrefix}${t.id}  ${t.title}${formatTaskTag(t, board)}`,
      priority: taskPriority(t, blockedByCount),
      status: mapStatus(t),
    });
    if (t.status !== "assigned") continue;
    const wid = workerByTask.get(t.id);
    if (!wid) continue;
    const subtodos = board.workers[wid]?.subtodos;
    const { visible, hiddenCount } = pickVisibleSubtodos(subtodos, cap);
    for (const s of visible) {
      entries.push({
        content: `    \u21B3 ${s.content}`,
        priority: "low",
        status: s.status,
      });
    }
    if (hiddenCount > 0) {
      entries.push({
        content: `    \u2026 +${hiddenCount} more`,
        priority: "low",
        status: "pending",
      });
    }
  }
  return {
    sessionId: opts.sessionId,
    update: {
      sessionUpdate: "plan",
      entries,
    },
  };
}

const STATUS_GLYPH: Record<string, string> = {
  done: "[x]",
  assigned: "[~]",
  failed: "[!]",
  blocked: "[-]",
  pending: "[ ]",
  awaiting_review: "[*]",
  awaiting_rework: "[+]",
  superseded: "(~)",
};

// Render the board as an ASCII checklist with a leading rule and a
// summary count, suitable for emitting as an agent_message_chunk in
// clients that don't render ACP `plan` updates well. The leading
// horizontal rule + summary header gives successive emits a clean
// visual separator so the user can see the most recent panel without
// having to scroll back.
export function buildAsciiPlanText(board: Board): string {
  const lines: string[] = [];
  const done = board.tasks.filter((t) => t.status === "done").length;
  const failed = board.tasks.filter((t) => t.status === "failed").length;
  const inFlight = board.tasks.filter((t) => t.status === "assigned").length;
  const counts: string[] = [
    `${done}/${board.tasks.length} done`,
  ];
  if (inFlight > 0) counts.push(`${inFlight} running`);
  if (failed > 0) counts.push(`${failed} failed`);
  lines.push(`── ${shortProjectId(board.projectId)} (${board.state}) — ${counts.join(", ")} ──`);

  const reviewsByParent = buildReviewsByParent(board.tasks);
  const renderedReviews = new Set<string>();

  const tagFor = (t: Task) => formatTaskTag(t, board);
  const cap = workerSubtodoCap();
  const workerByTask = new Map<string, string>();
  for (const [wid, w] of Object.entries(board.workers)) {
    if (w.currentTaskId) workerByTask.set(w.currentTaskId, wid);
  }
  const renderedTaskIds = new Set<string>();
  const pendingPeerReviews: Task[] = [];
  const flushPendingPeers = () => {
    for (let i = pendingPeerReviews.length - 1; i >= 0; i--) {
      const pt = pendingPeerReviews[i];
      if (!pt) continue;
      const targets = reviewTargetsOf(pt);
      if (targets.every((id) => renderedTaskIds.has(id))) {
        const line = renderReviewTask(pt, renderedReviews, { indent: "  ", renderTaskTag: tagFor, allTasks: board.tasks });
        if (line) lines.push(line);
        pendingPeerReviews.splice(i, 1);
      }
    }
  };
  for (const t of board.tasks) {
    if (t.kind === "review" || t.kind === "distill") {
      if (isMultiRevieweeReview(t)) {
        pendingPeerReviews.push(t);
        flushPendingPeers();
      }
      continue;
    }
    const glyph = STATUS_GLYPH[t.status] ?? "?";
    lines.push(`  ${glyph} ${t.id}  ${t.title}${tagFor(t)}`);
    renderedTaskIds.add(t.id);
    if (t.status === "assigned") {
      const wid = workerByTask.get(t.id);
      const subtodos = wid ? board.workers[wid]?.subtodos : undefined;
      const { visible, hiddenCount } = pickVisibleSubtodos(subtodos, cap);
      for (const s of visible) {
        const subGlyph = s.status === "in_progress" ? "\u22EF" : s.status === "completed" ? "\u2713" : "\u00B7";
        lines.push(`      ${subGlyph} ${s.content}`);
      }
      if (hiddenCount > 0) {
        lines.push(`      \u2026 +${hiddenCount} more`);
      }
    }
    const childReviews = reviewsByParent.get(t.id);
    if (childReviews) {
      for (const r of childReviews) {
        const line = renderReviewTask(r, renderedReviews, { indent: "    ", renderTaskTag: tagFor, allTasks: board.tasks });
        if (line) lines.push(line);
      }
    }
    flushPendingPeers();
  }
  for (const pt of pendingPeerReviews) {
    const line = renderReviewTask(pt, renderedReviews, { indent: "  ", renderTaskTag: tagFor, allTasks: board.tasks });
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

// Build the ASCII fallback as an agent_message_chunk envelope.
export function buildAsciiPlanEnvelope(opts: {
  sessionId: string;
  board: Board;
}): UpdateEnvelope {
  return buildAgentMessageChunkEnvelope({
    sessionId: opts.sessionId,
    text: `\n${buildAsciiPlanText(opts.board)}\n`,
  });
}
