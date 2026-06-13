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
import { newBoard, saveBoard, pickEligible, resolveTaskLane, type Board, type Task } from "../src/board.ts";
import {
  setWorkerState,
  registerWorker,
  getWorkerState,
  setOrchestratorState,
  clearOrchestratorState,
} from "../src/state.ts";

// End-to-end integration tests for the distiller role. Mirrors
// test/competition-integration.test.ts: drive the real
// PlannerBridge.handleTaskComplete entry point with normalized
// hydra-result payloads injected via the worker state's
// resultAccumulator. No live LLM. Catches regressions in the
// synthesize → distill spawn and the per-action distill dispatch
// (apply Tx / rework / new-work / parser-rejection / max-attempts).

// request returns a never-resolving promise so the reprompt loop in
// PlannerBridge.repromptForResultBlock (which re-enters handleTaskComplete
// after the request resolves) doesn't run-away within a single test step.
// Tests drive each retry explicitly by re-priming the worker state and
// calling complete() again.
class FakeClient extends EventEmitter implements BridgeClient {
  request<R = unknown>(): Promise<R> {
    return new Promise<R>(() => {});
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}
}

const ORCH = "hydra_session_orch_distill";
const WORKER = "hydra_session_worker_distill";

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-distill-int-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client: new FakeClient(),
    fetchSessionDiff: async () => undefined,
  });
  setOrchestratorState(ORCH, {
    projectId: "p-distill",
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

function makeBoard(tasks: Task[], currentTaskId: string | null = null): Board {
  const b = newBoard({ description: "distill", concurrencyCap: 2 });
  b.state = "paused";
  b.tasks = tasks;
  b.workers[WORKER] = {
    workerSessionId: WORKER,
    agentId: null,
    model: null,
    currentTaskId,
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
    artifacts: { summary: `${id} approach` },
    kind: "work",
    ...overrides,
  } as Task;
}

function reviewTask(id: string, reviews: string[], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `review ${id}`,
    deps: reviews,
    status: "assigned",
    assignedTo: WORKER,
    attemptCount: 0,
    kind: "review",
    reviews,
    ...overrides,
  } as Task;
}

function distillTask(id: string, reviews: string[], distillOf: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `distill ${distillOf}`,
    deps: reviews,
    status: "assigned",
    assignedTo: WORKER,
    attemptCount: 1,
    kind: "distill",
    reviews,
    distillOf,
    ...overrides,
  } as Task;
}

function doneReview(id: string, reviews: string[], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `review ${id}`,
    deps: reviews,
    status: "done",
    assignedTo: null,
    attemptCount: 1,
    kind: "review",
    reviews,
    artifacts: { summary: "synthesize", review_decision: "synthesize", notes: "no clear winner" },
    ...overrides,
  } as Task;
}

function primeWorker(taskId: string, reply: string) {
  registerWorker(WORKER, ORCH);
  setWorkerState(WORKER, {
    orchestratorSessionId: ORCH,
    taskId,
    resultAccumulator: reply,
    repromptCount: 0,
  });
}

function setWorkerReply(taskId: string, reply: string, repromptCount: number) {
  setWorkerState(WORKER, {
    orchestratorSessionId: ORCH,
    taskId,
    resultAccumulator: reply,
    repromptCount,
  });
}

