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
import { newBoard, saveBoard, type Board } from "../src/board.ts";
import { registerWorker, unregisterWorker } from "../src/state.ts";

// T1: Reactive session_info_update / current_model_update events on
// worker sessions must update board.workers[wid].agent / .model. Mirrors
// the orchestrator-side reactive path (handleUpdateResponse) for slow-
// starting agents whose currentModel doesn't materialize for minutes.

interface RecordedReply {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

class FakeClient extends EventEmitter implements BridgeClient {
  replies: RecordedReply[] = [];
  requests: Array<{ method: string; params: unknown }> = [];
  defaultRequestResult: unknown = {};
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    this.requests.push({ method, params });
    return Promise.resolve(this.defaultRequestResult as R);
  }
  reply(id: string | number, result: unknown): void {
    this.replies.push({ id, result });
  }
  replyError(id: string | number, code: number, message: string): void {
    this.replies.push({ id, error: { code, message } });
  }
  start(): void {}
  stop(): void {}
}

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;
let client: FakeClient;

const ORCH = "hydra_session_orch";
const WORKER = "hydra_session_worker_a";

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-reactive-test-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  client = new FakeClient();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client,
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  unregisterWorker(WORKER);
});

function seedBoardWithWorker(opts: {
  agent?: string | null;
  model?: string | null;
} = {}): Board {
  const b = newBoard({ description: "seed", concurrencyCap: 1 });
  b.state = "ready";
  b.tasks = [{ id: "T1", title: "task", deps: [], status: "pending", attemptCount: 0 }];
  b.workers[WORKER] = {
    currentTaskId: "T1",
    tasksCompleted: [],
    agent: opts.agent ?? null,
    model: opts.model ?? null,
  };
  boards.set(ORCH, b);
  saveBoard(b, ORCH);
  registerWorker(WORKER, ORCH);
  return b;
}

function dispatchUpdate(sessionId: string, envelope: unknown, id = 100): void {
  (bridge as unknown as { handleRequest: (r: unknown) => void }).handleRequest({
    jsonrpc: "2.0",
    id,
    method: "hydra-acp/transformer/message",
    params: {
      phase: "response",
      method: "session/update",
      sessionId,
      envelope,
    },
  });
}

function sessionInfoUpdate(agentId: string): unknown {
  return {
    update: {
      sessionUpdate: "session_info_update",
      _meta: { "hydra-acp": { agentId } },
    },
  };
}

function currentModelUpdate(currentModel: string): unknown {
  return {
    update: {
      sessionUpdate: "current_model_update",
      currentModel,
    },
  };
}

describe("worker reactive session-update handler", () => {
  it("session_info_update for a worker session updates worker.agent", () => {
    const board = seedBoardWithWorker({ agent: null, model: "m" });
    dispatchUpdate(WORKER, sessionInfoUpdate("opencode-local"));
    assert.equal(board.workers[WORKER].agent, "opencode-local");
    assert.equal(board.workers[WORKER].model, "m");
  });

  it("current_model_update for a worker session updates worker.model", () => {
    const board = seedBoardWithWorker({ agent: "a", model: null });
    dispatchUpdate(WORKER, currentModelUpdate("llama-3"));
    assert.equal(board.workers[WORKER].model, "llama-3");
    assert.equal(board.workers[WORKER].agent, "a");
  });

  it("current_model_update for an unknown session: no crash, no board write", () => {
    seedBoardWithWorker({ agent: "a", model: "m" });
    const before = JSON.stringify(boards.get(ORCH));
    dispatchUpdate("hydra_session_unknown_xyz", currentModelUpdate("nope"));
    const after = JSON.stringify(boards.get(ORCH));
    assert.equal(before, after);
  });

  it("current_model_update with empty-string model: no update applied", () => {
    const board = seedBoardWithWorker({ agent: "a", model: "m" });
    dispatchUpdate(WORKER, currentModelUpdate(""));
    assert.equal(board.workers[WORKER].model, "m");
  });

  it("current_model_update where model matches persisted value: no spurious emit", () => {
    const board = seedBoardWithWorker({ agent: "a", model: "same" });
    const emitsBefore = client.requests.filter(
      (r) => r.method === "hydra-acp/message/emit",
    ).length;
    dispatchUpdate(WORKER, currentModelUpdate("same"));
    assert.equal(board.workers[WORKER].model, "same");
    const emitsAfter = client.requests.filter(
      (r) => r.method === "hydra-acp/message/emit",
    ).length;
    assert.equal(emitsAfter, emitsBefore);
  });

  it("current_model_update after worker unregistered: no crash, no board write", () => {
    const board = seedBoardWithWorker({ agent: "a", model: "m" });
    unregisterWorker(WORKER);
    delete board.workers[WORKER];
    dispatchUpdate(WORKER, currentModelUpdate("new-model"));
    assert.equal(board.workers[WORKER], undefined);
  });

  it("orchestrator-side handling still writes orchestratorAgent / orchestratorModel", () => {
    const board = seedBoardWithWorker({ agent: "a", model: "m" });
    board.orchestratorAgent = null;
    board.orchestratorModel = null;
    dispatchUpdate(ORCH, sessionInfoUpdate("orch-agent"));
    dispatchUpdate(ORCH, currentModelUpdate("orch-model"));
    assert.equal(board.orchestratorAgent, "orch-agent");
    assert.equal(board.orchestratorModel, "orch-model");
    // Worker untouched.
    assert.equal(board.workers[WORKER].agent, "a");
    assert.equal(board.workers[WORKER].model, "m");
  });
});
