// M1 transformer: drive decomposition from `/hydra planner create <desc>`.
//
// Flow per orchestrator session:
//   1. user types  /hydra planner create build X
//   2. hydra dispatches to our hydra-acp/commands/invoke handler with
//      verb="create", args="build X"
//   3. we mint a project + board, set state=decomposing, kick off a
//      substitute decomposition prompt via message/emit (no broadcast,
//      runs through the chain to the agent), and return a short ack
//      that hydra surfaces as a synthetic agent_message_chunk
//   4. the agent streams its JSON reply as agent_message_chunk session/update
//      notifications; intercept response:session/update, accumulate text,
//      stop each chunk so clients never see raw JSON
//   5. response:session/prompt fires when the agent's turn completes;
//      parse accumulated reply, populate board.tasks, persist, emit a
//      synthetic agent_message_chunk with the plan summary, transition
//      state to running
//
// Non-orchestrator sessions and prompts unrelated to decomposition:
// pass through untouched. The planner only inspects traffic during an
// in-flight decomposition turn for a known orchestrator.

import { TransformerClient } from "./acp/transformer.js";
import type { JsonRpcRequest, JsonRpcNotification } from "./acp/protocol.js";
import { logger } from "./util/log.js";
import {
  buildAgentMessageChunkEnvelope,
  buildTextPromptEnvelope,
  extractPromptText,
  extractUpdateText,
  updateKind,
} from "./util/text.js";
import { formatBoardContext, formatStatus } from "./format.js";
import { rmSync } from "node:fs";
import {
  allTerminal,
  canonicalProjectId,
  inFlightCount,
  listProjects,
  loadBoard,
  newBoard,
  nowIso,
  pickEligible,
  saveBoard,
  shortProjectId,
  shortSessionId,
  type Board,
  type Task,
} from "./board.js";
import { projectDir } from "./paths.js";
import {
  buildAddTaskPrompt,
  buildDecompositionPrompt,
  extractAddTaskBlock,
  extractJsonBlock,
  formatPlanSummary,
  normalizeAddedTasks,
  normalizeDecomposition,
  sweepLineConcurrencyCap,
} from "./decomposition.js";
import {
  buildTaskPrompt,
  extractResultBlock,
  normalizeResult,
} from "./task.js";
import {
  clearOrchestratorState,
  clearWorkerState,
  getOrchestratorState,
  getWorkerState,
  orchestratorOfWorker,
  registerWorker,
  setOrchestratorState,
  setWorkerState,
  unregisterWorker,
} from "./state.js";

const log = logger("planner");

const INTERCEPTS = [
  // User-typed non-slash prompts to an orchestrator session get
  // rewritten to include a board-context preamble, so the agent can
  // answer natural-language questions about the project ("what's
  // left?", "why bcrypt cost 12?") without needing MCP tools. Slash
  // commands (`/hydra ...`) are intercepted by hydra before the chain
  // runs, so they don't reach this handler.
  "request:session/prompt",
  // Only response:session/update fires in the response chain — hydra's
  // runResponseChain is session/update-only. We use the embedded
  // sessionUpdate kind ("agent_message_chunk", "turn_complete", ...)
  // to demultiplex what we'd otherwise want as separate intercepts.
  "response:session/update",
  "lifecycle:session.opened",
  "lifecycle:session.idle",
  "lifecycle:session.closed",
];

// The advertised name. Hydra-acp's slash-command convention is
// `/hydra <name> <verb>`, and the prefix elision lets users type the
// short form: `/hydra planner create ...` routes here. Both forms work.
const PROCESS_NAME = "hydra-acp-planner";

const COMMANDS = [
  {
    verb: "create",
    argsHint: "<description>",
    description: "Plan a new project from a description and spawn workers (M2+).",
  },
  {
    verb: "status",
    description: "Show the board for this session's project.",
  },
  {
    verb: "cancel",
    argsHint: "[<projectId>]",
    description: "Stop this session's project (or another by id). Cancels in-flight workers; pending tasks stay frozen on the board.",
  },
  {
    verb: "add",
    argsHint: "<description>",
    description: "Slot a new task into this session's project. Asks the orchestrator agent where it fits and schedules it.",
  },
  {
    verb: "retask",
    argsHint: "<taskId>",
    description: "Reset a task to pending. Closes its current worker (if any), bumps attemptCount, schedules next.",
  },
  {
    verb: "skip",
    argsHint: "<taskId>",
    description: "Mark a task done without running it. Use to bypass a task whose intent is no longer needed.",
  },
  {
    verb: "kill",
    argsHint: "<workerId>",
    description: "Close a specific worker session. Requeues its current task as pending.",
  },
  {
    verb: "remove",
    argsHint: "[<projectId>]",
    description: "Delete this session's project (or another by id). Closes worker sessions; orchestrator session is left intact.",
  },
];

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
}

// Track active boards in memory so we don't reload from disk on every
// intercept. Updates flow to board.json on every state transition; the
// in-memory copy is the source of truth during process lifetime.
const boards = new Map<string, Board>(); // orchestratorSessionId -> Board

// Sessions we've successfully attached to via hydra-acp/transformer/attach
// during this process lifetime. Best-effort: if the daemon restarted
// the session or removed us from its chain, this set is wrong, but
// there's no current way for the planner to know that without
// querying. Used by `/hydra planner status` to report whether we
// believe we're observing the session.
const attachedSessions = new Set<string>();

// Walk projects on disk and find the board owned by `orchestratorSessionId`.
// Cheap fallback for `/hydra planner status` queries on done/failed
// projects that rehydrateFromDisk leaves out of the in-memory boards map.
// O(N) over the number of projects on disk; not on the intercept hot path.
function findBoardOnDisk(orchestratorSessionId: string): Board | undefined {
  for (const entry of listProjects()) {
    if (entry.orchestratorSessionId === orchestratorSessionId) {
      return loadBoard(entry.projectId);
    }
  }
  return undefined;
}

// Inverse of findBoardOnDisk — given a projectId, return its
// orchestrator session id (the session the user typed /hydra planner
// create in). Reads the `orchestrator` pointer file via listProjects'
// existing scan. Used by `cancel <projectId>` from a non-orchestrator
// session.
function orchestratorSessionForProject(projectId: string): string | undefined {
  for (const entry of listProjects()) {
    if (entry.projectId === projectId) {
      return entry.orchestratorSessionId;
    }
  }
  return undefined;
}

