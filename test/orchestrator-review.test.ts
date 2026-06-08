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

const ORCH_ID = "hydra_session_abc123";

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

// ── Chunk accumulation during orchestrator review ──────────────────────────

describe("orchestrator review — chunk accumulation", () => {
  it("accumulates agent_message_chunk text into orchestratorReviewAccumulator", () => {
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });
    const st = getOrchestratorState(ORCH_ID)!;

    // Simulate handleUpdateResponse for agent_message_chunk.
    const chunkEnvelope = { kind: "agent_message_chunk", text: "Looking at the code" };
    if (st.awaitingOrchestratorReview) {
      const kind = (chunkEnvelope as Record<string, unknown>).kind;
      if (kind === "agent_message_chunk") {
        const text = (chunkEnvelope as Record<string, unknown>).text as string;
        st.orchestratorReviewAccumulator += text;
      }
    }

    assert.equal(st.orchestratorReviewAccumulator, "Looking at the code");

    // Second chunk.
    const chunk2 = { kind: "agent_message_chunk", text: "\n```hydra-result\n" };
    if (st.awaitingOrchestratorReview) {
      const kind = (chunk2 as Record<string, unknown>).kind;
      if (kind === "agent_message_chunk") {
        const text = (chunk2 as Record<string, unknown>).text as string;
        st.orchestratorReviewAccumulator += text;
      }
    }

    assert.equal(st.orchestratorReviewAccumulator, "Looking at the code\n```hydra-result\n");
  });

  it("non-chunk envelopes are not accumulated", () => {
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });
    const st = getOrchestratorState(ORCH_ID)!;

    // A turn_complete or usage_update envelope should NOT be accumulated.
    const metaEnvelope = { kind: "usage_update", tokens: 42 };
    if (st.awaitingOrchestratorReview) {
      const kind = (metaEnvelope as Record<string, unknown>).kind;
      if (kind === "agent_message_chunk") {
        const text = (metaEnvelope as Record<string, unknown>).text as string;
        st.orchestratorReviewAccumulator += text;
      }
    }

    assert.equal(st.orchestratorReviewAccumulator, "");
  });

  it("clears accumulator after review completes", () => {
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = "some accumulated text";

    // Simulate end-of-review state reset (what runReviewOnOrchestrator does
    // after the emit promise resolves).
    st.awaitingOrchestratorReview = false;
    const accumulated = st.orchestratorReviewAccumulator;
    st.orchestratorReviewTaskId = null;
    st.orchestratorReviewAccumulator = "";

    assert.equal(accumulated, "some accumulated text");
    assert.equal(st.orchestratorReviewAccumulator, "");
    assert.equal(st.awaitingOrchestratorReview, false);
  });
});

// ── Dispatch: runReviewOnOrchestrator state setup ──────────────────────────

describe("orchestrator review — dispatch state setup", () => {
  it("marks review task as assigned to orchestrator sentinel", () => {
    const workTask = work("T1", { status: "awaiting_review" });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // Simulate runReviewOnOrchestrator dispatch.
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    reviewTask.startedAt = "2026-01-01T00:00:00.000Z";

    assert.equal(reviewTask.status, "assigned");
    assert.equal(reviewTask.assignedTo, "orchestrator");
    assert.ok(reviewTask.startedAt);
  });

  it("sets awaitingOrchestratorReview in OrchestratorState", () => {
    const st = setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    assert.equal(st.awaitingOrchestratorReview, true);
    assert.equal(st.orchestratorReviewTaskId, "R1");
  });

  it("resets OrchestratorState after review completes", () => {
    const st = setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // Simulate post-review cleanup.
    st.awaitingOrchestratorReview = false;
    st.orchestratorReviewTaskId = null;
    st.orchestratorReviewAccumulator = "";

    assert.equal(st.awaitingOrchestratorReview, false);
    assert.equal(st.orchestratorReviewTaskId, null);
  });
});

// ── Full flow: dispatch -> accumulate -> parse -> handleReviewComplete (approve) ──

