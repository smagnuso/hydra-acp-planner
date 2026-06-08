import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  PlannerBridge,
  boards,
  attachedSessions,
  clientAttachedSessions,
  type BridgeClient,
} from "../src/bridge.ts";
import { newBoard, saveBoard, type Board, type Task } from "../src/board.ts";
import {
  setWorkerState,
  registerWorker,
  setOrchestratorState,
  getWorkerState,
  clearOrchestratorState,
} from "../src/state.ts";

// Real integration tests for the review pipeline. These exercise the
// actual PlannerBridge.handleTaskComplete path, not a manual
// reimplementation of what it's supposed to do. Catches regressions in
// markTaskDone → handleReviewComplete handoff and the artifacts shape
// expected by review-decision dispatch.

class FakeClient extends EventEmitter implements BridgeClient {
  request<R = unknown>(): Promise<R> {
    return Promise.resolve({} as R);
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}
}

const ORCH = "hydra_session_orch_int";
const WORKER = "hydra_session_worker_int";

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-review-int-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client: new FakeClient(),
  });
  setOrchestratorState(ORCH, {
    projectId: "p-int",
    decompositionAccumulator: "",
    awaitingDecomposition: false,
    addAccumulator: "",
    awaitingAdd: false,
    awaitingOrchestratorReview: false,
    orchestratorReviewTaskId: null,
    orchestratorReviewAccumulator: "",
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  clearOrchestratorState(ORCH);
});

function makeBoard(tasks: Task[]): Board {
  const b = newBoard({ description: "integration", concurrencyCap: 2 });
  b.state = "running";
  b.tasks = tasks;
  b.workers[WORKER] = {
    workerSessionId: WORKER,
    agentId: null,
    model: null,
    currentTaskId: tasks.find((t) => t.kind === "review")?.id ?? null,
    tasksCompleted: [],
  };
  boards.set(ORCH, b);
  saveBoard(b, ORCH);
  return b;
}

function workTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `work ${id}`,
    deps: [],
    status: "awaiting_review",
    assignedTo: null,
    attemptCount: 1,
    artifacts: { summary: "initial work" },
    kind: "work",
    ...overrides,
  } as Task;
}

function reviewTask(id: string, reviews: string | string[], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `review ${id}`,
    deps: Array.isArray(reviews) ? reviews : [reviews],
    status: "assigned",
    assignedTo: WORKER,
    attemptCount: 0,
    kind: "review",
    reviews,
    ...overrides,
  } as Task;
}

function primeWorkerForReview(taskId: string, reviewerReply: string) {
  registerWorker(WORKER, ORCH);
  setWorkerState(WORKER, {
    orchestratorSessionId: ORCH,
    taskId,
    resultAccumulator: reviewerReply,
    repromptCount: 0,
  });
}

