import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeReview } from "../src/task.ts";

// Pure-function tests for parsing the "fix" review decision. The fix
// *flow* — canApplyFixes gating, retask-on-false, done-on-true,
// maxAttempts interaction — is covered by real integration tests in
// test/review-integration.test.ts (worker lane) and
// test/orchestrator-review-integration.test.ts (orchestrator lane),
// which drive PlannerBridge handlers and let production code mutate the
// board.

describe("normalizeReview — fix decision parsing", () => {
  it("extracts review_decision 'fix' with notes and applied flag", () => {
    const r = normalizeReview({ decision: "fix", notes: "patched auth flow", applied: true })!;
    assert.equal((r.artifacts as Record<string, unknown>).review_decision, "fix");
    assert.equal((r.artifacts as Record<string, unknown>).notes, "patched auth flow");
    assert.equal((r.artifacts as Record<string, unknown>).applied, true);
    assert.equal(r.artifacts.summary, "fix");
  });

  it("extracts applied=false when explicitly set", () => {
    const r = normalizeReview({ decision: "fix", notes: "deferred fix", applied: false })!;
    assert.equal((r.artifacts as Record<string, unknown>).applied, false);
  });

  it("omits applied key when not provided", () => {
    const r = normalizeReview({ decision: "fix", notes: "no flag" })!;
    assert.equal((r.artifacts as Record<string, unknown>).applied, undefined);
  });

  it("returns undefined for unrecognized decision (not 'fix')", () => {
    assert.equal(normalizeReview({ decision: "hold" as string, notes: "wait" }), undefined);
    assert.equal(normalizeReview({ decision: "approve" as string, notes: "ok" })!.artifacts.summary, "approve");
  });
});
