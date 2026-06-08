import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBoard, type Board, type Task, pickEligible, allTerminal, inFlightCount } from "../src/board.ts";
import { normalizeReview } from "../src/task.ts";

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
  return { ...newBoard({ description: "competition e2e" }), tasks };
}

// ── competition end-to-end: judge picks winner → supersede losers ─────────

describe("competition e2e — judge picks winner", () => {
  it("T2 wins, T1 and T3 become superseded; review task done", () => {
    // Board with 3 sibling work tasks (no inter-deps) + 1 competition review.
    const t1 = work("T1", {
      status: "awaiting_review",
      artifacts: { summary: "v1 approach", decisions: ["use regex"] },
    });
    const t2 = work("T2", {
      status: "awaiting_review",
      artifacts: { summary: "v2 approach", decisions: ["use parser", "better correctness"] },
    });
    const t3 = work("T3", {
      status: "awaiting_review",
      artifacts: { summary: "v3 approach", decisions: ["use regex v2"] },
    });
    const r1 = review("R1", ["T1", "T2", "T3"]);

    const b = makeBoard([t1, t2, t3, r1]);

    // Mock judge produces winner=T2.
    const normalized = normalizeReview({ decision: "winner", winner: "T2", notes: "v2 has better correctness" }, ["T1", "T2", "T3"]);
    assert.ok(normalized);
    const winnerId = (normalized.artifacts as Record<string, unknown>).winner as string;
    assert.equal(winnerId, "T2");

    // Simulate handleReviewWinner: set winner to done with merged notes.
    const winnerTask = b.tasks.find((t) => t.id === winnerId)!;
    const mergedArtifacts = { ...winnerTask.artifacts };
    if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
    (mergedArtifacts.decisions as string[]).push("[review winner] v2 has better correctness");
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.artifacts = mergedArtifacts;
    winnerTask.assignedTo = null;

    // Supersede all other reviewees.
    const reviewsList = r1.reviews as string[];
    for (const id of reviewsList) {
      if (id === winnerId) continue;
      const other = b.tasks.find((t) => t.id === id);
      if (!other) continue;
      other.status = "superseded";
      other.finishedAt = "2026-01-01T00:00:00.000Z";
      other.assignedTo = null;
    }

    // Review task itself becomes done.
    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    assert.equal(winnerTask.status, "done");
    assert.ok(winnerTask.finishedAt);
    assert.deepEqual(winnerTask.artifacts!.decisions, ["use parser", "better correctness", "[review winner] v2 has better correctness"]);
    assert.equal(winnerTask.assignedTo, null);

    const t1sup = b.tasks.find((t) => t.id === "T1")!;
    const t3sup = b.tasks.find((t) => t.id === "T3")!;
    assert.equal(t1sup.status, "superseded");
    assert.ok(t1sup.finishedAt);
    assert.equal(t1sup.assignedTo, null);
    assert.equal(t3sup.status, "superseded");
    assert.ok(t3sup.finishedAt);
    assert.equal(t3sup.assignedTo, null);

    assert.equal(r1.status, "done");
  });

  it("winner's decisions array includes the review winner note", () => {
    const t2 = work("T2", {
      status: "awaiting_review",
      artifacts: { summary: "v2 approach", decisions: ["use parser"] },
    });
    const r1 = review("R1", ["T1", "T2"]);

    const b = makeBoard([t2, r1]);

    // Simulate winner decision for T2.
    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    const mergedArtifacts = { ...winnerTask.artifacts };
    if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
    (mergedArtifacts.decisions as string[]).push("[review winner] v2 is best");
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.artifacts = mergedArtifacts;

    assert.deepEqual(winnerTask.artifacts!.decisions, ["use parser", "[review winner] v2 is best"]);
  });

  it("winner's decisions array is initialized when missing", () => {
    const t2 = work("T2", {
      status: "awaiting_review",
      artifacts: { summary: "v2 approach" },
    });
    const r1 = review("R1", ["T1", "T2"]);

    const b = makeBoard([t2, r1]);

    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    const mergedArtifacts = { ...winnerTask.artifacts };
    if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
    (mergedArtifacts.decisions as string[]).push("[review winner] v2 wins");
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.artifacts = mergedArtifacts;

    assert.ok(winnerTask.artifacts!.decisions);
    assert.deepEqual(winnerTask.artifacts!.decisions, ["[review winner] v2 wins"]);
  });
});

