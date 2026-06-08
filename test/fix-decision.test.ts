import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newBoard, type Board, type Task } from "../src/board.ts";
import { normalizeReview, extractReviewBlock } from "../src/task.ts";
import {
  setOrchestratorState,
  getOrchestratorState,
  clearOrchestratorState,
  type OrchestratorState,
} from "../src/state.ts";

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

const ORCH_ID = "hydra_session_fix_test";

function setOrchState(opts: Partial<OrchestratorState> = {}): OrchestratorState {
  const state: OrchestratorState = {
    projectId: "hydra_plan_xyz",
    decompositionAccumulator: "",
    awaitingDecomposition: false,
    addAccumulator: "",
    awaitingAdd: false,
    awaitingOrchestratorReview: false,
    orchestratorReviewTaskId: null,
    orchestratorReviewAccumulator: "",
    ...opts,
  };
  setOrchestratorState(ORCH_ID, state);
  return state;
}

// ── Fix decision with applied=true on orchestrator-lane review ─────────────

describe("fix decision — applied=true on orchestrator-lane", () => {
  it("reviewed task transitions from awaiting_review to done with [review fix] in decisions", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── Accumulate chunks ──
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "patched the auth flow", "applied": true }',
      "\n```",
    ].join("");

    // ── Parse ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.ok(result, "should have parsed a valid fix review");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // ── handleReviewComplete: fix path with applied=true ──
    // Merge reviewer notes into artifacts.decisions.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const reviewNotes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (reviewNotes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${reviewNotes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.ok(reviewed.finishedAt);
    assert.equal(reviewed.assignedTo, null);
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review fix] patched the auth flow"]);
    assert.equal(rev.status, "done");
  });

  it("no retask occurs — task stays done after fix", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 2, artifacts: { summary: "attempt 2" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "quick fix applied", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse fix review");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Simulate fix path.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${notes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    // CRITICAL: the task must NOT go back to pending (no retask).
    assert.equal(reviewed.status, "done", "task should be done, not retasked");
    assert.ok(reviewed.finishedAt, "finishedAt should be set");
    assert.equal(reviewed.assignedTo, null);
    assert.equal(rev.status, "done", "review task should also be done");
  });

  it("preserves existing artifacts on fix with applied=true", () => {
    const workTask = work("T1", {
      status: "awaiting_review",
      artifacts: { summary: "added auth", files_changed: ["src/auth.ts"], decisions: ["use bcrypt"] },
    });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "added salt rounds config", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse fix review");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Simulate fix path.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${notes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;

    assert.equal(reviewed.artifacts!.summary, "added auth");
    assert.deepEqual(reviewed.artifacts!.files_changed, ["src/auth.ts"]);
    assert.deepEqual(reviewed.artifacts!.decisions, ["use bcrypt", "[review fix] added salt rounds config"]);
  });

  it("fix with applied=true but no notes still marks task done", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse fix review even without notes");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = { ...(reviewed.artifacts ?? {}) };
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.ok(reviewed.finishedAt);
  });

  it("fix with applied=false still marks task done (applied flag is informational)", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "will apply later", "applied": false }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse fix review with applied=false");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // The fix decision still marks done regardless of applied flag.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${notes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done", "task should be done even with applied=false");
    assert.ok(reviewed.finishedAt);
  });
});

// ── canApplyFixes=false fallback to reject ────────────────────────────────

describe("fix decision — canApplyFixes=false falls back to reject", () => {
  it("work task retasked to pending when canApplyFixes=false", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", { canApplyFixes: false });
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "would patch this", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse fix review");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // ── canApplyFixes=false gate triggers reject path ──
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = [];
    const fb = "fix decision not permitted on this review lane (canApplyFixes=false)";
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "pending", "task should be retasked, not done");
    assert.equal(reviewed.artifacts, null);
    assert.deepEqual(reviewed.reviewFeedback, [fb]);
    assert.equal(rev.status, "done");
  });

  it("canApplyFixes=false rejects even when applied=true", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", { canApplyFixes: false });
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "auto-fixed", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Even with applied=true, the canApplyFixes=false gate rejects.
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = ["fix decision not permitted on this review lane (canApplyFixes=false)"];

    assert.equal(reviewed.status, "pending", "task should be retasked regardless of applied flag");
    assert.equal(reviewed.finishedAt, null, "finishedAt should be cleared on reject");
  });

  it("canApplyFixes=true allows fix (positive control)", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1", { canApplyFixes: true });
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "applied directly", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // canApplyFixes=true → fix path succeeds.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${notes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review fix] applied directly"]);
  });

  it("undefined canApplyFixes defaults to orchestrator lane (fix allowed)", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    // No canApplyFixes set — defaults to true for orchestrator-lane reviews.
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "default allowed", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // canApplyFixes is undefined → not === false → fix allowed.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review fix] ${notes}`);
    }

    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review fix] default allowed"]);
  });

  it("canApplyFixes=false with maxAttempts exhaustion → failed", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3, artifacts: { summary: "v3" } });
    const reviewTask = review("R1", "T1", { canApplyFixes: false });
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "would fix", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // canApplyFixes=false triggers reject, and attemptCount=3 >= maxAttempts(3) → fail.
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = ["fix decision not permitted on this review lane (canApplyFixes=false)"];
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.ok(reviewed.finishedAt);
  });
});

