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

// The daemon's `/hydra workspace status` reply, header and all.
//
// The header is not decoration: sendWorkspaceCommand matches on it to
// tell a reply apart from the unsolicited drift advisory the daemon
// pushes at turn boundaries. Fixtures that started at the body silently
// stopped resembling the daemon, which is how a real reply-routing bug
// survived a green suite. Mirrors cli's workspace-reply-contract test.
function statusReply(body: string): string {
  return [
    "Isolated in ~/.hydra-acp/workspaces/abc/T1",
    "  source:   ~/repo",
    "  provider: git (hydra/T1)",
    body,
    "Use `/hydra workspace stop` to merge and return, `discard` to throw the work away, `detach` to return and leave it here, or `clean` to wipe it and keep working here.",
  ].join("\n");
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
  // Separate hook for `status`, so a test can say "the worker committed"
  // (or didn't) independently of what the merge reply says.
  statusReplyFor: ((sessionId: string) => string | undefined) | null = null;
  // Unsolicited synthetic text pushed onto the session immediately
  // before the real reply, the way the daemon's noticeSourceDrift does
  // at a turn boundary.
  driftNoticeFor: ((sessionId: string) => string | undefined) | null = null;

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    this.requests.push({ method, params });
    if (method === "session/prompt" && this.workspaceReplyFor) {
      const p = params as { sessionId: string; prompt: Array<{ text?: string }> };
      const text = p.prompt?.[0]?.text ?? "";
      if (text.startsWith("/hydra workspace ")) {
        const reply = text.includes("status")
          ? (this.statusReplyFor?.(p.sessionId) ??
              statusReply("  no uncommitted changes\n  1 commit(s) recorded here and not landed yet."))
          : this.workspaceReplyFor(p.sessionId);
        if (reply !== undefined) {
          const emit = (body: string) =>
            (bridge as unknown as { handleNotification: (n: unknown) => void }).handleNotification({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: p.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `\n${body}\n` },
                  _meta: { "hydra-acp": { synthetic: true } },
                },
              },
            });
          const drift = this.driftNoticeFor?.(p.sessionId);
          queueMicrotask(() => {
            if (drift !== undefined) emit(drift);
            emit(reply);
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

  it("ignores the daemon's drift advisory and waits for the actual reply", async () => {
    // Regression, and the one that survived a green suite longest. The
    // daemon pushes this advisory unprompted at any turn boundary once
    // the source has moved on (noticeSourceDrift), which under isolation
    // is nearly always: every sibling landing moves the source. Taking
    // "the next synthetic chunk" as the reply read the advisory as the
    // answer to `status`, could-not-confirm followed, and the project
    // paused over work that had landed perfectly well.
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing"}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.driftNoticeFor = () =>
      "~/repo has moved on: 3 commit(s) are there and not in this workspace. " +
      "Landing is fast-forward-only, so `/hydra workspace sync` now is what keeps `stop` from refusing later.";

    await complete(board, task);
    await settle();

    assert.equal(task.workspaceLanding?.status, "landed");
  });

  it("adopted: a task working in a borrowed workspace never lands it itself", async () => {
    // Regression. A review adopts its reviewee's tree so it can see the
    // code under review, which leaves the two tasks holding identical
    // workspace records. When the reviewer also landed on completion,
    // the same branch was merged twice: the second attempt met a source
    // its siblings had already moved on, and the daemon answers that
    // with neither "merged" nor "failed" but with "the source has moved
    // on, sync first" — classified `unknown`, which paused the project
    // over work that had in fact landed.
    const reviewed = workTaskWithWorkspace("T1", { status: "awaiting_review" });
    const task = workTaskWithWorkspace("R1", {
      kind: "review",
      reviews: "T1",
      // Identical to the reviewee's record, which is the whole problem:
      // only this flag tells the borrower from the owner.
      workspace: reviewed.workspace,
      workspaceAdopted: true,
    });
    const board = makeBoard([reviewed, task]);
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";

    // markTaskDone directly: the guard lives there, and driving a review
    // through handleTaskComplete would exercise the review result parser
    // rather than the landing decision under test.
    await (bridge as unknown as {
      markTaskDone: (
        t: Task,
        a: Record<string, unknown>,
        b: Board,
        orch: string,
        worker: string,
      ) => Promise<void>;
    }).markTaskDone(task, { summary: "approve" }, board, ORCH, WORKER);
    await settle();

    assert.equal(task.workspaceLanding?.status, "skipped");
    const merges = client.requestsFor("session/prompt").filter((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.prompt?.[0]?.text === "/hydra workspace merge";
    });
    assert.equal(merges.length, 0, "a borrower must not land the workspace it adopted");

    // And it must still be OPEN. The owner's landing is sent through
    // this very session (it holds the binding), and a session that is
    // closing rejects new prompts with -32014, which surfaces as the
    // same false "did not confirm landing" pause. finishReview closes
    // it afterwards.
    const closes = client.requestsFor("hydra-acp/child_session/close");
    assert.equal(
      closes.filter((r) => (r.params as { childSessionId?: string }).childSessionId === WORKER)
        .length,
      0,
      "a borrower must stay open until its owner has landed through it",
    );
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

describe("merge-on-completion — competition winner/loser workspace cleanup (Phase 4)", () => {
  const WINNER = "hydra_session_worker_winner";
  const LOSER = "hydra_session_worker_loser";

  function competitionBoard(): { board: Board; winnerTask: Task; loserTask: Task; reviewTask: Task } {
    const winnerTask = workTaskWithWorkspace("T1", {
      status: "awaiting_review",
      assignedTo: WINNER,
      workerSessions: [WINNER],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/T1",
        sourceCwd: "/home/u/repo",
        label: "T1",
        provider: "git",
      },
    });
    const loserTask = workTaskWithWorkspace("T2", {
      status: "awaiting_review",
      assignedTo: LOSER,
      workerSessions: [LOSER],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/T2",
        sourceCwd: "/home/u/repo",
        label: "T2",
        provider: "git",
      },
    });
    const reviewTask: Task = {
      id: "R1",
      title: "competition review",
      deps: ["T1", "T2"],
      status: "assigned",
      assignedTo: "orchestrator",
      attemptCount: 0,
      kind: "review",
      reviews: ["T1", "T2"],
    };
    const board = newBoard({ description: "competition", concurrencyCap: 2 });
    board.state = "running";
    board.isolation = { mode: "per-task" };
    board.tasks = [winnerTask, loserTask, reviewTask];
    board.workers[WINNER] = { currentTaskId: "T1", tasksCompleted: [] };
    board.workers[LOSER] = { currentTaskId: "T2", tasksCompleted: [] };
    boards.set(ORCH, board);
    saveBoard(board, ORCH);
    return { board, winnerTask, loserTask, reviewTask };
  }

  it("winner's workspace lands, loser's workspace is discarded and its worker closed", async () => {
    const { board, winnerTask, loserTask, reviewTask } = competitionBoard();
    client.workspaceReplyFor = (sessionId) => {
      if (sessionId === WINNER) return "Merged hydra/T1 into ~/repo";
      if (sessionId === LOSER) return "Discarded ~/.hydra-acp/workspaces/abc/T2 and its branch hydra/T2";
      return undefined;
    };

    await (bridge as unknown as {
      handleReviewWinner: (
        reviewTask: Task,
        normalized: { artifacts: Record<string, unknown>; warnings: string[] },
        notes: string,
        board: Board,
        orch: string,
      ) => Promise<void>;
    }).handleReviewWinner(
      reviewTask,
      { artifacts: { review_decision: "winner", winner: "T1", notes: "T1 wins" }, warnings: [] },
      "T1 wins",
      board,
      ORCH,
    );
    await settle();

    assert.equal(winnerTask.status, "done");
    assert.equal(winnerTask.workspaceLanding?.status, "landed");
    assert.equal(loserTask.status, "superseded");

    const discardPrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.sessionId === LOSER && p.prompt?.[0]?.text === "/hydra workspace discard";
    });
    assert.ok(discardPrompt, "expected a /hydra workspace discard sent to the loser's worker");

    const closes = client.requestsFor("hydra-acp/child_session/close");
    assert.ok(
      closes.some((r) => (r.params as { childSessionId?: string }).childSessionId === LOSER),
      "loser's worker should be closed after a confirmed discard",
    );
  });

  it("a discard refusal is cosmetic — logs a synthetic note but does not block or throw", async () => {
    const { board, winnerTask, loserTask, reviewTask } = competitionBoard();
    client.workspaceReplyFor = (sessionId) => {
      if (sessionId === WINNER) return "Merged hydra/T1 into ~/repo";
      if (sessionId === LOSER) return "Workspace discard failed: workspace is shared with another session";
      return undefined;
    };

    await (bridge as unknown as {
      handleReviewWinner: (
        reviewTask: Task,
        normalized: { artifacts: Record<string, unknown>; warnings: string[] },
        notes: string,
        board: Board,
        orch: string,
      ) => Promise<void>;
    }).handleReviewWinner(
      reviewTask,
      { artifacts: { review_decision: "winner", winner: "T1", notes: "T1 wins" }, warnings: [] },
      "T1 wins",
      board,
      ORCH,
    );
    await settle();

    // Winner still lands correctly — a loser's discard failure must
    // never block the winner's own merge.
    assert.equal(winnerTask.status, "done");
    assert.equal(winnerTask.workspaceLanding?.status, "landed");
    assert.equal(loserTask.status, "superseded");

    // Discard was still attempted even though it failed.
    assert.ok(
      client.requestsFor("session/prompt").some((r) => {
        const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
        return p.sessionId === LOSER && p.prompt?.[0]?.text === "/hydra workspace discard";
      }),
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

describe("merge-on-completion — distill task's own workspace (follow-up #1)", () => {
  const DISTILL_WORKER = "hydra_session_worker_distill_own";
  const WINNER_WORKER = "hydra_session_worker_distill_winner";
  const LOSER_WORKER = "hydra_session_worker_distill_loser";

  function distillTaskWithWorkspace(overrides: Partial<Task> = {}): Task {
    return {
      id: "R1d",
      title: "distill R1",
      deps: ["T1", "T2"],
      status: "running",
      assignedTo: DISTILL_WORKER,
      workerSessions: [DISTILL_WORKER],
      attemptCount: 1,
      kind: "distill",
      reviews: ["T1", "T2"],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/R1d",
        sourceCwd: "/home/u/repo",
        label: "R1d",
        provider: "git",
      },
      ...overrides,
    } as Task;
  }

  async function callHandleDistillComplete(
    distillTask: Task,
    board: Board,
    normalized: { artifacts: Record<string, unknown>; warnings: string[] },
  ) {
    await (bridge as unknown as {
      handleDistillComplete: (
        distillTask: Task,
        board: Board,
        orch: string,
        normalized: { artifacts: Record<string, unknown>; warnings: string[] },
      ) => Promise<void>;
    }).handleDistillComplete(distillTask, board, ORCH, normalized);
  }

  it("user-authored distill (no distillOf): lands the distill task's own workspace", async () => {
    const distillTask = distillTaskWithWorkspace();
    const board = makeBoard([distillTask]);
    client.workspaceReplyFor = (sessionId) =>
      sessionId === DISTILL_WORKER ? "Merged hydra/R1d into ~/repo" : undefined;

    await callHandleDistillComplete(distillTask, board, {
      artifacts: { summary: "merged angles", recommended_action: "apply T1" },
      warnings: [],
    });
    await settle();

    assert.equal(distillTask.status, "done");
    assert.equal(distillTask.workspaceLanding?.status, "landed");
  });

  it("apply-winner branch: winner merges via finishReview, loser's workspace is discarded, AND the distill task's own workspace merges", async () => {
    const distillTask = distillTaskWithWorkspace({ distillOf: "R1" });
    const winnerTask = workTaskWithWorkspace("T1", {
      status: "awaiting_review",
      assignedTo: WINNER_WORKER,
      workerSessions: [WINNER_WORKER],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/T1",
        sourceCwd: "/home/u/repo",
        label: "T1",
        provider: "git",
      },
    });
    const loserTask = workTaskWithWorkspace("T2", {
      status: "awaiting_review",
      assignedTo: LOSER_WORKER,
      workerSessions: [LOSER_WORKER],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/T2",
        sourceCwd: "/home/u/repo",
        label: "T2",
        provider: "git",
      },
    });
    const originatingReview: Task = {
      id: "R1",
      title: "competition review",
      deps: ["T1", "T2"],
      status: "assigned",
      assignedTo: "orchestrator",
      attemptCount: 0,
      kind: "review",
      reviews: ["T1", "T2"],
    };
    const board = makeBoard([winnerTask, loserTask, originatingReview, distillTask]);
    client.workspaceReplyFor = (sessionId) => {
      if (sessionId === WINNER_WORKER) return "Merged hydra/T1 into ~/repo";
      if (sessionId === LOSER_WORKER) return "Discarded ~/.hydra-acp/workspaces/abc/T2 and its branch hydra/T2";
      if (sessionId === DISTILL_WORKER) return "Merged hydra/R1d into ~/repo";
      return undefined;
    };

    await callHandleDistillComplete(distillTask, board, {
      artifacts: { summary: "T1 strongest", applied_winner: "T1", recommended_action: "apply T1" },
      warnings: [],
    });
    await settle();

    assert.equal(winnerTask.status, "done");
    assert.equal(winnerTask.workspaceLanding?.status, "landed");
    assert.equal(loserTask.status, "superseded");
    assert.equal(distillTask.status, "done");
    assert.equal(distillTask.workspaceLanding?.status, "landed");

    const discardPrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.sessionId === LOSER_WORKER && p.prompt?.[0]?.text === "/hydra workspace discard";
    });
    assert.ok(discardPrompt, "expected the loser's workspace to be discarded");
    assert.ok(
      client
        .requestsFor("hydra-acp/child_session/close")
        .some((r) => (r.params as { childSessionId?: string }).childSessionId === LOSER_WORKER),
      "loser's worker should be closed after a confirmed discard",
    );
  });

  it("rework branch: superseded reviewee's workspace is discarded and the distill task's own workspace merges", async () => {
    const distillTask = distillTaskWithWorkspace({ distillOf: "R1" });
    const revieweeTask = workTaskWithWorkspace("T1", {
      status: "awaiting_review",
      assignedTo: LOSER_WORKER,
      workerSessions: [LOSER_WORKER],
      workspace: {
        path: "/home/u/.hydra-acp/workspaces/abc/T1",
        sourceCwd: "/home/u/repo",
        label: "T1",
        provider: "git",
      },
    });
    const originatingReview: Task = {
      id: "R1",
      title: "competition review",
      deps: ["T1"],
      status: "assigned",
      assignedTo: "orchestrator",
      attemptCount: 0,
      kind: "review",
      reviews: ["T1"],
    };
    const board = makeBoard([revieweeTask, originatingReview, distillTask]);
    client.workspaceReplyFor = (sessionId) => {
      if (sessionId === LOSER_WORKER) return "Discarded ~/.hydra-acp/workspaces/abc/T1 and its branch hydra/T1";
      if (sessionId === DISTILL_WORKER) return "Merged hydra/R1d into ~/repo";
      return undefined;
    };

    await callHandleDistillComplete(distillTask, board, {
      artifacts: {
        summary: "both miss the spec",
        recommended_action: "rework",
        rework_brief: "redo with streaming support",
      },
      warnings: [],
    });
    await settle();

    assert.equal(revieweeTask.status, "superseded");
    assert.equal(distillTask.status, "done");
    assert.equal(distillTask.workspaceLanding?.status, "landed");

    const discardPrompt = client.requestsFor("session/prompt").find((r) => {
      const p = r.params as { sessionId?: string; prompt?: Array<{ text?: string }> };
      return p.sessionId === LOSER_WORKER && p.prompt?.[0]?.text === "/hydra workspace discard";
    });
    assert.ok(discardPrompt, "expected the superseded reviewee's workspace to be discarded");
  });
});

describe("merge-on-completion — the commit contract (Phase C)", () => {
  const DIRTY = statusReply("  2 unstaged:\n    M src/a.ts");
  const COMMITTED = statusReply("  no uncommitted changes\n  1 commit(s) recorded here and not landed yet.");
  const NOTHING = statusReply("  no uncommitted changes\n  in sync with ~/repo");

  function commitReminders() {
    return client.requestsFor("hydra-acp/message/emit").filter((r) =>
      JSON.stringify(r.params).includes("still has uncommitted changes"),
    );
  }

  it("reminds a worker that finished with uncommitted work, instead of landing it", async () => {
    // The nudge happens while the session is still live and its context
    // still holds what it did, which is the only moment it is cheap.
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing","files_changed":["a.ts"]}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => DIRTY;

    await complete(board, task);
    await settle();

    assert.equal(commitReminders().length, 1, "expected one commit reminder");
    assert.notEqual(task.status, "done", "the task must not complete while its work is uncommitted");
  });

  it("gives up after a bounded number of reminders and records it as not landed", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing","files_changed":["a.ts"]}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => DIRTY;
    // Pretend the reminders already happened.
    getWorkerState(WORKER)!.commitRepromptCount = 2;

    await complete(board, task);
    await settle();

    assert.equal(task.status, "done", "the work itself is done; only its durability is not");
    assert.equal(task.workspaceLanding?.status, "unknown");
    assert.match(task.workspaceLanding?.detail ?? "", /uncommitted/);
  });

  it("records a real landing when the worker committed", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing","commits":["abc123"]}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => COMMITTED;

    await complete(board, task);
    await settle();

    assert.equal(task.workspaceLanding?.status, "landed");
    assert.deepEqual(task.artifacts?.commits, ["abc123"]);
    assert.equal(commitReminders().length, 0);
  });

  it("does not nag a task that genuinely changed nothing", async () => {
    // Clean and in sync means nothing was committed — which is the
    // CORRECT outcome for a no-op task, and must not be confused with
    // forgetting to commit.
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"nothing needed changing"}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => NOTHING;

    await complete(board, task);
    await settle();

    assert.equal(commitReminders().length, 0, "a no-op task must not be nagged");
    assert.equal(task.workspaceLanding?.status, "landed");
  });

  it("DOES chase a task that claims file changes but committed nothing", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did it","files_changed":["a.ts"]}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => NOTHING;

    await complete(board, task);
    await settle();

    assert.equal(commitReminders().length, 1, "claimed changes with no commit is a contradiction");
  });

  it("does not assume committed when the commit state cannot be read", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did the thing"}\n```');
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    client.statusReplyFor = () => "In workspace T1 (git) at ~/ws/T1";

    await complete(board, task);
    await settle();

    assert.equal(task.workspaceLanding?.status, "unknown");
  });
});

