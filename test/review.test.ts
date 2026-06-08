import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBoard, type Board, type Task } from "../src/board.ts";
import { buildTaskPrompt, normalizeReview } from "../src/task.ts";

// Pure-function tests for the review parser and prompt builder. The
// review *flow* (approve/reject/amend/fix/escalate/continue/maxAttempts)
// is covered by real integration tests in test/review-integration.test.ts,
// which drive PlannerBridge.handleTaskComplete and let production code
// mutate board state — see that file rather than re-simulating the
// handlers here.

// ── helpers ────────────────────────────────────────────────────────────────

function work(id: string, opts: Partial<Task> = {}): Task {
  return {
    id,
    title: opts.title ?? `${id} task`,
    deps: opts.deps ?? [],
    status: opts.status ?? "pending",
    kind: "work" as const,
    attemptCount: opts.attemptCount ?? 0,
    reviewFeedback: opts.reviewFeedback ?? undefined,
    artifacts: opts.artifacts ?? undefined,
    assignedTo: opts.assignedTo ?? null,
    startedAt: opts.startedAt ?? null,
    finishedAt: opts.finishedAt ?? null,
    ...opts,
  };
}

function makeBoard(tasks: Task[]): Board {
  return { ...newBoard({ description: "test" }), tasks };
}

// ── normalizeReview — decision parsing ─────────────────────────────────────

describe("normalizeReview — decision parsing", () => {
  it("extracts review_decision 'approve' with notes", () => {
    const r = normalizeReview({ decision: "approve", notes: "LGTM, looks good" })!;
    assert.equal((r.artifacts as Record<string, unknown>).review_decision, "approve");
    assert.equal((r.artifacts as Record<string, unknown>).notes, "LGTM, looks good");
    assert.equal(r.artifacts.summary, "approve");
  });

  it("extracts review_decision 'reject' with notes", () => {
    const r = normalizeReview({ decision: "reject", notes: "tests are broken" })!;
    assert.equal((r.artifacts as Record<string, unknown>).review_decision, "reject");
    assert.equal((r.artifacts as Record<string, unknown>).notes, "tests are broken");
  });

  it("extracts review_decision 'amend' with notes", () => {
    const r = normalizeReview({ decision: "amend", notes: "rename the function" })!;
    assert.equal((r.artifacts as Record<string, unknown>).review_decision, "amend");
    assert.equal((r.artifacts as Record<string, unknown>).notes, "rename the function");
  });

  it("returns undefined for unrecognized decision", () => {
    assert.equal(normalizeReview({ decision: "hold" as string, notes: "wait" }), undefined);
  });

  it("returns undefined when decision field is missing", () => {
    assert.equal(normalizeReview({ notes: "no decision here" }), undefined);
  });

  it("treats empty notes as missing (warning), omits notes key from artifacts", () => {
    const r = normalizeReview({ decision: "approve", notes: "" })!;
    assert.equal((r.artifacts as Record<string, unknown>).notes, undefined);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /missing notes/);
  });

  it("omits notes key when absent from input", () => {
    const r = normalizeReview({ decision: "approve" })!;
    assert.equal((r.artifacts as Record<string, unknown>).notes, undefined);
  });
});

// ── reviewFeedback surfaced in buildTaskPrompt ─────────────────────────────

describe("reviewFeedback surfaced in buildTaskPrompt", () => {
  it("includes Previous attempt feedback section when attemptCount > 0 and reviewFeedback present", () => {
    const t = work("T1", {
      title: "Implement login",
      attemptCount: 2,
      reviewFeedback: ["Add input validation", "Handle edge cases"],
    });
    const p = buildTaskPrompt(t, makeBoard([t]));

    assert.match(p, /## Previous attempt feedback/);
    assert.match(p, /- Add input validation/);
    assert.match(p, /- Handle edge cases/);
  });

  it("omits Previous attempt feedback when attemptCount is 0", () => {
    const t = work("T1", {
      title: "Implement login",
      attemptCount: 0,
      reviewFeedback: ["some feedback"],
    });
    const p = buildTaskPrompt(t, makeBoard([t]));

    assert.doesNotMatch(p, /## Previous attempt feedback/);
  });

  it("omits Previous attempt feedback when reviewFeedback is empty", () => {
    const t = work("T1", {
      title: "Implement login",
      attemptCount: 2,
      reviewFeedback: [],
    });
    const p = buildTaskPrompt(t, makeBoard([t]));

    assert.doesNotMatch(p, /## Previous attempt feedback/);
  });

  it("omits Previous attempt feedback when reviewFeedback is undefined", () => {
    const t = work("T1", {
      title: "Implement login",
      attemptCount: 2,
    });
    const p = buildTaskPrompt(t, makeBoard([t]));

    assert.doesNotMatch(p, /## Previous attempt feedback/);
  });

  it("includes reviewFeedback section after dependency context", () => {
    const dep = work("T0", { status: "done", artifacts: { summary: "dep done" } });
    const t = work("T1", {
      title: "Implement login",
      deps: ["T0"],
      attemptCount: 1,
      reviewFeedback: ["fix the bug"],
    });
    const p = buildTaskPrompt(t, makeBoard([dep, t]));

    const depIdx = p.indexOf("## Context from completed dependencies");
    const fbIdx = p.indexOf("## Previous attempt feedback");
    assert.ok(depIdx >= 0, "should have context section");
    assert.ok(fbIdx >= 0, "should have feedback section");
    assert.ok(fbIdx > depIdx, "feedback should come after context");
  });

  it("surfaces multiple feedback entries as bullet points", () => {
    const t = work("T1", {
      title: "x",
      attemptCount: 3,
      reviewFeedback: ["first issue", "second issue", "third issue"],
    });
    const p = buildTaskPrompt(t, makeBoard([t]));

    assert.match(p, /- first issue/);
    assert.match(p, /- second issue/);
    assert.match(p, /- third issue/);
  });
});

// ── normalizeReview — notes extraction for handleReviewComplete path ───────

describe("normalizeReview — artifacts shape for handleReviewComplete", () => {
  it("stores review_decision and notes as artifact fields used by switch dispatch", () => {
    const r = normalizeReview({ decision: "reject", notes: "test failure details" })!;
    const art = r.artifacts as Record<string, unknown>;

    assert.equal(art.review_decision, "reject");
    assert.equal(art.notes, "test failure details");
  });

  it("stores review_decision and notes for amend decision", () => {
    const r = normalizeReview({ decision: "amend", notes: "change X to Y" })!;
    const art = r.artifacts as Record<string, unknown>;

    assert.equal(art.review_decision, "amend");
    assert.equal(art.notes, "change X to Y");
  });

  it("stores review_decision and notes for approve decision", () => {
    const r = normalizeReview({ decision: "approve", notes: "looks good" })!;
    const art = r.artifacts as Record<string, unknown>;

    assert.equal(art.review_decision, "approve");
    assert.equal(art.notes, "looks good");
  });
});