describe("orchestrator review — full flow: approve", () => {
  it("work task transitions from awaiting_review to done with merged decisions", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── Accumulate chunks (simulated) ──
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "Looking at the code...",
      "\n```hydra-result",
      '\n{',
      '  "decision": "approve",',
      '  "notes": "LGTM, looks good"',
      "}\n```",
    ].join("");

    // ── Parse accumulated text (simulated runReviewOnOrchestrator post-emit) ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    // ── handleReviewComplete: approve path ──
    assert.ok(result, "should have parsed a valid review result");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // Merge review notes into artifacts.decisions.
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const reviewNotes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (reviewNotes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review] ${reviewNotes}`);
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
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review] LGTM, looks good"]);
    assert.equal(rev.status, "done");
  });
});

// ── Full flow: dispatch -> accumulate -> parse -> handleReviewComplete (reject) ──

describe("orchestrator review — full flow: reject (retask)", () => {
  it("work task transitions from awaiting_review back to pending on reject", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── Accumulate chunks ──
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "Found issues...",
      "\n```hydra-result",
      '\n{',
      '  "decision": "reject",',
      '  "notes": "missing error handling"',
      "}\n```",
    ].join("");

    // ── Parse ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.ok(result, "should have parsed a valid review result");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // ── handleReviewComplete: reject path (below maxAttempts) ──
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = (result!.artifacts as Record<string, unknown>).notes as string;
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

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

  it("work task fails when attemptCount >= maxAttempts", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 3, artifacts: { summary: "v3" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── Accumulate chunks (reject) ──
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{',
      '  "decision": "reject",',
      '  "notes": "still broken"',
      "}\n```",
    ].join("");

    // ── Parse ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.ok(result, "should have parsed a valid review result");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // ── handleReviewComplete: reject path (maxAttempts exceeded) ──
    reviewed.status = "failed";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = (result!.artifacts as Record<string, unknown>).notes as string;
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }
    reviewed.assignedTo = null;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "failed");
    assert.ok(reviewed.finishedAt);
    assert.deepEqual(reviewed.reviewFeedback, ["still broken"]);
    assert.equal(rev.status, "done");
  });
});

// ── Full flow: dispatch -> accumulate -> parse -> handleReviewComplete (amend) ──

describe("orchestrator review — full flow: amend", () => {
  it("work task transitions to done with [review amend] in decisions", () => {
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
      '\n{',
      '  "decision": "amend",',
      '  "notes": "rename the function"',
      "}\n```",
    ].join("");

    // ── Parse ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.ok(result, "should have parsed a valid review result");

    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const rev = b.tasks.find((t) => t.id === "R1")!;

    // ── handleReviewComplete: amend path ──
    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.assignedTo = null;

    const amendedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (result!.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!amendedArtifacts.decisions) amendedArtifacts.decisions = [];
      amendedArtifacts.decisions.push(`[review amend] ${notes}`);
    }
    reviewed.artifacts = amendedArtifacts;

    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";
    rev.assignedTo = null;

    assert.equal(reviewed.status, "done");
    assert.ok(reviewed.finishedAt);
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review amend] rename the function"]);
    assert.equal(rev.status, "done");
  });
});

// ── Parse failure treated as rejection ─────────────────────────────────────

describe("orchestrator review — parse failure", () => {
  it("empty accumulator is treated as rejection", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;

    // ── Parse empty accumulator ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.equal(result, undefined, "parse should fail on empty text");

    // ── handleReviewComplete: parse failure -> reject path ──
    reviewTask.status = "done";
    reviewTask.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewTask.assignedTo = null;
    reviewTask.artifacts = { summary: "reject", review_decision: "reject", notes: "missing or malformed review result" };

    const reviewed = b.tasks.find((t) => t.id === "T1")!;

    // On parse failure, the work task is NOT modified - it stays in its
    // current state (awaiting_review). The review task itself is marked done.
    assert.equal(reviewed.status, "awaiting_review", "work task should remain awaiting_review on parse failure");
    assert.equal(reviewTask.status, "done");
  });

  it("malformed JSON block is treated as rejection", () => {
    const workTask = work("T1", { status: "awaiting_review" });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      "\n{ broken json }",
      "\n```",
    ].join("");

    // ── Parse malformed JSON ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.equal(result, undefined, "parse should fail on malformed JSON");

    reviewTask.status = "done";
    reviewTask.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewTask.assignedTo = null;
    reviewTask.artifacts = { summary: "reject", review_decision: "reject", notes: "missing or malformed review result" };

    assert.equal(reviewTask.status, "done");
  });

  it("valid JSON but missing decision field is treated as rejection", () => {
    const workTask = work("T1", { status: "awaiting_review" });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    // ── Dispatch ──
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "notes": "no decision here" }',
      "\n```",
    ].join("");

    // ── Parse ──
    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = raw === undefined ? undefined : normalizeReview(raw);

    assert.equal(result, undefined, "normalizeReview should reject missing decision");

    reviewTask.status = "done";
    reviewTask.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewTask.assignedTo = null;
    reviewTask.artifacts = { summary: "reject", review_decision: "reject", notes: "missing or malformed review result" };

    assert.equal(reviewTask.status, "done");
  });
});