describe("landing safety — serialization and dependent gating", () => {
  const COMMITTED = statusReply("  no uncommitted changes\n  1 commit(s) recorded here and not landed yet.");

  it("pauses the project when a landing does not confirm", async () => {
    // A dependent forking a tree that is missing its dependency's work
    // is the silent-garbage failure the whole design exists to avoid.
    // Pausing, not failing: the work still exists in its workspace.
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did it"}\n```');
    client.statusReplyFor = () => COMMITTED;
    client.workspaceReplyFor = () =>
      "Workspace merge failed: not a fast-forward; run /hydra workspace sync first";

    await complete(board, task);
    await settle();

    assert.equal(board.state, "paused", "dependents must not be allowed to run");
    assert.equal(task.status, "done", "the task itself is done; only its landing is not");
    const note = client.requestsFor("hydra-acp/message/emit").find((r) =>
      JSON.stringify(r.params).includes("did not confirm landing"),
    );
    assert.ok(note, "the user must be told why the project stopped");
  });

  it("does not pause on a clean landing", async () => {
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did it"}\n```');
    client.statusReplyFor = () => COMMITTED;
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";

    await complete(board, task);
    await settle();

    // Not "running": a single-task project legitimately finishes here.
    // The claim is only that a clean landing does not HOLD the project.
    assert.notEqual(board.state, "paused");
    assert.equal(task.workspaceLanding?.status, "landed");
  });

  it("does not start a landing once the project has been stopped", async () => {
    // Landing into the user's tree after they asked to stop is exactly
    // the surprise isolation is meant to prevent. The workspace is kept,
    // so nothing is lost by declining to land.
    const task = workTaskWithWorkspace("T1");
    const board = makeBoard([task]);
    primeWorker("T1", '```hydra-result\n{"summary":"did it"}\n```');
    client.statusReplyFor = () => COMMITTED;
    client.workspaceReplyFor = () => "Merged hydra/T1 into ~/repo";
    board.state = "stopped";

    await complete(board, task);
    await settle();

    const merges = client.requestsFor("session/prompt").filter((r) => {
      const p = r.params as { prompt?: Array<{ text?: string }> };
      return p.prompt?.[0]?.text === "/hydra workspace merge";
    });
    assert.equal(merges.length, 0, "no landing may begin on a stopped board");
  });
});
