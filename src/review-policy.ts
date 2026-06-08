import type { Board } from "./board.js";

export interface ReviewPolicy {
  mode: "off" | "hints" | "all" | "high-only";
  overrideHint: boolean;
}

interface RawReviewPolicy {
  mode?: "off" | "hints" | "all" | "high-only";
  overrideHint?: boolean;
}

const DEFAULT_POLICY: ReviewPolicy = {
  mode: "hints",
  overrideHint: false,
};

// Normalize a board's reviewPolicy (which has optional properties) into
// a concrete ReviewPolicy with defaults applied. Returns undefined if the
// board has no reviewPolicy at all (so applyReviewPolicy can use its own
// default).
export function resolveReviewPolicy(raw: RawReviewPolicy | undefined): ReviewPolicy | undefined {
  if (!raw) return undefined;
  return { mode: raw.mode ?? "hints", overrideHint: raw.overrideHint ?? false };
}

// Walk a board's tasks and synthesize review tasks according to the given
// policy. Returns a new Board with review tasks appended — does not mutate
// the input board. Idempotent: if a review task already exists for a work
// task, no duplicate is created.
export function applyReviewPolicy(board: Board, policy?: ReviewPolicy): Board {
  const p = policy ?? DEFAULT_POLICY;

  if (p.mode === "off") {
    return board;
  }

  // Build a set of work-task ids that already have a corresponding review
  // task. Re-running on an already-processed board must not duplicate.
  const reviewedBy: Map<string, string> = new Map();
  for (const t of board.tasks) {
    if (t.kind === "review" && t.reviews) {
      const ids = Array.isArray(t.reviews) ? t.reviews : [t.reviews];
      for (const ref of ids) {
        reviewedBy.set(ref, t.id);
      }
    }
  }

  let changed = false;
  const tasks = [...board.tasks];

  for (const t of board.tasks) {
    // Only synthesize reviews for work tasks — skip review tasks, already-
    // reviewed tasks, and non-pending tasks (a task that's done/failed has
    // passed its review gate; awaiting_review already has one).
    if (t.kind !== "work" && t.kind !== undefined) continue;
    const alreadyReviewed = reviewedBy.has(t.id);
    if (alreadyReviewed) continue;
    if (t.status === "done" || t.status === "failed") continue;

    // Determine whether this task warrants a review under the current mode.
    const shouldReview = decideReview(t, p);
    if (!shouldReview) continue;

    // Synthesize a review task.
    // canApplyFixes defaults to true when runOn='orchestrator', false otherwise.
    tasks.push({
      id: `review-${t.id}`,
      title: `Review ${t.title}`,
      deps: [t.id],
      status: "pending",
      kind: "review",
      reviews: t.id,
      runOn: "orchestrator",
      canApplyFixes: true,
      attemptCount: 0,
    });
    reviewedBy.set(t.id, `review-${t.id}`);
    changed = true;
  }

  if (!changed) {
    return board;
  }

  return { ...board, tasks };
}

// Decide whether a work task warrants a synthesized review under the given
// policy. Pure boolean — no side effects.
function decideReview(task: { riskLevel?: string; reviewHint?: string }, policy: ReviewPolicy): boolean {
  const { mode } = policy;
  const hint = (task.reviewHint ?? "optional") as string;
  const risk = (task.riskLevel ?? "medium") as string;

  switch (mode) {
    case "all":
      return true;

    case "high-only":
      return risk === "high";

    case "hints":
      // honor the agent's reviewHint: skip → no, optional/recommended/required → yes.
      // overrideHint only matters when the hint says "skip" — if true, policy wins
      // and we still synthesize a review.
      if (hint === "skip") {
        return policy.overrideHint;
      }
      return true;

    case "off":
      return false;

    default:
      return false;
  }
}
