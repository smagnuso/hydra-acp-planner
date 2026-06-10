import type { Board } from "./board.js";

export interface ReviewPolicy {
  mode: "off" | "hints" | "all" | "high-only";
  overrideHint: boolean;
  // Board-level default for the number of work-task attempts allowed
  // before a rejecting review marks the task `failed`. Applies to every
  // synthesized review unless the task carries its own
  // onReject.maxAttempts. Falls through to the hard-coded default in
  // handleReviewReject (currently 3) when unset.
  maxAttempts?: number;
}

interface RawReviewPolicy {
  mode?: "off" | "hints" | "all" | "high-only";
  overrideHint?: boolean;
  maxAttempts?: number;
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
  const out: ReviewPolicy = {
    mode: raw.mode ?? "hints",
    overrideHint: raw.overrideHint ?? false,
  };
  if (typeof raw.maxAttempts === "number" && Number.isFinite(raw.maxAttempts) && raw.maxAttempts > 0) {
    out.maxAttempts = Math.floor(raw.maxAttempts);
  }
  return out;
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
    //
    // Intentionally leave runOn and canApplyFixes UNSET so resolveReviewLane
    // can derive the lane at dispatch time from fleetDefaults.review.runOn /
    // .agent / .model and per-task reviewAgent / reviewModel. Hard-coding
    // runOn: "orchestrator" here would short-circuit resolveReviewLane's
    // "configured-agent" / "configured-model" rules and silently strand the
    // user's configured review agent/model on a lane that doesn't honor
    // them. canApplyFixes is derived at the fix-gate from the resolved
    // lane (orchestrator → allowed, worker → not allowed) unless the task
    // carries an explicit override.
    const synthesized: import("./board.js").Task = {
      id: `review-${t.id}`,
      title: `Review ${t.title}`,
      deps: [t.id],
      status: "pending",
      kind: "review",
      reviews: t.id,
      attemptCount: 0,
    };
    if (p.maxAttempts !== undefined) {
      synthesized.onReject = { maxAttempts: p.maxAttempts };
    }
    // Per-work-task review-agent/model overrides take precedence over
    // fleetDefaults.review.{agent,model} at resolve time. Copy them onto
    // the synthesized review's own agent/model so resolveAgent/resolveModel
    // (which check task.agent/task.model first) pick them up.
    if (t.reviewAgent) synthesized.agent = t.reviewAgent;
    if (t.reviewModel) synthesized.model = t.reviewModel;
    tasks.push(synthesized);
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