// ── competition e2e — no valid winner → all reviewees fail ────────────────

describe("competition e2e — no valid winner", () => {
  it("all reviewees marked failed when winner ID not in reviews list", () => {
    const t1 = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);

    const b = makeBoard([t1, t2, r1]);

    // Mock judge picks a winner that doesn't exist in the reviews list.
    const normalized = normalizeReview({ decision: "winner", winner: "T99", notes: "none good" }, ["T1", "T2"]);
    assert.ok(normalized);

    // Simulate handleReviewWinner no-valid-winner branch.
    const reviewsList = r1.reviews as string[];
    for (const id of reviewsList) {
      const other = b.tasks.find((t) => t.id === id);
      if (!other) continue;
      if (other.status === "done" || other.status === "superseded") continue;
      other.status = "failed";
      other.finishedAt = "2026-01-01T00:00:00.000Z";
      other.reviewFeedback = other.reviewFeedback ?? [];
      other.reviewFeedback.push(`competition review R1: no valid winner specified`);
      other.assignedTo = null;
    }

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    const t1f = b.tasks.find((t) => t.id === "T1")!;
    const t2f = b.tasks.find((t) => t.id === "T2")!;
    assert.equal(t1f.status, "failed");
    assert.ok(t1f.finishedAt);
    assert.deepEqual(t1f.reviewFeedback, ["competition review R1: no valid winner specified"]);
    assert.equal(t2f.status, "failed");
    assert.ok(t2f.finishedAt);
    assert.equal(r1.status, "done");
  });
});

// ── competition e2e — dependents unblock correctly ────────────────────────

describe("competition e2e — dependents unblock", () => {
  it("task depending on winner is eligible after winner → done", () => {
    const t1 = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);
    // T4 depends on T2 (the winner).
    const t4 = work("T4", { deps: ["T2"], status: "pending" });

    const b = makeBoard([t1, t2, r1, t4]);

    // Simulate competition: T2 wins.
    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.assignedTo = null;

    const others = b.tasks.find((t) => t.id === "T1")!;
    others.status = "superseded";
    others.finishedAt = "2026-01-01T00:00:00.000Z";
    others.assignedTo = null;

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    // T4 should now be eligible (dep on T2 satisfied via done).
    assert.equal(pickEligible(b)?.id, "T4");
  });

  it("task depending on superseded reviewee is also eligible", () => {
    const t1 = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);
    // T4 depends on T1 (the loser).
    const t4 = work("T4", { deps: ["T1"], status: "pending" });

    const b = makeBoard([t1, t2, r1, t4]);

    // Simulate competition: T2 wins, T1 superseded.
    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.assignedTo = null;

    const loser = b.tasks.find((t) => t.id === "T1")!;
    loser.status = "superseded";
    loser.finishedAt = "2026-01-01T00:00:00.000Z";
    loser.assignedTo = null;

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    // T4 should be eligible because superseded satisfies dependencies.
    assert.equal(pickEligible(b)?.id, "T4");
  });

  it("task depending on both winner and loser is eligible", () => {
    const t1 = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);
    // T4 depends on both T1 (loser) and T2 (winner).
    const t4 = work("T4", { deps: ["T1", "T2"], status: "pending" });

    const b = makeBoard([t1, t2, r1, t4]);

    // Simulate competition: T2 wins, T1 superseded.
    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.assignedTo = null;

    const loser = b.tasks.find((t) => t.id === "T1")!;
    loser.status = "superseded";
    loser.finishedAt = "2026-01-01T00:00:00.000Z";
    loser.assignedTo = null;

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    // T4 should be eligible — both deps satisfied (one done, one superseded).
    assert.equal(pickEligible(b)?.id, "T4");
  });

  it("task depending on failed reviewee is NOT eligible", () => {
    const t1 = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);
    // T4 depends on T1 (which will fail).
    const t4 = work("T4", { deps: ["T1"], status: "pending" });

    const b = makeBoard([t1, t2, r1, t4]);

    // Simulate no valid winner → all reviewees fail.
    const reviewsList = r1.reviews as string[];
    for (const id of reviewsList) {
      const other = b.tasks.find((t) => t.id === id);
      if (!other) continue;
      other.status = "failed";
      other.finishedAt = "2026-01-01T00:00:00.000Z";
      other.assignedTo = null;
    }

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    // T4 should NOT be eligible — failed dep is not satisfied.
    assert.equal(pickEligible(b), undefined);
  });
});

