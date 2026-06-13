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
import { newBoard, saveBoard, pickEligible, inFlightCount, type Board, type Task } from "../src/board.ts";
import {
  setWorkerState,
  registerWorker,
  setOrchestratorState,
  clearOrchestratorState,
} from "../src/state.ts";

// Real integration tests for competition reviews. These drive
// PlannerBridge.handleTaskComplete with a multi-reviewee review task and
// let handleReviewWinner mutate the board: the winner goes to done with
// merged notes, the losers are superseded, and dependents become
// eligible via the real pickEligible scheduler. Catches regressions in
// the winner/supersede handoff and the dependency-satisfaction semantics
// the scheduler relies on.

class FakeClient extends EventEmitter implements BridgeClient {
  request<R = unknown>(): Promise<R> {
    return Promise.resolve({} as R);
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}
}

const ORCH = "hydra_session_orch_comp";
const WORKER = "hydra_session_worker_comp";

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-comp-int-"));
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
    projectId: "p-comp",
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
  const b = newBoard({ description: "competition", concurrencyCap: 2 });
  // Paused so the post-review scheduler pass doesn't dispatch the now-eligible
  // dependent — we assert on pickEligible directly.
  b.state = "paused";
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

function primeWorkerForReview(taskId: string, reviewerReply: string) {
  registerWorker(WORKER, ORCH);
  setWorkerState(WORKER, {
    orchestratorSessionId: ORCH,
    taskId,
    resultAccumulator: reviewerReply,
    repromptCount: 0,
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

describe("competition integration — winner + supersede + unblock", () => {
  it("declares winner done with merged notes, supersedes losers, review done", async () => {
    const t1 = workTask("T1", { artifacts: { summary: "v1", decisions: ["regex"] } });
    const t2 = workTask("T2", { artifacts: { summary: "v2", decisions: ["parser"] } });
    const t3 = workTask("T3", { artifacts: { summary: "v3" } });
    const rev = reviewTask("R1", ["T1", "T2", "T3"]);
    const board = makeBoard([t1, t2, t3, rev]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"winner","winner":"T2","notes":"v2 best"}\n```',
    );

    await complete(board, rev);
    await settle();

    const w1 = board.tasks.find((t) => t.id === "T1")!;
    const w2 = board.tasks.find((t) => t.id === "T2")!;
    const w3 = board.tasks.find((t) => t.id === "T3")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(w2.status, "done", "winner is marked done");
    assert.equal(w1.status, "superseded");
    assert.equal(w3.status, "superseded");
    assert.equal(rt.status, "done");
    assert.ok(
      w2.artifacts?.decisions?.some((d) => d === "[review winner] v2 best"),
      `expected winner note merged, got ${JSON.stringify(w2.artifacts?.decisions)}`,
    );
    // Superseded reviewees don't count as in-flight.
    assert.equal(inFlightCount(board), 0);
  });

  it("dependent on winner and dependent on loser both become eligible", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const rev = reviewTask("R1", ["T1", "T2"]);
    const depOnWinner = workTask("T4", { deps: ["T2"], status: "pending", artifacts: undefined });
    const depOnLoser = workTask("T5", { deps: ["T1"], status: "pending", artifacts: undefined });
    const board = makeBoard([t1, t2, rev, depOnWinner, depOnLoser]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"winner","winner":"T2","notes":"T2 wins"}\n```',
    );

    await complete(board, rev);
    await settle();

    // Winner done, loser superseded — both statuses satisfy dependencies.
    const eligible = new Set<string>();
    // pickEligible returns one at a time; mark-and-repeat to enumerate.
    for (let i = 0; i < 5; i++) {
      const next = pickEligible(board);
      if (!next) break;
      eligible.add(next.id);
      next.status = "assigned";
    }
    assert.ok(eligible.has("T4"), "dependent on winner (done) should be eligible");
    assert.ok(eligible.has("T5"), "dependent on superseded loser should be eligible");
  });

  it("synthesize decision spawns a distill task, rewires dependents, leaves reviewees untouched", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const t3 = workTask("T3");
    const rev = reviewTask("R1", ["T1", "T2", "T3"]);
    const dep = workTask("T4", {
      deps: ["R1"],
      status: "pending",
      artifacts: undefined,
    });
    const other = workTask("T5", {
      deps: ["T9"],
      status: "pending",
      artifacts: undefined,
    });
    const board = makeBoard([t1, t2, t3, rev, dep, other]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"synthesize","notes":"no clear winner — overlapping merits"}\n```',
    );

    await complete(board, rev);
    await settle();

    const w1 = board.tasks.find((t) => t.id === "T1")!;
    const w2 = board.tasks.find((t) => t.id === "T2")!;
    const w3 = board.tasks.find((t) => t.id === "T3")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    const distill = board.tasks.find((t) => t.id === "R1d");

    assert.equal(w1.status, "awaiting_review", "reviewee T1 untouched");
    assert.equal(w2.status, "awaiting_review", "reviewee T2 untouched");
    assert.equal(w3.status, "awaiting_review", "reviewee T3 untouched");
    assert.equal(rt.status, "done", "review marked done");

    assert.ok(distill, "distill task R1d created");
    assert.equal(distill!.kind, "distill");
    assert.equal(distill!.distillOf, "R1");
    assert.deepEqual(distill!.deps, ["T1", "T2", "T3"]);
    assert.deepEqual(distill!.reviews, ["T1", "T2", "T3"]);
    assert.equal(distill!.status, "pending");
    assert.equal(distill!.attemptCount, 0);
    assert.equal(distill!.assignedTo, null);

    const depAfter = board.tasks.find((t) => t.id === "T4")!;
    assert.deepEqual(
      depAfter.deps,
      ["R1", "R1d"],
      "dependent on R1 should also depend on R1d (review id preserved)",
    );

    const otherAfter = board.tasks.find((t) => t.id === "T5")!;
    assert.deepEqual(
      otherAfter.deps,
      ["T9"],
      "unrelated task deps untouched",
    );
  });

  it("distill apply-Tx produces the same reviewee board state as a real winner verdict", async () => {
    // Drive the real winner path on board A, then drive the distill
    // apply-Tx path on board B, and assert reviewee statuses match.
    const winnerReviewees = ["T1", "T2", "T3"].map((id) =>
      workTask(id, { artifacts: { summary: `${id} approach` } }),
    );
    const winnerReview = reviewTask("R1", ["T1", "T2", "T3"]);
    const boardA = makeBoard([...winnerReviewees, winnerReview]);
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"winner","winner":"T2","notes":"v2 best"}\n```',
    );
    await complete(boardA, winnerReview);
    await settle();
    const winnerSnap = ["T1", "T2", "T3"].map((id) => {
      const t = boardA.tasks.find((x) => x.id === id)!;
      return { id, status: t.status };
    });

    // Distill apply-Tx: simulate a synthesized distill task that has
    // already been spawned by T2's handleReviewSynthesize.
    boards.clear();
    const distillReviewees = ["T1", "T2", "T3"].map((id) =>
      workTask(id, { artifacts: { summary: `${id} approach` } }),
    );
    const originatingReview: Task = {
      id: "R1",
      title: "review R1",
      deps: ["T1", "T2", "T3"],
      status: "done",
      assignedTo: null,
      attemptCount: 1,
      kind: "review",
      reviews: ["T1", "T2", "T3"],
      artifacts: { summary: "synthesize", review_decision: "synthesize", notes: "no clear winner" },
    } as Task;
    const distill: Task = {
      id: "R1d",
      title: "distill R1",
      deps: ["T1", "T2", "T3"],
      status: "assigned",
      assignedTo: WORKER,
      attemptCount: 1,
      kind: "distill",
      reviews: ["T1", "T2", "T3"],
      distillOf: "R1",
    } as Task;
    const boardB = makeBoard([...distillReviewees, originatingReview, distill]);
    primeWorkerForReview(
      "R1d",
      '```hydra-result\n{"summary":"T2 is the strongest baseline",' +
      '"findings":[{"claim":"T2 covers the edge case","sources":["T2"],"verdict":"keep","evidence":"T2:src/foo.ts hunk 1"}],' +
      '"recommended_action":"apply T2"}\n```',
    );
    await complete(boardB, distill);
    await settle();

    const distillSnap = ["T1", "T2", "T3"].map((id) => {
      const t = boardB.tasks.find((x) => x.id === id)!;
      return { id, status: t.status };
    });
    assert.deepEqual(
      distillSnap,
      winnerSnap,
      "distill apply-Tx must produce the same reviewee statuses as the real winner verdict",
    );
    // Distill itself should be done; report surfaced on originating review.
    const distillAfter = boardB.tasks.find((t) => t.id === "R1d")!;
    const reviewAfter = boardB.tasks.find((t) => t.id === "R1")!;
    assert.equal(distillAfter.status, "done");
    const reviewArtifacts = reviewAfter.artifacts as Record<string, unknown>;
    assert.ok(reviewArtifacts.distill, "distill report surfaced on originating review");
    assert.equal(
      (reviewArtifacts.distill as Record<string, unknown>).applied_winner,
      "T2",
    );
  });

  it("distill rework supersedes all reviewees, spawns follow-up work, rewires dependents", async () => {
    const t1 = workTask("T1", { artifacts: { summary: "v1" } });
    const t2 = workTask("T2", { artifacts: { summary: "v2" } });
    const originatingReview: Task = {
      id: "R1",
      title: "review R1",
      deps: ["T1", "T2"],
      status: "done",
      assignedTo: null,
      attemptCount: 1,
      kind: "review",
      reviews: ["T1", "T2"],
      artifacts: { summary: "synthesize", review_decision: "synthesize", notes: "split" },
    } as Task;
    const distill: Task = {
      id: "R1d",
      title: "distill R1",
      deps: ["T1", "T2"],
      status: "assigned",
      assignedTo: WORKER,
      attemptCount: 1,
      kind: "distill",
      reviews: ["T1", "T2"],
      distillOf: "R1",
    } as Task;
    // Dependents: T4 depended on R1 (T2 appended R1d via handleReviewSynthesize),
    // T5 unrelated.
    const t4 = workTask("T4", {
      deps: ["R1", "R1d"],
      status: "pending",
      artifacts: undefined,
    });
    const t5 = workTask("T5", {
      deps: ["T9"],
      status: "pending",
      artifacts: undefined,
    });
    const board = makeBoard([t1, t2, originatingReview, distill, t4, t5]);
    primeWorkerForReview(
      "R1d",
      '```hydra-result\n{"summary":"both candidates miss the spec",' +
      '"findings":[{"claim":"neither handles streaming","sources":["T1","T2"],"verdict":"drop","evidence":"T1:src/x.ts hunk 2; T2:src/x.ts hunk 1"}],' +
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
    assert.ok(newWork, "follow-up work task R1dw spawned");
    assert.equal(newWork!.kind, "work");
    assert.equal(newWork!.what, "redo with streaming support");
    assert.equal(newWork!.status, "pending");

    const t4After = board.tasks.find((t) => t.id === "T4")!;
    assert.deepEqual(
      t4After.deps,
      ["R1", "R1dw"],
      "dependent's R1d dep replaced by the new work task id; review id preserved",
    );
    const t5After = board.tasks.find((t) => t.id === "T5")!;
    assert.deepEqual(t5After.deps, ["T9"], "unrelated deps untouched");

    // Report surfaced on the originating review.
    const reviewAfter = board.tasks.find((t) => t.id === "R1")!;
    const reviewArtifacts = reviewAfter.artifacts as Record<string, unknown>;
    assert.ok(reviewArtifacts.distill);
    assert.equal(
      (reviewArtifacts.distill as Record<string, unknown>).recommended_action,
      "rework",
    );
  });

  it("distill new-work behaves like rework (supersede + spawn + rewire)", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const originatingReview: Task = {
      id: "R1",
      title: "review R1",
      deps: ["T1", "T2"],
      status: "done",
      assignedTo: null,
      attemptCount: 1,
      kind: "review",
      reviews: ["T1", "T2"],
    } as Task;
    const distill: Task = {
      id: "R1d",
      title: "distill R1",
      deps: ["T1", "T2"],
      status: "assigned",
      assignedTo: WORKER,
      attemptCount: 1,
      kind: "distill",
      reviews: ["T1", "T2"],
      distillOf: "R1",
    } as Task;
    const board = makeBoard([t1, t2, originatingReview, distill]);
    primeWorkerForReview(
      "R1d",
      '```hydra-result\n{"summary":"both wrong direction",' +
      '"findings":[{"claim":"both miss the contract","sources":["T1","T2"],"verdict":"drop","evidence":"T1:hunk 1; T2:hunk 1"}],' +
      '"recommended_action":"new-work","rework_brief":"start over with the new spec"}\n```',
    );
    await complete(board, distill);
    await settle();

    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "superseded");
    assert.equal(board.tasks.find((t) => t.id === "T2")!.status, "superseded");
    assert.equal(board.tasks.find((t) => t.id === "R1d")!.status, "done");
    const spawned = board.tasks.find((t) => t.id === "R1dw");
    assert.ok(spawned);
    assert.equal(spawned!.what, "start over with the new spec");
  });

  it("distill max-attempts fails all reviewees with canonical feedback and marks distill failed", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const distill: Task = {
      id: "R1d",
      title: "distill R1",
      deps: ["T1", "T2"],
      status: "assigned",
      assignedTo: WORKER,
      attemptCount: 1,
      kind: "distill",
      reviews: ["T1", "T2"],
      distillOf: "R1",
    } as Task;
    const board = makeBoard([t1, t2, distill]);

    // Invoke the private failure handler directly — this is the entry
    // point the dispatcher uses when a distill task exhausts its
    // reprompt budget on malformed/unciteable output.
    await (bridge as unknown as {
      handleDistillFailure: (t: Task, b: Board, sid: string) => void;
    }).handleDistillFailure(distill, board, ORCH);

    const t1After = board.tasks.find((t) => t.id === "T1")!;
    const t2After = board.tasks.find((t) => t.id === "T2")!;
    const distillAfter = board.tasks.find((t) => t.id === "R1d")!;
    const expected = "distill R1d: max attempts exceeded";
    assert.equal(t1After.status, "failed");
    assert.equal(t2After.status, "failed");
    assert.deepEqual(t1After.reviewFeedback, [expected]);
    assert.deepEqual(t2After.reviewFeedback, [expected]);
    assert.equal(distillAfter.status, "failed");
  });

  it("non-winner decision on a competition fails all reviewees; dependent stays blocked", async () => {
    const t1 = workTask("T1");
    const t2 = workTask("T2");
    const rev = reviewTask("R1", ["T1", "T2"]);
    const dep = workTask("T4", { deps: ["T1"], status: "pending", artifacts: undefined });
    const board = makeBoard([t1, t2, rev, dep]);
    // approve on a competition is reviewer error → routed to winner handler
    // with no valid winnerId → all reviewees fail.
    primeWorkerForReview(
      "R1",
      '```hydra-result\n{"decision":"approve","notes":"both fine"}\n```',
    );

    await complete(board, rev);
    await settle();

    const w1 = board.tasks.find((t) => t.id === "T1")!;
    const w2 = board.tasks.find((t) => t.id === "T2")!;
    assert.equal(w1.status, "failed");
    assert.equal(w2.status, "failed");
    // A failed dependency does NOT satisfy dependents.
    assert.equal(pickEligible(board), undefined, "dependent on a failed reviewee must stay blocked");
  });
});
