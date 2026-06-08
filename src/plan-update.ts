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

import type { Board, Task } from "./board.js";
import {
  buildAgentMessageChunkEnvelope,
  type UpdateEnvelope,
} from "./util/text.js";
import { shortProjectId } from "./board.js";

export type PlanRenderMode = "plan" | "ascii";

export function getPlanRenderMode(): PlanRenderMode {
  const v = (process.env.PLANNER_RENDER ?? "").toLowerCase();
  return v === "ascii" ? "ascii" : "plan";
}

// Map our internal TaskStatus → the ACP plan entry status enum.
// pending/blocked → "pending"; assigned → "in_progress"; done/failed
// → "completed". (ACP plan has no "failed" status; we surface failure
// in the entry's content text via a "[FAILED] " prefix.)
function mapStatus(task: Task): "pending" | "in_progress" | "completed" {
  if (task.status === "assigned") return "in_progress";
  if (task.status === "done" || task.status === "failed") return "completed";
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
  const entries = board.tasks.map((t) => {
    const failedPrefix = t.status === "failed" ? "[FAILED] " : "";
    const content = `${failedPrefix}${t.id}  ${t.title}`;
    return {
      content,
      priority: taskPriority(t, blockedByCount),
      status: mapStatus(t),
    };
  });
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
  awaiting_review: "\u{1F50D}",
  superseded: "(~)",
};

// ANSI escape sequences for inline styling. buildAsciiPlanText is a
// plain-text fallback, but strikethrough gives superseded items a clear
// visual "deleted" feel even in raw terminal output.
const ESC_STRIKETHROUGH = "\u{001B}[9m";  // strikethrough on
const ESC_RESET = "\u{001B}[0m";          // reset all attributes

function applyStatusStyle(text: string, status: string): string {
  if (status === "superseded") return `${ESC_STRIKETHROUGH}${text}${ESC_RESET}`;
  return text;
}

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

  const reviewsByParent = new Map<string, Task[]>();
  const renderedReviews = new Set<string>();
  for (const t of board.tasks) {
    if (t.kind !== "review") continue;
    const reviewTargets = typeof t.reviews === "string" ? [t.reviews] : Array.isArray(t.reviews) ? t.reviews : [];
    for (const targetId of reviewTargets) {
      const arr = reviewsByParent.get(targetId) ?? [];
      arr.push(t);
      reviewsByParent.set(targetId, arr);
    }
  }

  for (const t of board.tasks) {
    if (t.kind === "review") {
      if (renderedReviews.has(t.id)) continue;
      const reviewTargets = typeof t.reviews === "string" ? [t.reviews] : Array.isArray(t.reviews) ? t.reviews : [];
      const isCompetition = reviewTargets.length > 1;
      renderedReviews.add(t.id);
      const glyph = STATUS_GLYPH[t.status] ?? "?";
      const line = `    ${glyph} ${t.id}  ${t.title}`;
      const styledLine = isCompetition
        ? `${line}  reviewees: [${reviewTargets.join(", ")}]`
        : line;
      lines.push(applyStatusStyle(styledLine, t.status));
      continue;
    }
    const glyph = STATUS_GLYPH[t.status] ?? "?";
    lines.push(`  ${glyph} ${t.id}  ${t.title}`);
    const childReviews = reviewsByParent.get(t.id);
    if (childReviews) {
      for (const r of childReviews) {
        if (renderedReviews.has(r.id)) continue;
        renderedReviews.add(r.id);
        const reviewGlyph = STATUS_GLYPH[r.status] ?? "?";
        lines.push(applyStatusStyle(`    ${reviewGlyph} ${r.id}  ${r.title}`, r.status));
      }
    }
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