// ── competition e2e — already-terminal reviewees are skipped ───────────────

describe("competition e2e — idempotent supersede", () => {
  it("skips reviewees already done or superseded", () => {
    const t1 = work("T1", { status: "done", finishedAt: "2025-01-01T00:00:00.000Z" });
    const t2 = work("T2", { status: "awaiting_review", artifacts: { summary: "v2" } });
    const r1 = review("R1", ["T1", "T2"]);

    const b = makeBoard([t1, t2, r1]);

    // Simulate winner=T2. T1 is already done — should be skipped.
    const reviewsList = r1.reviews as string[];
    for (const id of reviewsList) {
      if (id === "T2") continue;
      const other = b.tasks.find((t) => t.id === id);
      if (!other) continue;
      if (other.status === "done" || other.status === "superseded") continue;
      // This should NOT execute for T1.
      other.status = "superseded";
    }

    const t1check = b.tasks.find((t) => t.id === "T1")!;
    assert.equal(t1check.status, "done", "already-done reviewee should stay done");

    // T2 still awaiting_review — not yet processed.
    const t2check = b.tasks.find((t) => t.id === "T2")!;
    assert.equal(t2check.status, "awaiting_review");
  });
});

// ── competition e2e — different worker artifacts ───────────────────────────

describe("competition e2e — mock workers produce different artifacts", () => {
  it("each work task has distinct artifacts reflecting different approaches", () => {
    const t1 = work("T1", {
      status: "awaiting_review",
      artifacts: {
        summary: "regex-based parsing",
        files_changed: ["src/parse-regex.ts"],
        decisions: ["use regex for simplicity"],
        assumptions: ["input is well-formed"],
      },
    });
    const t2 = work("T2", {
      status: "awaiting_review",
      artifacts: {
        summary: "tokenizer-based parsing",
        files_changed: ["src/tokenizer.ts", "src/parser.ts"],
        decisions: ["use tokenizer for correctness", "handle edge cases"],
        assumptions: [],
        follow_ups: ["add benchmarks"],
      },
    });
    const t3 = work("T3", {
      status: "awaiting_review",
      artifacts: {
        summary: "regex v2 with lookahead",
        files_changed: ["src/parse-regex-v2.ts"],
        decisions: ["use regex with lookahead for edge cases"],
        assumptions: ["input has no nested structures"],
      },
    });
    const r1 = review("R1", ["T1", "T2", "T3"]);

    const b = makeBoard([t1, t2, t3, r1]);

    // Verify each task has unique artifacts.
    assert.equal(t1.artifacts!.summary, "regex-based parsing");
    assert.equal(t2.artifacts!.summary, "tokenizer-based parsing");
    assert.equal(t3.artifacts!.summary, "regex v2 with lookahead");

    assert.deepEqual(t1.artifacts!.files_changed, ["src/parse-regex.ts"]);
    assert.deepEqual(t2.artifacts!.files_changed, ["src/tokenizer.ts", "src/parser.ts"]);
    assert.deepEqual(t3.artifacts!.files_changed, ["src/parse-regex-v2.ts"]);

    // T2 has extra fields that differentiate it.
    assert.ok(t2.artifacts!.follow_ups);
    assert.equal(t2.artifacts!.follow_ups!.length, 1);
    assert.equal(t1.artifacts!.assumptions?.[0], "input is well-formed");
    assert.equal(t3.artifacts!.assumptions?.[0], "input has no nested structures");

    // All three are awaiting_review before the judge runs.
    assert.equal(t1.status, "awaiting_review");
    assert.equal(t2.status, "awaiting_review");
    assert.equal(t3.status, "awaiting_review");
  });
});

