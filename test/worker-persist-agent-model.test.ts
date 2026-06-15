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
import { formatSessionsTable } from "../src/format.ts";

// T1: Worker records must persist orchestrator fallback for agent/model
// so the sessions table reflects what the worker is actually using when
// no per-task / fleet override exists.

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
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-worker-persist-test-"));
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
    task?: { id?: string; agent?: string | null; model?: string | null };
    orchestratorAgent?: string | null;
    orchestratorModel?: string | null;
  } = {},
): Board {
  const b = newBoard({ description: "seed", concurrencyCap: 1 });
  b.state = "ready";
  const t = opts.task ?? {};
  b.tasks = [
    {
      id: t.id ?? "T1",
      title: "task",
      deps: [],
      status: "pending",
      attemptCount: 0,
      ...(t.agent !== undefined && t.agent !== null ? { agent: t.agent } : {}),
      ...(t.model !== undefined && t.model !== null ? { model: t.model } : {}),
    },
  ];
  if (opts.orchestratorAgent !== undefined) {
    b.orchestratorAgent = opts.orchestratorAgent;
  }
  if (opts.orchestratorModel !== undefined) {
    b.orchestratorModel = opts.orchestratorModel;
  }
  boards.set(sessionId, b);
  saveBoard(b, sessionId);
  return b;
}

async function spawnAndGetWorker(
  childSessionId: string,
  seedOpts: Parameters<typeof seedBoard>[1],
): Promise<{ board: Board; worker: Board["workers"][string] }> {
  seedBoard("hydra_session_test", seedOpts);
  client.responders.set("hydra-acp/child_session/spawn", () => ({
    childSessionId,
  }));
  dispatch(mkInvoke(1, "start", {}));
  await settle();
  const board = boards.get("hydra_session_test")!;
  const worker = board.workers[childSessionId];
  assert.ok(worker, "expected worker entry for spawned session");
  return { board, worker };
}

describe("worker persist — orchestrator fallback for agent/model", () => {
  it("task.agent set, only orchestratorModel for model → model stays null (no cross-agent inheritance)", async () => {
    const childSessionId = "hydra_session_worker_a";
    const { worker } = await spawnAndGetWorker(childSessionId, {
      task: { agent: "X" },
      orchestratorAgent: null,
      orchestratorModel: "Y",
    });
    assert.equal(worker.agent, "X");
    // No orchestratorModel fallback: workers on a different agent don't
    // inherit the host's model. Daemon's per-agent defaultModels supplies
    // the right model at spawn.
    assert.equal(worker.model, null);
  });

  it("task.model set, only orchestratorAgent for agent → persists orchestratorAgent", async () => {
    const childSessionId = "hydra_session_worker_b";
    const { worker } = await spawnAndGetWorker(childSessionId, {
      task: { model: "X" },
      orchestratorAgent: "Y",
      orchestratorModel: null,
    });
    assert.equal(worker.agent, "Y");
    assert.equal(worker.model, "X");
  });

  it("task.agent and task.model both set → exact values, no fallback", async () => {
    const childSessionId = "hydra_session_worker_c";
    const { worker } = await spawnAndGetWorker(childSessionId, {
      task: { agent: "task-agent", model: "task-model" },
      orchestratorAgent: "orch-agent",
      orchestratorModel: "orch-model",
    });
    assert.equal(worker.agent, "task-agent");
    assert.equal(worker.model, "task-model");
  });

  it("nothing configured anywhere → persists nulls", async () => {
    const childSessionId = "hydra_session_worker_d";
    const { worker } = await spawnAndGetWorker(childSessionId, {
      task: {},
      orchestratorAgent: null,
      orchestratorModel: null,
    });
    assert.equal(worker.agent, null);
    assert.equal(worker.model, null);
  });

  it("formatSessionsTable shows agent only (no orch-model fallback) when task has no model", async () => {
    const childSessionId = "hydra_session_worker_e";
    const { board } = await spawnAndGetWorker(childSessionId, {
      task: { agent: "task-agent" },
      orchestratorAgent: "orch-agent",
      orchestratorModel: "orch-model",
    });
    const out = formatSessionsTable(board, "hydra_session_test");
    assert.ok(
      !out.includes("task-agent·orch-model"),
      `did not expect orchestrator-model fallback in worker row, got:\n${out}`,
    );
    assert.ok(
      out.includes("task-agent"),
      `expected worker agent 'task-agent' in output, got:\n${out}`,
    );
  });
});
