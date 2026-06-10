import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBoard, type Board, type Task } from "../src/board.ts";
import { applyReviewPolicy, type ReviewPolicy } from "../src/review-policy.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function work(id: string, opts?: Partial<Task>): Task {
  return {
    id,
    title: `${id} task`,
    deps: opts?.deps ?? [],
    status: opts?.status ?? "pending",
    kind: opts?.kind ?? "work" as const,
    riskLevel: opts?.riskLevel,
    reviewHint: opts?.reviewHint,
    attemptCount: 0,
    ...opts,
  };
}

function review(id: string, reviews: string | string[], deps?: string[]): Task {
  return {
    id,
    title: `Review ${Array.isArray(reviews) ? reviews.join(",") : reviews}`,
    deps: deps ?? [],
    status: "pending" as const,
    kind: "review" as const,
    reviews,
    attemptCount: 0,
  };
}

function makeBoard(tasks: Task[]): Board {
  return { ...newBoard({ description: "test" }), tasks };
}

/** Count review tasks in a board. */
function reviewCount(b: Board): number {
  return b.tasks.filter((t) => t.kind === "review").length;
}

// ── table-driven cross-product tests ───────────────────────────────────────

describe("applyReviewPolicy — table-driven", () => {
  // Each row: [policy mode, reviewHint?, riskLevel?, overrideHint?, expected review count for a single pending work task]
  const matrix: Array<{
    mode: "off" | "hints" | "all" | "high-only";
    hint?: string;
    risk?: string;
    overrideHint: boolean;
    expectReviews: number;
    label: string;
  }> = [
    // --- mode: off (never synthesizes) ---
    { mode: "off",               overrideHint: false, expectReviews: 0, label: "off + no hint" },
    { mode: "off", hint: "skip", overrideHint: false, expectReviews: 0, label: "off + skip" },
    { mode: "off", hint: "optional", overrideHint: false, expectReviews: 0, label: "off + optional" },
    { mode: "off", hint: "recommended", overrideHint: false, expectReviews: 0, label: "off + recommended" },
    { mode: "off", hint: "required", overrideHint: false, expectReviews: 0, label: "off + required" },
    { mode: "off",               overrideHint: true,  expectReviews: 0, label: "off + overrideHint=true" },
    { mode: "off", hint: "skip", overrideHint: true,  expectReviews: 0, label: "off + skip + overrideHint=true" },

    // --- mode: all (always synthesizes for pending work tasks) ---
    { mode: "all",               overrideHint: false, expectReviews: 1, label: "all + no hint" },
    { mode: "all", hint: "skip", overrideHint: false, expectReviews: 1, label: "all + skip" },
    { mode: "all", hint: "optional", overrideHint: false, expectReviews: 1, label: "all + optional" },
    { mode: "all", hint: "recommended", overrideHint: false, expectReviews: 1, label: "all + recommended" },
    { mode: "all", hint: "required", overrideHint: false, expectReviews: 1, label: "all + required" },
    { mode: "all",               overrideHint: true,  expectReviews: 1, label: "all + overrideHint=true" },
    { mode: "all", hint: "skip", overrideHint: true,  expectReviews: 1, label: "all + skip + overrideHint=true" },

    // --- mode: high-only (synthesizes only when risk === "high") ---
    { mode: "high-only",               overrideHint: false, expectReviews: 0, label: "high-only + no hint (default medium)" },
    { mode: "high-only", hint: "skip", overrideHint: false, expectReviews: 0, label: "high-only + skip (medium)" },
    { mode: "high-only",               overrideHint: true,  expectReviews: 0, label: "high-only + no hint + overrideHint=true" },
    { mode: "high-only", risk: "high", hint: "skip", overrideHint: false, expectReviews: 1, label: "high-only + skip + high risk" },
    { mode: "high-only", risk: "high", hint: "optional", overrideHint: false, expectReviews: 1, label: "high-only + optional + high risk" },
    { mode: "high-only", risk: "high", hint: "required", overrideHint: false, expectReviews: 1, label: "high-only + required + high risk" },
    { mode: "high-only", risk: "high",               overrideHint: true,  expectReviews: 1, label: "high-only + high risk + overrideHint=true" },
    { mode: "high-only", risk: "low",  hint: "required", overrideHint: false, expectReviews: 0, label: "high-only + low risk (no review)" },

    // --- mode: hints (honors reviewHint; skip → no review unless overrideHint) ---
    { mode: "hints",               overrideHint: false, expectReviews: 1, label: "hints + no hint (defaults to optional)" },
    { mode: "hints", hint: "skip", overrideHint: false, expectReviews: 0, label: "hints + skip" },
    { mode: "hints", hint: "optional", overrideHint: false, expectReviews: 1, label: "hints + optional" },
    { mode: "hints", hint: "recommended", overrideHint: false, expectReviews: 1, label: "hints + recommended" },
    { mode: "hints", hint: "required", overrideHint: false, expectReviews: 1, label: "hints + required" },
    { mode: "hints",               overrideHint: true,  expectReviews: 1, label: "hints + no hint + overrideHint=true" },
    { mode: "hints", hint: "skip", overrideHint: true,  expectReviews: 1, label: "hints + skip + overrideHint=true (override)" },
    { mode: "hints", hint: "optional", overrideHint: true,  expectReviews: 1, label: "hints + optional + overrideHint=true" },
    { mode: "hints", hint: "required", overrideHint: true,  expectReviews: 1, label: "hints + required + overrideHint=true" },
  ];

  for (const row of matrix) {
    it(`mode=${row.mode} hint=${row.hint ?? "(default)"} risk=${row.risk ?? "(default)"} override=${row.overrideHint} → ${row.expectReviews} review(s)`, () => {
      const opts: Partial<Task> = {};
      if (row.hint !== undefined) opts.reviewHint = row.hint;
      if (row.risk !== undefined) opts.riskLevel = row.risk;

      const b = makeBoard([work("T1", opts)]);
      const result = applyReviewPolicy(b, { mode: row.mode, overrideHint: row.overrideHint });

      assert.equal(reviewCount(result), row.expectReviews, `[${row.label}] review count mismatch`);

      // Verify review task structure when one is expected.
      if (row.expectReviews > 0) {
        const rev = result.tasks.find((t) => t.kind === "review");
        assert.ok(rev, `[${row.label}] expected a review task but found none`);
        assert.equal(rev!.id, "review-T1", `[${row.label}] review id mismatch`);
        assert.equal(rev!.title, "Review T1 task", `[${row.label}] review title mismatch`);
        assert.deepEqual(rev!.deps, ["T1"], `[${row.label}] review deps mismatch`);
        assert.equal(rev!.status, "pending", `[${row.label}] review status mismatch`);
        assert.equal(rev!.kind, "review", `[${row.label}] review kind mismatch`);
        assert.equal(rev!.reviews, "T1", `[${row.label}] reviews field mismatch`);
        assert.equal(rev!.runOn, "orchestrator", `[${row.label}] runOn mismatch`);
        assert.equal(rev!.attemptCount, 0, `[${row.label}] attemptCount mismatch`);
      }
    });
  }

  // ── multi-task table-driven tests ──────────────────────────────────────

  it("hints mode: skip + optional + required in one board", () => {
    const b = makeBoard([
      work("T1", { reviewHint: "skip" }),
      work("T2", { reviewHint: "optional" }),
      work("T3", { reviewHint: "required" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "hints", overrideHint: false });
    assert.equal(reviewCount(result), 2);
    const ids = result.tasks.filter((t) => t.kind === "review").map((t) => t.id).sort();
    assert.deepEqual(ids, ["review-T2", "review-T3"]);
  });

  it("high-only mode: high + medium + low risk in one board", () => {
    const b = makeBoard([
      work("T1", { riskLevel: "high" }),
      work("T2", { riskLevel: "medium" }),
      work("T3", { riskLevel: "low" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "high-only", overrideHint: false });
    assert.equal(reviewCount(result), 1);
    const ids = result.tasks.filter((t) => t.kind === "review").map((t) => t.id);
    assert.deepEqual(ids, ["review-T1"]);
  });

  it("hints + overrideHint=true overrides all skip hints", () => {
    const b = makeBoard([
      work("T1", { reviewHint: "skip" }),
      work("T2", { reviewHint: "skip" }),
      work("T3", { reviewHint: "optional" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "hints", overrideHint: true });
    assert.equal(reviewCount(result), 3);
  });

  it("all mode ignores hint and risk — reviews every pending work task", () => {
    const b = makeBoard([
      work("T1", { reviewHint: "skip", riskLevel: "low" }),
      work("T2", { reviewHint: "optional", riskLevel: "high" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(reviewCount(result), 2);
  });

  it("off mode ignores hint and risk — no reviews synthesized", () => {
    const b = makeBoard([
      work("T1", { reviewHint: "required", riskLevel: "high" }),
      work("T2", { reviewHint: "skip", riskLevel: "low" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "off", overrideHint: true });
    assert.equal(reviewCount(result), 0);
  });

  // ── state-dependent table-driven tests ─────────────────────────────────

  it("status filter: done/failed never get reviews; awaiting_review does", () => {
    const b = makeBoard([
      work("T1", { status: "pending" }),
      work("T2", { status: "assigned" }),
      work("T3", { status: "awaiting_review" }),
      work("T4", { status: "done" }),
      work("T5", { status: "failed" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(reviewCount(result), 3); // T1, T2, T3 — not T4 or T5
  });

  it("status filter with hints mode: skip applies to all statuses correctly", () => {
    const b = makeBoard([
      work("T1", { status: "pending", reviewHint: "skip" }),
      work("T2", { status: "assigned", reviewHint: "required" }),
      work("T3", { status: "awaiting_review", reviewHint: "skip" }),
    ]);
    const result = applyReviewPolicy(b, { mode: "hints", overrideHint: false });
    // T1 skipped (hint=skip), T2 reviewed (hint=required), T3 skipped (hint=skip overrides awaiting_review status)
    assert.equal(reviewCount(result), 1);
    const ids = result.tasks.filter((t) => t.kind === "review").map((t) => t.id).sort();
    assert.deepEqual(ids, ["review-T2"]);
  });

  // ── idempotency table-driven tests ─────────────────────────────────────

  const idempotencyMatrix: Array<{
    mode: "off" | "hints" | "all" | "high-only";
    overrideHint: boolean;
    preExistingReviews: string[]; // work task ids that already have review tasks
    expectedAfterFirst: number;
    expectedAfterSecond: number;
  }> = [
    { mode: "off",               overrideHint: false, preExistingReviews: [],              expectedAfterFirst: 0, expectedAfterSecond: 0 },
    { mode: "off",               overrideHint: true,  preExistingReviews: [],              expectedAfterFirst: 0, expectedAfterSecond: 0 },
    { mode: "all",               overrideHint: false, preExistingReviews: [],              expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "all",               overrideHint: true,  preExistingReviews: [],              expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "all",               overrideHint: false, preExistingReviews: ["T1"],          expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "all",               overrideHint: true,  preExistingReviews: ["T1"],          expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "hints",             overrideHint: false, preExistingReviews: [],              expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "hints",             overrideHint: true,  preExistingReviews: [],              expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "hints",             overrideHint: false, preExistingReviews: ["T1"],          expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "high-only",         overrideHint: false, preExistingReviews: [],              expectedAfterFirst: 0, expectedAfterSecond: 0 },
    { mode: "high-only", risk: "high", overrideHint: false, preExistingReviews: [],      expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "high-only", risk: "high", overrideHint: false, preExistingReviews: ["T1"],  expectedAfterFirst: 1, expectedAfterSecond: 1 },
    { mode: "high-only", risk: "high", overrideHint: true,  preExistingReviews: [],      expectedAfterFirst: 1, expectedAfterSecond: 1 },
  ];

  for (const row of idempotencyMatrix) {
    it(`idempotent: mode=${row.mode} override=${row.overrideHint} preReviewed=[${row.preExistingReviews.join(",") || "(none)"}]`, () => {
      const opts: Partial<Task> = {};
      if ((row as any).risk) opts.riskLevel = (row as any).risk;

      // Build board with work task(s) and optionally pre-existing review tasks.
      const tasks: Task[] = [work("T1", opts)];
      for (const ref of row.preExistingReviews) {
        tasks.push(review(`review-${ref}`, ref));
      }
      const b = makeBoard(tasks);

      // First application.
      const first = applyReviewPolicy(b, { mode: row.mode, overrideHint: row.overrideHint });
      assert.equal(reviewCount(first), row.expectedAfterFirst, `[first] review count mismatch`);

      // Second application — must produce identical result.
      const second = applyReviewPolicy(first, { mode: row.mode, overrideHint: row.overrideHint });
      assert.equal(reviewCount(second), row.expectedAfterSecond, `[second] review count mismatch`);
      assert.deepEqual(
        first.tasks.map((t) => t.id).sort(),
        second.tasks.map((t) => t.id).sort(),
        `idempotency: task id sets differ between first and second application`,
      );
    });
  }

  // ── pure-function properties (no mutation, reference stability) ────────

  it("off mode returns the exact same board reference", () => {
    const b = makeBoard([work("T1")]);
    const result = applyReviewPolicy(b, { mode: "off", overrideHint: false });
    assert.strictEqual(result, b);
  });

  it("no-op (all reviews already present) returns the exact same board reference", () => {
    const b = makeBoard([work("T1"), review("review-T1", "T1")]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.strictEqual(result, b);
  });

  it("changing board is a shallow copy with new tasks array", () => {
    const b = makeBoard([work("T1")]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.notStrictEqual(result, b);
    assert.notStrictEqual(result.tasks, b.tasks);
    // Board-level metadata is preserved.
    b.description = "original";
    b.concurrencyCap = 5;
    const r2 = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(r2.description, "original");
    assert.equal(r2.concurrencyCap, 5);
  });

  it("input board is not mutated by any policy", () => {
    const b = makeBoard([work("T1")]);
    const originalLen = b.tasks.length;
    applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(b.tasks.length, originalLen);
  });

  // ── edge cases ─────────────────────────────────────────────────────────

  it("empty board is handled gracefully", () => {
    const b = makeBoard([]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(result.tasks.length, 0);
  });

  it("board with only review tasks is unchanged", () => {
    const b = makeBoard([review("review-A", "A"), review("review-B", "B")]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(result.tasks.length, 2);
  });

  it("default policy (no arg) is hints/overrideHint=false", () => {
    const b = makeBoard([
      work("T1"),           // no hint → defaults to optional → review synthesized
      work("T2", { reviewHint: "skip" }), // skip → no review
    ]);
    const result = applyReviewPolicy(b);
    assert.equal(reviewCount(result), 1);
    const ids = result.tasks.filter((t) => t.kind === "review").map((t) => t.id);
    assert.deepEqual(ids, ["review-T1"]);
  });

  it("undefined kind is treated as work", () => {
    const b = makeBoard([
      { id: "T1", title: "no kind", deps: [], status: "pending", attemptCount: 0 } as unknown as Task,
    ]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(reviewCount(result), 1);
  });

  it("tasks with dependencies get review tasks with correct deps", () => {
    const b = makeBoard([
      work("T1"),
      work("T2", { deps: ["T1"] }),
      work("T3", { deps: ["T2"] }),
    ]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    assert.equal(result.tasks.length, 6);
    for (const t of ["T1", "T2", "T3"]) {
      const rev = result.tasks.find((r) => r.id === `review-${t}`);
      assert.ok(rev);
      assert.deepEqual(rev!.deps, [t]);
    }
  });

  it("reviewAgent/reviewModel on a work task propagate to the synthesized review", () => {
    const b = makeBoard([
      work("T1", { reviewAgent: "security-expert", reviewModel: "opus" }),
      work("T2"),
    ]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    const r1 = result.tasks.find((t) => t.id === "review-T1")!;
    assert.equal(r1.agent, "security-expert");
    assert.equal(r1.model, "opus");
    const r2 = result.tasks.find((t) => t.id === "review-T2")!;
    assert.equal(r2.agent, undefined);
    assert.equal(r2.model, undefined);
  });

  it("synthesized reviews are appended in declaration order", () => {
    const b = makeBoard([work("T1"), work("T2"), work("T3")]);
    const result = applyReviewPolicy(b, { mode: "all", overrideHint: false });
    const positions = result.tasks.map((t) => ({ id: t.id, index: result.tasks.indexOf(t) }));
    const reviewPositions = positions.filter((x) => x.id.startsWith("review-"));
    assert.ok(reviewPositions[0]!.index < reviewPositions[1]!.index);
    assert.ok(reviewPositions[1]!.index < reviewPositions[2]!.index);
  });
});
