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
import { newBoard, type Board } from "../src/board.ts";
import type { SessionInfo } from "../src/util/session-info.ts";

class FakeClient extends EventEmitter implements BridgeClient {
  request<R = unknown>(): Promise<R> {
    return Promise.resolve({} as R);
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}
}

let originalHome: string;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-seed-test-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
});

function mkBoard(): Board {
  // Intentionally leave orchestratorAgent/orchestratorModel unset so tests
  // exercise the same starting state as a freshly-created production board
  // (newBoard / forkBoard leave them undefined, not null).
  return newBoard({ description: "seed", concurrencyCap: 1 });
}

function mkBridge(
  fetchSessionInfo: (sid: string) => Promise<SessionInfo | undefined>,
): PlannerBridge {
  return new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client: new FakeClient(),
    fetchSessionInfo,
  });
}

function callSeed(
  bridge: PlannerBridge,
  board: Board,
  sessionId: string,
): Promise<void> {
  return (bridge as unknown as {
    seedOrchestratorIdentity: (b: Board, s: string) => Promise<void>;
  }).seedOrchestratorIdentity(board, sessionId);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("seedOrchestratorIdentity retry", () => {
  it("retries when initial fetch returns empty agentId/currentModel", async () => {
    let calls = 0;
    const bridge = mkBridge(async (sid) => {
      calls++;
      if (calls === 1) {
        return { sessionId: sid, agentId: "", currentModel: "" };
      }
      return { sessionId: sid, agentId: "X", currentModel: "Y" };
    });
    const board = mkBoard();
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    assert.ok(!board.orchestratorAgent);
    assert.ok(!board.orchestratorModel);
    await waitMs(700);
    assert.equal(board.orchestratorAgent, "X");
    assert.equal(board.orchestratorModel, "Y");
    assert.ok(calls >= 2);
  });

  it("does not crash when fetch returns undefined on every attempt", async () => {
    let calls = 0;
    const bridge = mkBridge(async () => {
      calls++;
      return undefined;
    });
    const board = mkBoard();
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    await waitMs(100);
    assert.ok(!board.orchestratorAgent);
    assert.ok(!board.orchestratorModel);
    // Undefined is treated as a definitive empty response — no retries.
    assert.equal(calls, 1);
  });

  it("does not retry when fetch throws", async () => {
    let calls = 0;
    const bridge = mkBridge(async () => {
      calls++;
      throw new Error("boom");
    });
    const board = mkBoard();
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    await waitMs(700);
    assert.ok(!board.orchestratorAgent);
    assert.ok(!board.orchestratorModel);
    assert.equal(calls, 1);
  });

  it("makes no extra fetches when first attempt fully succeeds", async () => {
    let calls = 0;
    const bridge = mkBridge(async (sid) => {
      calls++;
      return { sessionId: sid, agentId: "A", currentModel: "M" };
    });
    const board = mkBoard();
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    await waitMs(700);
    assert.equal(board.orchestratorAgent, "A");
    assert.equal(board.orchestratorModel, "M");
    assert.equal(calls, 1);
  });

  it("preserves partial progress: writes agentId once it arrives and keeps retrying for model", async () => {
    let calls = 0;
    const bridge = mkBridge(async (sid) => {
      calls++;
      if (calls === 1) return { sessionId: sid, agentId: "", currentModel: "" };
      if (calls === 2) return { sessionId: sid, agentId: "A", currentModel: "" };
      return { sessionId: sid, agentId: "A", currentModel: "M" };
    });
    const board = mkBoard();
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    await waitMs(1300);
    assert.equal(board.orchestratorAgent, "A");
    assert.equal(board.orchestratorModel, "M");
    assert.ok(calls >= 3);
  });

  it("does not clobber already-populated fields", async () => {
    const bridge = mkBridge(async (sid) => ({
      sessionId: sid,
      agentId: "NEW",
      currentModel: "NEW",
    }));
    const board = mkBoard();
    board.orchestratorAgent = "EXISTING_A";
    board.orchestratorModel = "EXISTING_M";
    boards.set("hydra_session_test", board);
    await callSeed(bridge, board, "hydra_session_test");
    assert.equal(board.orchestratorAgent, "EXISTING_A");
    assert.equal(board.orchestratorModel, "EXISTING_M");
  });
});
