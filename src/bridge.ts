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
import { newBoard, saveBoard, type Board } from "./board.js";
import {
  buildDecompositionPrompt,
  extractJsonBlock,
  formatPlanSummary,
  normalizeDecomposition,
  sweepLineConcurrencyCap,
} from "./decomposition.js";
import {
  clearOrchestratorState,
  getOrchestratorState,
  setOrchestratorState,
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
          `⚠️ Decomposition turn for ${board.projectId} failed: ${(err as Error).message}`,
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
      text: `🧩 Planning project ${board.projectId} — asking the agent to decompose.`,
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
  // During a decomposition turn we accumulate the agent's text chunks
  // and suppress them from clients — the synthetic plan summary
  // replaces them once the turn ends.
  //
  // We do NOT key on turn_complete here: hydra's daemon synthesizes
  // turn_complete via broadcastTurnComplete which uses recordAndBroadcast
  // directly, bypassing the response chain. End-of-turn for decomposition
  // is instead detected by awaiting the message/emit promise in handleCreate.
  private handleUpdateResponse(reqId: number | string, sessionId: string, envelope: unknown): void {
    const state = getOrchestratorState(sessionId);
    if (!state || !state.awaitingDecomposition) {
      this.client.reply(reqId, { action: "continue" });
      return;
    }
    const kind = updateKind(envelope);
    if (kind === "agent_message_chunk") {
      const text = extractUpdateText(envelope);
      if (text.length > 0) {
        state.decompositionAccumulator += text;
      }
      // Suppress: client never sees the raw JSON streaming by.
      this.client.reply(reqId, { action: "stop" });
      return;
    }
    // Tool calls, plan updates, mode/model changes, usage_update,
    // turn boundaries from the daemon — pass through unchanged. The
    // agent shouldn't tool-call during a decomposition turn but if it
    // does, we don't interfere.
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
        `⚠️ Couldn't parse a decomposition out of the agent's reply for ${board.projectId}. Try \`/hydra planner create\` again with a clearer description.`,
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
