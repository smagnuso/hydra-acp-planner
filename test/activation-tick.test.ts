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
  pendingActivation,
  type BridgeClient,
} from "../src/bridge.ts";
import { newBoard, saveBoard } from "../src/board.ts";

// Regression for T7: the 3s activation interval must not start a new
// tickActivation pass while a previous one is still awaiting
// tryActivateBoard. Otherwise slow networks / large pending lists
// cause duplicate transformer/attach + session/load + resume prompts
// on the same orchestrator.

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
let bridge: PlannerBridge;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-activation-tick-test-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  pendingActivation.clear();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client: new FakeClient(),
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  pendingActivation.clear();
});

describe("activation tick — no concurrent self-overlap", () => {
  it("skips subsequent ticks while a prior tryActivateBoard is in flight", async () => {
    const orchestratorId = "hydra_session_orch_slow_activate";
    const board = newBoard({ description: "slow", concurrencyCap: 1 });
    boards.set(orchestratorId, board);
    saveBoard(board, orchestratorId);
    pendingActivation.add(orchestratorId);

    // Slow tryActivateBoard: never resolves on its own — we control
    // resolution from the test to assert overlap behavior.
    let calls = 0;
    let resolve!: () => void;
    const slow = new Promise<void>((res) => {
      resolve = res;
    });
    (bridge as unknown as {
      tryActivateBoard: (s: string, b: unknown) => Promise<void>;
    }).tryActivateBoard = () => {
      calls += 1;
      return slow;
    };

    const runTick = (bridge as unknown as { runActivationTick: () => void })
      .runActivationTick.bind(bridge);

    runTick();
    runTick();
    runTick();
    await Promise.resolve();

    assert.equal(
      calls,
      1,
      "overlapping ticks must not start additional tryActivateBoard invocations",
    );

    resolve();
    // Drain microtasks so the .finally() clears the in-flight guard.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    runTick();
    await Promise.resolve();
    assert.equal(
      calls,
      2,
      "once the prior tick settles, the next interval may start a new pass",
    );
  });
});