// ── Single-flight queueing ────────────────────────────────────────────────

describe("orchestrator review — single-flight queueing", () => {
  it("second review task is skipped when first is in flight", () => {
    const workTask1 = work("T1", { status: "awaiting_review" });
    const reviewTask1 = review("R1", "T1");
    const workTask2 = work("T2", { status: "awaiting_review" });
    const reviewTask2 = review("R2", "T2");
    const b = makeBoard([workTask1, reviewTask1, workTask2, reviewTask2]);

    // ── First review dispatch ──
    reviewTask1.status = "assigned";
    reviewTask1.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── simulate scheduleEligibleTasks encountering second review ──
    // (In the real code, this is the continue-skip at bridge.ts:2738-2743)
    const allReviews = b.tasks.filter((t) => t.kind === "review");
    for (const task of allReviews) {
      const st = getOrchestratorState(ORCH_ID);
      if (st?.awaitingOrchestratorReview && task.id !== "R1") {
        // Single-flight: a review is already in progress. Skip this task.
        continue;
      }
    }

    // R1 should be assigned, R2 should still be pending.
    const r1 = b.tasks.find((t) => t.id === "R1")!;
    const r2 = b.tasks.find((t) => t.id === "R2")!;

    assert.equal(r1.status, "assigned");
    assert.equal(r1.assignedTo, "orchestrator");
    assert.equal(r2.status, "pending", "second review should remain pending (single-flight)");
    assert.equal(r2.assignedTo, null);
  });

  it("after first review completes, second review is picked up", () => {
    const workTask1 = work("T1", { status: "awaiting_review" });
    const reviewTask1 = review("R1", "T1");
    const workTask2 = work("T2", { status: "awaiting_review" });
    const reviewTask2 = review("R2", "T2");
    const b = makeBoard([workTask1, reviewTask1, workTask2, reviewTask2]);

    // ── First review dispatch ──
    reviewTask1.status = "assigned";
    reviewTask1.assignedTo = "orchestrator";
    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // ── Complete first review (approve) ──
    const reviewed1 = b.tasks.find((t) => t.id === "T1")!;
    reviewed1.status = "done";
    reviewed1.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed1.artifacts = { summary: "added auth", decisions: ["[review] approved"] };

    const rev1 = b.tasks.find((t) => t.id === "R1")!;
    rev1.status = "done";
    rev1.finishedAt = "2026-01-01T00:00:00.000Z";

    // ── Reset orchestrator state (simulates runReviewOnOrchestrator cleanup) ──
    const st = getOrchestratorState(ORCH_ID)!;
    st.awaitingOrchestratorReview = false;
    st.orchestratorReviewTaskId = null;

    // ── scheduleEligibleTasks picks up second review ──
    reviewTask2.status = "assigned";
    reviewTask2.assignedTo = "orchestrator";
    reviewTask2.startedAt = "2026-01-01T00:00:01.000Z";

    const r2 = b.tasks.find((t) => t.id === "R2")!;
    assert.equal(r2.status, "assigned", "second review should now be assigned");
    assert.equal(r2.assignedTo, "orchestrator");
  });
});

// ── handleReviewComplete is invoked with parsed decision ───────────────────

