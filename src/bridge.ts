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
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./acp/protocol.js";

// Minimal surface PlannerBridge uses on its TransformerClient. Defined
// as a structural interface so tests can substitute a fake without
// pulling in the real WebSocket. TransformerClient already satisfies
// this shape.
export interface BridgeClient {
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  reply(id: JsonRpcId, result: unknown): void;
  replyError(id: JsonRpcId, code: number, message: string): void;
  start(): void;
  stop(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (info: { hadError: boolean }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "request", listener: (req: JsonRpcRequest) => void): unknown;
  on(event: "notification", listener: (n: JsonRpcNotification) => void): unknown;
}
import { logger } from "./util/log.js";
import {
  buildAgentMessageChunkEnvelope,
  buildTextPromptEnvelope,
  extractAgentIdUpdate,
  extractCurrentModelUpdate,
  extractPromptText,
  extractUpdateText,
  extractUsageUpdate,
  updateKind,
} from "./util/text.js";
import { formatBoardContext, formatStatus, totalUsage } from "./format.js";
import {
  buildAsciiPlanEnvelope,
  buildPlanUpdateEnvelope,
  getPlanRenderMode,
  normalizeSubtodoEntries,
} from "./plan-update.js";
import {
  clearHeldTurn,
  createHeldTurn,
  getHeldTurn,
  resolveHeldTurn,
  type HeldTurnReason,
  type HeldTurnVerb,
} from "./held-turn.js";
import { WorkerForwarder } from "./worker-forward.js";
import { PLANNER_MCP_INSTRUCTIONS, PLANNER_MCP_TOOLS } from "./mcp-tools.js";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  allTerminal,
  canonicalProjectId,
  inFlightCount,
  listProjects,
  loadBoard,
  newBoard,
  nowIso,
  pickEligible,
  resolveAgent,
  resolveModel,
  resolveReviewLane,
  resolveRunOn,
  saveBoard,
  setBoardState,
  shortProjectId,
  stopBoardBookkeeping,
  shortSessionId,
  type Board,
  type Task,
  type TaskArtifacts,
  type TaskStatus,
  type WorkerSubtodo,
} from "./board.js";
import { projectDir } from "./paths.js";
import {
  fetchSessionDiff,
  httpBaseFromWsUrl,
  summarizeDiff,
  type DiffFile,
} from "./util/session-diff.js";
import { fetchSessionInfo } from "./util/session-info.js";
import {
  buildAddTaskPrompt,
  buildDecompositionPrompt,
  buildExecuteDecompositionPrompt,
  buildResumeDecompositionPrompt,
  type AgentChoice,
  extractAddTaskBlock,
  extractJsonBlock,
  formatPlanSummary,
  normalizeAddedTasks,
  normalizeDecomposition,
  sweepLineConcurrencyCap,
} from "./decomposition.js";
import type { NormalizedResult } from "./task.js";
import { promptsFor } from "./task.js";
import {
  clearOrchestratorState,
  clearWorkerState,
  getLatestOrchestratorUsage,
  getOrchestratorState,
  getWorkerState,
  isOrchestrator,
  orchestratorOfWorker,
  recordOrchestratorUsage,
  registerWorker,
  setOrchestratorState,
  setWorkerState,
  unregisterWorker,
} from "./state.js";
import { type ReviewPolicy, applyReviewPolicy, resolveReviewPolicy } from "./review-policy.js";

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
//
// Agent→client requests like session/request_permission do NOT come
// through the transformer chain (the daemon broadcasts them only to
// attached clients). The planner gets visibility into them by also
// session/attach-ing to each worker as a regular client over the same
// WebSocket — see attachAsClient + handlePermissionRequest below.

// Worker session_update kinds we forward into the orchestrator's
// held turn, preserving the original sessionUpdate kind so the TUI
// renders them with the correct affordance (thought blocks, tool-call
// panels, message chunks). All text streams (agent_message_chunk +
// agent_thought_chunk) go through WorkerForwarder's buffer-and-flush
// (idle debounce + max-hold ceiling) so a worker's prose appears as
// cohesive chunks rather than per-token fragments with `[Tn] `
// re-injected mid-word. Tool calls are atomic and forwarded inline,
// after first flushing pending text so order reads naturally.
//
// `plan` updates from worker sessions are NOT forwarded — the
// orchestrator has its own plan panel managed by emitPlanUpdate, and
// worker plans would either collide with it or duplicate it.



// The advertised name. Hydra-acp's slash-command convention is
// `/hydra <name> <verb>`, and the prefix elision lets users type the
// short form: `/hydra planner create ...` routes here. Both forms work.
const PROCESS_NAME = "hydra-acp-planner";

