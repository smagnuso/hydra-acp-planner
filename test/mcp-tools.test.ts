import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
import { projectDir } from "../src/paths.ts";

// Tests for the MCP tool surface implemented in bridge.ts. We
// construct a PlannerBridge wired to a fake client so we never open
// a WebSocket. The bridge's `client.on("open")` listener — which
// triggers registerCommands/registerMcpTools/rehydrateFromDisk —
// never fires because the fake never emits "open". That's by design:
// these tests exercise the request handlers in isolation.

interface RecordedRequest {
  method: string;
  params: unknown;
}
interface RecordedReply {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Fake BridgeClient. request() resolves with whatever the test queued
// for that method (or {} by default). reply/replyError get recorded
// so assertions can inspect the CallToolResult envelope. Implements
// EventEmitter for the bridge's on() wiring — we never emit, but the
// listeners need somewhere to attach.
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

  // Convenience for tests
  lastReply(): RecordedReply {
    assert.ok(this.replies.length > 0, "expected at least one reply");
    return this.replies[this.replies.length - 1]!;
  }
  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

// Build a request envelope for invoking an MCP tool. The dispatcher
// is hydra-acp/mcp_tools/invoke; params carry the tool name + args
// + sessionId.
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

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;
let client: FakeClient;

// Drain microtasks. Tool handlers that fire `void this.client.request(...)`
// schedule promise callbacks; tests assert on side effects (like recorded
// requests) that may not have settled yet. Waiting a couple of
// macrotask boundaries is enough — no internal timers are armed.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-mcp-test-"));
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
});

// Direct-invoke private dispatcher.
function dispatch(req: ReturnType<typeof mkInvoke>) {
  (bridge as unknown as { handleRequest: (r: unknown) => void }).handleRequest(req);
}

// Seed a ready-state board into memory + disk so tests for tools that
// require a board (get_plan, get_status, start, pause, etc.) have
// something to operate on. Tasks are simple T1 / T2 with no deps.
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

// ── Dispatcher ─────────────────────────────────────────────────────

describe("handleMcpToolInvoke dispatcher", () => {
  it("returns isError when sessionId is missing", async () => {
    dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "hydra-acp/mcp_tools/invoke",
      params: { tool: "planner_list_agents", args: {} },
    });
    await settle();
    const r = client.lastReply();
    assert.equal(r.id, 1);
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /missing sessionId/);
  });

  it("returns isError for an unknown tool name", async () => {
    dispatch(mkInvoke(2, "planner_does_not_exist", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /unknown planner tool: planner_does_not_exist/);
  });

  it("ignores non-mcp requests with method-not-found", () => {
    (bridge as unknown as { handleRequest: (r: unknown) => void }).handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "some/other/method",
    });
    const r = client.lastReply();
    assert.equal(r.id, 3);
    assert.equal(r.error?.code, -32601);
  });
});

// ── planner_list_agents ────────────────────────────────────────────

describe("planner_list_agents", () => {
  it("returns no-agents text when daemon reports none installed", async () => {
    client.responders.set("hydra-acp/agents/list", () => ({ agents: [] }));
    dispatch(mkInvoke(10, "planner_list_agents", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }>; structuredContent: { agents: unknown[] } };
    assert.match(result.content[0]!.text, /No agents are installed/);
    assert.deepEqual(result.structuredContent.agents, []);
  });

  it("lists installed agents with descriptions and skips installed!=yes", async () => {
    client.responders.set("hydra-acp/agents/list", () => ({
      agents: [
        { id: "code-claude", description: "Claude code agent", installed: "yes" },
        { id: "code-gemini", description: "Gemini code agent", installed: "yes" },
        { id: "shadow-only", description: "not installed", installed: "no" },
        { id: 42, description: "bogus", installed: "yes" }, // non-string id
      ],
    }));
    dispatch(mkInvoke(11, "planner_list_agents", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }>; structuredContent: { agents: Array<{ id: string }> } };
    assert.equal(result.structuredContent.agents.length, 2);
    assert.deepEqual(
      result.structuredContent.agents.map((a) => a.id),
      ["code-claude", "code-gemini"],
    );
    assert.match(result.content[0]!.text, /code-claude — Claude code agent/);
    assert.match(result.content[0]!.text, /code-gemini — Gemini code agent/);
  });
});

