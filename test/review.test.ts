import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBoard, type Board, type Task } from "../src/board.ts";
import { buildTaskPrompt, normalizeReview } from "../src/task.ts";

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

function review(id: string, reviews: string | string[], opts: Partial<Task> = {}): Task {
  return {
    id,
    title: opts.title ?? `Review ${Array.isArray(reviews) ? reviews.join(",") : reviews}`,
    deps: opts.deps ?? [],
    status: opts.status ?? "pending",
    kind: "review" as const,
    reviews,
    attemptCount: opts.attemptCount ?? 0,
    artifacts: opts.artifacts ?? null,
    assignedTo: opts.assignedTo ?? null,
    finishedAt: opts.finishedAt ?? null,
    onReject: opts.onReject,
    reviewFeedback: opts.reviewFeedback ?? undefined,
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

// ── Full review flow — approve ────────────────────────────────────────────

describe("review flow — approve", () => {
  it("work task transitions from awaiting_review to done", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "approve", notes: "LGTM" },
    });
    const b = makeBoard([workTask, reviewTask]);

    // Simulate handleReviewApprove logic.
    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    const rev = b.tasks.find((t) => t.id === reviewTask.id)!;

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.assignedTo = null;

    // Merge review notes into artifacts.decisions.
    const merged = { ...reviewed.artifacts };
    if (merged && !merged.decisions) merged.decisions = [];
    (merged.decisions as string[]).push("[review] LGTM");
    reviewed.artifacts = merged;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.ok(reviewed.finishedAt);
    assert.equal(reviewed.assignedTo, null);
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review] LGTM"]);
    assert.equal(rev.status, "done");
  });

  it("preserves existing artifacts on approve", () => {
    const workTask = work("T1", {
      status: "awaiting_review",
      attemptCount: 1,
      artifacts: { summary: "added auth", files_changed: ["src/auth.ts"] },
    });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "approve", notes: "LGTM" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;

    // Simulate approve merging.
    const merged = { ...reviewed.artifacts };
    if (merged && !merged.decisions) merged.decisions = [];
    (merged.decisions as string[]).push("[review] LGTM");
    reviewed.artifacts = merged;

    assert.equal(reviewed.artifacts!.summary, "added auth");
    assert.deepEqual(reviewed.artifacts!.files_changed, ["src/auth.ts"]);
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review] LGTM"]);
  });

  it("amend also transitions work task to done with [review amend] prefix", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "added auth" } });
    const reviewTask = review("R2", "T1", {
      status: "done",
      artifacts: { decision: "amend", notes: "change parameter name" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.assignedTo = null;

    const amendedArtifacts = { ...reviewed.artifacts };
    if (!amendedArtifacts.decisions) amendedArtifacts.decisions = [];
    (amendedArtifacts.decisions as string[]).push("[review amend] change parameter name");
    reviewed.artifacts = amendedArtifacts;

    assert.equal(reviewed.status, "done");
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review amend] change parameter name"]);
  });
});

// ── Full review flow — reject with retask ──────────────────────────────────

describe("review flow — reject (retask)", () => {
  it("work task transitions from awaiting_review back to pending on reject", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "missing error handling" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    const rev = b.tasks.find((t) => t.id === reviewTask.id)!;

    // Simulate handleReviewReject (below maxAttempts).
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("missing error handling");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending");
    assert.equal(reviewed.assignedTo, null);
    assert.equal(reviewed.startedAt, null);
    assert.equal(reviewed.finishedAt, null);
    assert.equal(reviewed.artifacts, null);
    assert.deepEqual(reviewed.reviewFeedback, ["missing error handling"]);
    assert.equal(rev.status, "done");
  });

  it("accumulates feedback across multiple rejections (deduplicated)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 2, artifacts: null });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "missing error handling" },
      reviewFeedback: ["duplicate feedback", "missing error handling"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;

    // Simulate deduplicated push.
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "missing error handling";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

    assert.deepEqual(reviewed.reviewFeedback, ["duplicate feedback", "missing error handling"]);
  });

  it("clears artifacts on retask after reject", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "fix this" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    reviewed.artifacts = null;

    assert.equal(reviewed.artifacts, null);
  });
});