// ── Fix decision in normalized review result ───────────────────────────────

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

// ── Full end-to-end: fix vs reject comparison on same board ────────────────

describe("fix vs reject — side-by-side behavior", () => {
  it("fix with canApplyFixes=true → done; reject → pending", () => {
    const fixWork = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const fixReview = review("R1", "T1", { canApplyFixes: true });

    const rejectWork = work("T2", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const rejectReview = review("R2", "T2");

    const b = makeBoard([fixWork, fixReview, rejectWork, rejectReview]);

    // Simulate fix path.
    const fw = b.tasks.find((t) => t.id === "T1")!;
    const fr = b.tasks.find((t) => t.id === "R1")!;
    fw.status = "done";
    fw.finishedAt = "2026-01-01T00:00:00.000Z";
    fw.assignedTo = null;
    const fixMerged = { ...(fw.artifacts ?? {}) };
    fixMerged.decisions = ["[review fix] auto-patched"];
    fw.artifacts = fixMerged;
    fr.status = "done";
    fr.finishedAt = "2026-01-01T00:00:00.000Z";
    fr.assignedTo = null;

    // Simulate reject path.
    const rw = b.tasks.find((t) => t.id === "T2")!;
    const rr = b.tasks.find((t) => t.id === "R2")!;
    rw.status = "pending";
    rw.assignedTo = null;
    rw.startedAt = null;
    rw.finishedAt = null;
    rw.artifacts = null;
    rw.reviewFeedback = ["needs improvement"];
    rr.status = "done";
    rr.finishedAt = "2026-01-01T00:00:00.000Z";
    rr.assignedTo = null;

    // Fix → done, Reject → pending. Same review task status (done).
    assert.equal(fw.status, "done");
    assert.ok(fw.finishedAt);
    assert.equal(rw.status, "pending");
    assert.equal(rw.finishedAt, null);
    assert.equal(fr.status, "done");
    assert.equal(rr.status, "done");
  });

  it("fix with canApplyFixes=false behaves like reject (retask)", () => {
    const fixAllowed = work("T1", { status: "awaiting_review", artifacts: { summary: "v1" } });
    const fixReviewOk = review("R1", "T1", { canApplyFixes: true });

    const fixBlocked = work("T2", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const fixReviewNo = review("R2", "T2", { canApplyFixes: false });

    const b = makeBoard([fixAllowed, fixReviewOk, fixBlocked, fixReviewNo]);

    // Fix allowed → done.
    const fw = b.tasks.find((t) => t.id === "T1")!;
    const fr = b.tasks.find((t) => t.id === "R1")!;
    fw.status = "done";
    fw.finishedAt = "2026-01-01T00:00:00.000Z";
    fw.assignedTo = null;
    const mergedOk = { ...(fw.artifacts ?? {}) };
    mergedOk.decisions = ["[review fix] ok"];
    fw.artifacts = mergedOk;
    fr.status = "done";
    fr.finishedAt = "2026-01-01T00:00:00.000Z";
    fr.assignedTo = null;

    // Fix blocked → pending (same as reject).
    const fbw = b.tasks.find((t) => t.id === "T2")!;
    const fbr = b.tasks.find((t) => t.id === "R2")!;
    fbw.status = "pending";
    fbw.assignedTo = null;
    fbw.startedAt = null;
    fbw.finishedAt = null;
    fbw.artifacts = null;
    fbw.reviewFeedback = ["fix decision not permitted on this review lane (canApplyFixes=false)"];
    fbr.status = "done";
    fbr.finishedAt = "2026-01-01T00:00:00.000Z";
    fbr.assignedTo = null;

    assert.equal(fw.status, "done");
    assert.equal(fbw.status, "pending");
    assert.ok(fw.finishedAt);
    assert.equal(fbw.finishedAt, null);
  });
});

// ── Fix decision preserves task attemptCount (no increment on fix) ─────────

describe("fix decision — attemptCount is not incremented", () => {
  it("attemptCount stays unchanged after fix", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 5, artifacts: { summary: "v5" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "fix", "notes": "done", "applied": true }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result);

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // Fix marks done without incrementing attemptCount.
    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = { ...(reviewed.artifacts ?? {}) };
    reviewed.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.equal(reviewed.attemptCount, 5, "attemptCount should remain 5 after fix");
  });
});
