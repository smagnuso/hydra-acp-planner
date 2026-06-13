// Shared helpers for rendering review tasks grouped by parent.
// Used by formatStatus (format.ts) and buildAsciiPlanText (plan-update.ts).

import type { Task } from "./board.js";

export interface ReviewTaskRenderOptions {
  indent: string;
  renderTaskTag?: (task: Task) => string;
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
  const glyph = TASK_GLYPH[task.status] ?? "?";

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

// Build a map from parent task id → array of review/distill tasks that target it.
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