// Formatters moved to ./format.ts for unit-testability without
// dragging in the PlannerBridge constructor and its WS connection.

export class PlannerBridge {
  private client: TransformerClient;

  constructor(opts: BridgeOptions) {
    this.client = new TransformerClient({
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
      intercepts: INTERCEPTS,
      clientName: PROCESS_NAME,
    });
    this.client.on("open", () => {
      log.info("transformer registered, intercepts active");
      void this.registerCommands();
      void this.rehydrateFromDisk();
    });
    this.client.on("close", ({ hadError }) => log.info(`disconnected (hadError=${hadError})`));
    this.client.on("error", (err) => log.error("client error:", err));
    this.client.on("request", (req) => this.handleRequest(req));
    this.client.on("notification", (note) => this.handleNotification(note));
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.client.request("hydra-acp/commands/register", {
        commands: COMMANDS,
      });
      log.info(`registered ${COMMANDS.length} slash command(s): ${COMMANDS.map((c) => c.verb).join(", ")}`);
    } catch (err) {
      log.error(`commands/register failed: ${(err as Error).message}`);
    }
  }

  // Read every project board on disk after (re)connect and re-establish
  // the planner's presence in the sessions that need it. Three pieces:
  //
  //   1. Repopulate the in-memory `boards` map for ALL non-terminal
  //      projects, so incoming slash commands / response intercepts can
  //      resolve their orchestrator.
  //   2. For projects currently in `decomposing` state, restore the
  //      orchestrator's state-machine entry with awaitingDecomposition
  //      and re-attach to the orchestrator session so subsequent agent
  //      chunks reach our intercept. (Chunks emitted during the
  //      disconnect are lost; M5 resurrection picks up the slack.)
  //   3. For tasks currently in `assigned` state, restore the worker's
  //      state-machine entry and re-attach to the worker session.
  //
  // Best-effort throughout: a session that no longer exists on the
  // daemon is skipped with a warning. The board stays on disk; the next
  // user invocation cleans it up via `/hydra planner remove` or runs a
  // fresh attempt.
  private async rehydrateFromDisk(): Promise<void> {
    const entries = listProjects();
    if (entries.length === 0) {
      return;
    }
    let activeBoards = 0;
    let attachedOrchestrators = 0;
    let attachedWorkers = 0;

    for (const entry of entries) {
      if (entry.state === "done" || entry.state === "failed") {
        continue;
      }
      const board = loadBoard(entry.projectId);
      if (!board) continue;
      const orchestratorId = entry.orchestratorSessionId;
      if (!orchestratorId) {
        log.warn(
          `project ${shortProjectId(board.projectId)} has no orchestrator pointer; skipping rehydrate`,
        );
        continue;
      }

      boards.set(orchestratorId, board);
      activeBoards += 1;

      if (board.state === "decomposing") {
        setOrchestratorState(orchestratorId, {
          projectId: board.projectId,
          decompositionAccumulator: "",
          awaitingDecomposition: true,
          addAccumulator: "",
          awaitingAdd: false,
        });
        if (await this.tryAttach(orchestratorId, `orchestrator for ${shortProjectId(board.projectId)}`)) {
          attachedOrchestrators += 1;
        }
      }

      // Workers mid-task: restore state + reattach.
      for (const task of board.tasks) {
        if (task.status !== "assigned" || !task.assignedTo) continue;
        const workerId = task.assignedTo;
        setWorkerState(workerId, {
          orchestratorSessionId: orchestratorId,
          taskId: task.id,
          resultAccumulator: "",
        });
        registerWorker(workerId, orchestratorId);
        if (await this.tryAttach(workerId, `worker ${task.id} on ${shortProjectId(board.projectId)}`)) {
          attachedWorkers += 1;
        }
      }
    }

    if (activeBoards > 0) {
      log.info(
        `rehydrated ${activeBoards} active board(s); reattached ${attachedOrchestrators} orchestrator(s), ${attachedWorkers} worker(s)`,
      );
    }
  }

  private async tryAttach(sessionId: string, label: string): Promise<boolean> {
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
      return true;
    } catch (err) {
      log.warn(
        `rehydrate: could not attach to ${label} (session=…${sessionId.slice(-8)}): ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ── Request dispatch ────────────────────────────────────────────────

  private handleRequest(req: JsonRpcRequest): void {
    if (req.method === "hydra-acp/transformer/message") {
      this.handleTransformerMessage(req);
      return;
    }
    if (req.method === "hydra-acp/commands/invoke") {
      this.handleCommandsInvoke(req);
      return;
    }
    log.warn(`unexpected request method: ${req.method}`);
    this.client.replyError(req.id, -32601, "Method not found");
  }

  // ── Slash command invocation ───────────────────────────────────────

  private handleCommandsInvoke(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as {
      sessionId?: string;
      verb?: string;
      args?: string;
    };
    const sessionId = params.sessionId ?? "";
    const verb = params.verb ?? "";
    const args = (params.args ?? "").trim();

    if (verb === "create") {
      void this.handleCreate(req.id, sessionId, args).catch((err) => {
        log.error(`handleCreate threw: ${(err as Error).message}`);
        // The slash command's commands/invoke is still pending —
        // dispatch a reply so it doesn't hang forever.
        this.client.reply(req.id, {
          text: `⚠️ Internal error: ${(err as Error).message}`,
        });
      });
      return;
    }
    if (verb === "status") {
      this.handleStatus(req.id, sessionId);
      return;
    }
    if (verb === "cancel") {
      this.handleCancel(req.id, sessionId, args);
      return;
    }
    if (verb === "add") {
      void this.handleAdd(req.id, sessionId, args).catch((err) => {
        log.error(`handleAdd threw: ${(err as Error).message}`);
        this.client.reply(req.id, {
          text: `⚠️ Internal error: ${(err as Error).message}`,
        });
      });
      return;
    }
    if (verb === "retask") {
      this.handleRetask(req.id, sessionId, args);
      return;
    }
    if (verb === "skip") {
      this.handleSkip(req.id, sessionId, args);
      return;
    }
    if (verb === "kill") {
      this.handleKill(req.id, sessionId, args);
      return;
    }
    if (verb === "remove") {
      this.handleRemove(req.id, sessionId, args);
      return;
    }
    this.client.reply(req.id, { text: `unknown planner verb: ${verb}` });
  }

  // Stop a project mid-run. With no args, cancels the current session's
  // project; with an arg, cancels the named project (handy from any
  // session). For each task currently `assigned` to a worker, force-
  // cancel the worker's in-flight turn and mark the task `failed`.
  // Pending tasks stay frozen on the board. Board state transitions to
  // `failed`. The scheduler's terminal-state guard prevents the
  // worker-completion callbacks from re-arming. No sessions are deleted —
  // both orchestrator and worker sessions remain, so the user can
  // inspect (or later, when M5 resurrection lands, resume).
  private handleCancel(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    let board: Board | undefined;
    let orchestratorSessionId: string | undefined;
    if (args.length > 0) {
      const canonical = canonicalProjectId(args.split(/\s+/)[0]!);
      board = loadBoard(canonical);
      if (board) {
        orchestratorSessionId = orchestratorSessionForProject(canonical);
      }
    } else {
      board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
      orchestratorSessionId = sessionId;
    }
    if (!board || !orchestratorSessionId) {
      this.client.reply(reqId, {
        text:
          args.length > 0
            ? `No project '${args}' found.`
            : "No plan in this session to cancel. Use `/hydra planner cancel <projectId>` for a different project.",
      });
      return;
    }
    const canonical = board.projectId;
    if (board.state === "done" || board.state === "failed") {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(canonical)} is already ${board.state}.`,
      });
      return;
    }

    // Snapshot in-flight workers before mutating, then mark each as
    // failed. The actual force_cancel happens async; we don't await
    // because the user's reply should be immediate.
    const inFlight: Array<{ workerId: string; taskId: string }> = [];
    for (const task of board.tasks) {
      if (task.status === "assigned" && task.assignedTo) {
        inFlight.push({ workerId: task.assignedTo, taskId: task.id });
        task.status = "failed";
        task.finishedAt = nowIso();
      }
    }
    board.state = "failed";
    saveBoard(board, orchestratorSessionId);

    // Force-cancel each in-flight worker. force_cancel is a request
    // that aggressively halts the agent's current turn — more decisive
    // than the notification-shaped session/cancel. We swallow errors:
    // a worker that's already done/closed won't accept the cancel, and
    // that's fine because the goal is "stop running, drop state."
    log.info(
      `cancelling project ${shortProjectId(canonical)} — ${inFlight.length} in-flight worker${inFlight.length === 1 ? "" : "s"}`,
    );
    for (const { workerId } of inFlight) {
      void this.client
        .request("hydra-acp/session/force_cancel", { sessionId: workerId })
        .catch((err) => {
          log.warn(
            `force_cancel of worker ${workerId} failed: ${(err as Error).message}`,
          );
        });
    }

    const tail =
      inFlight.length > 0
        ? `; ${inFlight.length} in-flight task${inFlight.length === 1 ? "" : "s"} cancelled`
        : "";
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `⨯ Project ${shortProjectId(canonical)} cancelled${tail}.`,
    );
    this.client.reply(reqId, {
      text: `Cancelled project ${shortProjectId(canonical)}${tail}.`,
    });
  }

  // ── Plan mutations ────────────────────────────────────────────────

  // Look up the current session's board, with a friendly reply if no
  // project is owned by this session. Shared by the mutation verbs.
  private requireBoard(
    reqId: number | string,
    sessionId: string,
  ): { board: Board; orchestratorSessionId: string } | undefined {
    const board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
    if (!board) {
      this.client.reply(reqId, {
        text: "No plan in this session yet. Start one with `/hydra planner create <description>`.",
      });
      return undefined;
    }
    if (board.state === "done" || board.state === "failed") {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(board.projectId)} is ${board.state}. Use \`/hydra planner create\` to start a new one.`,
      });
      return undefined;
    }
    // The session this verb came from may not be the same as the
    // session that originally owned the board on disk (e.g. attached
    // via a different client). For mutations we want to use the
    // session the slash arrived on as the orchestratorSessionId so
    // saveBoard updates the right pointer.
    return { board, orchestratorSessionId: sessionId };
  }

  // /hydra planner add <description>
  //
  // Ask the orchestrator agent to slot the user's request into the
  // existing DAG. Uses the same suppress+accumulate pattern as
  // decomposition but with the hydra-add-task block schema. New tasks
  // are appended to board.tasks; the scheduler picks them up.
  private async handleAdd(
    reqId: number | string,
    sessionId: string,
    description: string,
  ): Promise<void> {
    if (description.length === 0) {
      this.client.reply(reqId, {
        text: "planner add: usage `/hydra planner add <description>`",
      });
      return;
    }
    const ctx = this.requireBoard(reqId, sessionId);
    if (!ctx) return;
    const { board, orchestratorSessionId } = ctx;

    // Best-effort attach (in case this session never invoked us before).
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(
        `add: transformer/attach failed: ${(err as Error).message}`,
      );
    }

    // Set the awaiting flag BEFORE we emit so the response intercept
    // accumulates this turn's chunks rather than passing them through.
    let state = getOrchestratorState(orchestratorSessionId);
    if (!state) {
      state = {
        projectId: board.projectId,
        decompositionAccumulator: "",
        awaitingDecomposition: false,
        addAccumulator: "",
        awaitingAdd: false,
      };
      setOrchestratorState(orchestratorSessionId, state);
    }
    state.addAccumulator = "";
    state.awaitingAdd = true;

    await this.emitSyntheticMessage(
      orchestratorSessionId,
      `📝 Asking the agent to slot in: "${description}"`,
    );

    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId: orchestratorSessionId,
        method: "session/prompt",
        envelope: buildTextPromptEnvelope({
          sessionId: orchestratorSessionId,
          text: buildAddTaskPrompt(description, board),
        }),
        route: "chain",
      });
    } catch (err) {
      state.awaitingAdd = false;
      log.error(`add: emit failed: ${(err as Error).message}`);
      await this.emitSyntheticMessage(
        orchestratorSessionId,
        `⚠️ Couldn't ask the agent to plan the addition: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Parse the accumulated reply.
    const existingIds = new Set(board.tasks.map((t) => t.id));
    const rawBlock = extractAddTaskBlock(state.addAccumulator);
    const result = rawBlock === undefined
      ? undefined
      : normalizeAddedTasks(rawBlock, existingIds);
    state.awaitingAdd = false;
    state.addAccumulator = "";

    if (!result) {
      log.warn(`add: parse failed for ${board.projectId}`);
      await this.emitSyntheticMessage(
        orchestratorSessionId,
        `⚠️ Couldn't parse a hydra-add-task block from the agent's reply. Try \`/hydra planner add <description>\` again with a clearer description.`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Merge the new tasks into the board and bump the concurrency cap
    // to reflect the (potentially wider) DAG. Persist before
    // scheduling so an immediate restart picks up the new tasks.
    board.tasks.push(...result.tasks);
    board.concurrencyCap = sweepLineConcurrencyCap(board.tasks);
    saveBoard(board, orchestratorSessionId);
    boards.set(orchestratorSessionId, board);

    log.info(
      `added ${result.tasks.length} task(s) to ${board.projectId}: ${result.tasks.map((t) => t.id).join(", ")}`,
    );

    const idsList = result.tasks.map((t) => `${t.id} ${t.title}`).join(", ");
    const warningsBlock =
      result.warnings.length > 0
        ? `\n⚠️ ${result.warnings.length} parse warning${result.warnings.length === 1 ? "" : "s"}:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}\n`
        : "";
    await this.emitSyntheticMessage(
      orchestratorSessionId,
      `+ Added ${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"}: ${idsList}${warningsBlock}`,
    );

    // Kick off the scheduler — newly-added tasks with all-deps-met are
    // eligible immediately, otherwise they wait for the dep chain to
    // catch up.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);

    this.client.reply(reqId, { text: "" });
  }

  // /hydra planner skip <taskId>
  //
  // Mark a task done with empty artifacts. Closes its worker if one
  // was assigned. Useful for bypassing tasks the user has decided
  // aren't needed after all without re-decomposing.
  private handleSkip(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    const taskId = args.split(/\s+/)[0]?.trim() ?? "";
    if (!taskId) {
      this.client.reply(reqId, {
        text: "planner skip: usage `/hydra planner skip <taskId>` (e.g. `/hydra planner skip T3`)",
      });
      return;
    }
    const ctx = this.requireBoard(reqId, sessionId);
    if (!ctx) return;
    const { board, orchestratorSessionId } = ctx;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.client.reply(reqId, { text: `No task '${taskId}' in this project.` });
      return;
    }
    if (task.status === "done") {
      this.client.reply(reqId, { text: `${taskId} is already done.` });
      return;
    }
    if (task.status === "failed") {
      this.client.reply(reqId, {
        text: `${taskId} is in failed state — use \`/hydra planner retask ${taskId}\` to retry or accept it as is.`,
      });
      return;
    }

    // If a worker is currently on this task, free it up.
    const workerId = task.assignedTo;
    if (task.status === "assigned" && workerId) {
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      delete board.workers[workerId];
      void this.closeWorker(workerId);
    }

    task.status = "done";
    task.finishedAt = nowIso();
    task.artifacts = { summary: "skipped by user" };
    task.assignedTo = null;
    saveBoard(board, orchestratorSessionId);
    log.info(`skipped ${taskId} in ${board.projectId}`);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `✓ ${taskId} skipped (marked done with no work).`,
    );
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
    this.client.reply(reqId, { text: `Skipped ${taskId}.` });
  }

  // /hydra planner retask <taskId>
  //
  // Reset a task to pending. If it's currently assigned, close its
  // worker first (the work is discarded). Useful when a task got into a
  // bad state and the user wants to try fresh.
  private handleRetask(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    const taskId = args.split(/\s+/)[0]?.trim() ?? "";
    if (!taskId) {
      this.client.reply(reqId, {
        text: "planner retask: usage `/hydra planner retask <taskId>` (e.g. `/hydra planner retask T3`)",
      });
      return;
    }
    const ctx = this.requireBoard(reqId, sessionId);
    if (!ctx) return;
    const { board, orchestratorSessionId } = ctx;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.client.reply(reqId, { text: `No task '${taskId}' in this project.` });
      return;
    }

    // If a worker is currently on this task, free it.
    const workerId = task.assignedTo;
    if (task.status === "assigned" && workerId) {
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      delete board.workers[workerId];
      void this.closeWorker(workerId);
    }

    task.status = "pending";
    task.assignedTo = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.artifacts = null;
    saveBoard(board, orchestratorSessionId);

    log.info(`retask ${taskId} in ${board.projectId} (attemptCount=${task.attemptCount})`);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `↻ ${taskId} reset to pending (attempt #${task.attemptCount + 1} next).`,
    );
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
    this.client.reply(reqId, { text: `Reset ${taskId} to pending.` });
  }

  // /hydra planner kill <workerId>
  //
  // Close a specific worker session, requeueing its current task as
  // pending. Use to force-stop a misbehaving worker without resetting
  // the whole task or cancelling the whole project.
  private handleKill(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    const rawWorkerId = args.split(/\s+/)[0]?.trim() ?? "";
    if (!rawWorkerId) {
      this.client.reply(reqId, {
        text: "planner kill: usage `/hydra planner kill <workerId>`",
      });
      return;
    }
    // Accept short or full worker session id.
    const workerId = rawWorkerId.startsWith("hydra_session_")
      ? rawWorkerId
      : `hydra_session_${rawWorkerId}`;

    const orchestratorId = orchestratorOfWorker(workerId);
    if (!orchestratorId) {
      this.client.reply(reqId, {
        text: `No active worker '${rawWorkerId}' tracked by planner.`,
      });
      return;
    }
    const board = boards.get(orchestratorId);
    if (!board) {
      this.client.reply(reqId, {
        text: `Worker '${rawWorkerId}' has no board in memory (project may have been removed).`,
      });
      return;
    }

    // Find the task this worker is on (if any).
    const task = board.tasks.find(
      (t) => t.status === "assigned" && t.assignedTo === workerId,
    );

    // Close + clean up regardless of whether we found a task.
    clearWorkerState(workerId);
    unregisterWorker(workerId);
    delete board.workers[workerId];
    void this.closeWorker(workerId);

    if (task) {
      task.status = "pending";
      task.assignedTo = null;
      task.startedAt = null;
      saveBoard(board, orchestratorId);
      log.info(`killed worker ${workerId}; requeued ${task.id}`);
      void this.emitSyntheticMessage(
        orchestratorId,
        `⨯ Worker ${shortSessionId(workerId)} killed; ${task.id} requeued.`,
      );
      void this.scheduleEligibleTasks(orchestratorId, board);
      this.client.reply(reqId, {
        text: `Killed worker ${shortSessionId(workerId)} and requeued ${task.id}.`,
      });
      return;
    }

    saveBoard(board, orchestratorId);
    log.info(`killed worker ${workerId} (no in-flight task)`);
    void this.emitSyntheticMessage(
      orchestratorId,
      `⨯ Worker ${shortSessionId(workerId)} killed.`,
    );
    this.client.reply(reqId, {
      text: `Killed worker ${shortSessionId(workerId)}.`,
    });
  }

  // Drop a project. With no args, removes the project owned by the
  // current session (the orchestrator). With an arg, removes that
  // project — useful when the user wants to clean up from inside an
  // unrelated session. The orchestrator session itself is never touched
  // (that's a real conversation the user might want to keep); worker
  // sessions ARE closed via the daemon.
  private handleRemove(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    let board: Board | undefined;
    let canonical: string | undefined;
    if (args.length > 0) {
      canonical = canonicalProjectId(args.split(/\s+/)[0]!);
      board = loadBoard(canonical);
      if (!board) {
        this.client.reply(reqId, {
          text: `No project '${args}' found.`,
        });
        return;
      }
    } else {
      board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
      if (!board) {
        this.client.reply(reqId, {
          text: "No plan in this session to remove. Use `/hydra planner remove <projectId>` for a different project.",
        });
        return;
      }
      canonical = board.projectId;
    }

    const workerIds = Object.keys(board.workers);
    // Close every worker session via the daemon. Best-effort — a worker
    // that's already gone won't block the cleanup.
    void (async () => {
      for (const workerId of workerIds) {
        try {
          await this.client.request("hydra-acp/session/delete", {
            sessionId: workerId,
          });
        } catch {
          // already-gone worker is fine; planner record removal is what matters
        }
      }
    })();

    // Drop in-memory state for the orchestrator (so /hydra planner
    // create in this session starts cleanly).
    if (boards.get(sessionId)?.projectId === canonical) {
      boards.delete(sessionId);
      clearOrchestratorState(sessionId);
    }
    // And worker state.
    for (const workerId of workerIds) {
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      attachedSessions.delete(workerId);
    }

    rmSync(projectDir(canonical), { recursive: true, force: true });
    log.info(
      `removed project ${shortProjectId(canonical)} (${workerIds.length} worker session${workerIds.length === 1 ? "" : "s"} closed)`,
    );
    this.client.reply(reqId, {
      text: `Removed project ${shortProjectId(canonical)}${workerIds.length > 0 ? ` (${workerIds.length} worker session${workerIds.length === 1 ? "" : "s"} closed)` : ""}.`,
    });
  }

  // Show the current session's project (if any) inline in the
  // transcript. Reply text becomes a synthetic agent_message_chunk via
  // hydra's emitExtensionReply path — no decomposition turn, no agent
  // round-trip.
  private handleStatus(reqId: number | string, sessionId: string): void {
    // In-memory first (hot path for active projects). Falls back to
    // disk for done/failed projects, which rehydrateFromDisk skips on
    // restart to keep the active set lean.
    const board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
    if (!board) {
      const attached = attachedSessions.has(sessionId);
      const tail = attached
        ? " (planner is attached to this session but has no project for it)"
        : "";
      this.client.reply(reqId, {
        text: `No plan in this session yet. Start one with \`/hydra planner create <description>\`.${tail}`,
      });
      return;
    }
    this.client.reply(reqId, {
      text: formatStatus(board, attachedSessions.has(sessionId)),
    });
  }

  private async handleCreate(reqId: number | string, sessionId: string, description: string): Promise<void> {
    if (!sessionId) {
      this.client.reply(reqId, { text: "planner create: missing sessionId" });
      return;
    }
    if (!description) {
      this.client.reply(reqId, {
        text: "planner create: usage `/hydra planner create <description>`",
      });
      return;
    }
    if (getOrchestratorState(sessionId)?.awaitingDecomposition) {
      this.client.reply(reqId, {
        text: "planner create: a decomposition is already in flight for this session — wait for it to finish.",
      });
      return;
    }

    const board = newBoard({ description });
    boards.set(sessionId, board);
    saveBoard(board, sessionId);
    setOrchestratorState(sessionId, {
      projectId: board.projectId,
      decompositionAccumulator: "",
      addAccumulator: "",
      awaitingAdd: false,
      awaitingDecomposition: true,
    });

    log.info(
      `decomposing project ${board.projectId} for session …${sessionId.slice(-8)}: ${description.slice(0, 80)}`,
    );

    // Surface the initial status immediately so the user sees something
    // happen while decomposition runs. Then we hold the commands/invoke
    // response open until the work completes, which keeps hydra's
    // in-flight turn (the slash command itself) busy — driving the
    // busy indicator in the TUI / other clients.
    await this.emitSyntheticMessage(
      sessionId,
      `🧩 Planning project ${shortProjectId(board.projectId)} — asking the agent to decompose.`,
    );

    // Self-install into this session's chain so our response intercepts
    // fire on the decomposition turn we're about to start. Idempotent.
    try {
      await this.client.request("hydra-acp/transformer/attach", {
        sessionId,
      });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.error(
        `transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
      board.state = "failed";
      saveBoard(board, sessionId);
      const errState = getOrchestratorState(sessionId);
      if (errState) errState.awaitingDecomposition = false;
      await this.emitSyntheticMessage(
        sessionId,
        `⚠️ Could not attach to this session: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Fire the substitute decomposition prompt. The emit promise
    // resolves when the agent's session/prompt response returns — i.e.
    // when the synthetic turn completes. We await it because:
    //
    //   - It IS the end-of-turn signal we use to parse the accumulator
    //     and emit the plan summary (the daemon's synthesized
    //     turn_complete bypasses the response chain via
    //     broadcastTurnComplete, so we can't observe end-of-turn through
    //     intercepts).
    //   - Holding the await keeps commands/invoke pending, which keeps
    //     the user's slash-command turn in flight in hydra's queue, which
    //     keeps the busy indicator on while decomposition runs.
    //
    // Agent chunks during the await still flow through our response
    // intercepts (separate handler dispatch), so accumulation works
    // even though we're "blocked" here.
    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/prompt",
        envelope: buildTextPromptEnvelope({
          sessionId,
          text: buildDecompositionPrompt(description),
        }),
        route: "chain",
      });
    } catch (err) {
      log.error(
        `decomposition turn failed for ${board.projectId}: ${(err as Error).message}`,
      );
      const failedState = getOrchestratorState(sessionId);
      if (failedState) failedState.awaitingDecomposition = false;
      board.state = "failed";
      saveBoard(board, sessionId);
      await this.emitSyntheticMessage(
        sessionId,
        `⚠️ Decomposition turn for ${shortProjectId(board.projectId)} failed: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Turn complete — parse the accumulated reply and emit the summary.
    // finishDecomposition is synchronous; it also kicks off the first
    // pass of scheduling via `void this.scheduleEligibleTasks(...)` which
    // runs in the background after we return (workers don't keep the
    // orchestrator's slash-command turn busy).
    const doneState = getOrchestratorState(sessionId);
    if (doneState && doneState.awaitingDecomposition) {
      this.finishDecomposition(sessionId, doneState);
    }

    // Reply empty so hydra doesn't tack on a redundant synthetic chunk —
    // we've already emitted everything we wanted to say.
    this.client.reply(reqId, { text: "" });
  }

  // ── Transformer message intercepts ─────────────────────────────────

  private handleTransformerMessage(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as {
      phase?: string;
      method?: string;
      sessionId?: string;
      envelope?: unknown;
      token?: string;
    };
    const sessionId = params.sessionId ?? "";
    const phase = params.phase ?? "";
    const method = params.method ?? "";

    if (phase === "request" && method === "session/prompt") {
      this.handlePromptRequest(
        req.id,
        sessionId,
        params.envelope,
        params.token ?? "",
      );
      return;
    }
    if (phase === "response" && method === "session/update") {
      this.handleUpdateResponse(req.id, sessionId, params.envelope);
      return;
    }
    // Anything else we declared an interest in: pass through.
    this.client.reply(req.id, { action: "continue" });
  }

  // Inject board context into user prompts to the orchestrator agent.
  // Only acts when:
  //   - The session is one we have a board for in memory (i.e. an
  //     orchestrator we're actively driving), AND
  //   - The board has tasks (no point injecting an empty board).
  //
  // Pass through unchanged for: worker sessions, sessions with no
  // board, decomposition-in-progress orchestrators (we already own the
  // turn there), and slash-command prompts (filtered by hydra before
  // the chain runs, but defensive).
  //
  // Uses the modify-and-continue pattern via `action: "processing"`:
  // park the user's original request with the chain token, emit the
  // rewritten prompt via route:"chain" and capture the agent's
  // response, then discharge the parked claim with that response. The
  // user's wire-level session/prompt stays in flight throughout — one
  // prompt_received, one turn_complete, clean turn boundary for the
  // TUI (vs. stop+emit which severs the boundary and confuses the
  // TUI's echo flushing).
  private handlePromptRequest(
    reqId: number | string,
    sessionId: string,
    envelope: unknown,
    token: string,
  ): void {
    const board = boards.get(sessionId);
    if (!board || board.tasks.length === 0) {
      this.client.reply(reqId, { action: "continue" });
      return;
    }
    const orchState = getOrchestratorState(sessionId);
    if (orchState?.awaitingDecomposition) {
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    const params = (envelope as { params?: unknown })?.params ?? envelope;
    const originalPrompt = (params as { prompt?: unknown })?.prompt;
    const userText = extractPromptText(originalPrompt);
    if (userText.startsWith("/hydra")) {
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    // Build the rewritten envelope: context preamble as a new leading
    // text block, then everything the user actually sent.
    const preamble = formatBoardContext(board);
    const originalBlocks: Array<{ type?: string; text?: string }> = Array.isArray(
      originalPrompt,
    )
      ? (originalPrompt as Array<{ type?: string; text?: string }>)
      : [{ type: "text", text: typeof originalPrompt === "string" ? originalPrompt : "" }];
    const rewrittenPrompt = [
      { type: "text", text: preamble + "\n" },
      ...originalBlocks,
    ];
    const rewrittenEnvelope: Record<string, unknown> = {
      sessionId,
      prompt: rewrittenPrompt,
    };
    const originalMeta = (params as { _meta?: unknown })?._meta;
    if (originalMeta !== undefined) {
      rewrittenEnvelope._meta = originalMeta;
    }

    // Park the original. The daemon now holds the user's session/prompt
    // call open until we discharge `token`.
    this.client.reply(reqId, { action: "processing" });

    void (async () => {
      try {
        // Emit the rewritten prompt down the rest of the chain to the
        // agent. With the daemon's chain-response support, this returns
        // the agent's actual session/prompt response (containing
        // stopReason etc.) — which is exactly what the user's parked
        // call should resolve to.
        const result = await this.client.request<{
          ok: boolean;
          response?: unknown;
        }>("hydra-acp/message/emit", {
          sessionId,
          method: "session/prompt",
          envelope: rewrittenEnvelope,
          route: "chain",
        });
        const response = result?.response ?? { stopReason: "end_turn" };
        // Discharge the parked claim with the agent's response. This
        // resolves the daemon's pending forwardRequest, which returns
        // up through runQueueEntry and triggers broadcastTurnComplete
        // with the agent's actual stopReason.
        await this.client.request("hydra-acp/message/emit", {
          sessionId,
          method: "session/prompt",
          envelope: response,
          respondsTo: token,
        });
      } catch (err) {
        log.warn(
          `context-injection turn for session …${sessionId.slice(-8)} failed: ${(err as Error).message}`,
        );
        // Best-effort: try to discharge with a synthetic stop so the
        // user's call doesn't hang indefinitely. If discharge also
        // fails, the daemon's claim timeout will eventually fail-open
        // (resume the chain from after our position with the original
        // envelope, which will then hit the agent unmodified — degraded
        // but not broken).
        await this.client
          .request("hydra-acp/message/emit", {
            sessionId,
            method: "session/prompt",
            envelope: { stopReason: "cancelled" },
            respondsTo: token,
          })
          .catch(() => {});
      }
    })();
  }

  // Response-side session/update intercept. Demuxes on the embedded
  // sessionUpdate kind because hydra's response chain is session/update-only.
  // Three cases:
  //   1. Orchestrator session mid-decomposition  → accumulate + suppress
  //   2. Worker session running an assigned task → accumulate + pass through
  //   3. Anything else                            → pass through
  //
  // We do NOT key on turn_complete: hydra synthesizes it via
  // broadcastTurnComplete → recordAndBroadcast, bypassing the response
  // chain. End-of-turn is detected by awaiting the message/emit promise
  // in handleCreate (orchestrator) and spawnTaskOnNewWorker (worker).
  private handleUpdateResponse(reqId: number | string, sessionId: string, envelope: unknown): void {
    const orchState = getOrchestratorState(sessionId);
    if (orchState && orchState.awaitingDecomposition) {
      const kind = updateKind(envelope);
      if (kind === "agent_message_chunk") {
        const text = extractUpdateText(envelope);
        if (text.length > 0) {
          orchState.decompositionAccumulator += text;
        }
        this.client.reply(reqId, { action: "stop" });
        return;
      }
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    // Same suppress+accumulate pattern for /hydra planner add. The
    // agent's reply contains a hydra-add-task JSON block we'll parse
    // when the turn completes; the user shouldn't see the raw JSON.
    if (orchState && orchState.awaitingAdd) {
      const kind = updateKind(envelope);
      if (kind === "agent_message_chunk") {
        const text = extractUpdateText(envelope);
        if (text.length > 0) {
          orchState.addAccumulator += text;
        }
        this.client.reply(reqId, { action: "stop" });
        return;
      }
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    const workerState = getWorkerState(sessionId);
    if (workerState) {
      const kind = updateKind(envelope);
      if (kind === "agent_message_chunk") {
        const text = extractUpdateText(envelope);
        if (text.length > 0) {
          workerState.resultAccumulator += text;
        }
        // Pass through for workers — they're ancillary sessions so
        // attached clients (if any) opted in to seeing the raw work.
        this.client.reply(reqId, { action: "continue" });
        return;
      }
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    this.client.reply(reqId, { action: "continue" });
  }

  // Called when the message/emit promise resolves (agent's session/prompt
  // response came back, turn is complete). Parses the accumulated agent
  // reply, populates the board, emits the plan summary.
  private finishDecomposition(
    sessionId: string,
    state: NonNullable<ReturnType<typeof getOrchestratorState>>,
  ): void {
    const board = boards.get(sessionId);
    if (!board) {
      log.warn(`turn_complete with state but no board for session …${sessionId.slice(-8)}`);
      clearOrchestratorState(sessionId);
      return;
    }

    const raw = extractJsonBlock(state.decompositionAccumulator);
    const result = raw === undefined ? undefined : normalizeDecomposition(raw);

    if (!result) {
      log.warn(`decomposition parse failed for ${board.projectId}; accumulator length=${state.decompositionAccumulator.length}`);
      board.state = "failed";
      saveBoard(board, sessionId);
      void this.emitSyntheticMessage(
        sessionId,
        `⚠️ Couldn't parse a decomposition out of the agent's reply for ${shortProjectId(board.projectId)}. Try \`/hydra planner create\` again with a clearer description.`,
      );
      state.awaitingDecomposition = false;
      state.decompositionAccumulator = "";
      return;
    }

    board.tasks = result.tasks;
    board.concurrencyCap = sweepLineConcurrencyCap(result.tasks);
    board.state = "running";
    saveBoard(board, sessionId);
    state.awaitingDecomposition = false;
    state.decompositionAccumulator = "";

    log.info(
      `decomposed ${board.projectId}: ${result.tasks.length} tasks, cap=${board.concurrencyCap}, warnings=${result.warnings.length}`,
    );

    const summary = formatPlanSummary(result.tasks, board.concurrencyCap);
    const warningsBlock =
      result.warnings.length > 0
        ? `\n⚠️ ${result.warnings.length} parse warning${result.warnings.length === 1 ? "" : "s"}:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}\n`
        : "";
    void this.emitSyntheticMessage(sessionId, `${summary}${warningsBlock}`);

    // Kick off the scheduler: fills up to concurrencyCap workers with
    // initial eligible tasks. Subsequent completions trigger refill.
    void this.scheduleEligibleTasks(sessionId, board);
  }

  // ── Worker scheduling ─────────────────────────────────────────────

  // The scheduler: spawn up to `board.concurrencyCap` workers,
  // each on the next eligible task. Called after decomposition
  // (initial fill), after every task completion (refill the freed
  // slot + any newly-unblocked tasks), and after every task failure
  // (likewise — don't stall on failure).
  //
  // Invocation is idempotent and safe to call concurrently with
  // itself: each spawn synchronously marks its task `assigned` and
  // persists the board before yielding the event loop, so a second
  // entry sees the up-to-date state. Single-threaded JS means no
  // real races.
  private async scheduleEligibleTasks(orchestratorSessionId: string, board: Board): Promise<void> {
    // Terminal-state guard: once a board is done or failed (including
    // user-cancelled), never schedule new work. Completion callbacks
    // from in-flight workers still fire after cancel — the guard
    // prevents them from re-arming the scheduler.
    if (board.state === "done" || board.state === "failed") {
      return;
    }
    // Project-complete short-circuit. Emit once, transition state, return.
    if (allTerminal(board)) {
      board.state = "done";
      saveBoard(board, orchestratorSessionId);
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `🎉 Project ${shortProjectId(board.projectId)} complete — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} done.`,
      );
      return;
    }

    while (inFlightCount(board) < board.concurrencyCap) {
      const task = pickEligible(board);
      if (!task) {
        // Nothing eligible right now. Either we hit the cap, or
        // remaining work is dep-blocked behind in-flight tasks. The
        // next task completion will retry — no need to poll.
        return;
      }
      // Spawn synchronously enough to claim the task before the
      // next loop iteration sees it. The actual emit + run is
      // fire-and-forget; on completion it calls back into
      // scheduleEligibleTasks to fill the slot.
      await this.spawnTaskOnNewWorker(orchestratorSessionId, board, task);
    }
  }

  // Spawn a fresh worker session, attach to it, mark the task as
  // assigned, persist the board, fire the task prompt. The promise
  // resolves once the task is claimed (board state is consistent) —
  // not when the turn completes. Turn completion is handled by the
  // inner async closure firing handleTaskComplete / handleTaskFailure.
  private async spawnTaskOnNewWorker(
    orchestratorSessionId: string,
    board: Board,
    task: Task,
  ): Promise<void> {
    let childSessionId: string;
    try {
      const spawnResult = await this.client.request<{ childSessionId: string }>(
        "hydra-acp/child_session/spawn",
        {
          parentSessionId: orchestratorSessionId,
          // cwd omitted → inherits from parent
          // agentId omitted → daemon uses defaultAgent. M6 honors per-task overrides.
        },
      );
      childSessionId = spawnResult.childSessionId;
    } catch (err) {
      log.error(
        `failed to spawn worker for ${task.id}: ${(err as Error).message}`,
      );
      task.status = "failed";
      task.attemptCount += 1;
      saveBoard(board, orchestratorSessionId);
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `⚠️ ${task.id} failed to spawn a worker: ${(err as Error).message}`,
      );
      return;
    }

    try {
      await this.client.request("hydra-acp/transformer/attach", {
        sessionId: childSessionId,
      });
      attachedSessions.add(childSessionId);
    } catch (err) {
      log.error(
        `transformer/attach to worker ${childSessionId} failed: ${(err as Error).message}`,
      );
      void this.closeWorker(childSessionId);
      task.status = "failed";
      task.attemptCount += 1;
      saveBoard(board, orchestratorSessionId);
      return;
    }

    // Claim the task: mark assigned + persist BEFORE the outer
    // scheduler loop can pickEligible again. After this point the
    // task is no longer "pending" to anyone.
    task.status = "assigned";
    task.assignedTo = childSessionId;
    task.startedAt = nowIso();
    task.attemptCount += 1;
    board.workers[childSessionId] = { currentTaskId: task.id, tasksCompleted: [] };
    saveBoard(board, orchestratorSessionId);

    setWorkerState(childSessionId, {
      orchestratorSessionId,
      taskId: task.id,
      resultAccumulator: "",
    });
    registerWorker(childSessionId, orchestratorSessionId);

    log.info(
      `assigned ${task.id} (${task.title}) to worker …${childSessionId.slice(-8)}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `▶ ${task.id} → worker ${shortSessionId(childSessionId)}  (${task.title})`,
    );

    // Fire the task prompt asynchronously. We're not awaiting the
    // emit promise here because the scheduler needs to return so
    // the next iteration of its loop can spawn the next worker in
    // parallel — that's the whole point of concurrent execution.
    // Turn completion is handled when this promise resolves.
    void (async () => {
      try {
        await this.client.request("hydra-acp/message/emit", {
          sessionId: childSessionId,
          method: "session/prompt",
          envelope: buildTextPromptEnvelope({
            sessionId: childSessionId,
            text: buildTaskPrompt(task, board),
            ancillary: true,
          }),
          route: "chain",
        });
      } catch (err) {
        log.error(
          `task turn for ${task.id} on worker ${childSessionId} failed: ${(err as Error).message}`,
        );
        this.handleTaskFailure(
          orchestratorSessionId,
          childSessionId,
          board,
          task,
          `task turn failed: ${(err as Error).message}`,
        );
        return;
      }
      this.handleTaskComplete(orchestratorSessionId, childSessionId, board, task);
    })();
  }

  // Called when the worker's session/prompt turn completes. Parses the
  // hydra-result block from the accumulated reply, persists artifacts,
  // closes the worker session, and (M2: halts; M3+: schedules next).
  private handleTaskComplete(
    orchestratorSessionId: string,
    workerSessionId: string,
    board: Board,
    task: Task,
  ): void {
    const workerState = getWorkerState(workerSessionId);
    if (!workerState) {
      log.warn(
        `task complete fired but no worker state for …${workerSessionId.slice(-8)}`,
      );
      return;
    }
    const raw = extractResultBlock(workerState.resultAccumulator);
    const result = raw === undefined ? undefined : normalizeResult(raw);

    if (!result) {
      this.handleTaskFailure(
        orchestratorSessionId,
        workerSessionId,
        board,
        task,
        `worker reply missing or malformed hydra-result block (accumulator length=${workerState.resultAccumulator.length})`,
      );
      return;
    }

    task.status = "done";
    task.finishedAt = nowIso();
    task.artifacts = result.artifacts;
    task.assignedTo = null;
    const workerEntry = board.workers[workerSessionId];
    if (workerEntry) {
      workerEntry.currentTaskId = null;
      workerEntry.tasksCompleted.push(task.id);
    }
    saveBoard(board, orchestratorSessionId);

    log.info(
      `completed ${task.id} on worker …${workerSessionId.slice(-8)} — ${result.artifacts.summary}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `✓ ${task.id}  ${result.artifacts.summary ?? task.title}`,
    );

    clearWorkerState(workerSessionId);
    unregisterWorker(workerSessionId);
    void this.closeWorker(workerSessionId);

    // Try to refill the freed slot. Completing this task may have also
    // unblocked dependents — scheduleEligibleTasks loops until it hits
    // the cap or runs out of eligible work. Also handles the
    // project-complete transition when no more work remains.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
  }

  private handleTaskFailure(
    orchestratorSessionId: string,
    workerSessionId: string,
    board: Board,
    task: Task,
    reason: string,
  ): void {
    log.warn(`task ${task.id} failed on worker …${workerSessionId.slice(-8)}: ${reason}`);
    task.status = "failed";
    task.assignedTo = null;
    const workerEntry = board.workers[workerSessionId];
    if (workerEntry) {
      workerEntry.currentTaskId = null;
    }
    saveBoard(board, orchestratorSessionId);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `⨯ ${task.id} failed — ${reason}`,
    );
    clearWorkerState(workerSessionId);
    unregisterWorker(workerSessionId);
    void this.closeWorker(workerSessionId);

    // Don't stall on failure — the next eligible task (or project
    // completion when nothing remains) is still the right thing.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
  }

  private async closeWorker(workerSessionId: string): Promise<void> {
    attachedSessions.delete(workerSessionId);
    try {
      await this.client.request("hydra-acp/child_session/close", {
        childSessionId: workerSessionId,
      });
    } catch (err) {
      log.warn(
        `closing worker ${workerSessionId} failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Notifications ──────────────────────────────────────────────────

  private handleNotification(note: JsonRpcNotification): void {
    if (note.method === "hydra-acp/transformer/session_event") {
      const params = (note.params ?? {}) as { event?: string; sessionId?: string };
      log.debug(
        `lifecycle ${params.event} session=${params.sessionId?.slice(-8) ?? "?"}`,
      );
      return;
    }
    log.debug(`unhandled notification: ${note.method}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  // Synthetic progress messages get wrapped with leading + trailing
  // newlines so successive emissions render with visible separation in
  // the transcript. Mirrors how hydra's own emitExtensionReply formats
  // slash-command replies.
  private async emitSyntheticMessage(sessionId: string, text: string): Promise<void> {
    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/update",
        envelope: buildAgentMessageChunkEnvelope({
          sessionId,
          text: `\n${text}\n`,
        }),
        route: "chain",
      });
    } catch (err) {
      log.warn(`emit synthetic message failed: ${(err as Error).message}`);
    }
  }
}