const COMMANDS = [
  {
    // Bare `/hydra planner` (no verb) routes here. Treated as a
    // synonym for `status` — see verb dispatch in handleCommandsInvoke.
    verb: "",
    description: "Show the board for this session's project (same as `status`).",
  },
  {
    verb: "create",
    argsHint: "[--attach <path>] <description>",
    description: "Plan a new project from a description and spawn workers (M2+). Use `--attach <path>` (repeatable) to inline a spec/plan file into every worker prompt — useful when workers don't have permission to read it themselves.",
  },
  {
    verb: "status",
    description: "Show the current board snapshot for this session's project. One-shot — does not open a live view.",
  },
  {
    verb: "continue",
    description: "Re-open the live view on this session's running project. The plan panel re-renders, worker output streams, banner stays busy until the project completes (or the user amends/cancels).",
  },
  {
    verb: "stop",
    argsHint: "[<projectId>]",
    description: "Stop this session's project (or another by id). Force-cancels in-flight workers and reverts those tasks to pending; the project is resumable via /hydra planner start.",
  },
  {
    verb: "add",
    argsHint: "<description>",
    description: "Slot a new task into this session's project. Asks the orchestrator agent where it fits and schedules it.",
  },
  {
    verb: "retry",
    argsHint: "[taskId]",
    description: "Reset a task to pending and resume work. Closes its current worker (if any), bumps attemptCount. If the project was stopped, flips it back to running and re-opens the live view. With no arg, retries every failed task.",
  },
  {
    verb: "restart",
    description: "Reset every task on the board to pending and run the whole plan from scratch. Closes any in-flight workers, clears artifacts, and opens the live view. The plan structure stays intact — only task state is wiped. Use to redo a project after a code change without rebuilding the DAG.",
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
    verb: "start",
    argsHint: "[--workers N] [--agent ID] [--model ID] [--attach <path>]",
    description: "Plan from the conversation so far. Asks the orchestrator agent to decompose what you've been discussing into a task DAG and spawns workers. Use `--attach <path>` (repeatable) to inline a spec/plan file into every worker prompt.",
  },
  {
    verb: "pause",
    description: "Stop scheduling new tasks. In-flight workers run to completion; their results land normally but no new tasks dispatch until resume.",
  },
  {
    verb: "resume",
    description: "Resume scheduling on a paused project.",
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
  // Test seam: when provided, PlannerBridge uses this instead of
  // constructing a TransformerClient. Lets tests inject a fake that
  // records request/reply calls without opening a real WebSocket.
  client?: BridgeClient;
  // Test seam: when provided, the verified_diff audit calls this
  // instead of hitting the daemon's HTTP API. Lets tests exercise
  // the audit logic without a live daemon.
  fetchSessionDiff?: (
    sessionId: string,
  ) => Promise<import("./util/session-diff.js").DiffFile[] | undefined>;
  // Test seam: when provided, the orchestrator-identity seed at
  // board-create time calls this instead of hitting the daemon's
  // GET /v1/sessions/:id endpoint.
  fetchSessionInfo?: (
    sessionId: string,
  ) => Promise<import("./util/session-info.js").SessionInfo | undefined>;
}

// Track active boards in memory so we don't reload from disk on every
// intercept. Updates flow to board.json on every state transition; the
// in-memory copy is the source of truth during process lifetime.
// Exported so tests can reset between cases — production code never
// imports this; it's a module-private singleton in practice.
export const boards = new Map<string, Board>(); // orchestratorSessionId -> Board

// Sessions we've successfully attached to (via transformer/attach for
// orchestrators, or session/attach client mode for workers) during
// this process lifetime. Best-effort: if the daemon restarted
// the session or removed us from its chain, this set is wrong, but
// there's no current way for the planner to know that without
// querying. Used by `/hydra planner status` to report whether we
// believe we're observing the session.
export const attachedSessions = new Set<string>();

// Sessions we've attached to as a peer client via session/attach.
// Two roles, one WS connection: transformer-attach (orchestrators)
// plugs us into the chain so we can intercept prompts and updates;
// session-attach makes us a peer client so we can submit prompts
// via session/prompt (e.g. to inject /hydra planner status after an
// amend, restoring the live view at the head of the queue) and
// receive client broadcasts like hydra-acp/prompt/amended. Mirrors
// the pattern slack-bridge uses in [slack/src/acp/attach.ts].
export const clientAttachedSessions = new Set<string>();

// Boards rehydrated from disk that we haven't yet been able to attach
// to because their orchestrator session is still cold. The polling
// loop probes these every few seconds via `hydra-acp/transformer/attach`
// — when the user reopens the TUI or fires a slash command, the
// session goes live, attach succeeds, and we activate (waking workers
// and resuming tasks).
export const pendingActivation = new Set<string>(); // orchestratorSessionId

// Per-worker forwarders that buffer streaming agent_message_chunk /
// agent_thought_chunk text from the worker and flush it as a single
// cohesive emit on natural boundaries. See worker-forward.ts for
// rationale (avoids `[Tn] ` injection mid-sentence).
const workerForwarders = new Map<string, WorkerForwarder>();

// Tracks in-flight commands/invoke dispatches keyed by the daemon-
// assigned messageId. Set when handleCommandsInvoke receives the
// request, cleared when it finishes. The `cancelled` flag is set by
// handleCommandsCancel when the daemon's commands/cancel
// notification fires. handleCreate / handleStart / handleStatus
// check this flag at major await boundaries so they can bail out
// gracefully even when the cancel arrives BEFORE the held turn is
// opened (e.g. during the ~10s decomposition window). Without this,
// an early cancel would orphan the dispatch: decomposition would
// complete, holdAndReply would open a turn that no signal ever
// resolves, and workers spawned mid-decomposition would run
// indefinitely.
interface PendingDispatch {
  sessionId: string;
  messageId: string;
  cancelled: boolean;
  cancelReason: "amended" | "cancelled" | "abandoned" | "";
}
const pendingDispatches = new Map<string, PendingDispatch>(); // by messageId

const ACTIVATION_POLL_INTERVAL_MS = 3000;

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

// Resolve a list of `--attach <path>` values into Attachment records.
// Tilde-expands `~/...`, then resolves relative paths against the
// daemon's cwd. Reads the file synchronously (these are user-supplied
// at command time — we want to fail loudly before decomposition
// starts rather than crash a worker mid-task). Returns a list of
// Attachment records on success, or an error string on the first
// path that fails to resolve or read.
function loadAttachments(paths: string[]): { attachments: import("./board.js").Attachment[] } | { error: string } {
  const out: import("./board.js").Attachment[] = [];
  for (const raw of paths) {
    const expanded = raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
    const absolute = resolvePath(expanded);
    try {
      const content = readFileSync(absolute, "utf8");
      out.push({ path: absolute, content });
    } catch (err) {
      return { error: `--attach ${raw}: ${(err as Error).message}` };
    }
  }
  return { attachments: out };
}

interface FinishReviewOpts {
  reviewedTask: Task;
  reviewTask: Task;
  board: Board;
  orchestratorSessionId: string;
  /** Status to set on the reviewed task (default: "done") */
  reviewedStatus?: TaskStatus;
  /** Merge decision-specific content into reviewed task artifacts */
  mergeArtifacts?: (artifacts: TaskArtifacts, normalized: NormalizedResult | undefined) => void;
  /** Custom log message */
  logMessage: string;
  /** Synthetic event message text */
  eventMessage: string;
  /** Event tag for the synthetic message metadata */
  eventTag: string;
  /** Extra event metadata properties */
  extraEventProps?: Record<string, unknown>;
}

export class PlannerBridge {
  private client: BridgeClient;
  // Daemon HTTP base URL and bearer token. Derived from BridgeOptions
  // and used by the verified_diff audit (which hits /v1/sessions/:id/diff
  // directly rather than going through the ACP WS channel).
  private daemonHttpBase: string;
  private daemonToken: string;
  // Test seam: swap in a fake fetcher so tests don't need a live
  // daemon. When undefined, the production fetchSessionDiff path
  // is used.
  private fetchDiffOverride:
    | ((sessionId: string) => Promise<import("./util/session-diff.js").DiffFile[] | undefined>)
    | undefined;
  private fetchSessionInfoOverride:
    | ((sessionId: string) => Promise<import("./util/session-info.js").SessionInfo | undefined>)
    | undefined;
  // Cached list of installed specialist agents, populated lazily on
  // first prompt-building call. Refreshed at startup. Decomposition and
  // add-task prompts splice this in so the planner agent only suggests
   // agents that actually exist.
  private agentChoices: AgentChoice[] | undefined;
  // Per-project guard for the "stuck behind failed deps" notification
  // so we don't re-emit it every time scheduleEligibleTasks is invoked
  // (which happens after every completion + cancel + retry). Cleared
  // when the board exits the blocked state (any pending task becomes
  // eligible again, e.g. via retry of the failed root).
  private blockedNotifiedFor = new Set<string>();

  private async ensureAgentChoices(): Promise<AgentChoice[] | undefined> {
    if (this.agentChoices !== undefined) return this.agentChoices;
    try {
      const result = await this.client.request<{
        agents?: Array<{ id?: unknown; description?: unknown; installed?: unknown }>;
      }>("hydra-acp/agents/list", {});
      const out: AgentChoice[] = [];
      for (const a of result?.agents ?? []) {
        if (typeof a.id !== "string") continue;
        if (a.installed !== "yes") continue;
        out.push({
          id: a.id,
          description: typeof a.description === "string" ? a.description : undefined,
        });
      }
      this.agentChoices = out;
      log.info(`fetched ${out.length} installed agent choice(s) for prompts`);
      return out;
    } catch (err) {
      log.warn(`agents/list failed; decomposition prompt will omit agent options: ${(err as Error).message}`);
      this.agentChoices = [];
      return this.agentChoices;
    }
  }

  // Seed `board.orchestratorAgent` / `orchestratorModel` from the
  // daemon's authoritative session info at board-create time. The
  // reactive update path (session_info_update / current_model_update
  // intercepts in handleSessionUpdate) only fires when the orchestrator
  // emits a fresh notification — which typically happened during
  // session startup, long before any board existed for that session.
  // Without this seed, freshly-created boards have null agent/model
  // until the user changes models or otherwise re-triggers emission,
  // and the status / plan-panel / preamble all render "-".
  private async seedOrchestratorIdentity(
    board: Board,
    sessionId: string,
  ): Promise<void> {
    const fetcher = this.fetchSessionInfoOverride
      ?? ((sid: string) =>
        fetchSessionInfo(sid, {
          daemonHttpBase: this.daemonHttpBase,
          token: this.daemonToken,
        }));
    try {
      const info = await fetcher(sessionId);
      if (!info) return;
      if (info.agentId && !board.orchestratorAgent) {
        board.orchestratorAgent = info.agentId;
      }
      if (info.currentModel && !board.orchestratorModel) {
        board.orchestratorModel = info.currentModel;
      }
    } catch (err) {
      log.debug(`seedOrchestratorIdentity ${sessionId}: ${(err as Error).message}`);
    }
  }

  constructor(opts: BridgeOptions) {
    this.daemonHttpBase = httpBaseFromWsUrl(opts.daemonWsUrl);
    this.daemonToken = opts.token;
    this.fetchDiffOverride = opts.fetchSessionDiff;
    this.fetchSessionInfoOverride = opts.fetchSessionInfo;
    this.client =
      opts.client ??
      new TransformerClient({
        daemonWsUrl: opts.daemonWsUrl,
        token: opts.token,
        intercepts: INTERCEPTS,
        clientName: PROCESS_NAME,
      });
    this.client.on("open", () => {
      log.info("transformer registered, intercepts active");
      void this.registerCommands();
      void this.registerMcpTools();
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
    // Mark shutdown so in-flight emit catches don't mark tasks failed.
    // The work continues on the daemon's side; we want it to stay
    // "assigned" on disk so the next planner startup resumes it via
    // rehydrate.
    this.shuttingDown = true;
    if (this.activationTimer) {
      clearInterval(this.activationTimer);
      this.activationTimer = null;
    }
    this.client.stop();
  }

  private activationTimer: NodeJS.Timeout | null = null;
  private activationTickInFlight: Promise<void> | null = null;

  // True between PlannerBridge.stop() and process exit. Used to
  // distinguish "ws closed because we're shutting down" from "ws
  // closed because of some other failure" in task-turn catch
  // handlers. When true, do not call handleTaskFailure — let the
  // on-disk task state stay "assigned" so the next process startup
  // picks it up.
  private shuttingDown = false;

  // Recognise errors that are really about our connection going down
  // (own shutdown, daemon dying out from under us, network blip)
  // rather than a real agent / work failure. Tasks affected by these
  // errors should be left in their on-disk state so the next startup
  // resumes them, instead of being marked failed.
  private isShutdownError(err: unknown): boolean {
    if (this.shuttingDown) return true;
    const msg = (err as Error)?.message ?? "";
    return msg.includes("ws closed") || msg.includes("ws is closed");
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

  // Advertise MCP tools the planner implements. The daemon injects
  // them into each session's mcpServers list at session/new time, so
  // MCP-capable agents (Claude, opencode, codex, …) see them
  // natively and can call them from conversational turns without the
  // user needing to remember slash command syntax.
  //
  // Tool invocations arrive on this transformer's WS connection as
  // hydra-acp/mcp_tools/invoke requests; dispatched in handleRequest.
  private async registerMcpTools(): Promise<void> {
    try {
      const result = await this.client.request<{ ok: boolean; registered: number }>(
        "hydra-acp/mcp_tools/register",
        {
          instructions: PLANNER_MCP_INSTRUCTIONS,
          tools: PLANNER_MCP_TOOLS,
        },
      );
      log.info(
        `registered ${result.registered ?? PLANNER_MCP_TOOLS.length} MCP tool(s): ${PLANNER_MCP_TOOLS.map((t) => t.name).join(", ")}`,
      );
    } catch (err) {
      log.error(`mcp_tools/register failed: ${(err as Error).message}`);
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

    // Group non-terminal boards by their owning orchestrator session
    // and pick a single canonical board per orchestrator (newest by
    // createdAt). Orphaned older boards get retired to `failed` on
    // disk — they pre-date the one-active-per-session rule
    // `handleCreate` now enforces. One-time cleanup for sessions
    // polluted by earlier runs.
    const byOrchestrator = new Map<string, Board[]>();
    for (const entry of entries) {
      if (entry.state === "done" || entry.state === "failed") continue;
      const board = loadBoard(entry.projectId);
      if (!board) continue;
      const orchestratorId = entry.orchestratorSessionId;
      if (!orchestratorId) {
        log.warn(
          `project ${shortProjectId(board.projectId)} has no orchestrator pointer; skipping rehydrate`,
        );
        continue;
      }
      const arr = byOrchestrator.get(orchestratorId) ?? [];
      arr.push(board);
      byOrchestrator.set(orchestratorId, arr);
    }

    for (const [orchestratorId, group] of byOrchestrator) {
      group.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const [board, ...orphans] = group;
      if (!board) continue;
      for (const orphan of orphans) {
        log.warn(
          `retiring orphaned board ${shortProjectId(orphan.projectId)} (orchestrator …${orchestratorId.slice(-8)} already has newer board ${shortProjectId(board.projectId)})`,
        );
        setBoardState(orphan, "failed");
        saveBoard(orphan, orchestratorId);
      }

      boards.set(orchestratorId, board);
      activeBoards += 1;

      // Populate in-memory state so intercepts and slash commands have
      // a handle, but do NOT attempt to attach yet. Orchestrators come
      // back to life naturally when the user reopens the TUI or fires
      // a slash command; the polling loop below detects that and
      // activates the board (attach + wake workers + resume).
      setOrchestratorState(orchestratorId, {
         projectId: board.projectId,
         decompositionAccumulator: "",
         awaitingDecomposition: board.state === "decomposing",
         addAccumulator: "",
         awaitingAdd: false,
         awaitingOrchestratorReview: false,
         orchestratorReviewTaskId: null,
         orchestratorReviewAccumulator: "",
       });

      for (const task of board.tasks) {
        if (task.status !== "assigned" || !task.assignedTo) continue;
        const workerId = task.assignedTo;
        setWorkerState(workerId, {
          orchestratorSessionId: orchestratorId,
          taskId: task.id,
          resultAccumulator: "",
          repromptCount: 0,
        });
        registerWorker(workerId, orchestratorId);
        workerForwarders.set(
          workerId,
          new WorkerForwarder({
            workerSessionId: workerId,
            orchestratorSessionId: orchestratorId,
            taskId: task.id,
            emit: this.makeWorkerEmit(workerId),
          }),
        );
      }

      // Rehydrate in-flight orchestrator-lane reviews: reset them to
      // pending so the scheduler can reschedule them. The previous
      // process crashed mid-review; the host session is free again.
      for (const task of board.tasks) {
        if (task.kind === "review" && task.status === "assigned" && task.assignedTo === "orchestrator") {
          task.status = "pending";
          task.assignedTo = null;
          task.startedAt = null;
          log.info(
            `rehydrated: reset orchestrator review ${task.id} to pending`,
          );
        }
      }

      pendingActivation.add(orchestratorId);
    }

    if (activeBoards > 0) {
      log.info(
        `rehydrated ${activeBoards} active board(s); ${pendingActivation.size} awaiting activation`,
      );
      this.ensureActivationTimer();
    }
  }

  // Probe pending boards for a live orchestrator. The orchestrator
  // session goes live whenever the user reopens the TUI on it or
  // fires a slash command — we just retry transformer/attach until
  // it stops returning SessionNotFound.
  private ensureActivationTimer(): void {
    if (this.activationTimer || pendingActivation.size === 0) return;
    this.activationTimer = setInterval(() => {
      this.runActivationTick();
    }, ACTIVATION_POLL_INTERVAL_MS);
  }

  // Guarded entry point for the activation interval. Skips re-entry
  // while a prior tick is still awaiting tryActivateBoard so a slow
  // network / large pending list can't cause overlapping transformer/attach
  // + session/load + resume-prompt storms on the same orchestrator.
  private runActivationTick(): void {
    if (this.activationTickInFlight) {
      return;
    }
    const p = this.tickActivation().finally(() => {
      if (this.activationTickInFlight === p) {
        this.activationTickInFlight = null;
      }
    });
    this.activationTickInFlight = p;
    void p;
  }

  private async tickActivation(): Promise<void> {
    if (this.shuttingDown) return;
    if (pendingActivation.size === 0) {
      if (this.activationTimer) {
        clearInterval(this.activationTimer);
        this.activationTimer = null;
      }
      return;
    }
    for (const orchestratorId of [...pendingActivation]) {
      const board = boards.get(orchestratorId);
      if (!board) {
        pendingActivation.delete(orchestratorId);
        continue;
      }
      await this.tryActivateBoard(orchestratorId, board);
    }
  }

  // Attempt to bring `board` live: attach orchestrator, wake any
  // assigned workers, resume their tasks. Best-effort — leaves the
  // board in `pendingActivation` if the orchestrator is still cold.
  private async tryActivateBoard(
    orchestratorId: string,
    board: Board,
  ): Promise<void> {
    try {
      await this.client.request("hydra-acp/transformer/attach", {
        sessionId: orchestratorId,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // SessionNotFound is the expected "still cold" outcome; quiet.
      if (!msg.includes("not found")) {
        log.warn(
          `activate: orchestrator attach failed for ${shortProjectId(board.projectId)}: ${msg}`,
        );
      }
      return;
    }
    attachedSessions.add(orchestratorId);
    pendingActivation.delete(orchestratorId);
    log.info(
      `activated board ${shortProjectId(board.projectId)} (orchestrator …${orchestratorId.slice(-8)})`,
    );

    if (board.state === "decomposing") {
      this.resumeDecomposition(orchestratorId, board);
    }

    for (const task of board.tasks) {
      if (task.status !== "assigned" || !task.assignedTo) continue;
      const workerId = task.assignedTo;
      const ok = await this.wakeAndAttachWorker(workerId, task.id, board.projectId);
      if (ok) {
        void this.resumeTask(orchestratorId, board, task, workerId);
      }
    }

    // Kick the scheduler. Without this, a board rehydrated mid-flight
    // can get stuck: e.g. a work task parked in awaiting_review with
    // its review sitting `pending` (runOn=orchestrator) has no in-flight
    // worker whose completion would call scheduleEligibleTasks. Same for
    // any pending task whose deps are already satisfied at rehydrate
    // time. Cheap and idempotent — guards inside scheduleEligibleTasks
    // handle terminal/paused/decomposing boards correctly.
    if (board.state === "running") {
      void this.scheduleEligibleTasks(orchestratorId, board);
    }
  }

  // Resurrect a cold worker session and attach as a peer client.
  // Returns true on success. Worker updates arrive via the
  // session/update notification path (handled by
  // handleWorkerSessionUpdate), not through transformer chain intercepts.
  //
  // Important: we do NOT call session/detach after session/load even
  // though session/load implicitly attached us as a client. Workers
  // are spawned `interactive:false` and resume prompts are tagged
  // `ancillary:true`, so the worker never promotes to interactive.
  // If we detached, the daemon's `reapIfOrphanedNonInteractive` would
  // fire (attachedCount hits 0, interactive !== true) and immediately
  // kill the freshly-resurrected agent — the next session/prompt
  // would fail with "connection is closed". Staying attached as a
  // client keeps attachedCount at 1, blocking the reaper.
  private async wakeAndAttachWorker(
    workerId: string,
    taskId: string,
    projectId: string,
  ): Promise<boolean> {
    const label = `worker ${taskId} on ${shortProjectId(projectId)}`;
    try {
      await this.client.request("session/load", { sessionId: workerId });
    } catch (err) {
      log.warn(
        `activate: session/load failed for ${label}: ${(err as Error).message}`,
      );
      return false;
    }
    // Also attach as a client for permission forwarding (best-effort).
    await this.attachAsClient(workerId);
    return true;
  }

  // ── Request dispatch ────────────────────────────────────────────────

  private handleRequest(req: JsonRpcRequest): void {
    if (req.method === "hydra-acp/transformer/message") {
      this.handleTransformerMessage(req);
      return;
    }
    if (req.method === "session/request_permission") {
      // Delivered to us because we session/attach-ed as a client on
      // the worker session. Forward to the orchestrator (user's TUI)
      // and reply with their pick.
      this.handlePermissionRequest(req);
      return;
    }
    if (req.method === "hydra-acp/commands/invoke") {
      this.handleCommandsInvoke(req);
      return;
    }
    if (req.method === "hydra-acp/mcp_tools/invoke") {
      void this.handleMcpToolInvoke(req).catch((err) => {
        log.error(`handleMcpToolInvoke threw: ${(err as Error).message}`);
        this.client.reply(req.id, {
          content: [
            {
              type: "text",
              text: `internal error invoking planner tool: ${(err as Error).message}`,
            },
          ],
          isError: true,
        });
      });
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
      messageId?: string;
    };
    const sessionId = params.sessionId ?? "";
    const verb = params.verb ?? "";
    const args = (params.args ?? "").trim();
    // messageId is the user-prompt queue entry id the daemon
    // assigned to this slash command (Stage A of the slash-as-user-
    // prompt refactor). Track the dispatch from this moment so an
    // early commands/cancel (Stage B notification) can mark us
    // before holdAndReply even opens its held turn. Cleanup is per
    // handler — they wrap their work in try/finally + a call to
    // clearPendingDispatch(messageId).
    const messageId = params.messageId;
    if (messageId) {
      pendingDispatches.set(messageId, {
        sessionId,
        messageId,
        cancelled: false,
        cancelReason: "",
      });
    }

    if (verb === "create") {
      void this.handleCreate(req.id, sessionId, args, messageId)
        .catch((err) => {
          log.error(`handleCreate threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
      return;
    }
    if (verb === "start") {
      void this.handleStart(req.id, sessionId, args, messageId)
        .catch((err) => {
          log.error(`handleStart threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
      return;
    }
    if (verb === "status" || verb === "") {
      void this.handleStatus(req.id, sessionId)
        .catch((err) => {
          log.error(`handleStatus threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
      return;
    }
    if (verb === "continue") {
      void this.handleContinue(req.id, sessionId, messageId)
        .catch((err) => {
          log.error(`handleContinue threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
      return;
    }
    if (verb === "stop") {
      this.handleStop(req.id, sessionId, args);
      return;
    }
    if (verb === "add") {
      void this.handleAdd(req.id, sessionId, args).catch((err) => {
        log.error(`handleAdd threw: ${(err as Error).message}`);
        this.client.reply(req.id, {
          text: `Internal error: ${(err as Error).message}`,
        });
      });
      return;
    }
    if (verb === "retry") {
      void this.handleRetry(req.id, sessionId, args, messageId)
        .catch((err) => {
          log.error(`handleRetry threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
      return;
    }
    if (verb === "restart") {
      void this.handleRestart(req.id, sessionId, messageId)
        .catch((err) => {
          log.error(`handleRestart threw: ${(err as Error).message}`);
          this.client.reply(req.id, {
            text: `Internal error: ${(err as Error).message}`,
          });
        })
        .finally(() => this.clearPendingDispatch(messageId));
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
    if (verb === "pause") {
      this.handlePause(req.id, sessionId);
      return;
    }
    if (verb === "resume") {
      this.handleResume(req.id, sessionId);
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
  private handleStop(
    reqId: number | string,
    sessionId: string,
    args: string,
  ): void {
    let board: Board | undefined;
    let orchestratorSessionId: string | undefined;
    if (args.length > 0) {
      const canonical = canonicalProjectId(args.split(/\s+/)[0]!);
      orchestratorSessionId = orchestratorSessionForProject(canonical);
      // Prefer the in-memory board so the mutation is observed by
      // subsequent status/scheduling calls; only fall back to a fresh
      // disk read when we don't have it cached.
      if (orchestratorSessionId) {
        board = boards.get(orchestratorSessionId);
      }
      if (!board) {
        board = loadBoard(canonical);
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
            : "No plan in this session to stop. Use `/hydra planner stop <projectId>` for a different project.",
      });
      return;
    }
    const canonical = board.projectId;
    if (
      board.state === "done" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(canonical)} is already ${board.state}.`,
      });
      return;
    }
    const inFlight = board.tasks.filter(
      (t) => t.status === "assigned" && t.assignedTo,
    ).length;
    // Shared cleanup path. Resolves the held turn if one exists,
    // which makes the orchestrator's held commands/invoke reply with
    // the cancelled summary. When invoked from a non-orchestrator
    // session (cancel by project id), there's no held turn for the
    // caller's session, so we reply to the caller's commands/invoke
    // separately with a short ack.
    void this.runProjectStop(orchestratorSessionId, board, "slash");
    const tail =
      inFlight > 0
        ? `; ${inFlight} in-flight task${inFlight === 1 ? "" : "s"} cancelled`
        : "";
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
    // In-memory only: mutations on a disk-loaded copy would not be
    // observed by `/status` (which checks the cache first) or by the
    // scheduler. If the board isn't in the cache, it's either terminal
    // (rehydrate skips those) or this session doesn't own one.
    const board = boards.get(sessionId);
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
        awaitingOrchestratorReview: false,
        orchestratorReviewTaskId: null,
        orchestratorReviewAccumulator: "",
      };
      setOrchestratorState(orchestratorSessionId, state);
    }
    state.addAccumulator = "";
    state.awaitingAdd = true;

    await this.emitSyntheticMessage(
      orchestratorSessionId,
      `Asking the agent to slot in: "${description}"`,
    );

    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId: orchestratorSessionId,
        method: "session/prompt",
        envelope: buildTextPromptEnvelope({
          sessionId: orchestratorSessionId,
          text: buildAddTaskPrompt(description, board, await this.ensureAgentChoices()),
        }),
        route: "chain",
      });
    } catch (err) {
      state.awaitingAdd = false;
      log.error(`add: emit failed: ${(err as Error).message}`);
      await this.emitSyntheticMessage(
        orchestratorSessionId,
        `Couldn't ask the agent to plan the addition: ${(err as Error).message}`,
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
        `Couldn't parse a hydra-add-task block from the agent's reply. Try \`/hydra planner add <description>\` again with a clearer description.`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Merge the new tasks into the board and bump the concurrency cap
    // to reflect the (potentially wider) DAG. Persist before
    // scheduling so an immediate restart picks up the new tasks.
    board.tasks.push(...result.tasks);
    board.concurrencyCap = sweepLineConcurrencyCap(board.tasks);
    // Synthesize review tasks for the newly added tasks.
    // Only applies when reviewPolicy is explicitly set on the board.
    if (board.reviewPolicy) {
      const updatedBoard = applyReviewPolicy(board, resolveReviewPolicy(board.reviewPolicy));
      if (updatedBoard !== board) {
        board.tasks = updatedBoard.tasks;
      }
    }
    saveBoard(board, orchestratorSessionId);
    boards.set(orchestratorSessionId, board);

    log.info(
      `added ${result.tasks.length} task(s) to ${board.projectId}: ${result.tasks.map((t) => t.id).join(", ")}`,
    );
    this.emitPlanUpdate(orchestratorSessionId, board);

    const idsList = result.tasks.map((t) => `${t.id} ${t.title}`).join(", ");
    const warningsBlock =
      result.warnings.length > 0
        ? `\n${result.warnings.length} parse warning${result.warnings.length === 1 ? "" : "s"}:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}\n`
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
        text: `${taskId} is in failed state — use \`/hydra planner retry ${taskId}\` to retry or accept it as is.`,
      });
      return;
    }

    // If a worker is currently on this task, free it up.
    const workerId = task.assignedTo;
    if (task.status === "assigned" && workerId) {
      this.endWorkerForward(workerId);
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
    this.emitPlanUpdate(orchestratorSessionId, board);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      "skipped (marked done with no work)",
      { event: "task-skipped", taskId },
    );
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
    this.client.reply(reqId, { text: `Skipped ${taskId}.` });
  }

  // Reset a single task to pending. If it's currently assigned, close
  // its worker first (the work is discarded). Mutates board in place;
  // caller is responsible for saveBoard + emitPlanUpdate +
  // scheduleEligibleTasks (and, if the board was stopped, the resume
  // flow) after one or more invocations.
  private retryOne(board: Board, orchestratorSessionId: string, task: Task): void {
    const workerId = task.assignedTo;
    if (task.status === "assigned" && workerId) {
      this.endWorkerForward(workerId);
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
    log.info(`retry ${task.id} in ${board.projectId} (attemptCount=${task.attemptCount})`);
    // Include task id and (if any) the now-closed worker session in the
    // user-facing notice so it's identifiable at a glance in a transcript
    // that may carry multiple retry events from a no-arg "retry all
    // failed" invocation. The metadata carries taskId separately but
    // renderers don't all surface it inline.
    const workerTag = workerId ? ` on worker ${shortSessionId(workerId)}` : "";
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `${task.id}${workerTag} reset to pending (attempt #${task.attemptCount + 1} next)`,
      { event: "task-retried", taskId: task.id },
    );

    // If this is a work task with an associated review, the review
    // also needs to re-run after the retry. findReviewedTask in the
    // completion path only considers `pending` reviews, so if the
    // review is in any terminal state (done / failed) the retry would
    // bypass the gate entirely and the work would be marked done with
    // no fresh review. Reset every review that targets this task.
    if (task.kind !== "review") {
      for (const other of board.tasks) {
        if (other.kind !== "review") continue;
        if (other.id === task.id) continue;
        const refs = other.reviews;
        const reviewsThisTask =
          typeof refs === "string"
            ? refs === task.id
            : Array.isArray(refs) && refs.includes(task.id);
        if (!reviewsThisTask) continue;
        if (other.status === "pending") continue;
        const prevStatus = other.status;
        const orchAssigned =
          other.status === "assigned" && other.assignedTo === "orchestrator";
        other.status = "pending";
        other.assignedTo = null;
        other.startedAt = null;
        other.finishedAt = null;
        other.artifacts = null;
        if (orchAssigned) {
          const orchState = getOrchestratorState(orchestratorSessionId);
          if (orchState && orchState.orchestratorReviewTaskId === other.id) {
            orchState.awaitingOrchestratorReview = false;
            orchState.orchestratorReviewTaskId = null;
            orchState.orchestratorReviewAccumulator = "";
          }
        }
        log.info(
          `retry cascade: reset review ${other.id} (was ${prevStatus}) so it re-runs after ${task.id}`,
        );
        void this.emitSyntheticMessage(
          orchestratorSessionId,
          `${other.id} reset to pending (will re-run after ${task.id})`,
          { event: "task-retried-cascade", taskId: other.id },
        );
      }
    }
  }

  // Transitive dependency check: does `task` depend (directly or via
  // a chain of deps) on any task whose id is in `rootIds`? Used by
  // handleRetry to flag stale downstream work without auto-resetting it.
  private dependsOnAny(task: Task, rootIds: Set<string>, board: Board): boolean {
    const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const stack = [...task.deps];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (rootIds.has(id)) return true;
      const dep = byId.get(id);
      if (dep) {
        for (const d of dep.deps) stack.push(d);
      }
    }
    return false;
  }

  // Resume a stopped board: flip state to running, re-attach the
  // transformer, kick the scheduler. Mirrors the `stopped` branch of
  // handleStart (src/bridge.ts ~1955) so retry-after-stop behaves
  // identically to start-after-stop. Returns after attach + initial
  // schedule; caller is responsible for opening the held turn.
  private async resumeStoppedBoard(sessionId: string, board: Board): Promise<void> {
    log.info(`resuming stopped plan ${board.projectId} on session …${sessionId.slice(-8)} (via retry)`);
    setBoardState(board, "running");
    saveBoard(board, sessionId);
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(
        `retry: transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
    }
    void this.scheduleEligibleTasks(sessionId, board);
  }

  private async resumeBoardToRunning(
    sessionId: string,
    board: Board,
  ): Promise<{ resumedFrom: 'ready' | 'paused' | 'stopped' } | null> {
    if (board.state === "running" || board.state === "done" || board.state === "failed" || board.state === "decomposing") {
      return null;
    }
    const prevState = board.state as 'ready' | 'paused' | 'stopped';
    setBoardState(board, "running");
    saveBoard(board, sessionId);
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(
        `resumeBoardToRunning: transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
    }
    void this.scheduleEligibleTasks(sessionId, board);
    return { resumedFrom: prevState };
  }

  // /hydra planner retry [taskId]
  //
  // With <taskId>: reset that one task to pending (closing its worker
  // if assigned). With no arg: reset every task currently in `failed`
  // status — the common case after a stuck-board notice naming several
  // failed roots. Useful when a task got into a bad state and the user
  // wants to try fresh.
  //
  // If the board is in `stopped` state, retry also resumes the
  // project: flips state to running, re-attaches the transformer,
  // re-opens the live view. Single command, no follow-up start
  // needed.
  private async handleRetry(
    reqId: number | string,
    sessionId: string,
    args: string,
    slashMessageId: string | undefined,
  ): Promise<void> {
    const taskId = args.split(/\s+/)[0]?.trim() ?? "";
    const ctx = this.requireBoard(reqId, sessionId);
    if (!ctx) return;
    const { board, orchestratorSessionId } = ctx;

    let resetIds: string[];
    if (!taskId) {
      const failed = board.tasks.filter((t) => t.status === "failed");
      if (failed.length === 0) {
        this.client.reply(reqId, {
          text: "planner retry: no failed tasks. Usage: `/hydra planner retry` (all failed) or `/hydra planner retry <taskId>` (one task).",
        });
        return;
      }
      for (const task of failed) {
        this.retryOne(board, orchestratorSessionId, task);
      }
      resetIds = failed.map((t) => t.id);
    } else {
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task) {
        this.client.reply(reqId, { text: `No task '${taskId}' in this project.` });
        return;
      }
      this.retryOne(board, orchestratorSessionId, task);
      resetIds = [taskId];
    }

    saveBoard(board, orchestratorSessionId);
    this.emitPlanUpdate(orchestratorSessionId, board);

    // Surface (but do NOT auto-reset) any already-done downstream
    // work tasks that depend, directly or transitively, on a retried
    // task. Their artifacts may have been produced against the older
    // result and could now be stale — but resetting them would
    // silently throw away real work, so leave the decision to the
    // user. Reviews of the retried task are NOT included here: those
    // are cascaded automatically in retryOne (a stale review is
    // meaningless by definition).
    const resetIdSet = new Set(resetIds);
    const stale: string[] = [];
    for (const t of board.tasks) {
      if (t.status !== "done") continue;
      if (t.kind === "review") continue;
      if (resetIdSet.has(t.id)) continue;
      if (this.dependsOnAny(t, resetIdSet, board)) {
        stale.push(t.id);
      }
    }
    if (stale.length > 0) {
      const list = stale.join(", ");
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `Note: ${stale.length} done downstream task${stale.length === 1 ? "" : "s"} (${list}) depend on the retried task${resetIds.length === 1 ? "" : "s"}; their results may be stale. Retry them explicitly if needed.`,
        { event: "task-retry-stale-downstream" },
      );
    }

    const wasStopped = board.state === "stopped";
    if (wasStopped) {
      // Auto-resume + open held turn so the user gets the live view
      // back. holdAndReply keeps the commands/invoke open for the
      // remainder of the project lifetime — same shape as start.
      await this.resumeStoppedBoard(orchestratorSessionId, board);
      await this.holdAndReply(reqId, orchestratorSessionId, board, slashMessageId, "retry");
      return;
    }

    // Hold a turn for the live view, mirroring start/continue.
    // The scheduler runs inside holdAndReply (via the initial plan
    // snapshot + subsequent task-state handlers), and the held turn
    // resolves on project completion / failure / cancel — same as
    // start. Without this the TUI snaps back to ready immediately
    // while workers spin in the background, hiding the work.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
    await this.holdAndReply(reqId, orchestratorSessionId, board, slashMessageId, "retry");
  }

  // /hydra planner restart
  //
  // Reset every task on the board to pending and run the whole plan
  // from scratch. The DAG structure (titles, deps, agents, reviews)
  // stays intact — only per-task runtime state (status, artifacts,
  // assignedTo, timestamps, reviewFeedback) is wiped. Closes any
  // in-flight workers. Opens a held turn so the live view tracks
  // execution to completion. Useful when the user has changed the
  // source tree underneath the plan (e.g. stashed/applied a patch)
  // and wants to redo everything end-to-end without rebuilding the
  // plan.
  private async handleRestart(
    reqId: number | string,
    sessionId: string,
    slashMessageId: string | undefined,
  ): Promise<void> {
    const ctx = this.requireBoard(reqId, sessionId);
    if (!ctx) return;
    const { board, orchestratorSessionId } = ctx;

    if (board.state === "done" || board.state === "failed" || board.state === "stopped" || board.state === "running" || board.state === "paused") {
      // All non-decomposing states are restartable. Decomposing is the
      // only state where the task list isn't finalized yet.
    } else {
      this.client.reply(reqId, {
        text: `planner restart: project ${shortProjectId(board.projectId)} is ${board.state} — wait for decomposition to finish first.`,
      });
      return;
    }

    // Close any in-flight workers. Don't go through runProjectStop
    // (which transitions to "stopped" and resolves the held turn) —
    // we want a clean reset, not a stop. Mirror retryOne's worker
    // cleanup inline.
    const closedWorkers: string[] = [];
    for (const task of board.tasks) {
      const workerId = task.assignedTo;
      if (task.status === "assigned" && workerId && workerId !== "orchestrator") {
        this.endWorkerForward(workerId);
        clearWorkerState(workerId);
        unregisterWorker(workerId);
        delete board.workers[workerId];
        void this.closeWorker(workerId);
        closedWorkers.push(workerId);
      }
    }
    // Clear any in-flight orchestrator-lane review state so the
    // single-flight latch doesn't block the fresh run.
    const orchState = getOrchestratorState(orchestratorSessionId);
    if (orchState) {
      orchState.awaitingOrchestratorReview = false;
      orchState.orchestratorReviewTaskId = null;
      orchState.orchestratorReviewAccumulator = "";
    }

    // Reset every task. attemptCount is also zeroed — restart is a
    // fresh start, not a retry continuation.
    for (const task of board.tasks) {
      task.status = "pending";
      task.assignedTo = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.artifacts = null;
      task.attemptCount = 0;
      task.reviewFeedback = undefined;
    }

    setBoardState(board, "running");
    saveBoard(board, orchestratorSessionId);
    log.info(
      `restart project ${shortProjectId(board.projectId)} — reset ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}${closedWorkers.length > 0 ? `, closed ${closedWorkers.length} worker${closedWorkers.length === 1 ? "" : "s"}` : ""}`,
    );
    this.emitPlanUpdate(orchestratorSessionId, board);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `Restarted project ${shortProjectId(board.projectId)} — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} reset to pending.`,
      { event: "project-restarted" },
    );

    // Re-attach the transformer in case we drifted (mirrors the
    // stopped-board resume path). Best-effort.
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId: orchestratorSessionId });
      attachedSessions.add(orchestratorSessionId);
    } catch (err) {
      log.warn(
        `restart: transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
    }

    void this.scheduleEligibleTasks(orchestratorSessionId, board);
    await this.holdAndReply(reqId, orchestratorSessionId, board, slashMessageId, "restart");
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
    this.endWorkerForward(workerId);
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
        `Worker ${shortSessionId(workerId)} killed; ${task.id} requeued`,
        { event: "worker-killed", taskId: task.id },
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
      `Worker ${shortSessionId(workerId)} killed.`,
      { event: "worker-killed" },
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
    let orchestratorSessionId: string | undefined;
    if (args.length > 0) {
      canonical = canonicalProjectId(args.split(/\s+/)[0]!);
      orchestratorSessionId = orchestratorSessionForProject(canonical);
      if (orchestratorSessionId) {
        board = boards.get(orchestratorSessionId);
      }
      if (!board) {
        board = loadBoard(canonical);
      }
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
      orchestratorSessionId = sessionId;
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
    // create in this session starts cleanly). Use the resolved
    // orchestratorSessionId — when the user removes a project from
    // a different session via `/hydra planner remove <projectId>`,
    // the in-memory entry is keyed by the owning orchestrator, not
    // the session that ran the command.
    if (orchestratorSessionId && boards.get(orchestratorSessionId)?.projectId === canonical) {
      boards.delete(orchestratorSessionId);
      clearOrchestratorState(orchestratorSessionId);
      // Release any held turn so the orchestrator's commands/invoke
      // reply lands instead of hanging forever.
      resolveHeldTurn(orchestratorSessionId, {
        reason: "removed",
        text: `Removed project ${shortProjectId(canonical)}.`,
      });
    }
    // And worker state.
    for (const workerId of workerIds) {
      this.endWorkerForward(workerId);
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
  private handlePause(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId);
    if (!board) {
      this.client.reply(reqId, {
        text: "planner pause: no active project in this session.",
      });
      return;
    }
    if (board.state === "paused") {
      this.client.reply(reqId, {
        text: `planner pause: ${shortProjectId(board.projectId)} is already paused.`,
      });
      return;
    }
    if (board.state !== "running") {
      this.client.reply(reqId, {
        text: `planner pause: project ${shortProjectId(board.projectId)} is ${board.state}; can only pause a running project.`,
      });
      return;
    }
    setBoardState(board, "paused");
    saveBoard(board, sessionId);
    const inFlight = inFlightCount(board);
    const tail = inFlight > 0
      ? ` ${inFlight} in-flight worker${inFlight === 1 ? "" : "s"} will run to completion; no new tasks will dispatch until resume.`
      : " No new tasks will dispatch until resume.";
    this.client.reply(reqId, {
      text: `Paused ${shortProjectId(board.projectId)}.${tail}`,
    });
  }

  private handleResume(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId);
    if (!board) {
      this.client.reply(reqId, {
        text: "planner resume: no active project in this session.",
      });
      return;
    }
    if (board.state !== "paused") {
      this.client.reply(reqId, {
        text: `planner resume: ${shortProjectId(board.projectId)} is ${board.state}, not paused.`,
      });
      return;
    }
    setBoardState(board, "running");
    saveBoard(board, sessionId);
    this.client.reply(reqId, {
      text: `Resumed ${shortProjectId(board.projectId)}.`,
    });
    void this.scheduleEligibleTasks(sessionId, board);
  }

  // `/hydra planner status` — snapshot reading. One-shot turn:
  // emits the formatted board state and ends. Safe to invoke at
  // any time, on any session (including from a non-orchestrator
  // session to inspect another session's project) — never affects
  // the live view's held-turn state.
  //
  // For re-opening the live view on a running project, use
  // `/hydra planner continue` (which opens a held turn).
  private async handleStatus(
    reqId: number | string,
    sessionId: string,
  ): Promise<void> {
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
      text: formatStatus(board, attachedSessions.has(sessionId), sessionId),
    });
  }

  // `/hydra planner continue` — open the live view on a running
  // project owned by this session. Same held-turn machinery as
  // create/start, just without a fresh decomposition. Used both
  // by the user (typed directly to re-acquire after manual yield)
  // and by the planner itself (auto-injected after amend on
  // create/start/continue held turns to keep the live view
  // engaged through the project's lifetime).
  //
  // Errors out (with a friendly message) if the session has no
  // project or the project is terminal.
  private async handleContinue(
    reqId: number | string,
    sessionId: string,
    slashMessageId: string | undefined,
  ): Promise<void> {
    const board = boards.get(sessionId);
    if (!board) {
      this.client.reply(reqId, {
        text:
          "No active plan in this session to continue. Use `/hydra planner status` to inspect, or `/hydra planner create <description>` to start a new project.",
      });
      return;
    }
    if (board.state === "done" || board.state === "failed") {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(board.projectId)} is ${board.state} — nothing to continue. Use \`/hydra planner status\` for the final snapshot.`,
      });
      return;
    }
    if (board.state === "ready") {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(board.projectId)} is ready — use \`/hydra planner start\` to begin.`,
      });
      return;
    }
    if (board.state === "decomposing") {
      this.client.reply(reqId, {
        text: `Project ${shortProjectId(board.projectId)} is decomposing — wait for the plan to form, then continue.`,
      });
      return;
    }
    if (board.state === "paused" || board.state === "stopped") {
      await this.resumeBoardToRunning(sessionId, board);
    }
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(`continue: transformer/attach failed: ${(err as Error).message}`);
    }
    // If there's already a held turn, decline politely. The
    // existing live view is still active; another concurrent hold
    // would race.
    if (getHeldTurn(sessionId)) {
      this.client.reply(reqId, {
        text: `Live view of ${shortProjectId(board.projectId)} is already open.`,
      });
      return;
    }
    await this.holdAndReply(reqId, sessionId, board, slashMessageId, "continue");
  }

  private async handleCreate(
    reqId: number | string,
    sessionId: string,
    description: string,
    slashMessageId: string | undefined,
  ): Promise<void> {
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
    const existing = boards.get(sessionId);
    if (
      existing &&
      existing.state !== "done" &&
      existing.state !== "failed" &&
      existing.state !== "ready" &&
      existing.state !== "stopped"
    ) {
      // running / paused / decomposing — refuse. The user needs to
      // stop or wait for the in-flight work before forming a new
      // plan. `ready` / `stopped` boards (formed-but-not-started,
      // or user-halted) are overwritable since the workflow allows
      // "create → review → revise" or "stop → revise → create new".
      this.client.reply(reqId, {
        text: `planner create: project ${shortProjectId(existing.projectId)} is already ${existing.state} in this session. \`/hydra planner stop\` or \`/hydra planner remove\` it first, or run create from a different session.`,
      });
      return;
    }
    // `ready` overwrite: clean up the draft on disk before the new
    // board claims this session's orchestrator pointer. No workers
    // were spawned (ready boards have empty board.workers), so this
    // is purely a disk-cleanup step. For `done` / `failed`
    // overwrites we deliberately leave the prior directory in place
    // — those carry the full history (tasks, artifacts) and may be
    // useful for inspection later.
    let replacedReadyId: string | undefined;
    if (existing && existing.state === "ready") {
      replacedReadyId = existing.projectId;
      try {
        rmSync(projectDir(existing.projectId), { recursive: true, force: true });
        log.info(
          `replacing prior ready plan ${shortProjectId(existing.projectId)} on session …${sessionId.slice(-8)}`,
        );
      } catch (err) {
        log.warn(
          `failed to remove prior ready plan ${shortProjectId(existing.projectId)}: ${(err as Error).message}`,
        );
      }
    }

    // Parse leading fleet-override flags off the description string.
    // Recognized: --workers N, --agent <id>, --model <id>, --review-policy <mode>,
    // --work-agent <id>, --work-model <id>, --review-agent <id>, --review-model <id>.
    // Unknown flags are left in the description — the user probably meant them as
    // prose; the orchestrator agent will see them.
    let descRemaining = description;
    let fleetWorkers: number | undefined;
    let fleetAgent: string | null = null;
    let fleetModel: string | null = null;
    let workAgent: string | undefined;
    let workModel: string | undefined;
    let reviewAgent: string | undefined;
    let reviewModel: string | undefined;
    let reviewRunOn: "orchestrator" | "worker" | undefined;
    let reviewPolicyMode: "off" | "hints" | "all" | "high-only" | undefined;
    let overrideHint: boolean | undefined;
    let compete = false;
    const attachPaths: string[] = [];
    const flagRe = /^--(workers|agent|model|review-policy|override-hint|work-agent|work-model|review-agent|review-model|review-run-on|compete|attach)\s+(\S+)\s*/;
    while (true) {
      const m = descRemaining.match(flagRe);
      if (!m) break;
      const [, key, value] = m as unknown as [string, string, string];
      if (key === "workers") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fleetWorkers = n;
      } else if (key === "agent") {
        fleetAgent = value;
      } else if (key === "model") {
        fleetModel = value;
      } else if (key === "review-policy") {
        const validModes = ["off", "hints", "all", "high-only"];
        if (validModes.includes(value)) {
          reviewPolicyMode = value as "off" | "hints" | "all" | "high-only";
        }
      } else if (key === "work-agent") {
        workAgent = value;
      } else if (key === "work-model") {
        workModel = value;
      } else if (key === "review-agent") {
        reviewAgent = value;
      } else if (key === "review-model") {
        reviewModel = value;
      } else if (key === "review-run-on") {
        if (value === "worker" || value === "orchestrator") {
          reviewRunOn = value as "orchestrator" | "worker";
        }
      } else if (key === "override-hint") {
        overrideHint = value === "true";
      } else if (key === "compete") {
        compete = value === "true";
      } else if (key === "attach") {
        attachPaths.push(value);
      }
      descRemaining = descRemaining.slice(m[0].length);
    }
    const attachResult = loadAttachments(attachPaths);
    if ("error" in attachResult) {
      this.client.reply(reqId, { text: `planner create: ${attachResult.error}` });
      return;
    }
    if (!descRemaining) {
      this.client.reply(reqId, {
        text: "planner create: missing description (only flags were provided). Usage: `/hydra planner create [--workers N] [--agent ID] [--model ID] [--review-policy MODE] [--override-hint true|false] [--compete true|false] [--work-agent ID] [--work-model ID] [--review-agent ID] [--review-model ID] [--review-run-on orchestrator|worker] [--attach <path>]... <description>`",
      });
      return;
    }
    if (fleetAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === fleetAgent);
      if (!known) {
        log.warn(`--agent "${fleetAgent}" not in installed agent list; workers will spawn with default unless a per-task agent is set`);
      }
    }
    if (workAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === workAgent);
      if (!known) {
        log.warn(`--work-agent "${workAgent}" not in installed agent list; workers will spawn with default unless a per-task agent is set`);
      }
    }
    if (reviewAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === reviewAgent);
      if (!known) {
        log.warn(`--review-agent "${reviewAgent}" not in installed agent list; reviews will spawn with default unless a per-task agent is set`);
      }
    }

    const boardFleetDefaults: import("./board.js").FleetDefaults = {
      agent: fleetAgent,
      model: fleetModel,
    };
    if (workAgent !== undefined || workModel !== undefined) {
      boardFleetDefaults.work = {};
      if (workAgent !== undefined) boardFleetDefaults.work.agent = workAgent;
      if (workModel !== undefined) boardFleetDefaults.work.model = workModel;
    }
    if (reviewAgent !== undefined || reviewModel !== undefined || reviewRunOn !== undefined) {
      boardFleetDefaults.review = {};
      if (reviewAgent !== undefined) boardFleetDefaults.review.agent = reviewAgent;
      if (reviewModel !== undefined) boardFleetDefaults.review.model = reviewModel;
      if (reviewRunOn !== undefined) boardFleetDefaults.review.runOn = reviewRunOn;
    }

    const board = newBoard({
      description: descRemaining,
      concurrencyCap: fleetWorkers,
      fleetDefaults: boardFleetDefaults,
      attachments: attachResult.attachments,
    });
    const baseline0 = getLatestOrchestratorUsage(sessionId);
    if (baseline0) board.orchestratorUsageBaseline = { ...baseline0 };
    await this.seedOrchestratorIdentity(board, sessionId);
    if (reviewPolicyMode || overrideHint !== undefined) {
      board.reviewPolicy = {
        mode: reviewPolicyMode ?? "hints",
        overrideHint: overrideHint ?? false,
      };
    }
    if (compete) {
      board.compete = true;
    }
    // create's intent: form the plan, show it, stop. No kickoff —
    // user must run `/hydra planner start` to start working.
    board.pendingExecute = false;
    boards.set(sessionId, board);
    saveBoard(board, sessionId);
    setOrchestratorState(sessionId, {
      projectId: board.projectId,
      decompositionAccumulator: "",
      addAccumulator: "",
      awaitingAdd: false,
      awaitingDecomposition: true,
      awaitingOrchestratorReview: false,
      orchestratorReviewTaskId: null,
      orchestratorReviewAccumulator: "",
    });

    log.info(
      `decomposing (plan-only) project ${board.projectId} for session …${sessionId.slice(-8)}: ${descRemaining.slice(0, 80)}` +
        (fleetWorkers ? ` [workers=${fleetWorkers}]` : "") +
        (fleetAgent ? ` [agent=${fleetAgent}]` : "") +
        (fleetModel ? ` [model=${fleetModel}]` : "") +
        (workAgent ? ` [work-agent=${workAgent}]` : "") +
        (workModel ? ` [work-model=${workModel}]` : "") +
        (reviewAgent ? ` [review-agent=${reviewAgent}]` : "") +
        (reviewModel ? ` [review-model=${reviewModel}]` : ""),
    );
    if (replacedReadyId) {
      // Make the replacement visible in the transcript so the user
      // knows their previous draft has been retired. No-op visually
      // when the prior board was done/failed (which we keep on disk
      // for inspection rather than replace).
      void this.emitSyntheticMessage(
        sessionId,
        `Replacing prior draft plan ${shortProjectId(replacedReadyId)} on this session.`,
      );
    }

    // No chrome to fill the decomposition gap — slash commands now
    // fire user-text in the TUI, which anchors the standard
    // "⚙ thinking…" placeholder under the user's slash text. The
    // placeholder is the natural activity indicator while
    // decomposition runs, and it transitions to "⚙ N tools" once
    // workers start firing tool calls.
    //
    // Self-install into this session's chain so our response intercepts
    // fire on the decomposition turn we're about to start. Idempotent.
    try {
      await this.client.request("hydra-acp/transformer/attach", {
        sessionId,
      });
      attachedSessions.add(sessionId);
    } catch (err) {
      if (this.isShutdownError(err)) {
        log.info(`create aborted (shutdown) for ${board.projectId}; board left as is`);
        this.client.reply(reqId, { text: "" });
        return;
      }
      log.error(
        `transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
      setBoardState(board, "failed");
      saveBoard(board, sessionId);
      const errState = getOrchestratorState(sessionId);
      if (errState) errState.awaitingDecomposition = false;
      await this.emitSyntheticMessage(
        sessionId,
        `Could not attach to this session: ${(err as Error).message}`,
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
          text: buildDecompositionPrompt(descRemaining, await this.ensureAgentChoices(), compete),
        }),
        route: "chain",
      });
    } catch (err) {
      if (this.isShutdownError(err)) {
        log.info(
          `decomposition aborted (shutdown) for ${board.projectId}; left as decomposing for resume`,
        );
        this.client.reply(reqId, { text: "" });
        return;
      }
      log.error(
        `decomposition turn failed for ${board.projectId}: ${(err as Error).message}`,
      );
      const failedState = getOrchestratorState(sessionId);
      if (failedState) failedState.awaitingDecomposition = false;
      setBoardState(board, "failed");
      saveBoard(board, sessionId);
      await this.emitSyntheticMessage(
        sessionId,
        `Decomposition turn for ${shortProjectId(board.projectId)} failed: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    // Decomposition is complete (board state is `ready` on success,
    // `failed` on parse failure — finishDecomposition emitted the
    // plan panel + "run start" hint, or the failure explanation,
    // accordingly). create doesn't hold a turn: the user reviews the
    // plan in the slash command's natural turn, then runs
    // `/hydra planner start` when ready.
    const doneState = getOrchestratorState(sessionId);
    if (doneState && doneState.awaitingDecomposition) {
      this.finishDecomposition(sessionId, doneState);
    }
    this.client.reply(reqId, { text: "" });
  }

  // Set up the held turn for `sessionId` (keyed by commands/invoke
  // reqId), emit the initial plan snapshot, then await terminal
  // resolution. Replies to commands/invoke with the resolved summary
  // text. Common tail for handleCreate / handleStart.
  private async holdAndReply(
    reqId: number | string,
    sessionId: string,
    board: Board,
    slashMessageId: string | undefined,
    slashVerb: HeldTurnVerb,
  ): Promise<void> {
    // If commands/cancel arrived during decomposition (before this
    // moment), the pending dispatch was flagged. Honor it now
    // instead of opening a held turn that no signal could resolve.
    const earlyCancel = this.checkDispatchCancelled(slashMessageId);
    if (earlyCancel === "cancelled") {
      // Worker spawning may have already started in the brief window
      // between finishDecomposition and holdAndReply — run the full
      // cancel path to kill them and freeze the board.
      log.info(
        `commands/cancel arrived during decomposition for ${shortProjectId(board.projectId)} — running project cancel before opening held turn`,
      );
      await this.runProjectStop(sessionId, board, "user-cancel");
      this.client.reply(reqId, {
        text: `Cancelled ${shortProjectId(board.projectId)}.`,
      });
      this.clearPendingDispatch(slashMessageId);
      return;
    }
    if (earlyCancel === "amended" || earlyCancel === "abandoned") {
      // Workers may have started; let them keep running. Just close
      // the slash command turn with a yield/abandon note.
      log.info(
        `commands/cancel (${earlyCancel}) arrived during decomposition for ${shortProjectId(board.projectId)} — skipping held turn, project continues in background`,
      );
      this.client.reply(reqId, {
        text:
          earlyCancel === "abandoned"
            ? `Session closing — ${shortProjectId(board.projectId)} state preserved on disk.`
            : `Pausing live view of ${shortProjectId(board.projectId)} for your prompt — will resume after.`,
      });
      if (earlyCancel === "amended") {
        // Same as the late-amend path: inject `/hydra planner
        // continue` at head so the live view resumes after the
        // amended turn. slashVerb here is always create / start /
        // continue (status doesn't open a held turn), so this is
        // unconditionally the right behavior.
        void this.injectContinueAtHead(sessionId);
      }
      void slashVerb;
      this.clearPendingDispatch(slashMessageId);
      return;
    }

    const held = createHeldTurn({
      orchestratorSessionId: sessionId,
      projectId: board.projectId,
      commandsInvokeReqId: reqId,
      slashMessageId,
      slashVerb,
    });
    log.info(
      `holding orchestrator turn for ${shortProjectId(board.projectId)} on session …${sessionId.slice(-8)}`,
    );
    // Initial plan snapshot — the first time the user sees the live
    // panel. After this, scheduleEligibleTasks / task-state handlers
    // emit additional plan updates as state evolves.
    this.emitPlanUpdate(sessionId, board);
    try {
      const resolution = await held.promise;
      this.client.reply(reqId, { text: resolution.text });
    } finally {
      clearHeldTurn(sessionId);
      this.clearPendingDispatch(slashMessageId);
    }
  }

  // Conversation-driven planning: instead of taking a description
  // string, asks the orchestrator agent to decompose the project the
  // user has been discussing with it in the current conversation. The
  // board's `description` is seeded with a placeholder and overwritten
  // from the agent's JSON response (which carries a `description`
  // field per buildExecuteDecompositionPrompt).
  private async handleStart(
    reqId: number | string,
    sessionId: string,
    args: string,
    slashMessageId: string | undefined,
  ): Promise<void> {
    if (!sessionId) {
      this.client.reply(reqId, { text: "planner start: missing sessionId" });
      return;
    }
    if (getOrchestratorState(sessionId)?.awaitingDecomposition) {
      this.client.reply(reqId, {
        text: "planner start: a decomposition is already in flight for this session — wait for it to finish.",
      });
      return;
    }
    const existing = boards.get(sessionId);
    if (
      existing &&
      (existing.state === "running" || existing.state === "decomposing")
    ) {
      this.client.reply(reqId, {
        text: `planner start: project ${shortProjectId(existing.projectId)} is already ${existing.state} in this session. \`/hydra planner stop\` or \`/hydra planner remove\` it first, or run start from a different session.`,
      });
      return;
    }

    // Fast path: a `ready`, `stopped`, or `paused` board exists. Ready =
    // first run after create; stopped = resume after user-initiated stop;
    // paused = resume after user-initiated pause. All paths flip to running
    // and kick the scheduler — no re-decomp.
    if (existing && (existing.state === "ready" || existing.state === "stopped" || existing.state === "paused")) {
      const resumedFrom = existing.state;
      log.info(
        `${resumedFrom === "stopped" ? "resuming stopped" : resumedFrom === "paused" ? "resuming paused" : "executing previously-formed"} plan ${existing.projectId} on session …${sessionId.slice(-8)}`,
      );
      await this.resumeBoardToRunning(sessionId, existing);
      await this.holdAndReply(reqId, sessionId, existing, slashMessageId, "start");
      return;
    }

    // Parse fleet-override flags. Unlike `create`, anything remaining
    // after flag parsing is an error — there's no description string
    // here, the conversation is the input.
    let argsRemaining = args;
    let fleetWorkers: number | undefined;
    let fleetAgent: string | null = null;
    let fleetModel: string | null = null;
    let workAgent: string | undefined;
    let workModel: string | undefined;
    let reviewAgent: string | undefined;
    let reviewModel: string | undefined;
    let reviewRunOn: "orchestrator" | "worker" | undefined;
    let reviewPolicyMode: "off" | "hints" | "all" | "high-only" | undefined;
    let overrideHint: boolean | undefined;
    let compete = false;
    const attachPaths: string[] = [];
    const flagRe = /^--(workers|agent|model|review-policy|override-hint|work-agent|work-model|review-agent|review-model|review-run-on|compete|attach)\s+(\S+)\s*/;
    while (true) {
      const m = argsRemaining.match(flagRe);
      if (!m) break;
      const [, key, value] = m as unknown as [string, string, string];
      if (key === "workers") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) fleetWorkers = n;
      } else if (key === "agent") {
        fleetAgent = value;
      } else if (key === "model") {
        fleetModel = value;
      } else if (key === "review-policy") {
        const validModes = ["off", "hints", "all", "high-only"];
        if (validModes.includes(value)) {
          reviewPolicyMode = value as "off" | "hints" | "all" | "high-only";
        }
      } else if (key === "work-agent") {
        workAgent = value;
      } else if (key === "work-model") {
        workModel = value;
      } else if (key === "review-agent") {
        reviewAgent = value;
      } else if (key === "review-model") {
        reviewModel = value;
      } else if (key === "review-run-on") {
        if (value === "worker" || value === "orchestrator") {
          reviewRunOn = value as "orchestrator" | "worker";
        }
      } else if (key === "override-hint") {
        overrideHint = value === "true";
      } else if (key === "compete") {
        compete = value === "true";
      } else if (key === "attach") {
        attachPaths.push(value);
      }
      argsRemaining = argsRemaining.slice(m[0].length);
    }
    const attachResult = loadAttachments(attachPaths);
    if ("error" in attachResult) {
      this.client.reply(reqId, { text: `planner start: ${attachResult.error}` });
      return;
    }
    if (argsRemaining.trim().length > 0) {
      this.client.reply(reqId, {
        text: `planner start: unexpected trailing argument "${argsRemaining.trim()}". Usage: \`/hydra planner start [--workers N] [--agent ID] [--model ID] [--review-policy MODE] [--override-hint true|false] [--compete true|false] [--work-agent ID] [--work-model ID] [--review-agent ID] [--review-model ID] [--review-run-on orchestrator|worker] [--attach <path>]...\` (no description — uses the conversation).`,
      });
      return;
    }
    if (fleetAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === fleetAgent);
      if (!known) {
        log.warn(`--agent "${fleetAgent}" not in installed agent list; workers will spawn with default unless a per-task agent is set`);
      }
    }
    if (workAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === workAgent);
      if (!known) {
        log.warn(`--work-agent "${workAgent}" not in installed agent list; workers will spawn with default unless a per-task agent is set`);
      }
    }
    if (reviewAgent) {
      const choices = await this.ensureAgentChoices();
      const known = (choices ?? []).some((a) => a.id === reviewAgent);
      if (!known) {
        log.warn(`--review-agent "${reviewAgent}" not in installed agent list; reviews will spawn with default unless a per-task agent is set`);
      }
    }

    const boardFleetDefaults: import("./board.js").FleetDefaults = {
      agent: fleetAgent,
      model: fleetModel,
    };
    if (workAgent !== undefined || workModel !== undefined) {
      boardFleetDefaults.work = {};
      if (workAgent !== undefined) boardFleetDefaults.work.agent = workAgent;
      if (workModel !== undefined) boardFleetDefaults.work.model = workModel;
    }
    if (reviewAgent !== undefined || reviewModel !== undefined || reviewRunOn !== undefined) {
      boardFleetDefaults.review = {};
      if (reviewAgent !== undefined) boardFleetDefaults.review.agent = reviewAgent;
      if (reviewModel !== undefined) boardFleetDefaults.review.model = reviewModel;
      if (reviewRunOn !== undefined) boardFleetDefaults.review.runOn = reviewRunOn;
    }

    const board = newBoard({
      description: "(from conversation)",
      concurrencyCap: fleetWorkers,
      fleetDefaults: boardFleetDefaults,
      attachments: attachResult.attachments,
    });
    const baselineStart = getLatestOrchestratorUsage(sessionId);
    if (baselineStart) board.orchestratorUsageBaseline = { ...baselineStart };
    await this.seedOrchestratorIdentity(board, sessionId);
    if (reviewPolicyMode || overrideHint !== undefined) {
      board.reviewPolicy = {
        mode: reviewPolicyMode ?? "hints",
        overrideHint: overrideHint ?? false,
      };
    }
    if (compete) {
      board.compete = true;
    }
    // start. intent: decompose + kick off in one step. The flag
    // tells finishDecomposition to transition state to running and
    // schedule workers when the agent's decomposition comes back.
    board.pendingExecute = true;
    boards.set(sessionId, board);
    saveBoard(board, sessionId);
    setOrchestratorState(sessionId, {
      projectId: board.projectId,
      decompositionAccumulator: "",
      addAccumulator: "",
      awaitingAdd: false,
      awaitingDecomposition: true,
      awaitingOrchestratorReview: false,
      orchestratorReviewTaskId: null,
      orchestratorReviewAccumulator: "",
    });

    log.info(
      `decomposing + executing project ${board.projectId} for session …${sessionId.slice(-8)} (from conversation)` +
        (fleetWorkers ? ` [workers=${fleetWorkers}]` : "") +
        (fleetAgent ? ` [agent=${fleetAgent}]` : "") +
        (fleetModel ? ` [model=${fleetModel}]` : "") +
        (workAgent ? ` [work-agent=${workAgent}]` : "") +
        (workModel ? ` [work-model=${workModel}]` : "") +
        (reviewAgent ? ` [review-agent=${reviewAgent}]` : "") +
        (reviewModel ? ` [review-model=${reviewModel}]` : ""),
    );

    // TUI's "⚙ thinking…" placeholder fills the decomposition gap
    // — same rationale as handleCreate.

    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      if (this.isShutdownError(err)) {
        log.info(`start aborted (shutdown) for ${board.projectId}; board left as is`);
        this.client.reply(reqId, { text: "" });
        return;
      }
      log.error(
        `transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
      setBoardState(board, "failed");
      saveBoard(board, sessionId);
      const errState = getOrchestratorState(sessionId);
      if (errState) errState.awaitingDecomposition = false;
      await this.emitSyntheticMessage(
        sessionId,
        `Could not attach to this session: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/prompt",
        envelope: buildTextPromptEnvelope({
          sessionId,
          text: buildExecuteDecompositionPrompt(await this.ensureAgentChoices(), compete),
        }),
        route: "chain",
      });
    } catch (err) {
      if (this.isShutdownError(err)) {
        log.info(
          `decomposition aborted (shutdown) for ${board.projectId}; left as decomposing for resume`,
        );
        this.client.reply(reqId, { text: "" });
        return;
      }
      log.error(
        `decomposition turn failed for ${board.projectId}: ${(err as Error).message}`,
      );
      const failedState = getOrchestratorState(sessionId);
      if (failedState) failedState.awaitingDecomposition = false;
      setBoardState(board, "failed");
      saveBoard(board, sessionId);
      await this.emitSyntheticMessage(
        sessionId,
        `Decomposition turn for ${shortProjectId(board.projectId)} failed: ${(err as Error).message}`,
      );
      this.client.reply(reqId, { text: "" });
      return;
    }

    const doneState = getOrchestratorState(sessionId);
    if (doneState && doneState.awaitingDecomposition) {
      this.finishDecomposition(sessionId, doneState);
    }
    if (board.state === "running") {
      await this.holdAndReply(reqId, sessionId, board, slashMessageId, "start");
      return;
    }
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

  // Shared project-cancellation core. Called by both the slash command
  // (/hydra planner stop) and the session/cancel intercept. Marks
  // in-flight tasks failed, force-cancels their workers, transitions
  // board state to failed, persists, emits a final plan snapshot, and
  // resolves the held turn (if any) with a cancelled summary.
  //
  // `source` is purely informational — included in the resolved text
  // so the user can tell whether they pressed ^C or typed the slash
  // command. Both paths produce identical board mutations.
  private async runProjectStop(
    orchestratorSessionId: string,
    board: Board,
    source: "user-cancel" | "slash",
  ): Promise<void> {
    if (
      board.state === "done" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      // Race: a concurrent stop or completion already landed.
      // Idempotent no-op.
      return;
    }
    // In-flight tasks revert to `pending` rather than `failed`. The
    // distinction matters: `failed` means "something broke, look at
    // it"; user-initiated stop means "I'll come back to this." When
    // start later resumes the board, pickEligible finds the
    // pending tasks naturally. attemptCount stays incremented from
    // the spawn so retry semantics remain honest.
    const { inFlightWorkerIds } = stopBoardBookkeeping(board);
    setBoardState(board, "stopped");
    saveBoard(board, orchestratorSessionId);

    log.info(
      `stopping project ${shortProjectId(board.projectId)} (${source}) — ${inFlightWorkerIds.length} in-flight worker${inFlightWorkerIds.length === 1 ? "" : "s"}`,
    );
    for (const workerId of inFlightWorkerIds) {
      // Abandon any buffered text — flushing post-cancel would surface
      // the worker's last thoughts after the cancel summary, which
      // reads as if the work continued.
      this.endWorkerForward(workerId);
      // Clear the planner's per-worker bookkeeping NOW so any late
      // emit-promise resolution from spawnTaskOnNewWorker (force_cancel
      // doesn't guarantee the agent halts in time — its in-flight turn
      // can still come back successful) lands on missing state and
      // bails cleanly via the early-return in handleTaskComplete /
      // handleTaskFailure. Without this clear, an old worker's
      // straggler session/update notifications can still find a live
      // workerState entry pointing at the orchestrator session, and
      // their tool_calls/thoughts can re-render in a *subsequent*
      // project's transcript on the same session — the "tools coming
      // back to life" bug.
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      void this.client
        .request("hydra-acp/session/force_cancel", { sessionId: workerId })
        .catch((err) => {
          log.warn(
            `force_cancel of worker ${workerId} failed: ${(err as Error).message}`,
          );
        });
    }
    // Final plan snapshot so the closing turn shows the stopped state.
    this.emitPlanUpdate(orchestratorSessionId, board);

    const tail =
      inFlightWorkerIds.length > 0
        ? `; ${inFlightWorkerIds.length} in-flight task${inFlightWorkerIds.length === 1 ? "" : "s"} reverted to pending`
        : "";
    resolveHeldTurn(orchestratorSessionId, {
      reason: "cancelled",
      text: `Project ${shortProjectId(board.projectId)} stopped${tail}. Use /hydra planner start (or the start tool) to resume.`,
    });
   }

  // Surface "project stuck behind failed dependencies" by ending the
  // user's held turn with a failure resolution. Called from the
  // scheduler when no task is eligible AND no worker is in flight AND
  // tasks remain pending — i.e. every pending task is transitively
  // blocked by a `failed` ancestor.
  //
  // Without this the board sat silently in "running" state with no
  // workers, leaving the TUI looking busy forever. By resolving the
  // held turn with reason "failed" we close the turn with explicit
  // instructions, so the TUI stops spinning and the user sees the
  // path forward. The board state itself stays `running` (tasks are
  // still pending, just unreachable); a follow-up `/hydra planner
  // retry` opens a fresh held turn via its own resume path.
  //
  // Per-project deduped: re-emitted only if a future call sees the
  // board unstuck and then stuck again.
  private notifyBlockedByFailure(orchestratorSessionId: string, board: Board): void {
    if (this.blockedNotifiedFor.has(board.projectId)) return;
    const failed = board.tasks.filter((t) => t.status === "failed");
    if (failed.length === 0) return; // shouldn't happen given the call-site guard
    const pending = board.tasks.filter((t) => t.status === "pending").length;
    const failedIds = failed.map((t) => t.id).join(", ");
    const msg =
      `Project ${shortProjectId(board.projectId)} is stuck: ${pending} pending task${pending === 1 ? "" : "s"} blocked by failed dep${failed.length === 1 ? "" : "s"} ${failedIds}. ` +
      `Use \`/hydra planner retry\` (or the retry tool with no taskId) to retry all failed tasks, ` +
      `or \`/hydra planner skip <id>\` to accept a failure and unblock dependents that are still reachable.`;
    log.info(
      `project ${shortProjectId(board.projectId)} blocked by failed deps [${failedIds}]; ${pending} pending task${pending === 1 ? "" : "s"} unreachable`,
    );
    this.blockedNotifiedFor.add(board.projectId);
    // Resolve the held turn with reason "failed" so the TUI closes
    // the turn cleanly. If there's no held turn (rehydrated project
    // in degraded mode), fall back to a synthetic message so the
    // transcript still carries the notice.
    if (!resolveHeldTurn(orchestratorSessionId, { reason: "failed", text: msg })) {
      void this.emitSyntheticMessage(orchestratorSessionId, msg, {
        event: "project-blocked-by-failure",
      });
    }
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
    // Don't inject board context while an orchestrator-lane review is in
    // flight — the host session is busy with the review turn.
    if (orchState?.awaitingOrchestratorReview) {
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

  // Handle a session/request_permission delivered to us because we
  // session/attach-ed as a client on the worker session. The agent
  // (worker) emitted the request; the daemon broadcasts to attached
  // clients; we're one of them. Forward to the orchestrator (user's
  // TUI) and reply with their pick.
  private handlePermissionRequest(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as { sessionId?: unknown };
    const workerSessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!workerSessionId) {
      this.client.replyError(req.id, -32602, "missing sessionId");
      return;
    }
    if (isOrchestrator(workerSessionId)) {
      // Shouldn't happen — we don't attach as a client to the
      // orchestrator session. Pass-through reply with cancelled so the
      // daemon's broadcast can still settle from another client.
      this.client.replyError(req.id, -32601, "planner does not handle orchestrator-session permissions");
      return;
    }
    const orchestratorId = orchestratorOfWorker(workerSessionId);
    if (!orchestratorId) {
      // Worker not registered (race during shutdown, or a session we
      // don't manage). Reject so a different attached client (if any)
      // can answer; don't auto-deny.
      this.client.replyError(req.id, -32601, "planner does not own this worker");
      return;
    }
    void this.forwardPermissionToOrchestrator(req.id, workerSessionId, orchestratorId, req.params);
  }

  // Forward a worker session/request_permission to the orchestrator
  // session as a new request, then reply to the worker's request with
  // the user's selection.
  private async forwardPermissionToOrchestrator(
    workerReqId: string | number,
    workerSessionId: string,
    orchestratorSessionId: string,
    workerParams: unknown,
  ): Promise<void> {
    const shortWorker = workerSessionId.slice(-8);
    try {
      // Ask the daemon to broadcast a session/request_permission on the
      // orchestrator session to ITS attached clients (the user's TUI).
      // This endpoint exposes the same broadcast-and-await logic the
      // agent's own session/request_permission goes through; it isn't
      // route:"chain" (which would dispatch to the agent, who doesn't
      // handle this method). The user's pick is the return value.
      const rewritten = {
        ...(workerParams as Record<string, unknown>),
        sessionId: orchestratorSessionId,
      };
      const result = await this.client.request<unknown>(
        "hydra-acp/session/request_permission",
        rewritten,
      );
      this.client.reply(workerReqId, result ?? { outcome: { outcome: "cancelled" } });
      log.info(`permission forwarded for worker …${shortWorker} → answered`);
    } catch (err) {
      log.warn(
        `permission forward for worker …${shortWorker} failed: ${(err as Error).message}; auto-denying`,
      );
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `Worker …${shortWorker} permission request auto-denied: ${(err as Error).message}`,
        { event: "worker-permission-auto-denied", workerSessionId },
      );
      this.client.reply(workerReqId, { outcome: { outcome: "cancelled" } });
    }
  }

  // Attach to a worker session as a regular ACP client so we receive
  // agent→client broadcasts (notably session/request_permission).
  // Best-effort: a failure here is logged but doesn't block worker
  // dispatch — only permission forwarding is degraded.
  private async attachAsClient(sessionId: string): Promise<void> {
    try {
      await this.client.request("session/attach", {
        sessionId,
        // historyPolicy: "none" — we only care about future
        // permission requests, not past transcript replay.
        historyPolicy: "none",
        clientInfo: { name: PROCESS_NAME, version: "0.0.2" },
      });
      attachedSessions.add(sessionId);
      log.debug(`session/attach (client) for worker …${sessionId.slice(-8)}`);
    } catch (err) {
      log.warn(
        `session/attach (client) for worker …${sessionId.slice(-8)} failed: ${(err as Error).message}; permission forwarding will be unavailable for this worker`,
      );
    }
  }

  // Worker-update handler driven from the session/update notification path.
  // Factor of handleUpdateResponse's worker branch — same accumulation +
  // forwarding logic, but without this.client.reply() since notifications
  // have no request id to reply to.
  private handleWorkerSessionUpdate(sessionId: string, envelope: unknown): void {
    const workerState = getWorkerState(sessionId);
    if (!workerState) return;

    const kind = updateKind(envelope);
    const forwarder = workerForwarders.get(sessionId);
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      let text = "";
      if (kind === "agent_message_chunk") {
        text = extractUpdateText(envelope);
        if (text.length > 0) {
          workerState.resultAccumulator += text;
        }
      } else {
        const content = (envelope as { update?: { content?: { text?: unknown } } } | undefined)
          ?.update?.content;
        text = typeof content?.text === "string" ? content.text : "";
      }
      if (text.length > 0 && forwarder) {
        const blockOpenerSeen = /```\s*hydra-result/.test(
          workerState.resultAccumulator,
        );
        if (!blockOpenerSeen) {
          forwarder.ingestText(text, kind);
        }
      }
      return;
    }
    if (
      kind === "usage_update" ||
      kind === "session_info_update" ||
      kind === "current_model_update"
    ) {
      const orchestratorId = orchestratorOfWorker(sessionId);
      const board = orchestratorId ? boards.get(orchestratorId) : undefined;
      const w = board ? board.workers[sessionId] : undefined;
      if (board && orchestratorId && w) {
        let changed = false;
        if (kind === "usage_update") {
          const usage = extractUsageUpdate(envelope);
          if (usage) {
            w.usage = { ...(w.usage ?? {}), ...usage };
            changed = true;
          }
        } else if (kind === "session_info_update") {
          const agentId = extractAgentIdUpdate(envelope);
          if (agentId && agentId !== w.agent) {
            w.agent = agentId;
            changed = true;
          }
        } else if (kind === "current_model_update") {
          const model = extractCurrentModelUpdate(envelope);
          if (model && model !== w.model) {
            w.model = model;
            changed = true;
          }
        }
        if (changed) saveBoard(board, orchestratorId);
      }
      return;
    }
    if (kind === "plan") {
      // ACP plan update from the worker. Don't forward as its own
      // panel (the orchestrator session has only one plan slot, owned
      // by the board panel) — instead merge into the board panel as
      // indented sub-rows under the worker's parent task. See
      // plan-update.ts for the rendering.
      this.applyWorkerSubtodosFromPlanEnvelope(sessionId, envelope);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      // Some hosts (opencode) emit their internal todolist as a
      // TodoWrite tool_call rather than an ACP plan envelope. Detect
      // by input shape (a `todos` array of {content,status,...}),
      // route the same way as plan updates, and suppress the tool
      // panel so the user doesn't see a redundant raw TodoWrite UI
      // alongside the merged board panel. Subsequent tool_call_update
      // envelopes on the same toolCallId are tracked in
      // workerState.todoToolCallIds so they're suppressed too.
      if (this.maybeInterceptTodoWriteToolCall(sessionId, kind, envelope, workerState)) {
        return;
      }
      if (forwarder) {
        forwarder.ingestToolUpdate(kind, envelope);
      }
      return;
    }
  }

  // Translate an ACP plan envelope's entries into WorkerSubtodo[] and
  // store on the worker's board entry. Triggers an orchestrator plan
  // update so the merged view re-renders. Best-effort: malformed
  // envelopes are silently ignored — a missed merge isn't worth
  // failing for, and the next emit replaces.
  private applyWorkerSubtodosFromPlanEnvelope(
    workerSessionId: string,
    envelope: unknown,
  ): void {
    const entries = (envelope as { update?: { entries?: unknown } } | undefined)
      ?.update?.entries;
    if (!Array.isArray(entries)) return;
    this.applyWorkerSubtodos(workerSessionId, normalizeSubtodoEntries(entries));
  }

  // Detect a TodoWrite-shaped tool_call / tool_call_update; if it
  // matches, route into the subtodo merge path and return true so the
  // caller suppresses normal forwarding. tool_call_update may arrive
  // without input — in that case we just remember the toolCallId was
  // a TodoWrite (so we keep suppressing it) and skip the merge.
  private maybeInterceptTodoWriteToolCall(
    workerSessionId: string,
    kind: string,
    envelope: unknown,
    workerState: { todoToolCallIds?: Set<string> },
  ): boolean {
    const update = (envelope as { update?: Record<string, unknown> } | undefined)?.update;
    if (!update) return false;
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const title = typeof update.title === "string" ? update.title : undefined;
    const input = update.input ?? update.rawInput;
    const todosFromInput =
      input && typeof input === "object" && Array.isArray((input as { todos?: unknown }).todos)
        ? ((input as { todos: unknown[] }).todos as unknown[])
        : undefined;

    const ids = workerState.todoToolCallIds;
    const alreadyKnown = !!(toolCallId && ids?.has(toolCallId));
    const looksLikeTodoWrite =
      todosFromInput !== undefined || (title?.toLowerCase().includes("todowrite") ?? false);

    if (!alreadyKnown && !looksLikeTodoWrite) return false;

    if (toolCallId) {
      const set = workerState.todoToolCallIds ?? new Set<string>();
      set.add(toolCallId);
      workerState.todoToolCallIds = set;
    }
    if (todosFromInput) {
      this.applyWorkerSubtodos(workerSessionId, normalizeSubtodoEntries(todosFromInput));
    }
    void kind;
    return true;
  }

  // Write a normalized subtodo list onto the worker's board record
  // and re-emit the orchestrator plan panel. No-ops if the worker
  // has no board entry yet (race with spawn) or no orchestrator.
  private applyWorkerSubtodos(workerSessionId: string, subtodos: WorkerSubtodo[]): void {
    const orchestratorId = orchestratorOfWorker(workerSessionId);
    if (!orchestratorId) return;
    const board = boards.get(orchestratorId);
    if (!board) return;
    const w = board.workers[workerSessionId];
    if (!w) return;
    if (subtodos.length === 0) {
      if (!w.subtodos || w.subtodos.length === 0) return;
      w.subtodos = [];
    } else {
      w.subtodos = subtodos;
    }
    this.emitPlanUpdate(orchestratorId, board);
  }

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

    // Orchestrator-lane review: suppress + accumulate agent_message_chunk
    // text while an orchestrator review is in flight. The emit promise
    // (awaited in runReviewOnOrchestrator) marks turn completion; at that
    // point the accumulated text is parsed as a review result.
    if (orchState && orchState.awaitingOrchestratorReview) {
      const kind = updateKind(envelope);
      if (kind === "agent_message_chunk") {
        const text = extractUpdateText(envelope);
        if (text.length > 0) {
          orchState.orchestratorReviewAccumulator += text;
        }
        this.client.reply(reqId, { action: "stop" });
        return;
      }
      // Non-chunk notifications during a review still pass through so
      // that metadata (usage, model) is captured on the board.
      this.client.reply(reqId, { action: "continue" });
      return;
    }

    // Orchestrator-side metadata capture: usage_update for cost/tokens,
    // session_info_update for agentId, current_model_update for model.
    // Snapshots are persisted on the board so the sessions table can
    // render them after the fact. We always pass through here so other
    // transformers and the client see these notifications normally.
    {
      const kind = updateKind(envelope);
      const board = boards.get(sessionId);
      // Track usage_update even when no board exists yet: newBoard
      // snapshots this value as orchestratorUsageBaseline so the
      // project's reported usage starts at 0 (and excludes any cost
      // already accrued on the orchestrator session before plan
      // creation).
      if (kind === "usage_update") {
        const usage = extractUsageUpdate(envelope);
        if (usage) {
          recordOrchestratorUsage(sessionId, usage);
          if (board) {
            board.orchestratorUsage = { ...(board.orchestratorUsage ?? {}), ...usage };
            saveBoard(board, sessionId);
          }
        }
      }
      if (board) {
        if (kind === "session_info_update") {
          const agentId = extractAgentIdUpdate(envelope);
          if (agentId && agentId !== board.orchestratorAgent) {
            board.orchestratorAgent = agentId;
            saveBoard(board, sessionId);
          }
        } else if (kind === "current_model_update") {
          const model = extractCurrentModelUpdate(envelope);
          if (model && model !== board.orchestratorModel) {
            board.orchestratorModel = model;
            saveBoard(board, sessionId);
          }
        }
      }
    }

    this.client.reply(reqId, { action: "continue" });
  }

  // Called when the decomposition prompt's emit promise resolves
  // (the agent's session/prompt response came back, turn is complete).
  // Thin wrapper around setPlan — parses the accumulated fenced-JSON
  // reply and delegates to the shared persistence layer.
  //
  // This is the non-MCP path: agents that don't speak the
  // set_plan MCP tool emit fenced JSON which we extract and
  // parse. MCP-speaking agents skip this code path — they call
  // set_plan directly with structured input, and the MCP
  // tool handler calls setPlan with the same shape we'd reconstruct
  // from the fenced block here.
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

    state.awaitingDecomposition = false;
    state.decompositionAccumulator = "";

    if (!result) {
      log.warn(`decomposition parse failed for ${board.projectId}; accumulator length=${state.decompositionAccumulator.length}`);
      setBoardState(board, "failed");
      saveBoard(board, sessionId);
      void this.emitSyntheticMessage(
        sessionId,
        `Couldn't parse a decomposition out of the agent's reply for ${shortProjectId(board.projectId)}. Try \`/hydra planner create\` again with a clearer description.`,
      );
      return;
    }

    // Hand off to the shared persistence layer. board.pendingExecute
    // (set by the original create/start caller) determines whether
    // we transition to ready or running.
    this.setPlan(sessionId, board, result);
  }

  // Shared persistence layer for plan materialization. Used by:
  //   - finishDecomposition (fenced-JSON path, for non-MCP agents)
  //   - set_plan MCP tool (for MCP-capable agents)
  //
  // Takes an already-normalized DecompositionResult (tasks + optional
  // description + warnings) and:
  //   - applies tasks + description to the board
  //   - recomputes concurrency cap from DAG shape unless locked
  //   - transitions state to running (when board.pendingExecute is
  //     true) or ready (otherwise)
  //   - persists, emits warnings, emits plan panel
  //   - kicks off the scheduler when running, or shows the "run
  //     `start` to begin" hint when ready
  //
  // Idempotent on the board reference — caller owns the board and
  // any pre-call mutations are visible. pendingExecute is cleared
  // after the transition so subsequent setPlan calls (e.g. user
  // revises via set_plan) default to ready unless explicitly
  // re-flagged.
  private setPlan(
    sessionId: string,
    board: Board,
    result: { tasks: Task[]; description?: string; warnings: string[] },
  ): void {
    board.tasks = result.tasks;
    if (!board.concurrencyCapLocked) {
      board.concurrencyCap = sweepLineConcurrencyCap(result.tasks);
    }
    // Synthesize review tasks according to the board's review policy.
    // Only applies when reviewPolicy is explicitly set on the board —
    // undefined means "don't synthesize" (preserves backward compatibility
    // with boards that never had a reviewPolicy configured).
    if (board.reviewPolicy) {
      const updatedBoard = applyReviewPolicy(board, resolveReviewPolicy(board.reviewPolicy));
      if (updatedBoard !== board) {
        board.tasks = updatedBoard.tasks;
      }
    }
    // start seeds the board with a placeholder description and asks
    // the agent to summarize the conversation-driven project in its
    // response (or sets a real description from the tool input). When
    // a non-empty description comes back, replace any placeholder so
    // /status and the context preamble read sensibly.
    if (result.description) {
      board.description = result.description;
    }
    const willKickoff = board.pendingExecute === true;
    setBoardState(board, willKickoff ? "running" : "ready");
    board.pendingExecute = undefined;
    saveBoard(board, sessionId);

    log.info(
      `decomposed ${board.projectId}: ${result.tasks.length} tasks, cap=${board.concurrencyCap}, warnings=${result.warnings.length}, state=${board.state}`,
    );

    if (result.warnings.length > 0) {
      const warningsBlock = `${result.warnings.length} decomposition warning${result.warnings.length === 1 ? "" : "s"}:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`;
      void this.emitSyntheticMessage(sessionId, warningsBlock);
    }
    log.debug(formatPlanSummary(result.tasks, board.concurrencyCap));

    if (willKickoff) {
      void this.scheduleEligibleTasks(sessionId, board);
      return;
    }
    // Dump the full status (description + task list + assignments)
    // as a one-shot agent_message_chunk, NOT an ACP plan update. The
    // live plan panel belongs to `/hydra planner continue`'s held
    // turn — emitting it here would render before any turn exists
    // to anchor to, duplicate whatever the orchestrator agent emits
    // later, and conflate "plan was just persisted" (a discrete
    // event) with "plan is live and updating" (a turn-anchored
    // panel). Status dump matches the mental model: here's what was
    // planned; run /start (or /continue) to engage the live view.
    // Wrap the status dump in a fenced code block so markdown
    // renderers (browser clients, etc.) preserve the aligned-column
    // formatting that formatStatus produces. Without the fence,
    // markdown collapses single newlines and runs of whitespace,
    // flattening the task list and sessions table into one wrapped
    // blob. Terminals render the fenced form the same as raw text,
    // so this is a strict improvement across clients.
    const statusDump = formatStatus(board, attachedSessions.has(sessionId), sessionId);
    const followup = `Plan ready: ${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"} (concurrency cap ${board.concurrencyCap}). Run \`/hydra planner start\` to start working, or \`/hydra planner create <new description>\` to revise.`;
    void this.emitSyntheticMessage(sessionId, `\`\`\`\n${statusDump}\n\`\`\`\n\n${followup}`);
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
    if (
      board.state === "done" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      return;
    }
    // Paused: in-flight workers keep running and their completions
    // still record results, but no new tasks dispatch. Resume flips
    // state back to "running" and re-invokes the scheduler.
    if (board.state === "paused") {
      return;
    }
    // Project-complete short-circuit. Emit a final plan snapshot,
    // transition state, resolve the held turn (if any) with a success
    // summary so handleCreate/Execute replies to commands/invoke.
    if (allTerminal(board)) {
      setBoardState(board, "done");
      saveBoard(board, orchestratorSessionId);
      this.emitPlanUpdate(orchestratorSessionId, board);
      const failed = board.tasks.filter((t) => t.status === "failed").length;
      const done = board.tasks.length - failed;
      const headline = failed > 0
        ? `Project ${shortProjectId(board.projectId)} done with ${failed} failure${failed === 1 ? "" : "s"} (${done}/${board.tasks.length} done).`
        : `Project ${shortProjectId(board.projectId)} complete — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} done.`;
      const statusDump = formatStatus(board, attachedSessions.has(orchestratorSessionId), orchestratorSessionId);
      const summary = `${headline}\n\n${statusDump}`;
      if (!resolveHeldTurn(orchestratorSessionId, {
        reason: failed > 0 ? "failed" : "complete",
        text: summary,
      })) {
        // No held turn (e.g. rehydrated project running in degraded
        // mode) — fall back to a synthetic chunk so the user still
        // sees the celebration.
        void this.emitSyntheticMessage(orchestratorSessionId, summary);
      }
      return;
    }

    while (inFlightCount(board) < board.concurrencyCap) {
      const task = pickEligible(board);
      if (!task) {
        // Nothing eligible right now. Either we hit the cap, or
        // remaining work is dep-blocked behind in-flight tasks. The
        // next task completion will retry — no need to poll.
        // …unless nothing is in flight AND tasks remain pending: that
        // means every pending task is transitively blocked by a failed
        // dep. Without a signal the project sits silently in "running"
        // state forever. Notify once, then leave the board so the
        // user can /hydra planner retry the failed root(s) to unblock.
        if (
          inFlightCount(board) === 0 &&
          board.tasks.some((t) => t.status === "pending")
        ) {
          this.notifyBlockedByFailure(orchestratorSessionId, board);
        }
        return;
      }
      // Forward progress is happening — clear the stuck-notice dedup
      // so if the board ever blocks again later (a future failure
      // strands new dependents), the user gets a fresh notification.
      this.blockedNotifiedFor.delete(board.projectId);

// Phase 4a: orchestrator-lane review tasks. Default runOn for
        // review tasks is "orchestrator"; "worker" is explicit opt-in.
        // Orchestrator reviews don't count against concurrencyCap and
        // are single-flight (only one at a time on the host session).
        //
        // Smart routing: resolveReviewLane sends reviews to the worker
        // lane whenever a review-targeted agent/model is configured (so
        // the configured values are actually honored), and defaults to
        // the orchestrator lane otherwise. Explicit runOn always wins.
        if (task.kind === "review") {
          const { lane, reason } = resolveReviewLane(task, board);
          if (reason === "configured-agent" || reason === "configured-model") {
            log.info(
              `review ${task.id}: routing to worker lane (${reason}) — configured ${reason === "configured-agent" ? "agent" : "model"} only takes effect on worker lane`,
            );
          }
          const runOn = lane;
        if (runOn === "orchestrator") {
          const orchState = getOrchestratorState(orchestratorSessionId);
          if (orchState?.awaitingOrchestratorReview) {
            // Single-flight: a review is already in progress. We must
            // RETURN, not `continue` — pickEligible is deterministic
            // and would return this same task on the next loop pass,
            // creating an infinite CPU-spinning loop. The in-flight
            // review's completion path calls scheduleEligibleTasks
            // again, which is when this pending review will get its
            // chance.
            return;
          }
          await this.runReviewOnOrchestrator(task, board, orchestratorSessionId);
          continue;
        }
      }

      // Spawn synchronously enough to claim the task before the
      // next loop iteration sees it. The actual emit + run is
      // fire-and-forget; on completion it calls back into
      // scheduleEligibleTasks to fill the slot.
      await this.spawnTaskOnNewWorker(orchestratorSessionId, board, task);
      // Re-check terminal state after the spawn await: a user-cancel
      // (^C → runProjectStop) can land during one of the spawn's
      // internal awaits, transitioning the board to "stopped". Without
      // this check the loop happily picks the next pending task and
      // spawns another worker the user thinks they cancelled.
      // (cast: TS narrowed `state` based on the top-of-function guard
      // and doesn't know runProjectStop can mutate it during the await.)
      const stateAfter = board.state as Board["state"];
      if (
        stateAfter === "done" ||
        stateAfter === "failed" ||
        stateAfter === "stopped" ||
        stateAfter === "paused"
      ) {
        return;
      }
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
    // Resolve effective agent using the centralized chain: per-task
    // override → kind-specific fleet default → fleet default → null.
    // Declared at function scope so it remains in scope after the spawn
    // try-block, where it's recorded on board.workers below.
    const effectiveAgent = resolveAgent(task, board);
    const effectiveModel = resolveModel(task, board);

    // Claim the task SYNCHRONOUSLY before any await. Without this,
    // two concurrent invocations of scheduleEligibleTasks both
    // pickEligible the same task (still "pending"), both enter this
    // function, both await ensureAgentChoices/spawn, and both end up
    // spawning a worker. assignedTo stays null until we have the real
    // childSessionId; pickEligible's `status === "pending"` test is
    // what gates duplicate selection, so this is sufficient.
    task.status = "assigned";
    task.assignedTo = null;
    task.startedAt = nowIso();
    task.attemptCount += 1;
    saveBoard(board, orchestratorSessionId);

    // Make sure the installed-agent list is populated before we validate
    // against it. Without this, a fresh transformer process (e.g. after
    // a restart) has an empty cache and every per-task / fleet-default
    // agent gets misreported as "unknown" and silently downgraded to
    // the daemon default.
    if (effectiveAgent) {
      await this.ensureAgentChoices();
    }
    let childSessionId: string;
    try {
      const spawnParams: Record<string, unknown> = {
        parentSessionId: orchestratorSessionId,
        // cwd omitted → inherits from parent
        // Pre-seed the worker's session title so it shows up labelled
        // in session/list and the picker from the moment it's created.
        // Without this, the first user prompt (the bulky task prompt)
        // would seed the title — unscannable. Daemon reads this under
        // _meta.hydra-acp.title (same shape as session/new).
        _meta: {
          "hydra-acp": { title: `${task.id}: ${task.title}` },
        },
      };
      if (effectiveAgent) {
        const known = (this.agentChoices ?? []).some((a) => a.id === effectiveAgent);
        if (known) {
          spawnParams.agentId = effectiveAgent;
        } else {
          log.warn(
            `task ${task.id} requested unknown agent "${effectiveAgent}"; spawning with default`,
          );
        }
      }
      const spawnResult = await this.client.request<{ childSessionId: string }>(
        "hydra-acp/child_session/spawn",
        spawnParams,
      );
      childSessionId = spawnResult.childSessionId;
    } catch (err) {
      log.error(
        `failed to spawn worker for ${task.id}: ${(err as Error).message}`,
      );
      // Claim was synchronous earlier; this is the spawn-failure path,
      // so flip to `failed` (attemptCount was already bumped).
      task.status = "failed";
      task.assignedTo = null;
      task.startedAt = null;
      saveBoard(board, orchestratorSessionId);
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `failed to spawn a worker: ${(err as Error).message}`,
        { event: "task-spawn-failed", taskId: task.id },
      );
      return;
    }

    // Attach as a regular ACP client so the daemon broadcasts
    // agent→client requests (session/request_permission) to us. Failure
    // here is non-fatal — only permission forwarding is degraded.
    await this.attachAsClient(childSessionId);

    // Abort the claim if the board was stopped/cancelled while we
    // were awaiting spawn + attach. The worker session exists at this
    // point but isn't doing anything yet (no prompt sent); close it and
    // revert the task to pending so a future resume can re-dispatch it.
    // Without this guard a ^C arriving mid-spawn lets the post-await
    // code below fire the task prompt — the user's "cancel" then races
    // against a freshly-launched worker.
    if (
      board.state === "stopped" ||
      board.state === "failed" ||
      board.state === "done"
    ) {
      log.info(
        `task ${task.id}: abandoning spawn — board entered "${board.state}" during spawn`,
      );
      // Revert the synchronous claim unconditionally on every terminal
      // path (stopped/failed/done). stopBoardBookkeeping only revisits
      // tasks with assignedTo set, and our pre-attach claim left
      // assignedTo null — so without this, failed/done leave a ghost
      // `assigned` row that confuses the scheduler and UI.
      task.status = "pending";
      task.assignedTo = null;
      task.startedAt = null;
      saveBoard(board, orchestratorSessionId);
      this.emitPlanUpdate(orchestratorSessionId, board);
      void this.closeWorker(childSessionId);
      return;
    }

    // Per-task model override (M6.2). The child_session/spawn protocol
    // doesn't take a model param — the model is applied via
    // session/set_model on the live session. Fire-and-forget: if the
    // worker's agent doesn't accept the model, log a warning and let
    // the task run on the agent's default model.
    if (effectiveModel) {
      this.client
        .request("session/set_model", {
          sessionId: childSessionId,
          modelId: effectiveModel,
        })
        .catch((err) => {
          log.warn(
            `task ${task.id} set_model "${effectiveModel}" failed; worker will run on default: ${(err as Error).message}`,
          );
        });
    }

    // Fill in the real worker id now that we have it. Status was
    // already flipped to "assigned" at the top of this function;
    // assignedTo was held null until the childSessionId existed.
    task.assignedTo = childSessionId;
    board.workers[childSessionId] = {
      currentTaskId: task.id,
      tasksCompleted: [],
      agent: effectiveAgent,
      model: effectiveModel,
    };
    saveBoard(board, orchestratorSessionId);

    setWorkerState(childSessionId, {
      orchestratorSessionId,
      taskId: task.id,
      resultAccumulator: "",
      repromptCount: 0,
    });
    registerWorker(childSessionId, orchestratorSessionId);
    workerForwarders.set(
      childSessionId,
      new WorkerForwarder({
        orchestratorSessionId,
        workerSessionId: childSessionId,
        taskId: task.id,
        emit: this.makeWorkerEmit(childSessionId),
      }),
    );

    log.info(
      `assigned ${task.id} (${task.title}) to worker …${childSessionId.slice(-8)}`,
    );
    // Plan panel update reflects the in_progress transition. The
    // task-to-worker mapping is visible via the [Tn] prefix on
    // forwarded worker output (thoughts + tool calls), so a separate
    // assignment line in the transcript would be redundant noise
    // crowding the TUI's natural turn-start placeholder.
    this.emitPlanUpdate(orchestratorSessionId, board);

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
            text: promptsFor(task.kind ?? 'work').buildPrompt(task, board),
            ancillary: true,
          }),
          route: "chain",
        });
      } catch (err) {
        if (this.isShutdownError(err)) {
          log.info(
            `task ${task.id} emit aborted (shutdown); leaving as assigned for next-process resume`,
          );
          return;
        }
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
      if (this.shuttingDown) return; // skip completion processing during shutdown
      await this.handleTaskComplete(orchestratorSessionId, childSessionId, board, task);
    })();
  }

  // Re-prompt an existing in-flight worker session after a daemon
  // restart. The worker session was already attached during rehydrate
  // and its state populated; this just sends the continuation prompt
  // that nudges the agent to pick up. Same emit-then-handleTaskComplete
  // pattern as a fresh spawn.
  private resumeTask(
    orchestratorSessionId: string,
    board: Board,
    task: Task,
    workerSessionId: string,
  ): void {
    log.info(
      `resuming ${task.id} on worker …${workerSessionId.slice(-8)}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `Resuming ${task.id} on worker ${shortSessionId(workerSessionId)} (${task.title})`,
      { event: "task-resumed", taskId: task.id },
    );
    void (async () => {
      try {
        await this.client.request("hydra-acp/message/emit", {
          sessionId: workerSessionId,
          method: "session/prompt",
          envelope: buildTextPromptEnvelope({
            sessionId: workerSessionId,
            text: promptsFor(task.kind ?? 'work').buildResumePrompt(task),
            ancillary: true,
          }),
          route: "chain",
        });
      } catch (err) {
        if (this.isShutdownError(err)) {
          log.info(
            `resume turn for ${task.id} aborted (shutdown); leaving as assigned`,
          );
          return;
        }
        log.error(
          `resume turn for ${task.id} on worker ${workerSessionId} failed: ${(err as Error).message}`,
        );
        this.handleTaskFailure(
          orchestratorSessionId,
          workerSessionId,
          board,
          task,
          `resume turn failed: ${(err as Error).message}`,
        );
        return;
      }
      if (this.shuttingDown) return;
      await this.handleTaskComplete(orchestratorSessionId, workerSessionId, board, task);
    })();
  }

  // Re-prompt an orchestrator session whose project was mid-decomposition
  // at the time of the last shutdown. Hydra auto-resurrects the
  // session (seeding the prior transcript as takeover); this just
  // tells the agent to either re-emit its previous decomposition or
  // continue producing one. The flow mirrors handleCreate's tail —
  // accumulator was already set up during rehydrate, we just need to
  // drive the emit + finishDecomposition.
  private resumeDecomposition(
    orchestratorSessionId: string,
    board: Board,
  ): void {
    log.info(
      `resuming decomposition of ${board.projectId} on session …${orchestratorSessionId.slice(-8)}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `Resuming decomposition of ${shortProjectId(board.projectId)} after restart`,
    );
    void (async () => {
      try {
        await this.client.request("hydra-acp/message/emit", {
          sessionId: orchestratorSessionId,
          method: "session/prompt",
          envelope: buildTextPromptEnvelope({
            sessionId: orchestratorSessionId,
            text: buildResumeDecompositionPrompt(board.description, board.compete),
          }),
          route: "chain",
        });
      } catch (err) {
        if (this.isShutdownError(err)) {
          log.info(
            `resume decomposition aborted (shutdown) for ${board.projectId}`,
          );
          return;
        }
        log.error(
          `resume decomposition turn for ${board.projectId} failed: ${(err as Error).message}`,
        );
        const state = getOrchestratorState(orchestratorSessionId);
        if (state) state.awaitingDecomposition = false;
        setBoardState(board, "failed");
        saveBoard(board, orchestratorSessionId);
        await this.emitSyntheticMessage(
          orchestratorSessionId,
          `Resume of decomposition for ${shortProjectId(board.projectId)} failed: ${(err as Error).message}`,
        );
        return;
      }
      if (this.shuttingDown) return;
      const state = getOrchestratorState(orchestratorSessionId);
      if (state && state.awaitingDecomposition) {
        this.finishDecomposition(orchestratorSessionId, state);
      }
    })();
  }

  // Send a one-shot reprompt asking the agent to emit the missing
  // hydra-result block. The worker's accumulator was cleared by the
  // caller. When the new turn ends, handleTaskComplete fires again;
  // if parse still fails, repromptCount has hit the cap and it
  // escalates to handleTaskFailure.
  private repromptForResultBlock(
    orchestratorSessionId: string,
    workerSessionId: string,
    board: Board,
    task: Task,
  ): void {
    log.info(
      `reprompting worker …${workerSessionId.slice(-8)} for missing hydra-result block on ${task.id}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `Asking ${task.id} worker ${shortSessionId(workerSessionId)} for missing hydra-result block`,
      { event: "task-result-reprompt", taskId: task.id },
    );
    void (async () => {
      try {
        await this.client.request("hydra-acp/message/emit", {
          sessionId: workerSessionId,
          method: "session/prompt",
          envelope: buildTextPromptEnvelope({
            sessionId: workerSessionId,
            text: promptsFor(task.kind ?? 'work').buildRepromptPrompt(task),
            ancillary: true,
          }),
          route: "chain",
        });
      } catch (err) {
        if (this.isShutdownError(err)) {
          log.info(
            `reprompt turn for ${task.id} aborted (shutdown); leaving as assigned`,
          );
          return;
        }
        log.error(
          `reprompt turn for ${task.id} on worker ${workerSessionId} failed: ${(err as Error).message}`,
        );
        this.handleTaskFailure(
          orchestratorSessionId,
          workerSessionId,
          board,
          task,
          `reprompt turn failed: ${(err as Error).message}`,
        );
        return;
      }
      if (this.shuttingDown) return;
      await this.handleTaskComplete(orchestratorSessionId, workerSessionId, board, task);
    })();
  }

  // Called when the worker's session/prompt turn completes. Parses the
  // hydra-result block from the accumulated reply, persists artifacts,
  // closes the worker session, and schedules the next task.
  private async handleTaskComplete(
    orchestratorSessionId: string,
    workerSessionId: string,
    board: Board,
    task: Task,
  ): Promise<void> {
    // Cancellation guard: runProjectStop marks every in-flight task
    // `failed` and force-cancels its worker. If force_cancel arrived
    // too late and the agent's turn completed successfully anyway,
    // this callback still fires — without the guard we'd happily
    // mark the task done (overwriting the cancel) or reprompt the
    // (supposedly-dead) worker for a missing hydra-result block,
    // which spawns a fresh worker turn whose tool_calls and thoughts
    // can leak into a subsequent project's transcript on the same
    // session. Quiet bail is correct: cancel already resolved the
    // held turn and emitted the cancel summary.
    // Stop reverts assigned tasks to pending (and board to stopped);
    // genuine task failures leave the task `failed`. Both cases mean
    // "this completion is stale — don't process artifacts."
    if (
      task.status === "failed" ||
      task.status === "pending" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      log.debug(
        `task ${task.id}: ignoring late completion — already accounted for`,
      );
      return;
    }
    const workerState = getWorkerState(workerSessionId);
    if (!workerState) {
      log.warn(
        `task complete fired but no worker state for …${workerSessionId.slice(-8)}`,
      );
      return;
    }
    const p = promptsFor(task.kind ?? 'work');
    const raw = p.extractResult(workerState.resultAccumulator);
    const result = raw === undefined ? undefined : p.normalizeResult(raw);

    if (!result) {
      // Reprompt up to twice before giving up. Common failure: agent
      // did the work but forgot to emit the structured block at
      // end-of-message; a single sharp reprompt usually recovers it,
      // and a second shove rescues the model when the first reprompt
      // turn also drifted (observed with thinking-mode models that
      // stay in their reasoning channel). Clear the accumulator so
      // the next turn's chunks land in a fresh slot; bump
      // repromptCount so we don't loop forever.
      if (workerState.repromptCount < 2) {
        log.warn(
          `${task.id}: missing hydra-result block on worker …${workerSessionId.slice(-8)} (accumulator length=${workerState.resultAccumulator.length}), reprompting`,
        );
        workerState.repromptCount += 1;
        workerState.resultAccumulator = "";
        this.repromptForResultBlock(
          orchestratorSessionId,
          workerSessionId,
          board,
          task,
        );
        return;
      }
      this.handleTaskFailure(
        orchestratorSessionId,
        workerSessionId,
        board,
        task,
        `worker reply missing or malformed hydra-result block after ${workerState.repromptCount + 1} attempts`,
      );
      return;
    }

    // Audit the worker's actual edits against its self-reported
    // files_changed. Attaches verified_diff to artifacts BEFORE any
    // downstream code reads them (reviewer prompts, markTaskDone
    // persistence) so reviewers always see the truth. Skipped on the
    // orchestrator lane — that session is the user's main session and
    // carries unrelated edits.
    if (workerSessionId !== "orchestrator") {
      await this.auditTaskDiff(task, result.artifacts, workerSessionId, orchestratorSessionId);
    }

    const taskKind = task.kind ?? 'work';

    if (taskKind === 'review') {
      // Review tasks are handled by handleReviewComplete, which
      // processes the reviewer's decision and updates the reviewed
      // task accordingly.
      this.markTaskDone(task, result.artifacts, board, orchestratorSessionId, workerSessionId);
      this.handleReviewComplete(task, board, orchestratorSessionId, result);
      void this.scheduleEligibleTasks(orchestratorSessionId, board);
      return;
    }

    // For work tasks: check if any pending review task references
    // this completed work. If so, transition the work task to
    // awaiting_review (not done) so its review can run next.
    const reviewTask = this.findReviewedTask(task.id, board);
    if (reviewTask) {
      // Park the work task in awaiting_review; don't mark it done yet.
      // The review task stays pending so the scheduler picks it up.
      task.status = "awaiting_review";
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
        `completed ${task.id} on worker …${workerSessionId.slice(-8)} — awaiting review (${reviewTask.id})`,
      );
      this.emitPlanUpdate(orchestratorSessionId, board);
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        result.artifacts.summary ?? task.title,
        { event: "task-completed", taskId: task.id },
      );

      const hasContinue = this.hasContinueStrategyReview(task.id, board);
      if (!hasContinue) {
        this.endWorkerForward(workerSessionId, { flush: true });
        clearWorkerState(workerSessionId);
        unregisterWorker(workerSessionId);
        void this.closeWorker(workerSessionId);
      }

      // Try to refill the freed slot — the review task should now
      // be eligible since its dependency (this work task) is in
      // awaiting_review (non-terminal but satisfied for deps).
      void this.scheduleEligibleTasks(orchestratorSessionId, board);
      return;
    }

    this.markTaskDone(task, result.artifacts, board, orchestratorSessionId, workerSessionId);

    // Try to refill the freed slot. Completing this task may have also
    // unblocked dependents — scheduleEligibleTasks loops until it hits
    // the cap or runs out of eligible work. Also handles the
    // project-complete transition when no more work remains.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
  }

  // Pull the worker's actual session diff from the daemon and attach it
  // to the task's artifacts as verified_diff. Emits a synthetic
  // 'task-diff-mismatch' message when the worker claimed files_changed
  // but the diff is empty — surfaces silent no-ops without auto-failing.
  // Best-effort: a fetch failure (older daemon, network error) leaves
  // verified_diff undefined and the rest of the pipeline proceeds.
  private async auditTaskDiff(
    task: Task,
    artifacts: TaskArtifacts,
    workerSessionId: string,
    orchestratorSessionId: string,
  ): Promise<void> {
    const fetcher = this.fetchDiffOverride ?? ((sid: string) =>
      fetchSessionDiff(sid, {
        daemonHttpBase: this.daemonHttpBase,
        token: this.daemonToken,
      }));
    let diff: DiffFile[] | undefined;
    try {
      diff = await fetcher(workerSessionId);
    } catch (err) {
      log.debug(`audit ${task.id}: fetcher threw: ${(err as Error).message}`);
      return;
    }
    if (!diff) return;
    const files = diff.map((f) => f.path);
    const hunkCount = diff.reduce((n, f) => n + f.hunks.length, 0);
    artifacts.verified_diff = {
      files,
      hunkCount,
      sample: summarizeDiff(diff),
    };
    const claimed = artifacts.files_changed ?? [];
    if (claimed.length > 0 && files.length === 0) {
      const msg = `task ${task.id} claimed files_changed=[${claimed.join(", ")}] but session diff shows no edits`;
      log.warn(msg);
      void this.emitSyntheticMessage(orchestratorSessionId, `audit: ${msg}`, {
        event: "task-diff-mismatch",
        taskId: task.id,
      });
    }
  }

  private markTaskDone(
    task: Task,
    artifacts: TaskArtifacts,
    board: Board,
    orchestratorSessionId: string,
    workerSessionId: string,
  ): void {
    task.status = "done";
    task.finishedAt = nowIso();
    task.artifacts = artifacts;
    task.assignedTo = null;
    const workerEntry = board.workers[workerSessionId];
    if (workerEntry) {
      workerEntry.currentTaskId = null;
      workerEntry.tasksCompleted.push(task.id);
    }
    saveBoard(board, orchestratorSessionId);

    const isOrchestratorLane = workerSessionId === "orchestrator";
    log.info(
      `completed ${task.id}${isOrchestratorLane ? " (orchestrator)" : ` on worker …${workerSessionId.slice(-8)}`} — ${artifacts.summary}`,
    );
    this.emitPlanUpdate(orchestratorSessionId, board);
    // For review tasks, suppress the bare-summary message — it would
    // render as a one-word "approve" / "reject" / etc. (the decision
    // verb is the artifact summary, set by review normalizeResult).
    // finishReview / handleReviewWinner emit a much nicer per-decision
    // message like "review-T1 approved T1" right after, so the bare
    // word would just be ugly noise immediately preceding it.
    if (task.kind !== "review") {
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        artifacts.summary ?? task.title,
        { event: "task-completed", taskId: task.id },
      );
    }

    if (!isOrchestratorLane) {
      this.endWorkerForward(workerSessionId, { flush: true });
      clearWorkerState(workerSessionId);
      unregisterWorker(workerSessionId);
      void this.closeWorker(workerSessionId);
    }
  }

  // Check whether any pending review task for the given work taskId has
  // onReject.strategy === 'continue'. Used to decide whether to keep the
  // worker session alive when the work task enters awaiting_review.
  private hasContinueStrategyReview(taskId: string, board: Board): boolean {
    for (const review of board.tasks) {
      if (review.status !== "pending") continue;
      if (review.kind !== "review") continue;
      const reviews = review.reviews;
      if (!reviews) continue;
      if (typeof reviews === "string") {
        if (reviews !== taskId) continue;
      } else {
        if (!reviews.includes(taskId)) continue;
      }
      if (review.onReject?.strategy === "continue") return true;
    }
    return false;
  }

  // Find a task that is under review by looking for pending review tasks
  // whose `reviews` field references the given taskId. Returns undefined
  // if no such review task exists.
  private findReviewedTask(taskId: string, board: Board): Task | undefined {
    const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
    for (const review of board.tasks) {
      if (review.status !== "pending") continue;
      if (review.kind !== "review") continue;
      const reviews = review.reviews;
      if (!reviews) continue;
      if (typeof reviews === "string") {
        if (reviews === taskId) return review;
      } else {
        if (reviews.includes(taskId)) return review;
      }
    }
    return undefined;
  }

  // Process the outcome of a review task and update the reviewed task(s).
  // `normalized` is the parsed review result from the worker's reply; it
  // carries `review_decision` and `notes` in artifacts. We pass it in
  // explicitly so callers don't have to round-trip through task.artifacts
  // (which has the normalized shape and can't be re-parsed by normalizeReview).
  private handleReviewComplete(
    reviewTask: Task,
    board: Board,
    orchestratorSessionId: string,
    normalized: NormalizedResult | undefined,
  ): void {
    const reviews = reviewTask.reviews;
    if (!reviews) return;

    if (!normalized) {
      log.warn(
        `review ${reviewTask.id}: missing or malformed review result, treating as reject`,
      );
      this.handleReviewReject(reviewTask, board, orchestratorSessionId, "missing review result");
      return;
    }

    const decision = (normalized.artifacts as Record<string, unknown>).review_decision as string;
    const notes = (normalized.artifacts as Record<string, unknown>).notes as string ?? "";
    const isCompetition = Array.isArray(reviews) && reviews.length > 1;

    // Competition reviews only accept "winner" or "synthesize" (which we
    // treat as winner with no valid winnerId — fails all reviewees). Other
    // decisions on a competition are reviewer error.
    if (isCompetition && decision !== "winner" && decision !== "synthesize") {
      log.warn(
        `review ${reviewTask.id}: competition received non-winner decision '${decision}', treating as winner with no valid winnerId`,
      );
      this.handleReviewWinner(reviewTask, normalized, notes, board, orchestratorSessionId);
      return;
    }

    switch (decision) {
      case "approve":
        this.handleReviewApprove(reviewTask, normalized, board, orchestratorSessionId);
        break;
      case "reject":
        this.handleReviewReject(reviewTask, board, orchestratorSessionId, notes);
        break;
      case "amend":
        this.handleReviewAmend(reviewTask, normalized, notes, board, orchestratorSessionId);
        break;
      case "fix":
        this.handleReviewFix(reviewTask, normalized, notes, board, orchestratorSessionId);
        break;
      case "winner":
      case "synthesize":
        this.handleReviewWinner(reviewTask, normalized, notes, board, orchestratorSessionId);
        break;
      default:
        log.warn(
          `review ${reviewTask.id}: unrecognized decision '${decision}', treating as reject`,
        );
        this.handleReviewReject(reviewTask, board, orchestratorSessionId, `unrecognized decision: ${decision}`);
        break;
    }
  }

  // Approve: mark the reviewed task done with merged artifacts.
  private handleReviewApprove(
    reviewTask: Task,
    normalized: NormalizedResult,
    board: Board,
    orchestratorSessionId: string,
  ): void {
    const reviewedTask = this.getReviewedTask(reviewTask, board);
    if (!reviewedTask) return;

    const reviewNotes = (normalized.artifacts as Record<string, unknown>).notes as string;
    this.finishReview({
      reviewedTask,
      reviewTask,
      board,
      orchestratorSessionId,
      mergeArtifacts: (artifacts) => {
        if (reviewNotes) {
          if (!artifacts.decisions) artifacts.decisions = [];
          artifacts.decisions.push(`[review] ${reviewNotes}`);
        }
      },
      logMessage: `review ${reviewTask.id}: approved ${reviewedTask.id}`,
      eventMessage: `${reviewTask.id} approved ${reviewedTask.id}`,
      eventTag: "task-review-approved",
    });
  }

  // Reject: retask the reviewed task with reviewFeedback. On maxAttempts
  // exceed, mark the reviewed task as failed.
    private handleReviewReject(
    reviewTask: Task,
    board: Board,
    orchestratorSessionId: string,
    feedback: string,
  ): void {
    const reviewedTask = this.getReviewedTask(reviewTask, board);
    if (!reviewedTask) return;

    // Check maxAttempts (default 3).
    const maxAttempts = reviewTask.onReject?.maxAttempts ?? 3;
    const attemptCount = reviewedTask.attemptCount;

    if (attemptCount >= maxAttempts) {
      reviewedTask.reviewFeedback = reviewTask.reviewFeedback ?? [];
      if (!reviewedTask.reviewFeedback.includes(feedback)) {
        reviewedTask.reviewFeedback.push(feedback);
      }
      this.finishReview({
        reviewedTask,
        reviewTask,
        board,
        orchestratorSessionId,
        reviewedStatus: "failed",
        logMessage: `review ${reviewTask.id}: max attempts (${maxAttempts}) exceeded for ${reviewedTask.id} — marking failed`,
        eventMessage: `${reviewedTask.id} failed after ${maxAttempts} review attempts: ${feedback}`,
        eventTag: "task-review-max-attempts",
      });
      return;
    }

    // Apply onReject strategy before retasking.
    const strategy = reviewTask.onReject?.strategy;
    if (strategy === "escalate") {
      const esc = reviewTask.onReject?.escalateTo;
      if (!esc || !esc.agent || !esc.model) {
        reviewedTask.reviewFeedback = reviewTask.reviewFeedback ?? [];
        if (!reviewedTask.reviewFeedback.includes(feedback)) {
          reviewedTask.reviewFeedback.push(feedback);
        }
        const escMsg = !esc
          ? "onReject.strategy='escalate' but onReject.escalateTo is missing"
          : !esc.agent
            ? "onReject.strategy='escalate' but onReject.escalateTo.agent is missing"
            : "onReject.strategy='escalate' but onReject.escalateTo.model is missing";
        this.finishReview({
          reviewedTask,
          reviewTask,
          board,
          orchestratorSessionId,
          reviewedStatus: "failed",
          logMessage: `review ${reviewTask.id}: escalation target missing for ${reviewedTask.id} — ${escMsg}`,
          eventMessage: `${reviewedTask.id} failed: escalation target unavailable (${escMsg})`,
          eventTag: "task-review-escalation-failed",
        });
        return;
      }
      reviewedTask.agent = esc.agent;
      reviewedTask.model = esc.model;
    }

    // Continue strategy: keep the worker alive, send feedback as next
    // prompt on the same session. Reset repromptCount and clear
    // resultAccumulator so the worker starts fresh for the retry.
    if (strategy === "continue") {
      const workerId = reviewedTask.assignedTo;
      if (workerId) {
        reviewedTask.attemptCount += 1;
        const ws = getWorkerState(workerId);
        if (ws) {
          ws.repromptCount = 0;
          ws.resultAccumulator = "";
        }
        log.info(
          `review ${reviewTask.id}: continue strategy for ${reviewedTask.id}, reprompting worker …${workerId.slice(-8)}`,
        );
        void this.emitSyntheticMessage(
          orchestratorSessionId,
          `${reviewTask.id} rejected ${reviewedTask.id} — asking same worker to retry (attempt #${reviewedTask.attemptCount})`,
          { event: "task-review-rejected", taskId: reviewTask.id, reviewedTaskId: reviewedTask.id },
        );
        void (async () => {
          try {
            await this.client.request("hydra-acp/message/emit", {
              sessionId: workerId,
              method: "session/prompt",
              envelope: buildTextPromptEnvelope({
                sessionId: workerId,
                text: promptsFor(reviewedTask.kind ?? 'work').buildPrompt(reviewedTask, board),
                ancillary: true,
              }),
              route: "chain",
            });
          } catch (err) {
            log.error(
              `continue reprompt for ${reviewedTask.id} on worker ${workerId} failed: ${(err as Error).message}`,
            );
          }
        })();
      } else {
        reviewedTask.status = "pending";
        reviewedTask.assignedTo = null;
        reviewedTask.startedAt = null;
        reviewedTask.finishedAt = null;
        reviewedTask.artifacts = null;
        saveBoard(board, orchestratorSessionId);
        log.info(
          `review ${reviewTask.id}: continue strategy for ${reviewedTask.id} but no worker assigned — retasking`,
        );
      }
      return;
    }

    // Default: retask the reviewed task with reviewFeedback.
    const workerId = reviewedTask.assignedTo;
    if (reviewedTask.status === "assigned" && workerId) {
      this.endWorkerForward(workerId);
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      delete board.workers[workerId];
      void this.closeWorker(workerId);
    }
    reviewedTask.startedAt = null;
    reviewedTask.artifacts = null;
    reviewedTask.reviewFeedback = reviewTask.reviewFeedback ?? [];
    if (!reviewedTask.reviewFeedback.includes(feedback)) {
      reviewedTask.reviewFeedback.push(feedback);
    }

    this.finishReview({
      reviewedTask,
      reviewTask,
      board,
      orchestratorSessionId,
      reviewedStatus: "pending",
      logMessage: `review ${reviewTask.id}: rejected ${reviewedTask.id}, retasking (attemptCount=${reviewedTask.attemptCount + 1})`,
      eventMessage: `${reviewTask.id} rejected ${reviewedTask.id}, retasking (attempt #${reviewedTask.attemptCount + 1})`,
      eventTag: "task-review-rejected",
    });
  }

  // Amend: mark the reviewed task done with notes appended to artifacts.decisions.
  private handleReviewAmend(
    reviewTask: Task,
    normalized: NormalizedResult,
    notes: string,
    board: Board,
    orchestratorSessionId: string,
  ): void {
    const reviewedTask = this.getReviewedTask(reviewTask, board);
    if (!reviewedTask) return;

    this.finishReview({
      reviewedTask,
      reviewTask,
      board,
      orchestratorSessionId,
      mergeArtifacts: (artifacts) => {
        if (notes) {
          if (!artifacts.decisions) artifacts.decisions = [];
          artifacts.decisions.push(`[review amend] ${notes}`);
        }
      },
      logMessage: `review ${reviewTask.id}: amended ${reviewedTask.id}`,
      eventMessage: `${reviewTask.id} amended ${reviewedTask.id}`,
      eventTag: "task-review-amended",
    });
  }

  // Fix: reviewer applies corrections directly and marks the task done.
  // Gated by canApplyFixes — if false (e.g. worker-lane review), treat as reject.
  private handleReviewFix(
    reviewTask: Task,
    normalized: NormalizedResult,
    notes: string,
    board: Board,
    orchestratorSessionId: string,
  ): void {
    const reviewedTask = this.getReviewedTask(reviewTask, board);
    if (!reviewedTask) return;

    // Gate: explicit task.canApplyFixes wins. Otherwise derive from the
    // resolved review lane — orchestrator-lane reviewers can apply fixes
    // directly to the host workspace; worker-lane reviewers cannot (the
    // fix would only land in the worker's ephemeral session). Synthesized
    // reviews leave canApplyFixes unset on purpose so this derivation
    // runs against whatever lane resolveReviewLane picks at dispatch time.
    const fixAllowed =
      reviewTask.canApplyFixes !== undefined
        ? reviewTask.canApplyFixes
        : resolveReviewLane(reviewTask, board).lane === "orchestrator";
    if (!fixAllowed) {
      log.info(
        `review ${reviewTask.id}: fix not allowed for this lane (canApplyFixes=${reviewTask.canApplyFixes ?? "derived:false"}), treating as reject`,
      );
      this.handleReviewReject(reviewTask, board, orchestratorSessionId, `fix decision not permitted on this review lane (canApplyFixes=false)`);
      return;
    }

    this.finishReview({
      reviewedTask,
      reviewTask,
      board,
      orchestratorSessionId,
      mergeArtifacts: (artifacts) => {
        if (notes) {
          if (!artifacts.decisions) artifacts.decisions = [];
          artifacts.decisions.push(`[review fix] ${notes}`);
        }
      },
      logMessage: `review ${reviewTask.id}: fixed ${reviewedTask.id}`,
      eventMessage: `${reviewTask.id} fixed ${reviewedTask.id}`,
      eventTag: "task-review-fixed",
    });
  }

  // Winner: competition mode — pick the winning task and supersede the rest.
  private handleReviewWinner(
    reviewTask: Task,
    normalized: NormalizedResult,
    notes: string,
    board: Board,
    orchestratorSessionId: string,
  ): void {
    const reviews = reviewTask.reviews;
    if (!reviews) return;

    const winnerId = (normalized.artifacts as Record<string, unknown>).winner as string | undefined;

    // Single reviewee with winner decision — treat like approve.
    if (typeof reviews === "string") {
      this.handleReviewApprove(reviewTask, normalized, board, orchestratorSessionId);
      return;
    }

    // Competition mode: reviews is string[] > 1.
    const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));

    if (winnerId && byId.has(winnerId)) {
      const winnerTask = byId.get(winnerId)!;

      this.finishReview({
        reviewedTask: winnerTask,
        reviewTask,
        board,
        orchestratorSessionId,
        mergeArtifacts: (artifacts) => {
          if (notes) {
            if (!artifacts.decisions) artifacts.decisions = [];
            artifacts.decisions.push(`[review winner] ${notes}`);
          }
        },
        logMessage: `review ${reviewTask.id}: competition — declared ${winnerId} the winner`,
        eventMessage: `${reviewTask.id} competition: ${winnerId} declared winner; other reviewees superseded`,
        eventTag: "task-review-winner",
      });

      // Supersede all other reviewees.
      for (const id of reviews) {
        if (id === winnerId) continue;
        const other = byId.get(id);
        if (!other) continue;
        if (other.status === "done" || other.status === "superseded") continue;
        other.status = "superseded";
        other.finishedAt = nowIso();
        other.assignedTo = null;
        log.info(
          `review ${reviewTask.id}: competition — superseded ${id} in favor of ${winnerId}`,
        );
        void this.emitSyntheticMessage(
          orchestratorSessionId,
          `${id} superseded by ${winnerId}`,
          { event: "task-superseded", taskId: id },
        );
      }
    } else {
      // No valid winner ID — treat all reviewees as failed.
      for (const id of reviews) {
        const other = byId.get(id);
        if (!other) continue;
        if (other.status === "done" || other.status === "superseded") continue;
        other.status = "failed";
        other.finishedAt = nowIso();
        other.reviewFeedback = other.reviewFeedback ?? [];
        other.reviewFeedback.push(`competition review ${reviewTask.id}: no valid winner specified`);
        other.assignedTo = null;
        log.warn(
          `review ${reviewTask.id}: competition — no valid winner; failed ${id}`,
        );
      }

      reviewTask.status = "done";
      reviewTask.finishedAt = nowIso();
      reviewTask.assignedTo = null;

      saveBoard(board, orchestratorSessionId);
      this.emitPlanUpdate(orchestratorSessionId, board);

      const ids = reviews.join(", ");
      void this.emitSyntheticMessage(
        orchestratorSessionId,
        `${reviewTask.id} competition: no valid winner — all reviewees (${ids}) failed`,
        { event: "task-review-winner-no-valid", taskId: reviewTask.id },
      );
    }
  }

  // Resolve the task(s) that a review task is reviewing. For single
   // reviewee (reviews is a string), returns that one task. For
   // competition (reviews is string[]), returns the first pending/assigned
   // entry or the first in the list.
  private getReviewedTask(reviewTask: Task, board: Board): Task | undefined {
    const byId = new Map<string, Task>(board.tasks.map((t) => [t.id, t]));
    const reviews = reviewTask.reviews;
    if (!reviews) return undefined;

    if (typeof reviews === "string") {
      return byId.get(reviews);
    }

    // Competition mode: return the first task that is still in flight
    // or pending, otherwise the first in the list.
    for (const id of reviews) {
      const t = byId.get(id);
      if (t && (t.status === "awaiting_review" || t.status === "pending" || t.status === "assigned")) {
        return t;
      }
    }
    // Fall back to the first entry.
    const firstId = reviews[0];
    if (!firstId) return undefined;
    return byId.get(firstId);
  }

  private finishReview(opts: FinishReviewOpts): void {
    const { reviewedTask, reviewTask, board, orchestratorSessionId, mergeArtifacts, logMessage, eventMessage, eventTag, extraEventProps, reviewedStatus = "done" } = opts;

    if (mergeArtifacts) {
      const mergedArtifacts: TaskArtifacts = { ...reviewedTask.artifacts };
      mergeArtifacts(mergedArtifacts, undefined);
      reviewedTask.artifacts = mergedArtifacts;
    }

    reviewedTask.status = reviewedStatus;
    if (reviewedStatus === "done" || reviewedStatus === "failed") {
      reviewedTask.finishedAt = nowIso();
    }
    reviewedTask.assignedTo = null;

    // When we're retasking the work (reviewedStatus === "pending"),
    // the review task must re-run after the worker re-completes —
    // otherwise pickEligible won't dispatch it again and the work
    // will park in awaiting_review forever. Reset it to pending and
    // clear its run state. In all other cases (approve / amend / fix
    // / winner / failed-after-max-attempts) the review is terminal.
    if (reviewedStatus === "pending") {
      reviewTask.status = "pending";
      reviewTask.assignedTo = null;
      reviewTask.startedAt = null;
      reviewTask.finishedAt = null;
      reviewTask.artifacts = null;
    } else {
      reviewTask.status = "done";
      reviewTask.finishedAt = nowIso();
      reviewTask.assignedTo = null;
    }

    saveBoard(board, orchestratorSessionId);

    log.info(logMessage);
    this.emitPlanUpdate(orchestratorSessionId, board);
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      eventMessage,
      { event: eventTag, taskId: reviewTask.id, reviewedTaskId: reviewedTask.id, ...extraEventProps },
    );
  }

  private handleTaskFailure(
    orchestratorSessionId: string,
    workerSessionId: string,
    board: Board,
    task: Task,
    reason: string,
  ): void {
    // Suppress double-report when the task was already marked failed
    // by an outer cancellation (runProjectStop marks every in-flight
    // task `failed` and force-cancels its worker; the worker's emit
    // promise then rejects with "connection closed" which lands here).
    // Without this guard the user sees the project's cancel summary
    // followed by a redundant "Tn failed — task turn failed: -32603"
    // line for each in-flight worker. Quiet cleanup is the right
    // behavior — the cancel summary already accounts for these.
    if (
      task.status === "failed" ||
      task.status === "pending" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      log.debug(
        `task ${task.id}: ignoring late failure (${reason}) — already accounted for by stop/cancel`,
      );
      this.endWorkerForward(workerSessionId);
      clearWorkerState(workerSessionId);
      unregisterWorker(workerSessionId);
      void this.closeWorker(workerSessionId);
      return;
    }
    log.warn(`task ${task.id} failed on worker …${workerSessionId.slice(-8)}: ${reason}`);
    task.status = "failed";
    task.assignedTo = null;
    const workerEntry = board.workers[workerSessionId];
    if (workerEntry) {
      workerEntry.currentTaskId = null;
    }
    saveBoard(board, orchestratorSessionId);
    this.emitPlanUpdate(orchestratorSessionId, board);
    // Prefix the user-facing failure line with task id + short worker
    // session id so a glance at the transcript tells you which task on
    // which worker died, without having to cross-reference the plan
    // panel. (The metadata carries taskId separately, but renderers
    // don't all surface it inline.)
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `${task.id} on worker ${shortSessionId(workerSessionId)} failed: ${reason}`,
      { event: "task-failed", taskId: task.id },
    );
    this.endWorkerForward(workerSessionId, { flush: true });
    clearWorkerState(workerSessionId);
    unregisterWorker(workerSessionId);
    void this.closeWorker(workerSessionId);

    // Don't stall on failure — the next eligible task (or project
    // completion when nothing remains) is still the right thing.
    void this.scheduleEligibleTasks(orchestratorSessionId, board);
  }

  // Run a review task on the orchestrator session (Phase 4a). Sends the
  // review prompt through the decomposition channel; on reply, parses via
  // promptsFor('review') and calls handleReviewComplete. Orchestrator-lane
  // reviews don't increment inFlightCount and don't go through board.workers.
  // Single-flight constraint: only one orchestrator review in flight at a
  // time (host session is serial).
  private async runReviewOnOrchestrator(
    reviewTask: Task,
    board: Board,
    orchestratorSessionId: string,
  ): Promise<void> {
    // Lazy-initialize: if an entry point forgot to seed sessionStates
    // (e.g. an older MCP-tool path), don't silently no-op — that would
    // strand the review pending and the scheduler would spin on it
    // (continue → pickEligible returns same task → again).
    let state = getOrchestratorState(orchestratorSessionId);
    if (!state) {
      log.warn(
        `review ${reviewTask.id}: orchestrator state missing for …${orchestratorSessionId.slice(-8)}; initializing lazily`,
      );
      state = {
        projectId: board.projectId,
        decompositionAccumulator: "",
        addAccumulator: "",
        awaitingAdd: false,
        awaitingDecomposition: false,
        awaitingOrchestratorReview: false,
        orchestratorReviewTaskId: null,
        orchestratorReviewAccumulator: "",
      };
      setOrchestratorState(orchestratorSessionId, state);
    }

    // Assign the task to the "orchestrator" sentinel so the plan view
    // shows what's happening. Orchestrator-lane reviews don't count
    // against inFlightCount or concurrencyCap.
    reviewTask.status = "assigned";
    reviewTask.assignedTo = "orchestrator";
    reviewTask.startedAt = nowIso();
    saveBoard(board, orchestratorSessionId);
    this.emitPlanUpdate(orchestratorSessionId, board);

    state.awaitingOrchestratorReview = true;
    state.orchestratorReviewTaskId = reviewTask.id;
    state.orchestratorReviewAccumulator = "";

    log.info(
      `review ${reviewTask.id} on orchestrator session …${orchestratorSessionId.slice(-8)}`,
    );
    void this.emitSyntheticMessage(
      orchestratorSessionId,
      `Reviewing ${reviewTask.title}${reviewTask.why ? ` — ${reviewTask.why}` : ""}`,
      { event: "task-review-orchestrator", taskId: reviewTask.id },
    );

    // Initial prompt + up to MAX_REPROMPTS reprompt attempts if the
    // agent forgets the hydra-result block. Mirrors the worker-lane
    // behavior in handleTaskComplete (`src/bridge.ts:3630`): chatty
    // TUI agents commonly write the review in prose and forget the
    // fence — without a reprompt, every such review parse-fails and
    // auto-rejects, and the work task ends up in a bogus reject loop
    // until it hits maxAttempts. The reprompt is cheap and surgical.
    const MAX_REPROMPTS = 2;
    let attempt = 0;
    let result: NormalizedResult | undefined;
    let accumulated = "";

    while (true) {
      // Re-check board/state before each emit. A cancel landing during the
      // in-flight emit will flip board.state to stopped (and clear
      // awaitingOrchestratorReview); without this guard the loop would
      // keep firing reprompts on a dead board.
      if (
        board.state === "stopped" ||
        board.state === "failed" ||
        board.state === "done" ||
        !state.awaitingOrchestratorReview ||
        state.orchestratorReviewTaskId !== reviewTask.id
      ) {
        log.info(
          `orchestrator review ${reviewTask.id}: bailing reprompt loop (board=${board.state}, awaiting=${state.awaitingOrchestratorReview})`,
        );
        return;
      }
      try {
        const text =
          attempt === 0
            ? promptsFor("review").buildPrompt(reviewTask, board)
            : promptsFor("review").buildRepromptPrompt(reviewTask);
        await this.client.request("hydra-acp/message/emit", {
          sessionId: orchestratorSessionId,
          method: "session/prompt",
          envelope: buildTextPromptEnvelope({
            sessionId: orchestratorSessionId,
            text,
            ancillary: attempt > 0,
          }),
          route: "chain",
        });
      } catch (err) {
        state.awaitingOrchestratorReview = false;
        state.orchestratorReviewTaskId = null;
        state.orchestratorReviewAccumulator = "";
        if (this.isShutdownError(err)) {
          log.info(
            `orchestrator review ${reviewTask.id} aborted (shutdown); leaving as assigned for next-process resume`,
          );
          return;
        }
        log.error(
          `orchestrator review turn for ${reviewTask.id} failed: ${(err as Error).message}`,
        );
        reviewTask.status = "done";
        reviewTask.finishedAt = nowIso();
        reviewTask.assignedTo = null;
        const failureArtifacts: Record<string, unknown> = { summary: "reject", review_decision: "reject", notes: `orchestrator review failed: ${(err as Error).message}` };
        reviewTask.artifacts = failureArtifacts as typeof reviewTask.artifacts;
        const failureResult: NormalizedResult = { artifacts: failureArtifacts as TaskArtifacts, warnings: [] };
        this.handleReviewComplete(reviewTask, board, orchestratorSessionId, failureResult);
        void this.scheduleEligibleTasks(orchestratorSessionId, board);
        return;
      }

      accumulated = state.orchestratorReviewAccumulator;
      const raw = promptsFor("review").extractResult(accumulated);
      result = raw === undefined ? undefined : promptsFor("review").normalizeResult(raw);
      if (result) break;

      if (attempt >= MAX_REPROMPTS) {
        log.warn(
          `orchestrator review ${reviewTask.id}: missing or malformed review result after ${attempt + 1} attempt${attempt === 0 ? "" : "s"} (accumulator length=${accumulated.length})`,
        );
        break;
      }
      log.info(
        `orchestrator review ${reviewTask.id}: missing hydra-result block, reprompting (attempt ${attempt + 1}/${MAX_REPROMPTS})`,
      );
      // Clear accumulator before reprompt so the next turn's text is
      // what we parse — don't append on top of the prior prose-only reply.
      state.orchestratorReviewAccumulator = "";
      attempt += 1;
    }

    state.awaitingOrchestratorReview = false;
    state.orchestratorReviewTaskId = null;
    state.orchestratorReviewAccumulator = "";

    let effectiveResult: NormalizedResult | undefined = result;
    if (!result) {
      reviewTask.status = "done";
      reviewTask.finishedAt = nowIso();
      reviewTask.assignedTo = null;
      const parseFailureArtifacts: Record<string, unknown> = { summary: "reject", review_decision: "reject", notes: `missing or malformed review result after ${MAX_REPROMPTS + 1} attempts` };
      reviewTask.artifacts = parseFailureArtifacts as typeof reviewTask.artifacts;
      effectiveResult = { artifacts: parseFailureArtifacts as TaskArtifacts, warnings: [] };
    } else {
      this.markTaskDone(reviewTask, result.artifacts, board, orchestratorSessionId, "orchestrator");
    }

    this.handleReviewComplete(reviewTask, board, orchestratorSessionId, effectiveResult);
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
    if (note.method === "hydra-acp/commands/cancel") {
      // Daemon-driven cancel of an in-flight commands/invoke that's
      // backing one of our held slash command turns. This is the
      // first-class signal from the daemon — `prompt_queue/added`
      // and `prompt/amended` only reach attached clients, but the
      // planner is a transformer, so we never received those. Stage
      // B added this dedicated notification for extensions.
      //
      // Reason semantics:
      //   - amended    : user wants to redirect; yield the live
      //                  view so the amended prompt runs against
      //                  the agent. Project continues in
      //                  background; workers keep running.
      //   - cancelled  : ^C / Esc / /hydra planner stop; full
      //                  project cancel via runProjectStop.
      //   - abandoned  : session is closing; release with a
      //                  short note. No further worker cleanup
      //                  needed beyond what markClosed handles
      //                  daemon-side.
      const params = (note.params ?? {}) as {
        sessionId?: string;
        messageId?: string;
        reason?: string;
      };
      const sessionId = params.sessionId;
      const reason = params.reason;
      if (typeof sessionId !== "string") return;
      this.handleCommandsCancel(sessionId, reason ?? "");
      return;
    }
    if (note.method === "session/update") {
      const params = (note.params ?? {}) as { sessionId?: string };
      const sessionId = params.sessionId;
      if (typeof sessionId === "string" && getWorkerState(sessionId)) {
        this.handleWorkerSessionUpdate(sessionId, note.params);
        return;
      }
    }

    log.debug(`unhandled notification: ${note.method}`);
  }

  // Handle hydra-acp/commands/cancel — the daemon's signal that an
  // in-flight commands/invoke (a held slash-command turn) is being
  // cancelled. Reason determines what we do:
  //
  //   - amended:    user wants to redirect their chat to the agent.
  //                 Yield the live view; project keeps running.
  //   - cancelled:  user wants to stop the work. Full project
  //                 cancel — force-cancel workers, freeze board.
  //   - abandoned:  session is being torn down. Quietly release.
  //
  // Two delivery paths:
  //
  //   1. If a held turn exists (handleCreate/Execute/Status already
  //      called holdAndReply), discharge it directly — the held
  //      promise resolves, commands/invoke replies, drainQueue
  //      advances.
  //
  //   2. If no held turn yet (cancel arrived during decomposition,
  //      before holdAndReply opened the turn), mark the pending
  //      dispatch as cancelled. handleCreate / handleStart /
  //      handleStatus check the flag at major await boundaries and
  //      bail out gracefully without opening a held turn that no
  //      signal could ever resolve.
  private handleCommandsCancel(sessionId: string, reason: string): void {
    const normalizedReason: "amended" | "cancelled" | "abandoned" =
      reason === "cancelled" || reason === "abandoned"
        ? reason
        : "amended";
    // Path 2: flag any pending dispatch on this session so its
    // handler bails. Find by sessionId since we may not have a
    // messageId in the notification (or it might not match the
    // dispatch's stored value if the daemon and planner state are
    // briefly out of sync during restart).
    for (const dispatch of pendingDispatches.values()) {
      if (dispatch.sessionId === sessionId && !dispatch.cancelled) {
        dispatch.cancelled = true;
        dispatch.cancelReason = normalizedReason;
      }
    }
    // Path 1: discharge an existing held turn if there is one.
    const held = getHeldTurn(sessionId);
    if (!held) {
      log.debug(
        `commands/cancel for session …${sessionId.slice(-8)} (reason=${normalizedReason}) — no held turn yet; pending dispatch flagged`,
      );
      return;
    }
    const board = boards.get(sessionId);
    if (
      !board ||
      board.state === "done" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      return;
    }
    log.info(
      `commands/cancel on ${shortProjectId(board.projectId)} session …${sessionId.slice(-8)} reason=${normalizedReason}`,
    );
    if (normalizedReason === "cancelled") {
      void this.runProjectStop(sessionId, board, "user-cancel");
      return;
    }
    if (normalizedReason === "abandoned") {
      resolveHeldTurn(sessionId, {
        reason: "cancelled",
        text: `Session closing — ${shortProjectId(board.projectId)} state preserved on disk.`,
      });
      return;
    }
    resolveHeldTurn(sessionId, {
      reason: "yielded",
      text: `Pausing live view of ${shortProjectId(board.projectId)} for your prompt — will resume after.`,
    });
    // After the amended prompt's turn completes, inject `/hydra
    // planner continue` at the queue head so the live view resumes —
    // keeps the session's busy indicator on continuously through the
    // project's lifetime, and gives the user visible attribution of
    // WHY the live view re-appears. All held-turn verbs (create /
    // start / continue) share this behavior — there's no held-turn
    // verb where auto-re-engage would be wrong. (`status` doesn't
    // open a held turn, so it can never reach this path.)
    void this.injectContinueAtHead(sessionId);
  }

  // Helper: check whether the pending commands/invoke for this
  // messageId was cancelled. Returns the cancel reason if so, null
  // otherwise. Handlers call this at major await boundaries (after
  // decomposition, after attach, etc.) to bail out gracefully when
  // the daemon already moved on.
  private checkDispatchCancelled(
    messageId: string | undefined,
  ): "amended" | "cancelled" | "abandoned" | null {
    if (!messageId) return null;
    const dispatch = pendingDispatches.get(messageId);
    if (!dispatch || !dispatch.cancelled) return null;
    return dispatch.cancelReason || "cancelled";
  }

  private clearPendingDispatch(messageId: string | undefined): void {
    if (!messageId) return;
    pendingDispatches.delete(messageId);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  // Lazy session/attach to the orchestrator so the planner can act
  // as a peer client on this session (submit prompts via session/
  // prompt, receive prompt/amended notifications, etc.) in addition
  // to its transformer-chain role. Idempotent per session — caches
  // attached sessions in clientAttachedSessions. historyPolicy:
  // "none" because we don't need the conversation backfilled; we
  // just need the WS to be registered as a participant.
  private async ensureClientAttached(sessionId: string): Promise<void> {
    if (clientAttachedSessions.has(sessionId)) return;
    try {
      await this.client.request("session/attach", {
        sessionId,
        historyPolicy: "none",
      });
      clientAttachedSessions.add(sessionId);
      log.debug(`session/attach ok for …${sessionId.slice(-8)}`);
    } catch (err) {
      log.warn(
        `session/attach failed for …${sessionId.slice(-8)}: ${(err as Error).message}`,
      );
    }
  }

  // Submit `/hydra planner continue` as the planner, queued at the
  // head of the session's prompt queue. Used after a user amends
  // our held slash command — once the amended turn ends, the daemon
  // picks up our injected continue, which re-acquires the live
  // view. Visible to the user as a normal-looking prompt in the
  // transcript (originator.name = "hydra-acp-planner") so they can
  // see WHY the live view re-appears.
  //
  // The injection requires session/attach (lazy via
  // ensureClientAttached); without it, session/prompt would be
  // rejected as "not attached to session."
  private async injectContinueAtHead(sessionId: string): Promise<void> {
    await this.ensureClientAttached(sessionId);
    try {
      // Slash commands are dispatched by hydra at the message layer;
      // the host agent never runs an LLM turn around the text, so
      // there's no opportunity to append instructions ("don't call
      // TodoWrite", etc.) that the host would read. Anything beyond
      // the bare verb is either echoed as dead text in the transcript
      // or stripped. The host's own TodoWrite during the held turn —
      // if any — is the host being proactive when the turn opens, not
      // a response to this prompt. Suppressing it requires host-level
      // cooperation we don't have today; until then, mixed-host runs
      // may show a host-emitted plan panel alongside the planner's
      // board panel.
      await this.client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/hydra planner continue" }],
        _meta: { "hydra-acp": { queuePosition: "head" } },
      });
    } catch (err) {
      log.warn(
        `inject /hydra planner continue (head) failed for …${sessionId.slice(-8)}: ${(err as Error).message}`,
      );
    }
  }

  // Synthetic progress messages get wrapped with leading + trailing
  // newlines so successive emissions render with visible separation in
  // the transcript. Mirrors how hydra's own emitExtensionReply formats
  // slash-command replies.
  //
  // Optional `plannerEvent` rides under
  // `_meta.hydra-acp.planner.{taskId,event}` so clients can render
  // event-class messages (task-completed, task-failed, etc.) with
  // proper attribution instead of relying on ASCII prefixes in the
  // text body. The text itself stays clean.
  private async emitSyntheticMessage(
    sessionId: string,
    text: string,
    plannerEvent?: {
      event: string;
      taskId?: string;
      reviewedTaskId?: string;
      workerSessionId?: string;
    },
  ): Promise<void> {
    const meta = plannerEvent
      ? {
          "hydra-acp": {
            planner: {
              event: plannerEvent.event,
              ...(plannerEvent.taskId ? { taskId: plannerEvent.taskId } : {}),
              ...(plannerEvent.reviewedTaskId ? { reviewedTaskId: plannerEvent.reviewedTaskId } : {}),
              ...(plannerEvent.workerSessionId
                ? { workerSessionId: plannerEvent.workerSessionId }
                : {}),
            },
          },
        }
      : undefined;
    try {
      await this.client.request("hydra-acp/message/emit", {
        sessionId,
        method: "session/update",
        envelope: buildAgentMessageChunkEnvelope({
          sessionId,
          text: `\n${text}\n`,
          meta,
        }),
        route: "chain",
      });
    } catch (err) {
      log.warn(`emit synthetic message failed: ${(err as Error).message}`);
    }
  }

  // Emit a board snapshot into the orchestrator's held turn as a
  // self-updating panel. Chooses between ACP `plan` updates (default,
  // renders as a checkboxed panel in spec-compliant clients) and an
  // ASCII checklist via agent_message_chunk (fallback for clients
  // that don't render plan updates well outside of an agent's own
  // turn). The choice is governed by PLANNER_RENDER=plan|ascii.
  //
  // Best-effort: emit failures only warn — a missed plan update isn't
  // worth failing scheduling for, and the next state change will emit
  // a fresh snapshot anyway.
  private emitPlanUpdate(sessionId: string, board: Board): void {
    const mode = getPlanRenderMode();
    const envelope =
      mode === "plan"
        ? buildPlanUpdateEnvelope({ sessionId, board })
        : buildAsciiPlanEnvelope({ sessionId, board });
    void this.client
      .request("hydra-acp/message/emit", {
        sessionId,
        method: "session/update",
        envelope,
        route: "chain",
      })
      .catch((err) => {
        log.warn(`emit plan update failed: ${(err as Error).message}`);
      });
  }

  // Dispose a worker's forwarder, optionally flushing any pending
  // buffered text first. Natural-end paths (task complete / task
  // failed) flush so the user sees whatever the worker was
  // last thinking; abrupt-end paths (skip / retry / kill / cancel /
  // remove) dispose without flushing so the abandoned text doesn't
  // appear after the "task ended" line in the transcript.
  private endWorkerForward(workerId: string, opts: { flush?: boolean } = {}): void {
    const forwarder = workerForwarders.get(workerId);
    if (!forwarder) return;
    if (opts.flush) {
      forwarder.flushAll();
    } else {
      forwarder.dispose();
    }
    workerForwarders.delete(workerId);
  }

  // Build the emit callback a WorkerForwarder uses when flushing or
  // forwarding an envelope. Centralized here so the WS-write path
  // stays in one place. Fire-and-forget — the planner's per-worker
  // queue inside WorkerForwarder already preserves intra-worker
  // order; the WS connection serializes writes so envelopes hit the
  // daemon in the order they were issued from this side.
  private makeWorkerEmit(workerSessionId: string) {
    return (env: { sessionId: string; update: Record<string, unknown> }): void => {
      void this.client
        .request("hydra-acp/message/emit", {
          sessionId: env.sessionId,
          method: "session/update",
          envelope: env,
          route: "chain",
        })
        .catch((err) => {
          log.warn(
            `worker-forward emit (worker …${workerSessionId.slice(-8)}) failed: ${(err as Error).message}`,
          );
        });
    };
  }

  // ── MCP tool dispatch ──────────────────────────────────────────────

  // Dispatch incoming hydra-acp/mcp_tools/invoke to the right tool
  // handler. Returns an MCP CallToolResult ({content, isError?,
  // structuredContent?}) shape that the daemon hands back to the
  // agent. Errors always come back as isError:true rather than
  // throwing — the agent's MCP client expects to read errors from
  // the result envelope, and a thrown JSON-RPC error doesn't surface
  // cleanly to the agent's reasoning.
  private async handleMcpToolInvoke(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as {
      server?: string;
      tool?: string;
      args?: Record<string, unknown>;
      sessionId?: string;
    };
    const tool = params.tool ?? "";
    const args = (params.args ?? {}) as Record<string, unknown>;
    const sessionId = params.sessionId ?? "";
    if (!sessionId) {
      return this.replyMcpTextError(
        req.id,
        "internal: missing sessionId on mcp_tools/invoke (daemon-side bug)",
      );
    }
    log.info(`mcp tool ${tool} on session …${sessionId.slice(-8)}`);
    try {
      switch (tool) {
        case "list_agents":
          return await this.toolListAgents(req.id);
        case "set_plan":
          return await this.toolSetPlan(req.id, sessionId, args);
        case "start":
          return await this.toolExecute(req.id, sessionId);
        case "get_plan":
          return this.toolGetPlan(req.id, sessionId);
        case "get_status":
          return this.toolGetStatus(req.id, sessionId);
        case "add_task":
          return await this.toolAddTask(req.id, sessionId, args);
        case "update_task":
          return this.toolUpdateTask(req.id, sessionId, args);
        case "stop":
          return this.toolStop(req.id, sessionId);
        case "pause":
          return this.toolPause(req.id, sessionId);
        case "resume":
          return this.toolResume(req.id, sessionId);
        case "skip":
          return this.toolSkip(req.id, sessionId, args);
        case "retry":
          return this.toolRetry(req.id, sessionId, args);
        case "restart":
          return this.toolRestart(req.id, sessionId);
        case "remove":
          return this.toolRemove(req.id, sessionId);
        default:
          return this.replyMcpTextError(req.id, `unknown planner tool: ${tool}`);
      }
    } catch (err) {
      return this.replyMcpTextError(
        req.id,
        `tool ${tool} failed: ${(err as Error).message}`,
      );
    }
  }

  // Helper: send an MCP CallToolResult with text content and
  // isError:true. Used for tool-handler error cases.
  private replyMcpTextError(reqId: number | string, text: string): void {
    this.client.reply(reqId, {
      content: [{ type: "text", text }],
      isError: true,
    });
  }

  // Helper: send an MCP CallToolResult with text + structured content.
  // The agent surfaces `content` to itself for reasoning; structured
  // content is parsed (when both client and tool agree on shape).
  private replyMcpResult(
    reqId: number | string,
    text: string,
    structuredContent?: Record<string, unknown>,
  ): void {
    const payload: Record<string, unknown> = {
      content: [{ type: "text", text }],
    };
    if (structuredContent !== undefined) {
      payload.structuredContent = structuredContent;
    }
    this.client.reply(reqId, payload);
  }

  // ── Individual tool handlers ───────────────────────────────────────

  private async toolListAgents(reqId: number | string): Promise<void> {
    const choices = (await this.ensureAgentChoices()) ?? [];
    const list = choices.map((a) => ({
      id: a.id,
      description: a.description ?? "",
    }));
    const text = list.length === 0
      ? "No agents are installed. Workers will spawn with the daemon's default agent."
      : `Available agents (${list.length}):\n${list.map((a) => `  - ${a.id}${a.description ? ` — ${a.description}` : ""}`).join("\n")}`;
    this.replyMcpResult(reqId, text, { agents: list });
  }

  private async toolSetPlan(
    reqId: number | string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) {
      return this.replyMcpTextError(reqId, "set_plan: missing required `description`");
    }
    const tasksRaw = args.tasks;
    if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
      return this.replyMcpTextError(reqId, "set_plan: `tasks` must be a non-empty array");
    }
    // Reuse the fenced-JSON normalizer — same task shape, same
    // validation. The agent's tool input is already structured but
    // may still be missing fields or carry invalid deps.
    const normalized = normalizeDecomposition({
      description,
      tasks: tasksRaw,
    });
    if (!normalized || normalized.tasks.length === 0) {
      return this.replyMcpTextError(
        reqId,
        "set_plan: tasks failed validation (need at least one valid task with id, title, and deps)",
      );
    }

    // Refuse to overwrite a running/paused board — same guard as
    // /hydra planner create. ready/done/failed/stopped boards are
    // replaceable (stopped is user-halted-and-resumable, so set_plan
    // is a legitimate "I want to start over" path).
    const existing = boards.get(sessionId);
    if (
      existing &&
      (existing.state === "running" ||
        existing.state === "paused" ||
        existing.state === "decomposing")
    ) {
      return this.replyMcpTextError(
        reqId,
        `set_plan: project ${shortProjectId(existing.projectId)} is already ${existing.state}. Stop or remove it first.`,
      );
    }
    // Clean up a prior ready draft on disk before overwriting (same
    // policy as slash command create).
    let replacedReadyId: string | undefined;
    if (existing && existing.state === "ready") {
      replacedReadyId = existing.projectId;
      try {
        rmSync(projectDir(existing.projectId), { recursive: true, force: true });
      } catch (err) {
        log.warn(
          `failed to remove prior ready plan ${shortProjectId(existing.projectId)}: ${(err as Error).message}`,
        );
      }
    }

    // Parse fleet defaults + concurrencyCap + reviewPolicy from the tool args.
    const fleetDefaultsRaw = args.fleetDefaults;
    let fleetAgent: string | null = null;
    let fleetModel: string | null = null;
    let workAgent: string | undefined;
    let workModel: string | undefined;
    let reviewAgent: string | undefined;
    let reviewModel: string | undefined;
    let reviewRunOn: "orchestrator" | "worker" | undefined;
    if (fleetDefaultsRaw && typeof fleetDefaultsRaw === "object" && !Array.isArray(fleetDefaultsRaw)) {
      const fd = fleetDefaultsRaw as Record<string, unknown>;
      if (typeof fd.agent === "string") fleetAgent = fd.agent;
      if (typeof fd.model === "string") fleetModel = fd.model;
      const workRaw = fd.work;
      if (workRaw && typeof workRaw === "object" && !Array.isArray(workRaw)) {
        const w = workRaw as Record<string, unknown>;
        if (typeof w.agent === "string") workAgent = w.agent;
        if (typeof w.model === "string") workModel = w.model;
      }
      const reviewRaw = fd.review;
      if (reviewRaw && typeof reviewRaw === "object" && !Array.isArray(reviewRaw)) {
        const r = reviewRaw as Record<string, unknown>;
        if (typeof r.agent === "string") reviewAgent = r.agent;
        if (typeof r.model === "string") reviewModel = r.model;
        if (typeof r.runOn === "string" && (r.runOn === "orchestrator" || r.runOn === "worker")) {
          reviewRunOn = r.runOn as "orchestrator" | "worker";
        }
      }
    }
    const concurrencyCapRaw = args.concurrencyCap;
    const concurrencyCap =
      typeof concurrencyCapRaw === "number" && Number.isFinite(concurrencyCapRaw) && concurrencyCapRaw > 0
        ? Math.floor(concurrencyCapRaw)
        : undefined;

    // Parse reviewPolicy from tool args.
    const reviewPolicyRaw = args.reviewPolicy;
    let boardReviewPolicy: ReviewPolicy | undefined;
    if (reviewPolicyRaw && typeof reviewPolicyRaw === "object" && !Array.isArray(reviewPolicyRaw)) {
      const rp = reviewPolicyRaw as Record<string, unknown>;
      const validModes = ["off", "hints", "all", "high-only"];
      let mode: ReviewPolicy["mode"] = "hints";
      if (typeof rp.mode === "string" && validModes.includes(rp.mode)) {
        mode = rp.mode as ReviewPolicy["mode"];
      }
      const overrideHint = typeof rp.overrideHint === "boolean" ? rp.overrideHint : false;
      boardReviewPolicy = { mode, overrideHint };
      if (typeof rp.maxAttempts === "number" && Number.isFinite(rp.maxAttempts) && rp.maxAttempts > 0) {
        boardReviewPolicy.maxAttempts = Math.floor(rp.maxAttempts);
      }
    } else {
      boardReviewPolicy = undefined;
    }

    const boardFleetDefaults: import("./board.js").FleetDefaults = {
      agent: fleetAgent,
      model: fleetModel,
    };
    if (workAgent !== undefined || workModel !== undefined) {
      boardFleetDefaults.work = {};
      if (workAgent !== undefined) boardFleetDefaults.work.agent = workAgent;
      if (workModel !== undefined) boardFleetDefaults.work.model = workModel;
    }
    if (reviewAgent !== undefined || reviewModel !== undefined || reviewRunOn !== undefined) {
      boardFleetDefaults.review = {};
      if (reviewAgent !== undefined) boardFleetDefaults.review.agent = reviewAgent;
      if (reviewModel !== undefined) boardFleetDefaults.review.model = reviewModel;
      if (reviewRunOn !== undefined) boardFleetDefaults.review.runOn = reviewRunOn;
    }

    const contractBriefRaw = args.contractBrief;
    const contractBrief =
      typeof contractBriefRaw === "string" && contractBriefRaw.trim().length > 0
        ? contractBriefRaw
        : undefined;

    const board = newBoard({
      description,
      concurrencyCap,
      fleetDefaults: boardFleetDefaults,
      contractBrief,
    });
    const baselineSetPlan = getLatestOrchestratorUsage(sessionId);
    if (baselineSetPlan) board.orchestratorUsageBaseline = { ...baselineSetPlan };
    await this.seedOrchestratorIdentity(board, sessionId);
    if (boardReviewPolicy) {
      board.reviewPolicy = boardReviewPolicy;
    }
    board.pendingExecute = false; // ready, awaiting start
    boards.set(sessionId, board);
    saveBoard(board, sessionId);
    // Initialize per-session orchestrator state. Mirrors the slash-command
    // entry points (handleCreate/handleStart). Without this, downstream
    // code that reads getOrchestratorState (notably runReviewOnOrchestrator)
    // silently no-ops and the scheduler spins on the same review task.
    if (!getOrchestratorState(sessionId)) {
      setOrchestratorState(sessionId, {
        projectId: board.projectId,
        decompositionAccumulator: "",
        addAccumulator: "",
        awaitingAdd: false,
        awaitingDecomposition: false,
        awaitingOrchestratorReview: false,
        orchestratorReviewTaskId: null,
        orchestratorReviewAccumulator: "",
      });
    }
    // Make sure we're a transformer on the session so subsequent
    // emits (plan panel, hints) reach attached clients.
    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(`set_plan: transformer/attach failed: ${(err as Error).message}`);
    }
    if (replacedReadyId) {
      void this.emitSyntheticMessage(
        sessionId,
        `Replacing prior draft plan ${shortProjectId(replacedReadyId)} on this session.`,
      );
    }

    this.setPlan(sessionId, board, normalized);

    // Build a compact summary the agent can quote back to the user.
    const titles = normalized.tasks
      .map((t) => `${t.id} ${t.title}`)
      .join(" · ");
    const summary = `Saved ${normalized.tasks.length} task${normalized.tasks.length === 1 ? "" : "s"} (concurrency cap ${board.concurrencyCap}): ${titles}. Call start when ready to start.`;
    this.replyMcpResult(reqId, summary, {
      projectId: board.projectId,
      replacedReadyProjectId: replacedReadyId,
      taskCount: normalized.tasks.length,
      concurrencyCap: board.concurrencyCap,
      warnings: normalized.warnings,
    });
  }

  private async toolExecute(reqId: number | string, sessionId: string): Promise<void> {
    const board = boards.get(sessionId);
    if (!board) {
      return this.replyMcpTextError(
        reqId,
        "start: no plan on this session. Call set_plan first.",
      );
    }
    if (board.state === "running") {
      return this.replyMcpTextError(
        reqId,
        `start: project ${shortProjectId(board.projectId)} is already running.`,
      );
    }
    if (board.state === "done" || board.state === "failed") {
      return this.replyMcpTextError(
        reqId,
        `start: project ${shortProjectId(board.projectId)} is ${board.state}. Call set_plan to start a new project.`,
      );
    }
    // ready and stopped are both eligible starting points. ready =
    // fresh plan waiting for kickoff; stopped = user halted, in-flight
    // tasks already reverted to pending by runProjectStop. Both flow
    // through the same transition below.
    if (board.state !== "ready" && board.state !== "stopped" && board.state !== "paused") {
      return this.replyMcpTextError(
        reqId,
        `start: project ${shortProjectId(board.projectId)} is ${board.state}; not ready to start.`,
      );
    }
    // Transition ready/paused/stopped → running and kick off the
    // scheduler. The live view isn't anchored to this tool call (the
    // MCP invoke is request-response, not a held turn) — plan updates
    // emit as session/updates regardless, and the user can run
    // `/hydra planner continue` to open a held live view if they
    // want.
    const result = await this.resumeBoardToRunning(sessionId, board);
    if (!result) {
      return this.replyMcpTextError(reqId, `start: project ${shortProjectId(board.projectId)} could not be resumed (unexpected state).`);
    }
    // Inject /hydra planner continue at the head of the session's
    // queue so the TUI opens a held live view automatically. Without
    // this, the MCP tool call returns immediately and the TUI goes
    // idle even though workers are running. The continue command
    // picks up after the agent's current turn ends — natural timing.
    void this.injectContinueAtHead(sessionId);
    const verb = result.resumedFrom === 'ready' ? 'Kicked off' : 'Resumed';
    const remaining = board.tasks.filter((t) => t.status !== "done").length;
    this.replyMcpResult(
      reqId,
      `${verb} ${shortProjectId(board.projectId)}: ${remaining} task${remaining === 1 ? "" : "s"} remaining, ${board.concurrencyCap} concurrent. Workers spawning now. Live view will open once your current turn ends.`,
      {
        projectId: board.projectId,
        taskCount: board.tasks.length,
        concurrencyCap: board.concurrencyCap,
        state: "running",
      },
    );
  }

  private toolGetPlan(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
    if (!board) {
      return this.replyMcpResult(
        reqId,
        "No plan on this session. Use set_plan to create one.",
        { hasPlan: false },
      );
    }
    const text = `Plan for ${shortProjectId(board.projectId)} (${board.state}): ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}, concurrency cap ${board.concurrencyCap}.\n${board.tasks.map((t) => `  - ${t.id} [${t.status}] ${t.title}${t.deps.length ? ` (deps: ${t.deps.join(", ")})` : ""}`).join("\n")}`;
    this.replyMcpResult(reqId, text, {
      hasPlan: true,
      projectId: board.projectId,
      state: board.state,
      description: board.description,
      concurrencyCap: board.concurrencyCap,
      fleetDefaults: board.fleetDefaults,
      tasks: board.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        why: t.why,
        what: t.what,
        constraints: t.constraints,
        deps: t.deps,
        agent: t.agent,
        model: t.model,
        status: t.status,
        assignedTo: t.assignedTo,
        artifacts: t.artifacts,
      })),
    });
  }

  private toolGetStatus(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
    if (!board) {
      return this.replyMcpResult(reqId, "No project on this session.", {
        hasProject: false,
      });
    }
    const text = formatStatus(board, attachedSessions.has(sessionId), sessionId);
    const totals = totalUsage(board);
    const done = board.tasks.filter((t) => t.status === "done").length;
    const failed = board.tasks.filter((t) => t.status === "failed").length;
    const inFlight = inFlightCount(board);
    const pending = board.tasks.filter((t) => t.status === "pending").length;
    const reviewsPending = board.tasks.filter(
      (t) => t.kind === "review" && (t.status === "pending" || t.status === "assigned"),
    ).length;
    const awaitingReview = board.tasks.filter(
      (t) => t.status === "awaiting_review",
    ).length;
    this.replyMcpResult(reqId, text, {
      hasProject: true,
      projectId: board.projectId,
      state: board.state,
      counts: {
        total: board.tasks.length,
        done,
        failed,
        inFlight,
        pending,
        reviewsPending,
        awaitingReview,
      },
      inFlightWorkers: board.tasks
        .filter((t) => t.status === "assigned" && t.assignedTo)
        .map((t) => ({
          taskId: t.id,
          taskTitle: t.title,
          workerSessionId: t.assignedTo,
        })),
      recentlyDone: board.tasks
        .filter((t) => t.status === "done")
        .slice(-5)
        .map((t) => ({
          taskId: t.id,
          summary: t.artifacts?.summary ?? null,
        })),
      usage: {
        totalCost: totals.cost,
        currency: totals.currency ?? null,
        perWorker: Object.entries(board.workers)
          .filter(([, w]) => w.usage)
          .map(([workerSessionId, w]) => ({
            workerSessionId,
            used: w.usage?.used ?? null,
            size: w.usage?.size ?? null,
            costAmount: w.usage?.costAmount ?? null,
            costCurrency: w.usage?.costCurrency ?? null,
          })),
      },
    });
  }

  private async toolAddTask(
    reqId: number | string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) {
      return this.replyMcpTextError(reqId, "add_task: missing required `description`");
    }
    const ctx = this.requireBoardForTool(sessionId);
    if ("error" in ctx) {
      return this.replyMcpTextError(reqId, ctx.error);
    }
    // Delegate to the slash command's handler via a synthetic reqId
    // — handleAdd already does all the work (orchestrator state
    // setup, sub-prompt to agent, parse, schedule). It replies via
    // this.client.reply on the reqId we pass in. We can't reuse the
    // MCP reqId since the daemon expects a CallToolResult, not a
    // commands/invoke-style { text } reply. Easier path: signal
    // success immediately and let handleAdd's emits flow through.
    void this.handleAdd(0 /* dummy reqId */, sessionId, description).catch((err) => {
      log.warn(`add via tool failed: ${(err as Error).message}`);
    });
    this.replyMcpResult(
      reqId,
      `Asking the agent to slot in: "${description}". The new task will appear once the agent figures out where it fits.`,
      { dispatched: true },
    );
  }

  private toolStop(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId);
    if (!board) {
      return this.replyMcpTextError(reqId, "stop: no project on this session");
    }
    if (
      board.state === "done" ||
      board.state === "failed" ||
      board.state === "stopped"
    ) {
      return this.replyMcpResult(
        reqId,
        `Project ${shortProjectId(board.projectId)} is already ${board.state}.`,
      );
    }
    const inFlight = board.tasks.filter((t) => t.status === "assigned").length;
    void this.runProjectStop(sessionId, board, "slash");
    this.replyMcpResult(
      reqId,
      `Stopped ${shortProjectId(board.projectId)}${inFlight > 0 ? `; ${inFlight} in-flight task${inFlight === 1 ? "" : "s"} reverted to pending` : ""}. Call start to resume.`,
    );
  }

  private toolPause(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId);
    if (!board) return this.replyMcpTextError(reqId, "pause: no project on this session");
    if (board.state === "paused") {
      return this.replyMcpResult(reqId, `${shortProjectId(board.projectId)} is already paused.`);
    }
    if (board.state !== "running") {
      return this.replyMcpTextError(
        reqId,
        `pause: project is ${board.state}; can only pause a running project.`,
      );
    }
    setBoardState(board, "paused");
    saveBoard(board, sessionId);
    const inFlight = inFlightCount(board);
    this.replyMcpResult(
      reqId,
      `Paused ${shortProjectId(board.projectId)}.${inFlight > 0 ? ` ${inFlight} in-flight worker${inFlight === 1 ? "" : "s"} will run to completion.` : ""}`,
    );
  }

  private toolResume(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId);
    if (!board) return this.replyMcpTextError(reqId, "resume: no project on this session");
    if (board.state !== "paused") {
      return this.replyMcpTextError(
        reqId,
        `resume: project is ${board.state}, not paused.`,
      );
    }
    setBoardState(board, "running");
    saveBoard(board, sessionId);
    void this.scheduleEligibleTasks(sessionId, board);
    // Same rationale as toolExecute — re-open the live view so the
    // TUI shows busy while resumed work runs.
    void this.injectContinueAtHead(sessionId);
    this.replyMcpResult(reqId, `Resumed ${shortProjectId(board.projectId)}.`);
  }

  private toolUpdateTask(
    reqId: number | string,
    sessionId: string,
    args: Record<string, unknown>,
  ): void {
    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    if (!taskId)
      return this.replyMcpTextError(reqId, "update_task: missing required `taskId`");
    const ctx = this.requireBoardForTool(sessionId);
    if ("error" in ctx) return this.replyMcpTextError(reqId, ctx.error);
    const { board } = ctx;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task)
      return this.replyMcpTextError(
        reqId,
        `update_task: no task '${taskId}' in this project`,
      );
    if (task.status !== "pending") {
      return this.replyMcpTextError(
        reqId,
        `update_task: ${taskId} is ${task.status}; only pending tasks can be edited. Use retry to re-run an in-flight or finished task.`,
      );
    }
    // Fields that resolve at spawn time — safe to rebind on a
    // pending task because resolveAgent/resolveModel re-read them
    // every time spawnTaskOnNewWorker runs.
    const MUTABLE: readonly string[] = [
      "agent",
      "model",
      "reviewAgent",
      "reviewModel",
      "what",
      "why",
      "constraints",
    ];
    const changes: Record<string, string> = {};
    let touched = false;
    for (const key of MUTABLE) {
      const raw = args[key];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      const next = trimmed === "" ? null : trimmed;
      const taskRec = task as unknown as Record<string, unknown>;
      const current = taskRec[key];
      const currentNorm = current == null ? null : current;
      if (currentNorm === next) continue;
      taskRec[key] = next;
      changes[key] = next ?? "(cleared)";
      touched = true;
    }
    // reviewAgent/reviewModel on a work task are consumed once, at
    // review-synthesis time (review-policy.ts) — once the review task
    // exists they're dead-letter. Propagate the user's intent to the
    // live review task whenever reviewAgent/reviewModel appears in
    // args, even if the parent field's value didn't change (idempotent
    // calls still need to take effect on the review task).
    const propagated: string[] = [];
    const reviewAgentArg = typeof args.reviewAgent === "string" ? args.reviewAgent.trim() : undefined;
    const reviewModelArg = typeof args.reviewModel === "string" ? args.reviewModel.trim() : undefined;
    if (reviewAgentArg !== undefined || reviewModelArg !== undefined) {
      const review = board.tasks.find(
        (t) => t.kind === "review" && t.id === `review-${task.id}`,
      );
      if (review && review.status === "pending") {
        if (reviewAgentArg !== undefined) {
          const next = reviewAgentArg === "" ? null : reviewAgentArg;
          if ((review.agent ?? null) !== next) {
            review.agent = next;
            propagated.push(`${review.id}.agent`);
            touched = true;
          }
        }
        if (reviewModelArg !== undefined) {
          const next = reviewModelArg === "" ? null : reviewModelArg;
          if ((review.model ?? null) !== next) {
            review.model = next;
            propagated.push(`${review.id}.model`);
            touched = true;
          }
        }
      }
    }
    if (!touched) {
      return this.replyMcpResult(reqId, `update_task: no changes for ${taskId}.`);
    }
    saveBoard(board, sessionId);
    this.emitPlanUpdate(sessionId, board);
    const summary = Object.entries(changes)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const propSummary = propagated.length > 0
      ? ` (also updated ${propagated.join(", ")})`
      : "";
    void this.emitSyntheticMessage(
      sessionId,
      `updated ${taskId}: ${summary}${propSummary}`,
      { event: "task-updated", taskId },
    );
    this.replyMcpResult(
      reqId,
      `Updated ${taskId} (${Object.keys(changes).join(", ")})${propSummary}.`,
    );
  }

  private toolSkip(
    reqId: number | string,
    sessionId: string,
    args: Record<string, unknown>,
  ): void {
    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    if (!taskId) return this.replyMcpTextError(reqId, "skip: missing required `taskId`");
    const ctx = this.requireBoardForTool(sessionId);
    if ("error" in ctx) return this.replyMcpTextError(reqId, ctx.error);
    const { board } = ctx;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return this.replyMcpTextError(reqId, `skip: no task '${taskId}' in this project`);
    if (task.status === "done") {
      return this.replyMcpResult(reqId, `${taskId} is already done.`);
    }
    const workerId = task.assignedTo;
    if (task.status === "assigned" && workerId) {
      this.endWorkerForward(workerId);
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      delete board.workers[workerId];
      void this.closeWorker(workerId);
    }
    task.status = "done";
    task.finishedAt = nowIso();
    task.artifacts = { summary: "skipped by user" };
    task.assignedTo = null;
    saveBoard(board, sessionId);
    this.emitPlanUpdate(sessionId, board);
    void this.emitSyntheticMessage(
      sessionId,
      "skipped (marked done with no work)",
      { event: "task-skipped", taskId },
    );
    void this.scheduleEligibleTasks(sessionId, board);
    this.replyMcpResult(reqId, `Skipped ${taskId}.`);
  }

  private async toolRetry(
    reqId: number | string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
    const ctx = this.requireBoardForTool(sessionId);
    if ("error" in ctx) return this.replyMcpTextError(reqId, ctx.error);
    const { board } = ctx;

    let resetIds: string[];
    if (!taskId) {
      // No taskId → retry every failed task. Mirrors the slash
      // command's no-arg form for the common "stuck behind failed
      // deps" recovery flow.
      const failed = board.tasks.filter((t) => t.status === "failed");
      if (failed.length === 0) {
        return this.replyMcpTextError(
          reqId,
          "retry: no failed tasks; pass `taskId` to retry a specific task",
        );
      }
      for (const task of failed) {
        this.retryOne(board, sessionId, task);
      }
      resetIds = failed.map((t) => t.id);
    } else {
      const task = board.tasks.find((t) => t.id === taskId);
      if (!task) return this.replyMcpTextError(reqId, `retry: no task '${taskId}' in this project`);
      this.retryOne(board, sessionId, task);
      resetIds = [taskId];
    }

    saveBoard(board, sessionId);
    this.emitPlanUpdate(sessionId, board);

    // Auto-resume if stopped. MCP tool callers don't open held turns
    // (no commands/invoke reqId to hold), so just flip state +
    // reattach + schedule.
    const wasStopped = board.state === "stopped";
    if (wasStopped) {
      await this.resumeStoppedBoard(sessionId, board);
    } else {
      void this.scheduleEligibleTasks(sessionId, board);
    }

    const head = resetIds.length === 1
      ? `Reset ${resetIds[0]} to pending`
      : `Reset ${resetIds.length} failed tasks to pending: ${resetIds.join(", ")}`;
    const tail = wasStopped ? " and resumed project." : ".";
    this.replyMcpResult(reqId, `${head}${tail}`);
  }

  private async toolRestart(reqId: number | string, sessionId: string): Promise<void> {
    const ctx = this.requireBoardForTool(sessionId);
    if ("error" in ctx) return this.replyMcpTextError(reqId, ctx.error);
    const { board } = ctx;

    if (board.state === "decomposing") {
      return this.replyMcpTextError(
        reqId,
        `restart: project ${shortProjectId(board.projectId)} is decomposing — wait for it to finish`,
      );
    }

    // Close any in-flight workers.
    const closedWorkers: string[] = [];
    for (const task of board.tasks) {
      const workerId = task.assignedTo;
      if (task.status === "assigned" && workerId && workerId !== "orchestrator") {
        this.endWorkerForward(workerId);
        clearWorkerState(workerId);
        unregisterWorker(workerId);
        delete board.workers[workerId];
        void this.closeWorker(workerId);
        closedWorkers.push(workerId);
      }
    }
    const orchState = getOrchestratorState(sessionId);
    if (orchState) {
      orchState.awaitingOrchestratorReview = false;
      orchState.orchestratorReviewTaskId = null;
      orchState.orchestratorReviewAccumulator = "";
    }

    for (const task of board.tasks) {
      task.status = "pending";
      task.assignedTo = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.artifacts = null;
      task.attemptCount = 0;
      task.reviewFeedback = undefined;
    }

    setBoardState(board, "running");
    saveBoard(board, sessionId);
    log.info(
      `restart (mcp) project ${shortProjectId(board.projectId)} — reset ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}${closedWorkers.length > 0 ? `, closed ${closedWorkers.length} worker${closedWorkers.length === 1 ? "" : "s"}` : ""}`,
    );
    this.emitPlanUpdate(sessionId, board);

    try {
      await this.client.request("hydra-acp/transformer/attach", { sessionId });
      attachedSessions.add(sessionId);
    } catch (err) {
      log.warn(
        `restart (mcp): transformer/attach failed for ${board.projectId}: ${(err as Error).message}`,
      );
    }
    void this.scheduleEligibleTasks(sessionId, board);

    this.replyMcpResult(
      reqId,
      `Restarted project ${shortProjectId(board.projectId)} — ${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} reset to pending${closedWorkers.length > 0 ? `; ${closedWorkers.length} worker${closedWorkers.length === 1 ? "" : "s"} closed` : ""}.`,
    );
  }

  private toolRemove(reqId: number | string, sessionId: string): void {
    const board = boards.get(sessionId) ?? findBoardOnDisk(sessionId);
    if (!board) {
      return this.replyMcpTextError(reqId, "remove: no project on this session");
    }
    const canonical = board.projectId;
    const workerIds = Object.keys(board.workers);
    void (async () => {
      for (const workerId of workerIds) {
        try {
          await this.client.request("hydra-acp/session/delete", { sessionId: workerId });
        } catch {
          // already-gone is fine
        }
      }
    })();
    if (boards.get(sessionId)?.projectId === canonical) {
      boards.delete(sessionId);
      clearOrchestratorState(sessionId);
      resolveHeldTurn(sessionId, {
        reason: "removed",
        text: `Removed project ${shortProjectId(canonical)}.`,
      });
    }
    for (const workerId of workerIds) {
      clearWorkerState(workerId);
      unregisterWorker(workerId);
      attachedSessions.delete(workerId);
    }
    rmSync(projectDir(canonical), { recursive: true, force: true });
    this.replyMcpResult(
      reqId,
      `Removed project ${shortProjectId(canonical)}${workerIds.length > 0 ? ` (${workerIds.length} worker session${workerIds.length === 1 ? "" : "s"} closed)` : ""}.`,
    );
  }

  // Helper used by tools that need an active (non-terminal) board.
  private requireBoardForTool(
    sessionId: string,
  ): { board: Board } | { error: string } {
    const board = boards.get(sessionId);
    if (!board) {
      return {
        error:
          "no plan in this session yet. Use set_plan to create one, or /hydra planner create.",
      };
    }
    if (board.state === "done" || board.state === "failed") {
      return {
        error: `project ${shortProjectId(board.projectId)} is ${board.state}; use set_plan to start a new one.`,
      };
    }
    return { board };
  }
}