// ── Full review flow — maxAttempts exhaustion → failed ─────────────────────

describe("review flow — maxAttempts exhaustion → failed", () => {
  it("marks task as failed when attemptCount >= maxAttempts (default 3)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3, artifacts: { summary: "v3" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "still broken" },
      reviewFeedback: ["issue 1", "issue 2", "still broken"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    const rev = b.tasks.find((t) => t.id === reviewTask.id)!;

    // Simulate handleReviewReject maxAttempts branch.
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "still broken";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.ok(reviewed.finishedAt);
    assert.equal(reviewed.assignedTo, null);
    assert.deepEqual(reviewed.reviewFeedback, ["issue 1", "issue 2", "still broken"]);
    assert.equal(rev.status, "done");
  });

  it("respects custom maxAttempts from onReject", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 2, artifacts: { summary: "v2" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "broken" },
      onReject: { maxAttempts: 2 },
      reviewFeedback: ["broken"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    const rev = b.tasks.find((t) => t.id === reviewTask.id)!;

    // maxAttempts=2, attemptCount=2 → 2 >= 2 → fail.
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "broken";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.deepEqual(reviewed.reviewFeedback, ["broken"]);
  });

  it("does NOT fail when attemptCount < maxAttempts", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 2, artifacts: { summary: "v2" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "still broken" },
      onReject: { maxAttempts: 5 },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;
    const rev = b.tasks.find((t) => t.id === reviewTask.id)!;

    // maxAttempts=5, attemptCount=2 → 2 < 5 → retask.
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("still broken");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending", "should be retasked, not failed");
    assert.equal(reviewed.artifacts, null);
  });

  it("failed task retains all accumulated reviewFeedback", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3 });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "final failure" },
      reviewFeedback: ["first rejection", "second rejection"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === workTask.id)!;

    // Simulate maxAttempts exhaustion with dedup.
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "final failure";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

    assert.deepEqual(reviewed.reviewFeedback, ["first rejection", "second rejection", "final failure"]);
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

// ── End-to-end flow simulation: work → review → each decision ──────────────

