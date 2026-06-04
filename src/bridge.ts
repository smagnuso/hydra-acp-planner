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
  extractUpdateText,
  updateKind,
} from "./util/text.js";
import {
  allTerminal,
  listProjects,
  loadBoard,
  newBoard,
  nowIso,
  pickEligible,
  saveBoard,
  shortProjectId,
  type Board,
  type Task,
} from "./board.js";
import {
  buildDecompositionPrompt,
  extractJsonBlock,
  formatPlanSummary,
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
  registerWorker,
  setOrchestratorState,
  setWorkerState,
  unregisterWorker,
} from "./state.js";

const log = logger("planner");

const INTERCEPTS = [
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
];

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
}

// Track active boards in memory so we don't reload from disk on every
// intercept. Updates flow to board.json on every state transition; the
// in-memory copy is the source of truth during process lifetime.
const boards = new Map<string, Board>(); // orchestratorSessionId -> Board

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
      this.handleCreate(req.id, sessionId, args);
      return;
    }
    this.client.reply(req.id, { text: `unknown planner verb: ${verb}` });
  }

  private handleCreate(reqId: number | string, sessionId: string, description: string): void {
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
      awaitingDecomposition: true,
    });

    log.info(
      `decomposing project ${board.projectId} for session …${sessionId.slice(-8)}: ${description.slice(0, 80)}`,
    );

    // Self-install into this session's chain so our response intercepts
    // fire on the decomposition turn we're about to start. Idempotent:
    // hydra's session.addTransformer is a no-op when we're already in
    // the chain (e.g. when the user did wire us into defaultTransformers
    // anyway). Lets users keep us out of defaultTransformers and have
    // invocation be the opt-in — the planner only joins sessions it's
    // actively driving.
    //
    // Fire the substitute decomposition prompt and await the message/emit
    // promise — it resolves when the agent's session/prompt response
    // returns, which IS the end-of-turn signal we need. (The daemon's
    // own synthesized turn_complete session/update bypasses the
    // response chain via broadcastTurnComplete, so we can't detect end
    // of turn via the intercept stream — we have to ride the emit
    // promise.) The agent's chunks have already streamed through our
    // response intercepts by the time the promise resolves.
    void (async () => {
      try {
        await this.client.request("hydra-acp/transformer/attach", {
          sessionId,
        });
      } catch (err) {
        log.error(
          `transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
        );
        return;
      }
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
        if (failedState) {
          failedState.awaitingDecomposition = false;
        }
        const failedBoard = boards.get(sessionId);
        if (failedBoard) {
          failedBoard.state = "failed";
          saveBoard(failedBoard, sessionId);
        }
        void this.emitSyntheticMessage(
          sessionId,
          `⚠️ Decomposition turn for ${shortProjectId(board.projectId)} failed: ${(err as Error).message}`,
        );
        return;
      }
      // Agent's turn is complete. The chunks were accumulated via our
      // response:session/update intercepts; now parse + emit summary.
      const doneState = getOrchestratorState(sessionId);
      if (doneState && doneState.awaitingDecomposition) {
        this.finishDecomposition(sessionId, doneState);
      }
    })();

    // Ack to hydra — surfaces as an agent_message_chunk in the user's
    // transcript right after their /hydra planner create command.
    this.client.reply(reqId, {
      text: `🧩 Planning project ${shortProjectId(board.projectId)} — asking the agent to decompose.`,
    });
  }

  // ── Transformer message intercepts ─────────────────────────────────

  private handleTransformerMessage(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as {
      phase?: string;
      method?: string;
      sessionId?: string;
      envelope?: unknown;
    };
    const sessionId = params.sessionId ?? "";
    const phase = params.phase ?? "";
    const method = params.method ?? "";

    if (phase === "response" && method === "session/update") {
      this.handleUpdateResponse(req.id, sessionId, params.envelope);
      return;
    }
    // Anything else we declared an interest in: pass through.
    this.client.reply(req.id, { action: "continue" });
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
  // in handleCreate (orchestrator) and assignNextTask (worker).
  private handleUpdateResponse(reqId: number | string, sessionId: string, envelope: unknown): void {
    const orchState = getOrchestratorState(sessionId);
    if (orchState && orchState.awaitingDecomposition) {
      const kind = updateKind(envelope);
      if (kind === "agent_message_chunk") {
        const text = extractUpdateText(envelope);
        if (text.length > 0) {
          orchState.decompositionAccumulator += text;
        }
        // Suppress: client never sees the raw JSON streaming by.
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

    // M2: kick off the first eligible task. M3+ replaces this with a
    // proper scheduler that maintains concurrencyCap workers in flight.
    void this.assignNextTask(sessionId, board);
  }

  // ── Worker scheduling ─────────────────────────────────────────────

  // Pick the next eligible task, spawn a fresh worker session for it,
  // attach the planner to the child's chain, fire off the task prompt,
  // and process the result on emit-promise resolution. M2 fires at most
  // one worker; M3 generalizes to maintain board.concurrencyCap in flight.
  private async assignNextTask(orchestratorSessionId: string, board: Board): Promise<void> {
    if (allTerminal(board)) {
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `🎉 Project ${shortProjectId(board.projectId)} complete — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} done.`,
      );
      board.state = "done";
      saveBoard(board, orchestratorSessionId);
      return;
    }

    const task = pickEligible(board);
    if (!task) {
      // Nothing pending and deps-satisfied right now. (M2 doesn't expect
      // this branch — with no parallelism yet, every non-terminal
      // sequence reaches here only between turns.) For now, just return.
      log.debug(
        `no eligible task for ${board.projectId}; ${board.tasks.length} tasks total`,
      );
      return;
    }

    // Spawn the worker session. cwd is omitted — the daemon inherits it
    // from the orchestrator (parentSessionId), so the worker runs in
    // the same project root.
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

    // Attach ourselves to the worker's chain so we see its response chunks.
    try {
      await this.client.request("hydra-acp/transformer/attach", {
        sessionId: childSessionId,
      });
    } catch (err) {
      log.error(
        `transformer/attach to worker ${childSessionId} failed: ${(err as Error).message}`,
      );
      void this.closeWorker(childSessionId);
      return;
    }

    // Reserve the task and the worker. Persist BEFORE emitting so a
    // crash in between leaves a recoverable record.
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
      `▶ ${task.id} → worker …${childSessionId.slice(-8)}  (${task.title})`,
    );

    // Fire the task prompt. As with decomposition, the emit promise
    // resolves when the agent's session/prompt response comes back —
    // i.e. when the task turn is complete. Mark ancillary so the worker
    // session stays out of default UI surfaces unless the user opts in
    // by attaching.
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

    // M2: halt after one task. M3+: void this.assignNextTask(...).
    if (allTerminal(board)) {
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `🎉 Project ${shortProjectId(board.projectId)} complete — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} done.`,
      );
      board.state = "done";
      saveBoard(board, orchestratorSessionId);
    }
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
  }

  private async closeWorker(workerSessionId: string): Promise<void> {
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

  private async emitSyntheticMessage(sessionId: string, text: string): Promise<void> {
    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/update",
        envelope: buildAgentMessageChunkEnvelope({ sessionId, text }),
        route: "chain",
      });
    } catch (err) {
      log.warn(`emit synthetic message failed: ${(err as Error).message}`);
    }
  }
}