// ── planner_set_plan ───────────────────────────────────────────────

describe("planner_set_plan", () => {
  it("errors when description is missing", async () => {
    dispatch(mkInvoke(20, "planner_set_plan", { tasks: [{ id: "T1", title: "x" }] }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /missing required `description`/);
  });

  it("errors when tasks is not a non-empty array", async () => {
    dispatch(mkInvoke(21, "planner_set_plan", { description: "x", tasks: [] }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /`tasks` must be a non-empty array/);
  });

  it("errors when no task survives validation", async () => {
    // No id, no title — normalizeDecomposition drops it; result is empty.
    dispatch(
      mkInvoke(22, "planner_set_plan", {
        description: "x",
        tasks: [{ deps: ["nowhere"] }],
      }),
    );
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /failed validation/);
  });

  it("saves a ready plan, persists pendingExecute=false, and attaches as transformer", async () => {
    dispatch(
      mkInvoke(23, "planner_set_plan", {
        description: "build a thing",
        tasks: [
          { id: "T1", title: "first", deps: [] },
          { id: "T2", title: "second", deps: ["T1"] },
        ],
        fleetDefaults: { agent: "code-claude", model: "opus" },
        concurrencyCap: 3,
      }),
    );
    await settle();
    const board = boards.get("hydra_session_test");
    assert.ok(board);
    assert.equal(board!.state, "ready");
    assert.equal(board!.tasks.length, 2);
    assert.equal(board!.concurrencyCap, 3);
    assert.equal(board!.fleetDefaults.agent, "code-claude");
    assert.equal(board!.fleetDefaults.model, "opus");
    // pendingExecute was set false by the tool, then cleared by setPlan
    // (it's `undefined` after setPlan consumes it).
    assert.notEqual(board!.pendingExecute, true);

    // Transformer attach was attempted for the orchestrator session.
    const attachCalls = client.requestsFor("hydra-acp/transformer/attach");
    assert.equal(attachCalls.length, 1);
    assert.deepEqual(attachCalls[0]!.params, { sessionId: "hydra_session_test" });

    // CallToolResult surface.
    const r = client.lastReply();
    const result = r.result as {
      content: Array<{ text: string }>;
      structuredContent: { taskCount: number; concurrencyCap: number; projectId: string };
    };
    assert.match(result.content[0]!.text, /Saved 2 tasks .* Call planner_start when ready/);
    assert.equal(result.structuredContent.taskCount, 2);
    assert.equal(result.structuredContent.concurrencyCap, 3);
    assert.equal(result.structuredContent.projectId, board!.projectId);
  });

  it("ignores non-string fleetDefaults fields and non-positive concurrencyCap", async () => {
    dispatch(
      mkInvoke(24, "planner_set_plan", {
        description: "x",
        tasks: [{ id: "T1", title: "t" }],
        fleetDefaults: { agent: 42, model: null },
        concurrencyCap: 0,
      }),
    );
    await settle();
    const board = boards.get("hydra_session_test")!;
    assert.equal(board.fleetDefaults.agent, null);
    assert.equal(board.fleetDefaults.model, null);
    // 0 → ignored → falls back to the sweep-line cap computed by setPlan.
    assert.ok(board.concurrencyCap >= 1);
  });

  it("refuses to overwrite when board is running", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(
      mkInvoke(25, "planner_set_plan", {
        description: "x",
        tasks: [{ id: "T1", title: "t" }],
      }),
    );
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /already running/);
  });

  it("refuses to overwrite when board is paused", async () => {
    seedBoard("hydra_session_test", { state: "paused" });
    dispatch(
      mkInvoke(26, "planner_set_plan", {
        description: "x",
        tasks: [{ id: "T1", title: "t" }],
      }),
    );
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /already paused/);
  });

  it("refuses to overwrite when board is decomposing", async () => {
    seedBoard("hydra_session_test", { state: "decomposing" });
    dispatch(
      mkInvoke(27, "planner_set_plan", {
        description: "x",
        tasks: [{ id: "T1", title: "t" }],
      }),
    );
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /already decomposing/);
  });

  it("cleans up the prior ready dir when replacing a ready draft", async () => {
    const old = seedBoard("hydra_session_test", { state: "ready" });
    const oldDir = projectDir(old.projectId);
    assert.equal(existsSync(oldDir), true);

    dispatch(
      mkInvoke(28, "planner_set_plan", {
        description: "replacement",
        tasks: [{ id: "T1", title: "t" }],
      }),
    );
    await settle();
    assert.equal(existsSync(oldDir), false, "old ready dir should be removed");
    const newBd = boards.get("hydra_session_test")!;
    assert.notEqual(newBd.projectId, old.projectId);

    const r = client.lastReply();
    const result = r.result as { structuredContent: { replacedReadyProjectId?: string } };
    assert.equal(result.structuredContent.replacedReadyProjectId, old.projectId);
  });
});

