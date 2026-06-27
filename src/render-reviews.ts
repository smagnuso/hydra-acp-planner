// Shared helpers for rendering review tasks grouped by parent.
// Used by formatStatus (format.ts) and buildAsciiPlanText (plan-update.ts).

import type { Task } from "./board.js";

export interface ReviewTaskRenderOptions {
  indent: string;
  renderTaskTag?: (task: Task) => string;
  // When present, used to derive `awaiting_rework` display state for
  // review tasks whose reviewee has accumulated reviewFeedback from a
  // prior rejection.
  allTasks?: Task[];
}

// Derived display status for a review/distill task. Returns
// "awaiting_rework" when the review is pending again because it
// previously rejected its reviewee and the rework is in flight (or
// queued). Falls back to the stored status otherwise.
//
// Detection rule: review is `pending` AND at least one reviewee has
// non-empty reviewFeedback (the signal of a prior rejection that
// finishReview pushed onto the reviewee). reviewFeedback is only ever
// populated by handleReviewReject, so it's an unambiguous marker.
export function reviewDisplayStatus(task: Task, allTasks: Task[]): string {
  if (task.kind !== "review" && task.kind !== "distill") return task.status;
  if (task.status !== "pending") return task.status;
  const targets = reviewTargetsOf(task);
  if (targets.length === 0) return task.status;
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  for (const id of targets) {
    const target = byId.get(id);
    if (target?.reviewFeedback && target.reviewFeedback.length > 0) {
      return "awaiting_rework";
    }
  }
  return task.status;
}

// Render a single review or distill task (standalone, not under a parent).
// Returns the rendered line(s) and adds to renderedReviews set.
export function renderReviewTask(
  task: Task,
  renderedReviews: Set<string>,
  options: ReviewTaskRenderOptions,
): string {
  if (renderedReviews.has(task.id)) return "";

  const reviewTargets =
    typeof task.reviews === "string"
      ? [task.reviews]
      : Array.isArray(task.reviews)
        ? task.reviews
        : [];
  renderedReviews.add(task.id);

  const tag = options.renderTaskTag?.(task) ?? "";
  const displayStatus = options.allTasks
    ? reviewDisplayStatus(task, options.allTasks)
    : task.status;
  const glyph = TASK_GLYPH[displayStatus] ?? "?";

  if (task.kind === "distill") {
    return renderDistillTask(task, reviewTargets, glyph, tag, options.indent);
  }

  const isCompetition = reviewTargets.length > 1;
  const line = `${options.indent}${glyph} ${task.id}  ${task.title}${tag}`;
  const styledLine = isCompetition
    ? `${line}  reviewees: [${reviewTargets.join(", ")}]`
    : line;

  return applyStatusStyle(styledLine, task.status);
}

function renderDistillTask(
  task: Task,
  reviewTargets: string[],
  glyph: string,
  tag: string,
  indent: string,
): string {
  const sources = reviewTargets.join(", ");
  const header = `${indent}${glyph} ${task.id}  ${task.title}${tag}  Distilled from ${sources}`;
  const lines: string[] = [header];
  const childIndent = `${indent}    `;

  const a = (task.artifacts ?? {}) as Record<string, unknown>;
  const summary = typeof a.summary === "string" ? a.summary : null;
  if (summary) {
    lines.push(`${childIndent}summary: ${summary}`);
  }

  const findings = Array.isArray(a.findings)
    ? (a.findings as Array<Record<string, unknown>>)
    : [];
  if (findings.length > 0) {
    lines.push(`${childIndent}findings:`);
    for (const f of findings) {
      const claim = typeof f.claim === "string" ? f.claim : "";
      const fsources = Array.isArray(f.sources)
        ? (f.sources as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [];
      const verdict = typeof f.verdict === "string" ? ` (${f.verdict})` : "";
      lines.push(
        `${childIndent}  - ${claim}${verdict}  sources: [${fsources.join(", ")}]`,
      );
    }
  }

  const action =
    typeof a.recommended_action === "string" ? a.recommended_action : null;
  if (action) {
    lines.push(`${childIndent}recommended_action: ${action}`);
  }

  return applyStatusStyle(lines.join("\n"), task.status);
}

// Build a map from parent task id → array of single-reviewee review tasks that target it.
// Only single-reviewee review/distill tasks (the synthesized per-work-task reviews) are
// registered under a parent — these render NESTED under their reviewee. Multi-reviewee
// tasks (competition referees, multi-source distills) are NOT children of any single
// task; callers render them at peer level after all reviewees.
export function buildReviewsByParent(tasks: Task[]): Map<string, Task[]> {
  const reviewsByParent = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.kind !== "review" && t.kind !== "distill") continue;
    const reviewTargets =
      typeof t.reviews === "string"
        ? [t.reviews]
        : Array.isArray(t.reviews)
          ? t.reviews
          : [];
    if (reviewTargets.length !== 1) continue;
    const targetId = reviewTargets[0];
    if (typeof targetId !== "string") continue;
    const arr = reviewsByParent.get(targetId) ?? [];
    arr.push(t);
    reviewsByParent.set(targetId, arr);
  }
  return reviewsByParent;
}

// True if a task is a multi-reviewee review or distill (renders at peer level, not nested).
export function isMultiRevieweeReview(t: Task): boolean {
  if (t.kind !== "review" && t.kind !== "distill") return false;
  const targets =
    typeof t.reviews === "string"
      ? [t.reviews]
      : Array.isArray(t.reviews)
        ? t.reviews
        : [];
  return targets.length > 1;
}

// Reviewee ids for a review/distill task (normalized to string[]).
export function reviewTargetsOf(t: Task): string[] {
  return typeof t.reviews === "string"
    ? [t.reviews]
    : Array.isArray(t.reviews)
      ? t.reviews
      : [];
}

// Glyph lookup — shared so both callers stay in sync.
const TASK_GLYPH: Record<string, string> = {
  done: "[x]",
  assigned: "[~]",
  running: "[>]",
  failed: "[!]",
  blocked: "[-]",
  pending: "[ ]",
  awaiting_review: "[*]",
  awaiting_rework: "[+]",
  superseded: "(~)",
};

const ESC_STRIKETHROUGH = "\u{001B}[9m";
const ESC_RESET = "\u{001B}[0m";

function applyStatusStyle(text: string, status: string): string {
  if (status === "superseded") return `${ESC_STRIKETHROUGH}${text}${ESC_RESET}`;
  return text;
}