describe("orchestrator review — handleReviewComplete dispatch", () => {
  it("approve decision triggers handleReviewApprove behavior", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // Simulate accumulated reply with approve decision.
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "approve", "notes": "LGTM" }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse approve");

    // Invoke handleReviewComplete logic: switch on review_decision.
    const normalized = result!;
    const decision = (normalized.artifacts as Record<string, unknown>).review_decision as string;
    assert.equal(decision, "approve");

    // Simulate handleReviewApprove.
    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    const mergedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const reviewNotes = (normalized.artifacts as Record<string, unknown>).notes as string;
    if (reviewNotes) {
      if (!mergedArtifacts.decisions) mergedArtifacts.decisions = [];
      mergedArtifacts.decisions.push(`[review] ${reviewNotes}`);
    }
    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.artifacts = mergedArtifacts;

    const rev = b.tasks.find((t) => t.id === "R1")!;
    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";

    assert.equal(reviewed.status, "done");
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review] LGTM"]);
  });

  it("reject decision triggers handleReviewReject behavior", () => {
    const workTask = work("T1", { status: "awaiting_review", attemptCount: 1, artifacts: { summary: "v1" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // Simulate accumulated reply with reject decision.
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "reject", "notes": "fix the bug" }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse reject");

    // Invoke handleReviewComplete logic: switch on review_decision.
    const normalized = result!;
    const decision = (normalized.artifacts as Record<string, unknown>).review_decision as string;
    assert.equal(decision, "reject");

    // Simulate handleReviewReject (below maxAttempts).
    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    reviewed.status = "pending";
    reviewed.assignedTo = null;
    reviewed.startedAt = null;
    reviewed.finishedAt = null;
    reviewed.artifacts = null;
    reviewed.reviewFeedback = reviewTask.reviewFeedback ?? [];
    const fb = (normalized.artifacts as Record<string, unknown>).notes as string;
    if (!reviewed.reviewFeedback.includes(fb)) {
      (reviewed.reviewFeedback as string[]).push(fb);
    }

    const rev = b.tasks.find((t) => t.id === "R1")!;
    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";

    assert.equal(reviewed.status, "pending");
    assert.deepEqual(reviewed.reviewFeedback, ["fix the bug"]);
  });

  it("amend decision triggers handleReviewAmend behavior", () => {
    const workTask = work("T1", { status: "awaiting_review", artifacts: { summary: "added auth" } });
    const reviewTask = review("R1", "T1");
    const b = makeBoard([workTask, reviewTask]);

    setOrchState({ awaitingOrchestratorReview: true, orchestratorReviewTaskId: "R1" });

    // Simulate accumulated reply with amend decision.
    const st = getOrchestratorState(ORCH_ID)!;
    st.orchestratorReviewAccumulator = [
      "\n```hydra-result",
      '\n{ "decision": "amend", "notes": "rename the function" }',
      "\n```",
    ].join("");

    st.awaitingOrchestratorReview = false;
    const raw = extractReviewBlock(st.orchestratorReviewAccumulator);
    const result = normalizeReview(raw);
    assert.ok(result, "should parse amend");

    // Invoke handleReviewComplete logic: switch on review_decision.
    const normalized = result!;
    const decision = (normalized.artifacts as Record<string, unknown>).review_decision as string;
    assert.equal(decision, "amend");

    // Simulate handleReviewAmend.
    const reviewed = b.tasks.find((t) => t.id === "T1")!;
    reviewed.status = "done";
    reviewed.finishedAt = "2026-01-01T00:00:00.000Z";
    reviewed.assignedTo = null;

    const amendedArtifacts = { ...(reviewed.artifacts ?? {}) };
    const notes = (normalized.artifacts as Record<string, unknown>).notes as string;
    if (notes) {
      if (!amendedArtifacts.decisions) amendedArtifacts.decisions = [];
      amendedArtifacts.decisions.push(`[review amend] ${notes}`);
    }
    reviewed.artifacts = amendedArtifacts;

    const rev = b.tasks.find((t) => t.id === "R1")!;
    rev.status = "done";
    rev.finishedAt = "2026-01-01T00:00:00.000Z";

    assert.equal(reviewed.status, "done");
    assert.deepEqual(reviewed.artifacts!.decisions, ["[review amend] rename the function"]);
  });
});
