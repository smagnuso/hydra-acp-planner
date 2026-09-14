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
  setWorkerState,
  registerWorker,
  getWorkerState,
} from "../src/state.ts";

// Integration tests for the merge-on-completion mechanism (Phase 2 of
// the workspace-isolation plan): when a task with a workspace reaches
// "done", handleTaskComplete → markTaskDone must send `/hydra workspace
// merge` to the worker and record the outcome on task.workspaceLanding
// BEFORE deciding whether to close the worker session. These exercise
// the real handleTaskComplete path, not a reimplementation of it.

interface RecordedRequest {
  method: string;
  params: unknown;
}

class FakeClient extends EventEmitter implements BridgeClient {
  requests: RecordedRequest[] = [];
  responders = new Map<string, (params: unknown) => unknown>();
  defaultRequestResult: unknown = {};
  // Set by a test to have the fake "workspace merge" reply delivered as
  // a session/update notification, mirroring how the real daemon's
  // emitExtensionReply works (see extractSyntheticReplyText in bridge.ts)
  // — NOT as the session/prompt RPC's own return value.
  workspaceReplyFor: ((sessionId: string) => string | undefined) | null = null;

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    this.requests.push({ method, params });
    if (method === "session/prompt" && this.workspaceReplyFor) {
      const p = params as { sessionId: string; prompt: Array<{ text?: string }> };
      const text = p.prompt?.[0]?.text ?? "";
      if (text.startsWith("/hydra workspace ")) {
        const reply = this.workspaceReplyFor(p.sessionId);
        if (reply !== undefined) {
          queueMicrotask(() => {
            (bridge as unknown as { handleNotification: (n: unknown) => void }).handleNotification({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: p.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `\n${reply}\n` },
                  _meta: { "hydra-acp": { synthetic: true } },
                },
              },
            });
          });
        }
      }
    }
    const responder = this.responders.get(method);
    const result = responder ? responder(params) : this.defaultRequestResult;
    return Promise.resolve(result as R);
  }
  reply(): void {}
  replyError(): void {}
  start(): void {}
  stop(): void {}

  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

const ORCH = "hydra_session_orch_merge";
const WORKER = "hydra_session_worker_merge";

let originalHome: string;
let tmpHome: string;
let bridge: PlannerBridge;
let client: FakeClient;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-merge-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = process.env.HOME;
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
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
  boards.clear();
  attachedSessions.clear();
  clientAttachedSessions.clear();
});

function workTaskWithWorkspace(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `work ${id}`,
    deps: [],
    status: "running",
    assignedTo: WORKER,
    workerSessions: [WORKER],
    attemptCount: 1,
    kind: "work",
    workspace: {
      path: "/home/u/.hydra-acp/workspaces/abc/T1",
      sourceCwd: "/home/u/repo",
      label: id,
      provider: "git",
    },
    ...overrides,
  } as Task;
}

function makeBoard(tasks: Task[]): Board {
  const b = newBoard({ description: "merge-on-completion", concurrencyCap: 2 });
  b.state = "running";
  b.isolation = { mode: "per-task" };
  b.tasks = tasks;
  b.workers[WORKER] = {
    currentTaskId: tasks[0]!.id,
    tasksCompleted: [],
  };
  boards.set(ORCH, b);
  saveBoard(b, ORCH);
  return b;
}

function primeWorker(taskId: string, workerReply: string) {
  registerWorker(WORKER, ORCH);
  setWorkerState(WORKER, {
    orchestratorSessionId: ORCH,
    taskId,
    resultAccumulator: workerReply,
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

describe("merge-on-completion — handleTaskComplete → markTaskDone → mergeTaskWorkspace", () => {
  it("landed: sends /hydra workspace merge, records workspaceLanding, and closes the worker", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing"}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";

    await complete(board, task);
    await settle();

    assert.equal(task.status, "done");
    assert.equal(task.workspaceLanding?.status, "landed");

    const prompts = client.requestsFor("session/prompt");
    const mergePrompt = prompts.find((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.sessionId === WORKER && p.prompt?.[0]?.text === "/hydra workspace merge";
    });
    assert.ok(mergePrompt, "expected a /hydra workspace merge sent to the worker session");

    const closes = client.requestsFor("hydra-acp/child_session/close");
    assert.ok(
      closes.some((r) => (r.params as { childSessionId?: string }).childSessionId === WORKER),
      "worker should be closed once landing is confirmed",
    );
  });

  it("declined: keeps the worker open and does not mark landing as landed", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing"}\n```');
    client.workspaceReplyFor = () =>
      "Workspace merge failed: not a fast-forward; run /hydra workspace sync first";

    await complete(board, task);
    await settle();

    assert.equal(task.status, "done", "the work itself is still done — only landing is uncertain");
    assert.equal(task.workspaceLanding?.status, "declined");
    assert.equal(
      task.workspaceLanding?.detail,
      "not a fast-forward; run /hydra workspace sync first",
    );

    const closes = client.requestsFor("hydra-acp/child_session/close");
    assert.ok(
      !closes.some((r) => (r.params as { childSessionId?: string }).childSessionId === WORKER),
      "worker must stay open when landing did not confirm, so it can be resolved by hand",
    );
    // Worker state also should not have been torn down, for the same reason.
    assert.ok(getWorkerState(WORKER), "worker state should be preserved when landing is unconfirmed");
  });

  it("skipped: a task with no workspace never sends a merge command", async () => {
    const task = workTaskWithWorkspace("T1", { workspace: undefined });
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing"}\n```');

    await complete(board, task);
    await settle();

    assert.equal(task.status, "done");
    assert.equal(task.workspaceLanding?.status, "skipped");
    assert.equal(client.requestsFor("session/prompt").length, 0);

    const closes = client.requestsFor("hydra-acp/child_session/close");
    assert.ok(
      closes.some((r) => (r.params as { childSessionId?: string }).childSessionId === WORKER),
      "worker should still be closed normally when there was nothing to merge",
    );
  });
});

describe("merge-on-completion — review approval path (finishReview)", () => {
  it("approve: lands the reviewed task's workspace via finishReview before the reviewed task is done", async () => {
    const reviewedTask = workTaskWithWorkspace("T1", { status: "awaiting_review" });
    const reviewTask: Task = {
      id: "R1",
      title: "review T1",
      deps: ["T1"],
      status: "assigned",
      assignedTo: "orchestrator",
      attemptCount: 0,
      kind: "review",
      reviews: "T1",
    };
    const board = makeBoard([reviewedTask, reviewTask]);
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";

    await (bridge as unknown as {
      handleReviewComplete: (
        reviewTask: Task,
        board: Board,
        orch: string,
        normalized: { artifacts: Record<string, unknown>; warnings: string[] },
      ) => Promise<void>;
    }).handleReviewComplete(reviewTask, board, ORCH, {
      artifacts: { review_decision: "approve", notes: "looks good" },
      warnings: [],
    });
    await settle();

    assert.equal(reviewedTask.status, "done");
    assert.equal(reviewedTask.workspaceLanding?.status, "landed");

    const mergePrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.sessionId === WORKER && p.prompt?.[0]?.text === "/hydra workspace merge";
    });
    assert.ok(mergePrompt, "expected a /hydra workspace merge sent to the reviewed task's worker");
  });
});