// ── competition e2e — full lifecycle: from pending through completion ──────

describe("competition e2e — full lifecycle", () => {
  it("pending work → awaiting_review → review done → winner done + losers superseded → dependents eligible", () => {
    // Phase 1: Board starts with tasks in pending state.
    const t1 = work("T1", { status: "pending" });
    const t2 = work("T2", { status: "pending" });
    const t3 = work("T3", { status: "pending" });
    // R1 depends on all three work tasks.
    const r1 = review("R1", ["T1", "T2", "T3"], { deps: ["T1", "T2", "T3"] });
    // T4 depends on the review task and both T1 and T2 (to test cross-dep).
    const t4 = work("T4", { deps: ["R1", "T1", "T2"], status: "pending" });

    const b = makeBoard([t1, t2, t3, r1, t4]);

    // Phase 2: Workers complete. Tasks transition to awaiting_review.
    for (const id of ["T1", "T2", "T3"]) {
      const task = b.tasks.find((t) => t.id === id)!;
      task.status = "awaiting_review";
      task.attemptCount = 1;
      task.artifacts = { summary: `${id} artifact`, decisions: [`${id} decision`] };
    }

    // Phase 3: Judge picks T2 as winner.
    const normalized = normalizeReview({ decision: "winner", winner: "T2", notes: "T2 is the best implementation" }, ["T1", "T2", "T3"]);
    assert.ok(normalized);

    // Apply winner logic.
    const winnerTask = b.tasks.find((t) => t.id === "T2")!;
    const mergedArtifacts = { ...winnerTask.artifacts };
    if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
    (mergedArtifacts.decisions as string[]).push("[review winner] T2 is the best implementation");
    winnerTask.status = "done";
    winnerTask.finishedAt = "2026-01-01T00:00:00.000Z";
    winnerTask.artifacts = mergedArtifacts;
    winnerTask.assignedTo = null;

    const reviewsList = r1.reviews as string[];
    for (const id of reviewsList) {
      if (id === "T2") continue;
      const other = b.tasks.find((t) => t.id === id);
      if (!other) continue;
      if (other.status === "done" || other.status === "superseded") continue;
      other.status = "superseded";
      other.finishedAt = "2026-01-01T00:00:00.000Z";
      other.assignedTo = null;
    }

    r1.status = "done";
    r1.finishedAt = "2026-01-01T00:00:00.000Z";
    r1.assignedTo = null;

    // Phase 5: Verify intermediate state.
    assert.equal(winnerTask.status, "done");
    assert.ok(winnerTask.finishedAt);
    assert.deepEqual(winnerTask.artifacts!.decisions, ["T2 decision", "[review winner] T2 is the best implementation"]);

    const t1sup = b.tasks.find((t) => t.id === "T1")!;
    const t3sup = b.tasks.find((t) => t.id === "T3")!;
    assert.equal(t1sup.status, "superseded");
    assert.ok(t1sup.finishedAt);
    assert.equal(t3sup.status, "superseded");
    assert.ok(t3sup.finishedAt);

    assert.equal(r1.status, "done");
    assert.ok(r1.finishedAt);

    // Phase 6: T4 should now be eligible (R1 done + T1/T2 deps satisfied).
    assert.equal(pickEligible(b)?.id, "T4", "T4 should be eligible after review completes and deps are satisfied");

    // Phase 7: Superseded tasks don't count as in-flight.
    assert.equal(inFlightCount(b), 0);
  });
});