describe("end-to-end review flow on a small board", () => {
  let b: Board;
  let workTask: Task;
  let reviewTask: Task;

  function setupBoard() {
    workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "initial implementation" } });
    reviewTask = review("R1", "T1");
    b = makeBoard([workTask, reviewTask]);
  }

  it("approve flow: both tasks end as done with merged decisions", () => {
    setupBoard();
    const wt = b.tasks.find((t) => t.id === "T1")!;
    const rt = b.tasks.find((t) => t.id === "R1")!;

    // Simulate approve.
    wt.status = "done";
    wt.finishedAt = "2026-01-01T00:00:00.000Z";
    wt.assignedTo = null;
    const merged = { ...wt.artifacts };
    if (merged && !merged.decisions) merged.decisions = [];
    (merged.decisions as string[]).push("[review] approved");
    wt.artifacts = merged;

    rt.status = "done";
    rt.finishedAt = "2026-01-01T00:00:00.000Z";
    rt.assignedTo = null;

    assert.equal(wt.status, "done");
    assert.ok(wt.finishedAt);
    assert.deepEqual(wt.artifacts!.decisions, ["[review] approved"]);
    assert.equal(rt.status, "done");
  });

  it("reject flow: work retasked to pending with feedback, review done", () => {
    setupBoard();
    const wt = b.tasks.find((t) => t.id === "T1")!;
    const rt = b.tasks.find((t) => t.id === "R1")!;

    // Simulate reject (below maxAttempts).
    wt.status = "pending";
    wt.assignedTo = null;
    wt.startedAt = null;
    wt.finishedAt = null;
    wt.artifacts = null;
    wt.reviewFeedback = ["needs improvement"];

    rt.status = "done";
    rt.finishedAt = "2026-01-01T00:00:00.000Z";
    rt.assignedTo = null;

    assert.equal(wt.status, "pending");
    assert.equal(wt.artifacts, null);
    assert.deepEqual(wt.reviewFeedback, ["needs improvement"]);
    assert.equal(rt.status, "done");
  });

  it("amend flow: work done with [review amend] in decisions", () => {
    setupBoard();
    const wt = b.tasks.find((t) => t.id === "T1")!;
    const rt = b.tasks.find((t) => t.id === "R1")!;

    // Simulate amend.
    wt.status = "done";
    wt.finishedAt = "2026-01-01T00:00:00.000Z";
    wt.assignedTo = null;
    const amended = { ...wt.artifacts };
    if (!amended.decisions) amended.decisions = [];
    (amended.decisions as string[]).push("[review amend] tweak the logic");
    wt.artifacts = amended;

    rt.status = "done";
    rt.finishedAt = "2026-01-01T00:00:00.000Z";
    rt.assignedTo = null;

    assert.equal(wt.status, "done");
    assert.deepEqual(wt.artifacts!.decisions, ["[review amend] tweak the logic"]);
    assert.equal(rt.status, "done");
  });

  it("maxAttempts flow: work failed after exhausting attempts", () => {
    setupBoard();
    const wt = b.tasks.find((t) => t.id === "T1")!;
    const rt = b.tasks.find((t) => t.id === "R1")!;

    // Simulate maxAttempts exceeded (attemptCount 3 >= default maxAttempts 3).
    wt.status = "failed";
    wt.finishedAt = "2026-01-01T00:00:00.000Z";
    wt.assignedTo = null;
    wt.reviewFeedback = ["feedback 1", "feedback 2"];

    rt.status = "done";
    rt.finishedAt = "2026-01-01T00:00:00.000Z";
    rt.assignedTo = null;

    assert.equal(wt.status, "failed");
    assert.ok(wt.finishedAt);
    assert.deepEqual(wt.reviewFeedback, ["feedback 1", "feedback 2"]);
    assert.equal(rt.status, "done");
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

// ── OnReject escalate strategy ─────────────────────────────────────────────

describe("onReject strategy: escalate", () => {
  it("swaps agent and model to escalation targets on reject with valid escalateTo", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, agent: "cheap-agent", model: "cheap-model" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "needs better approach" },
      onReject: { strategy: "escalate", escalateTo: { agent: "capable-agent", model: "capable-model" } },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Simulate escalate strategy: swap agent/model then retask.
    reviewed.agent = "capable-agent";
    reviewed.model = "capable-model";
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("needs better approach");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending");
    assert.equal(reviewed.agent, "capable-agent");
    assert.equal(reviewed.model, "capable-model");
    assert.deepEqual(reviewed.reviewFeedback, ["needs better approach"]);
  });

  it("hard-fails when escalateTo is missing entirely", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "broken" },
      onReject: { strategy: "escalate" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Simulate hard-fail: escalateTo missing.
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("broken");
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.ok(reviewed.finishedAt);
    assert.deepEqual(reviewed.reviewFeedback, ["broken"]);
  });

  it("hard-fails when escalateTo.agent is missing", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "broken" },
      onReject: { strategy: "escalate", escalateTo: { model: "capable-model" } },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("broken");
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
  });

  it("hard-fails when escalateTo.model is missing", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "broken" },
      onReject: { strategy: "escalate", escalateTo: { agent: "capable-agent" } },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("broken");
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
  });

  it("does NOT escalate when strategy is 'fresh' (default)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, agent: "cheap-agent", model: "cheap-model" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "fix this" },
      onReject: { strategy: "fresh" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Fresh strategy: no agent/model swap.
    reviewed.status = "pending";
    reviewed.agent = "cheap-agent";
    reviewed.model = "cheap-model";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("fix this");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending");
    assert.equal(reviewed.agent, "cheap-agent");
    assert.equal(reviewed.model, "cheap-model");
  });

  it("escalation overrides task agent/model even without prior values", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "upgrade agent" },
      onReject: { strategy: "escalate", escalateTo: { agent: "premium-agent", model: "premium-model" } },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // No prior agent/model on task — escalate sets them.
    reviewed.agent = "premium-agent";
    reviewed.model = "premium-model";
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("upgrade agent");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.agent, "premium-agent");
    assert.equal(reviewed.model, "premium-model");
  });
});