async function complete(board: Board, task: Task) {
  await (bridge as unknown as {
    handleTaskComplete: (orch: string, worker: string, b: Board, t: Task) => Promise<void>;
  }).handleTaskComplete(ORCH, WORKER, board, task);
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("distill integration — synthesize → distill spawn", () => {
  it("synthesize creates distill, rewires dependents, leaves reviewees untouched, dependents stay blocked", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const t3 = workTask("T3");
    const rev = reviewTask("R1", ["T1", "T2", "T3"]);
    const depOnReview = workTask("T4", { deps: ["R1"], status: "pending", artifacts: undefined });
    const unrelated = workTask("T5", { deps: ["T9"], status: "pending", artifacts: undefined });
    const board = makeBoard([t1, t2, t3, rev, depOnReview, unrelated], "R1");
    primeWorker(
      "R1",
      '```hydra-result\n{"decision":"synthesize","notes":"no clear winner — overlapping merits"}\n```',
    );

    await complete(board, rev);
    await settle();

    const t1After = board.tasks.find((t) => t.id === "T1")!;
    const t2After = board.tasks.find((t) => t.id === "T2")!;
    const t3After = board.tasks.find((t) => t.id === "T3")!;
    const reviewAfter = board.tasks.find((t) => t.id === "R1")!;
    const distill = board.tasks.find((t) => t.id === "R1d");

    assert.equal(t1After.status, "awaiting_review");
    assert.equal(t2After.status, "awaiting_review");
    assert.equal(t3After.status, "awaiting_review");
    assert.equal(reviewAfter.status, "done");

    assert.ok(distill, "distill task R1d spawned");
    assert.equal(distill!.kind, "distill");
    assert.equal(distill!.distillOf, "R1");
    assert.deepEqual(distill!.deps, ["T1", "T2", "T3"]);
    assert.deepEqual(distill!.reviews, ["T1", "T2", "T3"]);
    assert.equal(distill!.status, "pending");

    const depAfter = board.tasks.find((t) => t.id === "T4")!;
    assert.deepEqual(depAfter.deps, ["R1", "R1d"], "dependent rewired to also depend on distill");
    const unrelatedAfter = board.tasks.find((t) => t.id === "T5")!;
    assert.deepEqual(unrelatedAfter.deps, ["T9"], "unrelated deps untouched");

    // Dependent stays blocked: distill is pending and awaits its reviewees.
    const eligible = pickEligible(board);
    assert.notEqual(eligible?.id, "T4", "dependent on review+distill must stay blocked");
  });
});

describe("distill integration — apply Tx", () => {
  it("apply Tx marks Tx done, supersedes others, unblocks dependents, surfaces report on review", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const t3 = workTask("T3");
    const review = doneReview("R1", ["T1", "T2", "T3"]);
    const distill = distillTask("R1d", ["T1", "T2", "T3"], "R1");
    const dep = workTask("T4", {
      deps: ["R1", "R1d"],
      status: "pending",
      artifacts: undefined,
    });
    const board = makeBoard([t1, t2, t3, review, distill, dep], "R1d");
    primeWorker(
      "R1d",
      '```hydra-result\n{"summary":"T2 is the strongest baseline",' +
      '"findings":[{"claim":"T2 covers the edge case","sources":["T2"],"verdict":"keep","evidence":"T2:src/foo.ts hunk 1"}],' +
      '"recommended_action":"apply T2"}\n```',
    );

    await complete(board, distill);
    await settle();

    const t1After = board.tasks.find((t) => t.id === "T1")!;
    const t2After = board.tasks.find((t) => t.id === "T2")!;
    const t3After = board.tasks.find((t) => t.id === "T3")!;
    const distillAfter = board.tasks.find((t) => t.id === "R1d")!;
    const reviewAfter = board.tasks.find((t) => t.id === "R1")!;

    assert.equal(t2After.status, "done", "Tx winner is done");
    assert.equal(t1After.status, "superseded");
    assert.equal(t3After.status, "superseded");
    assert.equal(distillAfter.status, "done");

    // Report surfaced on originating review's artifacts.distill.
    const reviewArtifacts = reviewAfter.artifacts as Record<string, unknown>;
    assert.ok(reviewArtifacts.distill, "distill report surfaced on review");
    const distillReport = reviewArtifacts.distill as Record<string, unknown>;
    assert.equal(distillReport.applied_winner, "T2");
    assert.equal(distillReport.recommended_action, "apply T2");

    // Dependent unblocks: review is done, distill is done.
    const eligible = pickEligible(board);
    assert.equal(eligible?.id, "T4", "dependent unblocks after distill completes");

    // Report also surfaced on the distill task's own artifacts so
    // collectFindings / get_findings can read it without traversing
    // distillOf.
    const distillArtifacts = distillAfter.artifacts as Record<string, unknown>;
    assert.ok(distillArtifacts, "distill task carries its own artifacts");
    assert.equal(distillArtifacts.applied_winner, "T2");
    assert.equal(distillArtifacts.recommended_action, "apply T2");
  });
});

