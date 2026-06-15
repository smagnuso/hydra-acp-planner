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

// Tests that worker sessions spawned via spawnTaskOnNewWorker are
// attached as regular ACP clients (session/attach) but NEVER receive
// a hydra-acp/transformer/attach call. This locks in the invariant
// established by T4/T5: workers use attachAsClient, not the transformer
// attach path that orchestrator sessions use.

interface RecordedRequest {
  method: string;
  params: unknown;
}
interface RecordedReply {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

class FakeClient extends EventEmitter implements BridgeClient {
  requests: RecordedRequest[] = [];
  replies: RecordedReply[] = [];
  responders = new Map<string, (params: unknown) => unknown>();
  defaultRequestResult: unknown = {};

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    this.requests.push({ method, params });
    const responder = this.responders.get(method);
    const result = responder ? responder(params) : this.defaultRequestResult;
    return Promise.resolve(result as R);
  }
  reply(id: string | number, result: unknown): void {
    this.replies.push({ id, result });
  }
  replyError(id: string | number, code: number, message: string): void {
    this.replies.push({ id, error: { code, message } });
  }
  start(): void {}
  stop(): void {}

  lastReply(): RecordedReply {
    assert.ok(this.replies.length > 0, "expected at least one reply");
    return this.replies[this.replies.length - 1]!;
  }
  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

function mkInvoke(
  id: number,
  tool: string,
  args: Record<string, unknown>,
  sessionId = "hydra_session_test",
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "hydra-acp/mcp_tools/invoke",
    params: { tool, args, sessionId },
  };
}

async function settle(times = 20) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;
let client: FakeClient;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-worker-attach-test-"));
  process.env.HOME = tmpHome;
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
  client = new FakeClient();
  bridge = new PlannerBridge({
    daemonWsUrl: "ws://unused",
    token: "unused",
    client,
    fetchSessionInfo: async (sid: string) => ({
      sessionId: sid,
      interactive: true,
    }),
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
});

function dispatch(req: ReturnType<typeof mkInvoke>) {
  (bridge as unknown as { handleRequest: (r: unknown) => void }).handleRequest(req);
}

function seedBoard(
  sessionId: string,
  opts: {
    state?: Board["state"];
    cap?: number;
    tasks?: Array<Partial<Board["tasks"][number]>>;
  } = {},
): Board {
  const b = newBoard({ description: "seed", concurrencyCap: opts.cap ?? 1 });
  b.state = opts.state ?? "ready";
  b.tasks = (opts.tasks ?? [{ id: "T1", title: "task 1", deps: [] }]).map(
    (t) => ({
      id: t.id ?? "T1",
      title: t.title ?? "task",
      deps: t.deps ?? [],
      status: t.status ?? "pending",
      attemptCount: t.attemptCount ?? 0,
      ...(t.why !== undefined ? { why: t.why } : {}),
      ...(t.what !== undefined ? { what: t.what } : {}),
      ...(t.constraints !== undefined ? { constraints: t.constraints } : {}),
      ...(t.assignedTo !== undefined ? { assignedTo: t.assignedTo } : {}),
      ...(t.agent !== undefined ? { agent: t.agent } : {}),
      ...(t.model !== undefined ? { model: t.model } : {}),
      ...(t.artifacts !== undefined ? { artifacts: t.artifacts } : {}),
      ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
      ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
    }),
  );
  boards.set(sessionId, b);
  saveBoard(b, sessionId);
  return b;
}

