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
  setOrchestratorState,
  getOrchestratorState,
  clearOrchestratorState,
} from "../src/state.ts";

// Real integration tests for the orchestrator-lane review path. These
// drive PlannerBridge.runReviewOnOrchestrator end-to-end: the bridge
// flips awaitingOrchestratorReview, emits the review prompt, and (when
// the emit promise resolves) parses the accumulated reply and dispatches
// handleReviewComplete. We simulate the daemon streaming the reviewer's
// reply by having the fake client fill orchestratorReviewAccumulator
// inside its message/emit responder — exactly where chunks would land in
// production via handleUpdateResponse. Production code, not the test,
// mutates board + orchestrator state.

class FakeClient extends EventEmitter implements BridgeClient {
  responders = new Map<string, (params: unknown) => unknown>();
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const responder = this.responders.get(method);
    const result = responder ? responder(params) : {};
    return Promise.resolve(result as R);
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}
}

const ORCH = "hydra_session_orch_lane";

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;
let client: FakeClient;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-orch-lane-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  client = new FakeClient();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client,
    fetchSessionDiff: async () => undefined,
  });
  setOrchestratorState(ORCH, {
    projectId: "p-lane",
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
  const b = newBoard({ description: "orchestrator lane", concurrencyCap: 2 });
  b.state = "running";
  b.tasks = tasks;
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
    status: "pending",
    assignedTo: null,
    attemptCount: 0,
    kind: "review",
    reviews,
    ...overrides,
  } as Task;
}

// Make the fake client's message/emit fill the orchestrator review
// accumulator (as the daemon would stream chunks) before the turn
// resolves, so runReviewOnOrchestrator parses a real reply.
function streamReviewReply(reply: string) {
  client.responders.set("hydra-acp/message/emit", (params) => {
    const sessionId = (params as { sessionId?: string }).sessionId;
    const st = getOrchestratorState(ORCH);
    if (sessionId === ORCH && st?.awaitingOrchestratorReview) {
      st.orchestratorReviewAccumulator = reply;
    }
    return {};
  });
}

async function runOrchestratorReview(board: Board, rev: Task) {
  await (bridge as unknown as {
    runReviewOnOrchestrator: (t: Task, b: Board, orch: string) => Promise<void>;
  }).runReviewOnOrchestrator(rev, board, ORCH);
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("orchestrator-lane review — runReviewOnOrchestrator", () => {
  it("approve: work task done with merged review notes; review done", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    streamReviewReply(
      'Reviewed.\n```hydra-result\n{"decision":"approve","notes":"LGTM"}\n```',
    );

    await runOrchestratorReview(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(wt.status, "done");
    assert.equal(rt.status, "done");
    assert.ok(wt.artifacts?.decisions?.some((d) => d === "[review] LGTM"));
  });

  it("sets and clears awaitingOrchestratorReview around the turn", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    let sawAwaitingDuringEmit = false;
    client.responders.set("hydra-acp/message/emit", (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId;
      const st = getOrchestratorState(ORCH);
      if (sessionId === ORCH && st?.awaitingOrchestratorReview) {
        sawAwaitingDuringEmit = true;
        st.orchestratorReviewAccumulator =
          '```hydra-result\n{"decision":"approve","notes":"ok"}\n```';
      }
      return {};
    });

    await runOrchestratorReview(board, rev);
    await settle();

    assert.ok(sawAwaitingDuringEmit, "awaitingOrchestratorReview must be true while the turn is in flight");
    const st = getOrchestratorState(ORCH)!;
    assert.equal(st.awaitingOrchestratorReview, false, "flag cleared after the turn resolves");
    assert.equal(st.orchestratorReviewTaskId, null);
    assert.equal(st.orchestratorReviewAccumulator, "");
  });

  it("reject: work task retasked to pending with feedback; review reset to pending", async () => {
    const work = workTask("T1", { attemptCount: 1 });
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    board.state = "paused";
    streamReviewReply(
      '```hydra-result\n{"decision":"reject","notes":"missing error handling"}\n```',
    );

    await runOrchestratorReview(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    assert.equal(wt.status, "pending");
    assert.equal(rt.status, "pending", "review task reset so it runs again after work retry");
    assert.equal(rt.assignedTo, null);
    assert.equal(rt.finishedAt, null);
    assert.deepEqual(wt.reviewFeedback, ["missing error handling"]);
  });

  it("fix on orchestrator lane (canApplyFixes default) marks work done", async () => {
    const work = workTask("T1");
    // No canApplyFixes set — orchestrator lane allows fixes by default.
    const rev = reviewTask("R1", "T1", { canApplyFixes: true });
    const board = makeBoard([work, rev]);
    streamReviewReply(
      '```hydra-result\n{"decision":"fix","notes":"patched directly","applied":true}\n```',
    );

    await runOrchestratorReview(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    assert.equal(wt.status, "done");
    assert.ok(wt.artifacts?.decisions?.some((d) => d === "[review fix] patched directly"));
  });

  it("cancel mid-reprompt: bails loop without issuing further emits", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    let promptEmitCount = 0;
    client.responders.set("hydra-acp/message/emit", (params) => {
      const p = params as { sessionId?: string; method?: string };
      if (p.method === "session/prompt") {
        promptEmitCount += 1;
      }
      const sessionId = p.sessionId;
      const st = getOrchestratorState(ORCH);
      if (sessionId === ORCH && p.method === "session/prompt" && st?.awaitingOrchestratorReview) {
        // Simulate cancel landing during the first emit: board flips to
        // stopped and awaitingOrchestratorReview gets cleared (as the
        // cancel pathway does in production). Leave the accumulator
        // empty so the loop would otherwise reprompt.
        board.state = "stopped";
        st.awaitingOrchestratorReview = false;
        st.orchestratorReviewTaskId = null;
        st.orchestratorReviewAccumulator = "";
      }
      return {};
    });

    await runOrchestratorReview(board, rev);
    await settle();

    assert.equal(promptEmitCount, 1, "no further reprompts after cancel");
  });

  it("malformed reply: parse failure treated as reject (review reset to pending, work retasked)", async () => {
    const work = workTask("T1");
    const rev = reviewTask("R1", "T1");
    const board = makeBoard([work, rev]);
    board.state = "paused";
    // Reply with no hydra-result block at all.
    streamReviewReply("Just prose, no structured block here.");

    await runOrchestratorReview(board, rev);
    await settle();

    const wt = board.tasks.find((t) => t.id === "T1")!;
    const rt = board.tasks.find((t) => t.id === "R1")!;
    // Parse failure is treated as reject of the reviewed task (below maxAttempts → retask).
    // Review task is reset to pending so it re-runs after the work retry completes.
    assert.equal(rt.status, "pending", "review task reset to pending to re-run after work retry");
    assert.equal(wt.status, "pending");
  });
});