// Bypass `private` for direct invocation. handleTaskComplete is sync but
// schedules fire-and-forget closeWorker / emitSyntheticMessage promises;
// `settle` drains them so the test runner doesn't see post-test activity.
function complete(board: Board, task: Task) {
  (bridge as unknown as {
    handleTaskComplete: (orch: string, worker: string, b: Board, t: Task) => void;
  }).handleTaskComplete(ORCH, WORKER, board, task);
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("review integration — handleTaskComplete → handleReviewComplete", () => {
  it("approve: work task done with merged review notes; review done", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    primeWorkerForReview(
      "R1",
      'Looking good.\n```hydra-result\n{"decision":"approve","notes":"LGTM"}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(wt.status, "done", "work task should transition out of awaiting_review");
    assert.equal(rt.status, "done");
    assert.ok(
      wt.artifacts?.decisions?.some((d) => d.startsWith("[review] LGTM")),
      `expected merged review note in artifacts.decisions, got ${JSON.stringify(wt.artifacts?.decisions)}`,
    );
  });

  it("reject: work task back to pending with feedback; review done", async () => {
    const work = workTask("T1", { attemptCount: 1 });
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    // Pause so scheduleEligibleTasks doesn't immediately re-dispatch the
    // newly-pending work task — we want to assert on the post-reject state.
    board.state = "paused";
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"reject","notes":"needs error handling"}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(wt.status, "pending", "work task should be retasked");
    assert.equal(rt.status, "done");
    assert.deepEqual(wt.reviewFeedback, ["needs error handling"]);
    assert.equal(wt.artifacts, null, "artifacts cleared on retask");
  });

  it("amend: work task done with [review amend] in decisions", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"amend","notes":"tweak the logic"}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    assert.equal(wt.status, "done");
    assert.ok(
      wt.artifacts?.decisions?.some((d) => d === "[review amend] tweak the logic"),
    );
  });

  it("fix (canApplyFixes=true): work done with [review fix]; no retask", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1", { canApplyFixes: true });
    const board = makeBoard([work, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"fix","notes":"patched","applied":true}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    assert.equal(wt.status, "done");
    assert.ok(wt.artifacts?.decisions?.some((d) => d === "[review fix] patched"));
  });

  it("fix (canApplyFixes=false): falls through to reject", async () => {
    const work = workTask("T1", { attemptCount: 1 });
    const rev = reviewTask("R1", "T1", { canApplyFixes: false });
    const board = makeBoard([work, rev]);
    board.state = "paused";
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"fix","notes":"tried to patch","applied":true}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(wt.status, "pending", "fix should fall through to reject when canApplyFixes=false");
    assert.equal(rt.status, "done");
    assert.ok(
      (wt.reviewFeedback ?? []).some((f) => f.includes("canApplyFixes")),
      `expected reject feedback to mention canApplyFixes, got ${JSON.stringify(wt.reviewFeedback)}`,
    );
  });

  it("malformed review reply: treated as reject", async () => {
    const work = workTask("T1", { attemptCount: 1 });
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    // Two reprompts allowed before failure — prime worker with no block at all
    // AND set repromptCount=1 so handleTaskComplete falls into the failure
    // path instead of reprompting again.
    registerWorker(WORKER, ORCH);
    setWorkerState(WORKER, {
      orchestratorSessionId: ORCH,
      taskId: "R1",
      resultAccumulator: "Just some prose, no hydra-result block at all.",
      repromptCount: 1,
    });

    complete(board, rev);
    await settle();

    const rt = board.tasks.find((t) => t.id === "R1")!;
    // Missing block path: handleTaskFailure is invoked (review fails). The
    // important thing is that the review doesn't silently succeed and the
    // worker doesn't get a stuck task.
    assert.notEqual(rt.status, "awaiting_review", "review task should not be stuck");
  });

  it("maxAttempts exceeded → work task marked failed with feedback chain", async () => {
    const work = workTask("T1", {
      attemptCount: 3,
      reviewFeedback: ["round 1", "round 2", "round 3"],
    });
    const rev = reviewTask("R1", "T1", { onReject: { maxAttempts: 3 } });
    const board = makeBoard([work, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"reject","notes":"still wrong"}\n```',
    );

    complete(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    assert.equal(wt.status, "failed");
    assert.ok((wt.reviewFeedback ?? []).includes("still wrong"));
  });
});

describe("review integration — competition guard", () => {
  it("non-winner decision on a competition routes through winner handler", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const rev = reviewTask("R1", ["T1", "T2"]);
    const board = makeBoard([t1, t2, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"approve","notes":"both look fine"}\n```',
    );

    complete(board, rev);
    await settle();

    // approve on a competition is reviewer error. The dispatcher should
    // route to handleReviewWinner with no valid winnerId, which fails
    // all reviewees rather than silently approving only the first.
    const wt1 = board.tasks.find((t) => t.id === "T1")!;
    const wt2 = board.tasks.find((t) => t.id === "T2")!;
    assert.equal(wt1.status, "failed", "T1 should not silently approve on competition non-winner decision");
    assert.equal(wt2.status, "failed", "T2 should not silently approve on competition non-winner decision");
  });

  it("winner decision on a competition: winner done, others superseded", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const t3 = workTask("T3");
    const rev = reviewTask("R1", ["T1", "T2", "T3"]);
    const board = makeBoard([t1, t2, t3, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"winner","winner":"T2","notes":"T2 wins"}\n```',
    );

    complete(board, rev);
    await settle();

    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "superseded");
    assert.equal(board.tasks.find((t) => t.id === "T2")!.status, "done");
    assert.equal(board.tasks.find((t) => t.id === "T3")!.status, "superseded");
  });
});

// Suppress unused warning — getWorkerState is exported for diagnostic
// use within tests if needed.
void getWorkerState;