describe("worker attach — no transformer/attach for spawned workers", () => {
  it(
    "spawnTaskOnNewWorker: session/attach yes, hydra-acp/transformer/attach no for worker",
    async () => {
      const childSessionId = "hydra_session_worker_child_abc123";

      // Seed a ready-state board with an eligible (pending, no deps) task.
      seedBoard("hydra_session_test", {
        state: "ready",
        tasks: [{ id: "T1", title: "work item", status: "pending", deps: [] }],
      });

      // The spawn responder must be set BEFORE dispatch so that when
      // scheduleEligibleTasks → spawnTaskOnNewWorker fires, the client
      // already has a handler for hydra-acp/child_session/spawn.
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId,
      }));

      dispatch(mkInvoke(10, "start", {}));
      // Tick just enough for the guard fetch + scheduler + spawn to
      // complete. settle(20) would let the FakeClient's instant
      // responses run the task to completion and flip state to "done".
      await settle(7);

      // The board should have transitioned to running.
      const board = boards.get("hydra_session_test")!;
      assert.equal(board.state, "running");

      // Verify the worker was claimed.
      assert.ok(
        board.workers[childSessionId],
        "expected worker entry for spawned session",
      );
      const task1 = board.tasks.find((t) => t.id === "T1")!;
      assert.equal(task1.status, "assigned");
      assert.equal(task1.assignedTo, childSessionId);

      // Assert (b): zero hydra-acp/transformer/attach calls for the worker.
      const transformerAttaches = client.requestsFor(
        "hydra-acp/transformer/attach",
      );
      const workerTransformerAttach = transformerAttaches.find(
        (r) => (r.params as { sessionId?: string }).sessionId === childSessionId,
      );
      assert.equal(
        workerTransformerAttach,
        undefined,
        "worker session must NOT have hydra-acp/transformer/attach",
      );

      // Assert (c): at least one session/attach for the worker.
      const sessionAttaches = client.requestsFor("session/attach");
      const workerSessionAttach = sessionAttaches.find(
        (r) => (r.params as { sessionId?: string }).sessionId === childSessionId,
      );
      assert.ok(
        workerSessionAttach,
        "expected session/attach for the spawned worker",
      );

      // Additional sanity: verify message/emit was sent to the worker.
      const emits = client.requestsFor("hydra-acp/message/emit");
      const workerEmit = emits.find(
        (r) => (r.params as { sessionId?: string }).sessionId === childSessionId,
      );
      assert.ok(
        workerEmit,
        "expected hydra-acp/message/emit for the spawned worker",
      );
      const emitParams = workerEmit!.params as { route?: string };
      assert.equal(emitParams.route, "chain");
    },
  );

  it(
    "spawnTaskOnNewWorker: board entering 'done' mid-spawn reverts task to pending and clears assignedTo",
    async () => {
      const childSessionId = "hydra_session_worker_done_xyz789";

      seedBoard("hydra_session_test", {
        state: "ready",
        tasks: [{ id: "T1", title: "work item", status: "pending", deps: [] }],
      });

      // Deferred spawn responder so we can flip board.state to "done"
      // before the spawn resolves and the post-spawn guard runs.
      let resolveSpawn!: (v: { childSessionId: string }) => void;
      const spawnPromise = new Promise<{ childSessionId: string }>((res) => {
        resolveSpawn = res;
      });
      client.responders.set("hydra-acp/child_session/spawn", () => spawnPromise);

      dispatch(mkInvoke(11, "start", {}));
      await settle();

      const board = boards.get("hydra_session_test")!;
      // Synchronous claim should have happened by now.
      const task1 = board.tasks.find((t) => t.id === "T1")!;
      assert.equal(task1.status, "assigned");

      // Board enters a terminal state while spawn is still pending.
      board.state = "done";

      resolveSpawn({ childSessionId });
      await settle();

      // Task claim must have been reverted.
      assert.equal(task1.status, "pending", "task must revert to pending");
      assert.equal(task1.assignedTo, null, "assignedTo must be cleared");
      assert.equal(task1.startedAt, null, "startedAt must be cleared");
      // No worker entry should have been recorded for the abandoned spawn.
      assert.equal(
        board.workers[childSessionId],
        undefined,
        "no worker entry for abandoned spawn",
      );
      // The aborted worker session should have been closed.
      const closes = client.requestsFor("hydra-acp/child_session/close");
      assert.ok(
        closes.find(
          (r) =>
            (r.params as { childSessionId?: string }).childSessionId ===
            childSessionId,
        ),
        "expected hydra-acp/child_session/close for aborted worker",
      );
      // No task prompt should have been emitted to the worker.
      const emits = client.requestsFor("hydra-acp/message/emit");
      const workerEmit = emits.find(
        (r) => (r.params as { sessionId?: string }).sessionId === childSessionId,
      );
      assert.equal(
        workerEmit,
        undefined,
        "must not emit task prompt to abandoned worker",
      );
    },
  );
});