// ── planner_start ────────────────────────────────────────────────

describe("planner_start", () => {
  it("errors when no plan exists on the session", async () => {
    dispatch(mkInvoke(30, "planner_start", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /no plan on this session/);
  });

  it("errors when board is running, paused, done, or failed (distinct messages)", async () => {
    const cases: Array<{ state: Board["state"]; pattern: RegExp }> = [
      { state: "running", pattern: /already running/ },
      { state: "paused", pattern: /paused.*planner_resume/ },
      { state: "done", pattern: /done.*planner_set_plan to start a new project/ },
      { state: "failed", pattern: /failed.*planner_set_plan to start a new project/ },
    ];
    let id = 31;
    for (const c of cases) {
      boards.clear();
      seedBoard("hydra_session_test", { state: c.state });
      dispatch(mkInvoke(id++, "planner_start", {}));
      await settle();
      const r = client.lastReply();
      const result = r.result as { isError: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError, true, `state ${c.state} should error`);
      assert.match(result.content[0]!.text, c.pattern, `state ${c.state}`);
    }
  });

  it("flips ready board to running and asks the scheduler to run", async () => {
    // Seed a board with one task that's already `blocked` so the
    // scheduler can't pick anything up — keeps the test from spawning
    // a phantom worker via the fake client.
    seedBoard("hydra_session_test", {
      state: "ready",
      tasks: [{ id: "T1", title: "blocked", status: "blocked" }],
    });
    dispatch(mkInvoke(35, "planner_start", {}));
    await settle();
    const board = boards.get("hydra_session_test")!;
    assert.equal(board.state, "running");
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }>; structuredContent: { state: string } };
    assert.equal(result.structuredContent.state, "running");
    assert.match(result.content[0]!.text, /Kicked off/);
  });

  it("accepts a stopped board and reports 'Resumed' rather than 'Kicked off'", async () => {
    // After planner_stop, the board state is `stopped` and previously
    // assigned tasks are pending. Execute should treat this as a
    // resume — same transition + scheduler kick, distinct message.
    seedBoard("hydra_session_test", {
      state: "stopped",
      tasks: [
        { id: "T1", title: "done", status: "done" },
        // T2 depends on T3 (which is blocked), so the scheduler
        // can't pick it up — keeps the fake from spawning a phantom
        // worker. The test is about the resume *transition*, not
        // actual scheduling.
        { id: "T2", title: "was-assigned", status: "pending", deps: ["T3"] },
        { id: "T3", title: "blocked", status: "blocked" },
      ],
    });
    dispatch(mkInvoke(37, "planner_start", {}));
    await settle();
    assert.equal(boards.get("hydra_session_test")!.state, "running");
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }>; structuredContent: { state: string } };
    assert.equal(result.structuredContent.state, "running");
    assert.match(result.content[0]!.text, /Resumed/);
    // Remaining-tasks count excludes the already-done task.
    assert.match(result.content[0]!.text, /2 tasks remaining/);
  });

  it("injects /hydra planner continue at the head of the queue so the TUI shows busy", async () => {
    // Without the inject, the MCP tool returns immediately and the
    // TUI goes idle while workers are running. The continue command
    // opens a held turn that drives the busy banner.
    seedBoard("hydra_session_test", {
      state: "ready",
      tasks: [{ id: "T1", title: "blocked", status: "blocked" }],
    });
    dispatch(mkInvoke(36, "planner_start", {}));
    await settle();
    // session/attach is required before session/prompt — verify the
    // lazy attach happened.
    const attachAsClient = client
      .requestsFor("session/attach")
      .find((r) => (r.params as { sessionId?: string }).sessionId === "hydra_session_test");
    assert.ok(attachAsClient, "expected session/attach for orchestrator session");

    const continuePrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { prompt?: Array<{ text?: string }>; _meta?: { "hydra-acp"?: { queuePosition?: string } } };
      return p.prompt?.[0]?.text === "/hydra planner continue";
    });
    assert.ok(continuePrompt, "expected an injected /hydra planner continue prompt");
    const params = continuePrompt.params as {
      sessionId: string;
      _meta: { "hydra-acp": { queuePosition: string } };
    };
    assert.equal(params.sessionId, "hydra_session_test");
    assert.equal(params._meta["hydra-acp"].queuePosition, "head");
  });
});

