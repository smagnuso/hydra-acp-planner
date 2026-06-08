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