describe("distill integration — rework / new-work", () => {
  it("rework supersedes all reviewees, spawns follow-up work with rework_brief, dependents depend on new work task", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const review = doneReview("R1", ["T1", "T2"]);
    const distill = distillTask("R1d", ["T1", "T2"], "R1");
    const dep = workTask("T4", {
      deps: ["R1", "R1d"],
      status: "pending",
      artifacts: undefined,
    });
    const unrelated = workTask("T5", { deps: ["T9"], status: "pending", artifacts: undefined });
    const board = makeBoard([t1, t2, review, distill, dep, unrelated], "R1d");
    primeWorker(
      "R1d",
      '```hydra-result\n{"summary":"both miss the spec",' +
      '"findings":[{"claim":"neither handles streaming","sources":["T1","T2"],"verdict":"drop","evidence":"T1:hunk 1; T2:hunk 1"}],' +
      '"recommended_action":"rework","rework_brief":"redo with streaming support"}\n```',
    );

    await complete(board, distill);
    await settle();

    const t1After = board.tasks.find((t) => t.id === "T1")!;
    const t2After = board.tasks.find((t) => t.id === "T2")!;
    const distillAfter = board.tasks.find((t) => t.id === "R1d")!;
    assert.equal(t1After.status, "superseded");
    assert.equal(t2After.status, "superseded");
    assert.equal(distillAfter.status, "done");

    const newWork = board.tasks.find((t) => t.id === "R1dw");
    assert.ok(newWork, "follow-up work task spawned");
    assert.equal(newWork!.kind, "work");
    assert.equal(newWork!.what, "redo with streaming support");
    assert.equal(newWork!.status, "pending");

    const depAfter = board.tasks.find((t) => t.id === "T4")!;
    assert.deepEqual(
      depAfter.deps,
      ["R1", "R1dw"],
      "dependent's distill id replaced by new work id",
    );
    const unrelatedAfter = board.tasks.find((t) => t.id === "T5")!;
    assert.deepEqual(unrelatedAfter.deps, ["T9"], "unrelated deps untouched");

    // Report surfaced on originating review.
    const reviewAfter = board.tasks.find((t) => t.id === "R1")!;
    const reviewArtifacts = reviewAfter.artifacts as Record<string, unknown>;
    assert.ok(reviewArtifacts.distill);
    const report = reviewArtifacts.distill as Record<string, unknown>;
    assert.equal(report.recommended_action, "rework");
    assert.equal(report.rework_brief, "redo with streaming support");

    // Report also on the distill task itself.
    const distillArtifacts = distillAfter.artifacts as Record<string, unknown>;
    assert.ok(distillArtifacts);
    assert.equal(distillArtifacts.recommended_action, "rework");
    assert.equal(distillArtifacts.rework_brief, "redo with streaming support");
  });
});