// ── planner_get_plan ───────────────────────────────────────────────

describe("planner_get_plan", () => {
  it("returns hasPlan:false when nothing is on the session or disk", async () => {
    dispatch(mkInvoke(40, "planner_get_plan", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { structuredContent: { hasPlan: boolean } };
    assert.equal(result.structuredContent.hasPlan, false);
  });

  it("returns full task shape in structuredContent", async () => {
    seedBoard("hydra_session_test", {
      state: "ready",
      tasks: [
        { id: "T1", title: "first", deps: [], status: "done" },
        { id: "T2", title: "second", deps: ["T1"], status: "pending" },
      ],
    });
    dispatch(mkInvoke(41, "planner_get_plan", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as {
      content: Array<{ text: string }>;
      structuredContent: { hasPlan: boolean; state: string; tasks: Array<{ id: string; status: string; deps: string[] }> };
    };
    assert.equal(result.structuredContent.hasPlan, true);
    assert.equal(result.structuredContent.state, "ready");
    assert.equal(result.structuredContent.tasks.length, 2);
    assert.equal(result.structuredContent.tasks[1]!.deps[0], "T1");
    assert.match(result.content[0]!.text, /T1 \[done\] first/);
    assert.match(result.content[0]!.text, /T2 \[pending\] second \(deps: T1\)/);
  });
});

// ── planner_get_status ─────────────────────────────────────────────

describe("planner_get_status", () => {
  it("returns hasProject:false when no board", async () => {
    dispatch(mkInvoke(50, "planner_get_status", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { structuredContent: { hasProject: boolean } };
    assert.equal(result.structuredContent.hasProject, false);
  });

  it("counts tasks and lists in-flight workers", async () => {
    seedBoard("hydra_session_test", {
      state: "running",
      tasks: [
        { id: "T1", title: "done1", status: "done" },
        { id: "T2", title: "done2", status: "done" },
        { id: "T3", title: "infl", status: "assigned", assignedTo: "hydra_session_worker1" },
        { id: "T4", title: "pend", status: "pending" },
        { id: "T5", title: "fail", status: "failed" },
      ],
    });
    dispatch(mkInvoke(51, "planner_get_status", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as {
      structuredContent: {
        counts: { total: number; done: number; failed: number; inFlight: number; pending: number; reviewsPending: number; awaitingReview: number };
        inFlightWorkers: Array<{ taskId: string; workerSessionId: string }>;
      };
    };
    assert.deepEqual(result.structuredContent.counts, {
      total: 5,
      done: 2,
      failed: 1,
      inFlight: 1,
      pending: 1,
      reviewsPending: 0,
      awaitingReview: 0,
    });
    assert.equal(result.structuredContent.inFlightWorkers.length, 1);
    assert.equal(result.structuredContent.inFlightWorkers[0]!.taskId, "T3");
    assert.equal(result.structuredContent.inFlightWorkers[0]!.workerSessionId, "hydra_session_worker1");
  });
});

// ── planner_add_task ───────────────────────────────────────────────

describe("planner_add_task", () => {
  it("errors when description is missing", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(60, "planner_add_task", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /missing required `description`/);
  });

  it("errors when no board exists on the session", async () => {
    dispatch(mkInvoke(61, "planner_add_task", { description: "x" }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /no plan in this session/);
  });

  it("errors when board is terminal (done/failed)", async () => {
    seedBoard("hydra_session_test", { state: "done" });
    dispatch(mkInvoke(62, "planner_add_task", { description: "x" }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /is done.*start a new one/);
  });

  it("acks immediately with a 'Asking the agent' message on an active board", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(63, "planner_add_task", { description: "add tests" }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }>; structuredContent: { dispatched: boolean } };
    assert.equal(result.structuredContent.dispatched, true);
    assert.match(result.content[0]!.text, /Asking the agent to slot in: "add tests"/);
  });
});

// ── planner_stop / pause / resume ──────────────────────────────────

describe("planner_stop", () => {
  it("errors when no board exists", async () => {
    dispatch(mkInvoke(70, "planner_stop", {}));
    await settle();
    const r = client.lastReply();
    assert.equal((r.result as { isError: boolean }).isError, true);
  });

  it("reports already-terminal as a non-error for done/failed/stopped", async () => {
    for (const [state, idx] of [["done", 71], ["failed", 72], ["stopped", 73]] as const) {
      boards.clear();
      seedBoard("hydra_session_test", { state });
      dispatch(mkInvoke(idx, "planner_stop", {}));
      await settle();
      const r = client.lastReply();
      const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
      assert.notEqual(result.isError, true, `${state} should be non-error`);
      assert.match(result.content[0]!.text, new RegExp(`already ${state}`));
    }
  });

  it("transitions a running board to stopped and reverts in-flight tasks to pending", async () => {
    seedBoard("hydra_session_test", {
      state: "running",
      tasks: [
        { id: "T1", title: "done", status: "done" },
        { id: "T2", title: "inflight", status: "assigned", assignedTo: "hydra_session_w1" },
        { id: "T3", title: "pend", status: "pending" },
      ],
    });
    dispatch(mkInvoke(74, "planner_stop", {}));
    await settle();
    const board = boards.get("hydra_session_test")!;
    assert.equal(board.state, "stopped");
    const t2 = board.tasks.find((t) => t.id === "T2")!;
    assert.equal(t2.status, "pending", "in-flight task should revert to pending, not failed");
    assert.equal(t2.assignedTo, null);
    // Done tasks stay done — only assigned tasks revert.
    assert.equal(board.tasks.find((t) => t.id === "T1")!.status, "done");
    // Reply mentions resume path.
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /Stopped.*resume/);
  });
});

describe("planner_pause", () => {
  it("errors when board is not running", async () => {
    seedBoard("hydra_session_test", { state: "ready" });
    dispatch(mkInvoke(80, "planner_pause", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /can only pause a running project/);
  });

  it("is a no-op success when already paused", async () => {
    seedBoard("hydra_session_test", { state: "paused" });
    dispatch(mkInvoke(81, "planner_pause", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true);
    assert.match(result.content[0]!.text, /already paused/);
  });

  it("flips running to paused and persists", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(82, "planner_pause", {}));
    await settle();
    assert.equal(boards.get("hydra_session_test")!.state, "paused");
  });
});

describe("planner_resume", () => {
  it("errors when board is not paused", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(90, "planner_resume", {}));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /not paused/);
  });

  it("flips paused to running, invokes the scheduler, and injects continue", async () => {
    seedBoard("hydra_session_test", {
      state: "paused",
      tasks: [{ id: "T1", title: "blocked", status: "blocked" }], // nothing eligible
    });
    dispatch(mkInvoke(91, "planner_resume", {}));
    await settle();
    assert.equal(boards.get("hydra_session_test")!.state, "running");
    // Same live-view inject as start — resume also kicks workers,
    // so the TUI should go busy.
    const continuePrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { prompt?: Array<{ text?: string }> };
      return p.prompt?.[0]?.text === "/hydra planner continue";
    });
    assert.ok(continuePrompt, "expected an injected /hydra planner continue prompt on resume");
  });
});

// ── planner_skip / retry ───────────────────────────────────────────

describe("planner_skip", () => {
  it("errors when taskId is missing", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(100, "planner_skip", {}));
    await settle();
    assert.equal((client.lastReply().result as { isError: boolean }).isError, true);
  });

  it("errors when taskId doesn't exist on the board", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(101, "planner_skip", { taskId: "Tnope" }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /no task 'Tnope'/);
  });

  it("is a no-op when the task is already done", async () => {
    seedBoard("hydra_session_test", {
      state: "running",
      tasks: [{ id: "T1", title: "x", status: "done" }],
    });
    dispatch(mkInvoke(102, "planner_skip", { taskId: "T1" }));
    await settle();
    const r = client.lastReply();
    const result = r.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(result.isError, true);
    assert.match(result.content[0]!.text, /already done/);
  });

  it("marks pending task as done with artifacts.summary='skipped by user'", async () => {
    seedBoard("hydra_session_test", {
      state: "running",
      tasks: [
        { id: "T1", title: "skip me", status: "pending" },
        { id: "T2", title: "blocked", status: "blocked" }, // keeps scheduler quiet
      ],
    });
    dispatch(mkInvoke(103, "planner_skip", { taskId: "T1" }));
    await settle();
    const board = boards.get("hydra_session_test")!;
    const t1 = board.tasks.find((t) => t.id === "T1")!;
    assert.equal(t1.status, "done");
    assert.equal(t1.artifacts?.summary, "skipped by user");
  });
});

