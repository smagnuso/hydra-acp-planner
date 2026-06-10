// Shared helpers for rendering review tasks grouped by parent.
// Used by formatStatus (format.ts) and buildAsciiPlanText (plan-update.ts).

import type { Task } from "./board.js";

export interface ReviewTaskRenderOptions {
  indent: string;
  renderTaskTag?: (task: Task) => string;
}

// Render a single review task (standalone, not under a parent).
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
  const isCompetition = reviewTargets.length > 1;
  renderedReviews.add(task.id);

  const tag = options.renderTaskTag?.(task) ?? "";
  const line = `${options.indent}${TASK_GLYPH[task.status] ?? "?"} ${task.id}  ${task.title}${tag}`;
  const styledLine = isCompetition
    ? `${line}  reviewees: [${reviewTargets.join(", ")}]`
    : line;

  return applyStatusStyle(styledLine, task.status);
}

// Build a map from parent task id → array of review tasks that target it.
export function buildReviewsByParent(tasks: Task[]): Map<string, Task[]> {
  const reviewsByParent = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.kind !== "review") continue;
    const reviewTargets =
      typeof t.reviews === "string"
        ? [t.reviews]
        : Array.isArray(t.reviews)
          ? t.reviews
          : [];
    for (const targetId of reviewTargets) {
      const arr = reviewsByParent.get(targetId) ?? [];
      arr.push(t);
      reviewsByParent.set(targetId, arr);
    }
  }
  return reviewsByParent;
}

// Glyph lookup — shared so both callers stay in sync.
const TASK_GLYPH: Record<string, string> = {
  done: "[x]",
  assigned: "[~]",
  failed: "[!]",
  blocked: "[-]",
  pending: "[ ]",
  awaiting_review: "[*]",
  superseded: "(~)",
};

const ESC_STRIKETHROUGH = "\u{001B}[9m";
const ESC_RESET = "\u{001B}[0m";

function applyStatusStyle(text: string, status: string): string {
  if (status === "superseded") return `${ESC_STRIKETHROUGH}${text}${ESC_RESET}`;
  return text;
}