describe("distill integration — parser rejection retries", () => {
  it("unknown source id is rejected by parser and triggers a reprompt; valid retry then succeeds", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const review = doneReview("R1", ["T1", "T2"]);
    const distill = distillTask("R1d", ["T1", "T2"], "R1");
    const board = makeBoard([t1, t2, review, distill], "R1d");

    // First attempt: cites an unknown source id "T9" not in task.reviews.
    primeWorker(
      "R1d",
      '```hydra-result\n{"summary":"plausible",' +
      '"findings":[{"claim":"x","sources":["T9"],"verdict":"keep","evidence":"T9:hunk 1"}],' +
      '"recommended_action":"apply T1"}\n```',
    );
    await complete(board, distill);
    await settle();

    // Parser rejected → reprompt path: repromptCount bumped, accumulator
    // cleared, distill itself not marked failed yet, reviewees untouched.
    let ws = getWorkerState(WORKER)!;
    assert.equal(ws.repromptCount, 1, "repromptCount incremented after parser rejection");
    assert.equal(ws.resultAccumulator, "", "accumulator cleared for the next turn");
    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "assigned");
    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "awaiting_review");
    assert.equal(board.tasks.find((t) => t.id === "T2")!.status, "awaiting_review");
    const reviewMid = board.tasks.find((t) => t.id === "R1")!;
    assert.equal((reviewMid.artifacts as Record<string, unknown>).distill, undefined);

    // Retry with a valid result: distill completes with apply T1.
    setWorkerReply(
      "R1d",
      '```hydra-result\n{"summary":"T1 wins",' +
      '"findings":[{"claim":"T1 covers spec","sources":["T1"],"verdict":"keep","evidence":"T1:hunk 1"}],' +
      '"recommended_action":"apply T1"}\n```',
      1,
    );
    await complete(board, distill);
    await settle();

    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "done");
    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "done");
    assert.equal(board.tasks.find((t) => t.id === "T2")!.status, "superseded");
  });

  it("empty sources on a finding is rejected by parser and triggers a reprompt", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const review = doneReview("R1", ["T1", "T2"]);
    const distill = distillTask("R1d", ["T1", "T2"], "R1");
    const board = makeBoard([t1, t2, review, distill], "R1d");

    primeWorker(
      "R1d",
      '```hydra-result\n{"summary":"vibes",' +
      '"findings":[{"claim":"unbacked claim","sources":[],"verdict":"keep","evidence":"none"}],' +
      '"recommended_action":"apply T1"}\n```',
    );
    await complete(board, distill);
    await settle();

    const ws = getWorkerState(WORKER)!;
    assert.equal(ws.repromptCount, 1, "empty sources → parser rejects → reprompt");
    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "assigned");
    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "awaiting_review");
    assert.equal(board.tasks.find((t) => t.id === "T2")!.status, "awaiting_review");
  });
});

describe("distill integration — max attempts", () => {
  it("three consecutive parser rejections exhaust retries and fail all reviewees with canonical feedback", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const review = doneReview("R1", ["T1", "T2"]);
    const distill = distillTask("R1d", ["T1", "T2"], "R1");
    const board = makeBoard([t1, t2, review, distill], "R1d");

    const bad =
      '```hydra-result\n{"summary":"x",' +
      '"findings":[{"claim":"y","sources":[],"verdict":"keep","evidence":"z"}],' +
      '"recommended_action":"apply T1"}\n```';

    primeWorker("R1d", bad);
    await complete(board, distill);
    await settle();
    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "assigned");

    setWorkerReply("R1d", bad, 1);
    await complete(board, distill);
    await settle();
    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "assigned");

    setWorkerReply("R1d", bad, 2);
    await complete(board, distill);
    await settle();

    const expected = "distill R1d: max attempts exceeded";
    const t1After = board.tasks.find((t) => t.id === "T1")!;
    const t2After = board.tasks.find((t) => t.id === "T2")!;
    const distillAfter = board.tasks.find((t) => t.id === "R1d")!;
    assert.equal(t1After.status, "failed");
    assert.equal(t2After.status, "failed");
    assert.deepEqual(t1After.reviewFeedback, [expected]);
    assert.deepEqual(t2After.reviewFeedback, [expected]);
    assert.equal(distillAfter.status, "failed");
  });
});

describe("distill integration — lane resolution at dispatch", () => {
  it("distill with no agent/model and no runOn config resolves to worker default", () => {
    const board = newBoard({ description: "lane defaults" });
    const distill = distillTask("R1d", ["T1", "T2"], "R1", {
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
    });
    const { lane, reason } = resolveTaskLane(distill, board, "distill");
    assert.equal(lane, "worker");
    assert.equal(reason, "default");
  });
});