describe("planner_retry", () => {
  it("errors when taskId is missing or unknown", async () => {
    seedBoard("hydra_session_test", { state: "running" });
    dispatch(mkInvoke(110, "planner_retry", {}));
    await settle();
    assert.equal((client.lastReply().result as { isError: boolean }).isError, true);

    dispatch(mkInvoke(111, "planner_retry", { taskId: "Tnope" }));
    await settle();
    assert.equal((client.lastReply().result as { isError: boolean }).isError, true);
  });

  it("resets a done task to pending and clears timestamps/artifacts", async () => {
    seedBoard("hydra_session_test", {
      state: "running",
      tasks: [
        {
          id: "T1",
          title: "done-now-redo",
          status: "done",
          deps: ["T2"], // keeps T1 ineligible after retry so the scheduler can't re-assign it
          startedAt: "2025-01-01T00:00:00Z",
          finishedAt: "2025-01-01T00:01:00Z",
          artifacts: { summary: "old" },
        },
        { id: "T2", title: "blocked", status: "blocked" },
      ],
    });
    dispatch(mkInvoke(112, "planner_retry", { taskId: "T1" }));
    await settle();
    const t1 = boards.get("hydra_session_test")!.tasks.find((t) => t.id === "T1")!;
    assert.equal(t1.status, "pending");
    assert.equal(t1.startedAt, null);
    assert.equal(t1.finishedAt, null);
    assert.equal(t1.artifacts, null);
  });
});

