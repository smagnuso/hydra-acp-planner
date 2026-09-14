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
import { newBoard, saveBoard, shortProjectId, type Board } from "../src/board.ts";

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
  // os.homedir() reads USERPROFILE on Windows and HOME
  // everywhere else, so redirecting only HOME leaves the
  // code under test writing into the real profile.
  process.env.USERPROFILE = process.env.HOME;
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
  // os.homedir() reads USERPROFILE on Windows and HOME
  // everywhere else, so redirecting only HOME leaves the
  // code under test writing into the real profile.
  process.env.USERPROFILE = process.env.HOME;
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
      ...(t.kind !== undefined ? { kind: t.kind } : {}),
      ...(t.reviews !== undefined ? { reviews: t.reviews } : {}),
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
      assert.equal(task1.status, "running");
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
      assert.equal(emitParams.route, "queue");
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

  it(
    "spawnTaskOnNewWorker: omits workspace request when board.isolation is unset (default off)",
    async () => {
      const childSessionId = "hydra_session_worker_noiso_1";
      seedBoard("hydra_session_test", {
        state: "ready",
        tasks: [{ id: "T1", title: "work item", status: "pending", deps: [] }],
      });
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId,
      }));

      dispatch(mkInvoke(12, "start", {}));
      await settle(7);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      assert.equal(spawns.length, 1);
      const meta = (spawns[0]!.params as { _meta?: { "hydra-acp"?: Record<string, unknown> } })
        ._meta?.["hydra-acp"];
      assert.equal(meta?.workspace, undefined);

      const board = boards.get("hydra_session_test")!;
      assert.equal(board.tasks.find((t) => t.id === "T1")!.workspace, undefined);
    },
  );

  it(
    "spawnTaskOnNewWorker: no workspace for a LINEAR plan, even with isolation on",
    async () => {
      // The scoping rule: isolation buys keeping concurrent writers off
      // each other, so a chain that can never produce two at once gets
      // none of it and behaves exactly as an unisolated run.
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 4,
        tasks: [
          { id: "T1", title: "first", status: "pending", deps: [] },
          { id: "T2", title: "second", status: "pending", deps: ["T1"] },
        ],
      });
      board.isolation = { mode: "per-task" };
      saveBoard(board, "hydra_session_test");
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: "hydra_session_worker_linear_1",
      }));

      dispatch(mkInvoke(12, "start", {}));
      await settle(10);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      assert.ok(spawns.length >= 1, "the head of the chain should have spawned");
      for (const s of spawns) {
        const meta = (s.params as { _meta?: { "hydra-acp"?: Record<string, unknown> } })
          ._meta?.["hydra-acp"];
        assert.equal(meta?.workspace, undefined, "a chain needs no isolation");
      }
    },
  );

  it(
    "spawnTaskOnNewWorker: isolates overlapping work tasks, with project-scoped labels",
    async () => {
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 2,
        tasks: [
          { id: "T1", title: "one", status: "pending", deps: [] },
          { id: "T2", title: "two", status: "pending", deps: [] },
        ],
      });
      board.isolation = { mode: "per-task" };
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: `hydra_session_worker_iso_${n++}`,
      }));

      dispatch(mkInvoke(13, "start", {}));
      // Isolated creations serialize on the integration-tree queue, so a
      // second spawn is several promise hops behind the first.
      await settle(30);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      assert.equal(spawns.length, 2, "both independent tasks should have spawned");
      const short = shortProjectId(boards.get("hydra_session_test")!.projectId);
      const labels = spawns.map((s) => {
        const meta = (s.params as {
          _meta?: { "hydra-acp"?: { workspace?: { label?: string } } };
        })._meta?.["hydra-acp"];
        assert.ok(meta?.workspace, "an overlapping work task must be isolated");
        return meta!.workspace!.label;
      });
      // Project-scoped: a bare task id would collide with another plan's
      // T1 in the same repo, and the collision is silent.
      assert.deepEqual(labels.sort(), [`${short}-T1`, `${short}-T2`]);
    },
  );

  it(
    "spawnTaskOnNewWorker: a review of an UNISOLATED task gets no workspace of its own",
    async () => {
      // A review never provisions a tree of its own. When the task it
      // reviews is isolated it joins THAT tree (covered separately);
      // when the reviewee is unisolated, as here, there is nothing to
      // join and the review runs where everything else does.
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 3,
        tasks: [
          { id: "T1", title: "one", status: "awaiting_review", deps: [] },
          { id: "T2", title: "two", status: "pending", deps: [] },
          {
            id: "R1",
            title: "review T1",
            status: "pending",
            deps: ["T1"],
            kind: "review",
            reviews: "T1",
            runOn: "worker",
          },
        ],
      });
      board.isolation = { mode: "per-task" };
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: `hydra_session_worker_rev_${n++}`,
      }));

      dispatch(mkInvoke(14, "start", {}));
      await settle(10);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      const short = shortProjectId(boards.get("hydra_session_test")!.projectId);
      for (const s of spawns) {
        const p = s.params as {
          _meta?: { "hydra-acp"?: { title?: string; workspace?: { label?: string } } };
        };
        const meta = p._meta?.["hydra-acp"];
        if (meta?.title?.startsWith("R1")) {
          assert.equal(meta.workspace, undefined, "a review must not get its own workspace");
        }
      }
      // And the work task beside it still is isolated.
      const t2 = spawns.find((s) => {
        const meta = (s.params as { _meta?: { "hydra-acp"?: { title?: string } } })._meta?.[
          "hydra-acp"
        ];
        return meta?.title?.startsWith("T2");
      });
      if (t2) {
        const meta = (t2.params as {
          _meta?: { "hydra-acp"?: { workspace?: { label?: string } } };
        })._meta?.["hydra-acp"];
        assert.equal(meta?.workspace?.label, `${short}-T2`);
      }
    },
  );

  it(
    "spawnTaskOnNewWorker: competition candidates always request required:true",
    async () => {
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 2,
        tasks: [
          { id: "T1", title: "candidate 1", status: "pending", deps: [] },
          { id: "T2", title: "candidate 2", status: "pending", deps: [] },
          {
            id: "R1",
            title: "competition review",
            status: "pending",
            deps: ["T1", "T2"],
            kind: "review",
            reviews: ["T1", "T2"],
          },
        ],
      });
      board.isolation = { mode: "per-task" }; // required deliberately unset
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: `hydra_session_worker_comp_${n++}`,
      }));

      dispatch(mkInvoke(15, "start", {}));
      await settle(30);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      assert.equal(spawns.length, 2, "both competition candidates should have spawned");
      for (const s of spawns) {
        const meta = (s.params as {
          _meta?: { "hydra-acp"?: { workspace?: Record<string, unknown> } };
        })._meta?.["hydra-acp"];
        assert.equal(meta?.workspace?.required, true, "candidates must fail closed");
      }
    },
  );

  it(
    "spawnTaskOnNewWorker: a RETRY rejoins its own workspace instead of orphaning it",
    async () => {
      // Asking for the same label without adopt would hand back a
      // suffixed, EMPTY workspace and strand the first attempt's work —
      // silently, since the daemon suffixes rather than failing.
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 2,
        tasks: [
          { id: "T1", title: "one", status: "pending", deps: [] },
          { id: "T2", title: "two", status: "pending", deps: [] },
        ],
      });
      board.isolation = { mode: "per-task" };
      // As if a previous attempt already ran.
      board.tasks[0]!.workspace = {
        path: "/tmp/ws/p-T1",
        sourceCwd: "/tmp/repo",
        label: "p-T1",
        provider: "git",
      };
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: `hydra_session_worker_retry_${n++}`,
      }));

      dispatch(mkInvoke(17, "start", {}));
      await settle(10);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      const t1Spawn = spawns.find((sp) => {
        const meta = (sp.params as { _meta?: { "hydra-acp"?: { title?: string } } })._meta?.[
          "hydra-acp"
        ];
        return meta?.title?.startsWith("T1");
      });
      assert.ok(t1Spawn, "T1 should have spawned");
      const ws = (t1Spawn!.params as {
        _meta?: { "hydra-acp"?: { workspace?: Record<string, unknown> } };
      })._meta?.["hydra-acp"]?.workspace;
      assert.equal(ws?.label, "p-T1", "must rejoin the existing label");
      assert.equal(ws?.adopt, true, "must adopt, not create");
    },
  );

  it(
    "spawnTaskOnNewWorker: a REVIEW joins the workspace of the task it reviews",
    async () => {
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 3,
        tasks: [
          { id: "T1", title: "one", status: "awaiting_review", deps: [] },
          {
            id: "R1",
            title: "review T1",
            status: "pending",
            deps: ["T1"],
            kind: "review",
            reviews: "T1",
          },
        ],
      });
      board.isolation = { mode: "per-task" };
      board.tasks[0]!.workspace = {
        path: "/tmp/ws/p-T1",
        sourceCwd: "/tmp/repo",
        label: "p-T1",
        provider: "git",
      };
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", () => ({
        childSessionId: `hydra_session_worker_rev2_${n++}`,
      }));

      dispatch(mkInvoke(18, "start", {}));
      await settle(10);

      const spawns = client.requestsFor("hydra-acp/child_session/spawn");
      const r1 = spawns.find((sp) => {
        const meta = (sp.params as { _meta?: { "hydra-acp"?: { title?: string } } })._meta?.[
          "hydra-acp"
        ];
        return meta?.title?.startsWith("R1");
      });
      assert.ok(r1, "the review should have spawned (forced onto the worker lane)");
      const ws = (r1!.params as {
        _meta?: { "hydra-acp"?: { workspace?: Record<string, unknown> } };
      })._meta?.["hydra-acp"]?.workspace;
      assert.equal(ws?.label, "p-T1", "the reviewer must be in the reviewee's tree");
      assert.equal(ws?.adopt, true);
    },
  );

  it(
    "spawnTaskOnNewWorker: surfaces a workspace label collision instead of accepting it",
    async () => {
      // createWorkspace SUFFIXES a taken label rather than failing, so a
      // collision hands back a valid but empty workspace and the only
      // signal is the label coming back different.
      const board = seedBoard("hydra_session_test", {
        state: "ready",
        cap: 2,
        tasks: [
          { id: "T1", title: "one", status: "pending", deps: [] },
          { id: "T2", title: "two", status: "pending", deps: [] },
        ],
      });
      board.isolation = { mode: "per-task" };
      saveBoard(board, "hydra_session_test");
      let n = 0;
      client.responders.set("hydra-acp/child_session/spawn", (params) => {
        const asked = (params as {
          _meta?: { "hydra-acp"?: { workspace?: { label?: string } } };
        })._meta?.["hydra-acp"]?.workspace?.label;
        return {
          childSessionId: `hydra_session_worker_collide_${n++}`,
          _meta: {
            "hydra-acp": {
              workspaceInfo: {
                path: "/tmp/ws",
                sourceCwd: "/tmp/repo",
                // The daemon's suffix-on-collision behavior.
                label: `${asked}-2`,
                provider: "git",
              },
            },
          },
        };
      });

      dispatch(mkInvoke(16, "start", {}));
      await settle(10);

      const emits = client.requestsFor("hydra-acp/message/emit");
      const collisionNote = emits.find((r) =>
        JSON.stringify(r.params).includes("was already taken"),
      );
      assert.ok(collisionNote, "a label collision must be surfaced, not silently accepted");
    },
  );
});