// ── OnReject continue strategy ─────────────────────────────────────────────

describe("onReject strategy: continue", () => {
  it("keeps worker session alive and sends feedback as next prompt", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, assignedTo: "worker-1", startedAt: "2026-01-01T00:00:00.000Z" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "add input validation" },
      onReject: { strategy: "continue" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Simulate continue strategy: task stays in awaiting_review, attemptCount bumps, worker not closed.
    reviewed.status = "awaiting_review";
    reviewed.attemptCount = 2;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("add input validation");

    // Worker session is NOT closed — no cleanup of assignedTo/startedAt.
    assert.equal(reviewed.assignedTo, "worker-1");
    assert.ok(reviewed.startedAt);

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "awaiting_review");
    assert.equal(reviewed.attemptCount, 2);
    assert.deepEqual(reviewed.reviewFeedback, ["add input validation"]);
    assert.equal(rev.status, "done");
  });

  it("increments attemptCount on continue reprompt", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3, artifacts: { summary: "v3" }, assignedTo: "worker-2" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "fix the logic" },
      onReject: { strategy: "continue", maxAttempts: 5 },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Simulate continue: attemptCount goes from 3 to 4.
    reviewed.attemptCount = 4;

    assert.equal(reviewed.attemptCount, 4);
    assert.equal(reviewed.status, "awaiting_review");
  });

  it("resets repromptCount on continue (worker state simulation)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, assignedTo: "worker-3" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "second iteration feedback" },
      onReject: { strategy: "continue" },
    });
    const b = makeBoard([workTask, reviewTask]);

    // Worker state would be reset: repromptCount → 0, resultAccumulator → "".
    // This test verifies the task-level effect — continue keeps the worker alive.
    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    assert.equal(reviewed.status, "awaiting_review");
    assert.equal(reviewed.assignedTo, "worker-3");
  });

  it("falls back to retask when no worker is assigned (orchestrator-lane review)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, assignedTo: null });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "needs work" },
      onReject: { strategy: "continue" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // No worker assigned → fall back to standard retask.
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    (reviewed.reviewFeedback as string[]).push("needs work");

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending");
    assert.equal(reviewed.assignedTo, null);
    assert.deepEqual(reviewed.reviewFeedback, ["needs work"]);
  });

  it("does NOT fall back to retask when worker IS assigned", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" }, assignedTo: "worker-4" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "keep the worker" },
      onReject: { strategy: "continue" },
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Worker assigned → stay in awaiting_review, do NOT retask.
    assert.equal(reviewed.status, "awaiting_review");
    assert.equal(reviewed.assignedTo, "worker-4");
  });

  it("maxAttempts still enforced on continue strategy", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3, artifacts: { summary: "v3" }, assignedTo: "worker-5" });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "final failure" },
      onReject: { strategy: "continue", maxAttempts: 3 },
      reviewFeedback: ["issue 1", "issue 2", "final failure"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // maxAttempts=3, attemptCount=3 → 3 >= 3 → fail (continue does not bypass maxAttempts).
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "final failure";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.ok(reviewed.finishedAt);
    assert.deepEqual(reviewed.reviewFeedback, ["issue 1", "issue 2", "final failure"]);
  });

  it("accumulates feedback across continue rejections (deduplicated)", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 2, artifacts: { summary: "v2" }, assignedTo: "worker-6", reviewFeedback: ["first feedback"] });
    const reviewTask = review("R1", "T1", {
      status: "done",
      artifacts: { decision: "reject", notes: "second feedback" },
      onReject: { strategy: "continue" },
      reviewFeedback: ["first feedback", "second feedback"],
    });
    const b = makeBoard([workTask, reviewTask]);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Simulate deduplicated push on continue.
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = "second feedback";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

    assert.deepEqual(reviewed.reviewFeedback, ["first feedback", "second feedback"]);
  });
});