// ── planner_remove ─────────────────────────────────────────────────

describe("planner_remove", () => {
  it("errors when no board exists on memory or disk", async () => {
    dispatch(mkInvoke(120, "planner_remove", {}));
    await settle();
    const r = client.lastReply();
    assert.equal((r.result as { isError: boolean }).isError, true);
  });

  it("deletes worker sessions, removes the project dir, and clears in-memory state", async () => {
    const b = seedBoard("hydra_session_test", {
      state: "running",
      tasks: [{ id: "T1", title: "x", status: "assigned", assignedTo: "hydra_session_w1" }],
    });
    b.workers["hydra_session_w1"] = { currentTaskId: "T1", tasksCompleted: [] };
    saveBoard(b, "hydra_session_test");
    const dir = projectDir(b.projectId);
    assert.equal(existsSync(dir), true);

    dispatch(mkInvoke(121, "planner_remove", {}));
    await settle();

    // Worker session/delete request fired with the worker id.
    const deletes = client.requestsFor("hydra-acp/session/delete");
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0]!.params, { sessionId: "hydra_session_w1" });

    assert.equal(boards.has("hydra_session_test"), false);
    assert.equal(existsSync(dir), false);
    const r = client.lastReply();
    const result = r.result as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /Removed project/);
  });
});
