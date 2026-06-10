import type { Board } from "./board.js";

// In-memory per-session state. The orchestrator role is implied by
// presence in `boards`. Decomposition state machines (idle → decomposing
// → running → done) are carried on the Board itself; OrchestratorState
// here holds the *transient* bits that don't belong on disk: which
// decomposition reply text we've accumulated so far, etc.

export interface OrchestratorState {
  projectId: string;
  // Accumulator for the agent's reply during a decomposing turn. Built
  // up as agent_message_chunk notifications stream past. Drained and
  // parsed when the turn completes.
  decompositionAccumulator: string;
  // True between (commands/invoke for `create`) and the moment the
  // injected decomposition sub-prompt's turn completes. While true,
  // agent_message_chunk updates are suppressed from clients and
  // accumulated instead.
  awaitingDecomposition: boolean;
  // Accumulator + flag for `/hydra planner add <description>` sub-prompts.
  // Same shape as decomposition — when the user explicitly asks to slot a
  // new task into the DAG, the planner sends a sub-prompt asking the
  // orchestrator agent for a hydra-add-task block. We accumulate the
  // reply, parse it, then merge into the board.
  addAccumulator: string;
  awaitingAdd: boolean;
  // Orchestrator-lane review state (Phase 4a). While true, agent_message_chunk
  // updates are suppressed from clients and accumulated for review parsing.
  awaitingOrchestratorReview: boolean;
  orchestratorReviewTaskId: string | null;
  orchestratorReviewAccumulator: string;
}

const sessionStates = new Map<string, OrchestratorState>();

// Mirror map for workers → their orchestrator. Populated when workers
// are spawned by the planner; consulted by the response intercept to
// route incoming chunks to the right per-worker accumulator.
const workerToOrchestrator = new Map<string, string>();

// Per-worker in-memory state. A worker exists between
// `assignNextTask(...)` and `handleTaskComplete(...)`. We accumulate the
// agent's reply chunks here and parse the structured hydra-result block
// once the message/emit promise resolves (end of turn).
export interface WorkerState {
  orchestratorSessionId: string;
  taskId: string;
  // Reply text accumulated from agent_message_chunk intercepts. Drained
  // when handleTaskComplete fires.
  resultAccumulator: string;
  // Number of times we've already reprompted this worker for a missing
  // hydra-result block within the current attempt. Reset to 0 on fresh
  // task spawn or task resume (after restart); incremented each time
  // handleTaskComplete fires without a parseable block. Cap of 1
  // reprompt before we hand off to handleTaskFailure.
  repromptCount: number;
  // Tool call ids the worker has emitted that we recognized as
  // TodoWrite-shaped (input contained a `todos` array). The initial
  // `tool_call` envelope is suppressed and routed to the orchestrator
  // board's subtodo merge path; subsequent `tool_call_update` envelopes
  // sharing one of these ids must also be suppressed so the user
  // doesn't see a stray progress panel attributed to a hidden call.
  todoToolCallIds?: Set<string>;
}

const workerStates = new Map<string, WorkerState>();

export function getWorkerState(workerSessionId: string): WorkerState | undefined {
  return workerStates.get(workerSessionId);
}

export function setWorkerState(workerSessionId: string, state: WorkerState): void {
  workerStates.set(workerSessionId, state);
}

export function clearWorkerState(workerSessionId: string): void {
  workerStates.delete(workerSessionId);
}

export function getOrchestratorState(sessionId: string): OrchestratorState | undefined {
  return sessionStates.get(sessionId);
}

export function setOrchestratorState(sessionId: string, state: OrchestratorState): void {
  sessionStates.set(sessionId, state);
}

export function clearOrchestratorState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

export function isOrchestrator(sessionId: string): boolean {
  return sessionStates.has(sessionId);
}

export function orchestratorOfWorker(workerSessionId: string): string | undefined {
  return workerToOrchestrator.get(workerSessionId);
}

export function registerWorker(workerSessionId: string, orchestratorSessionId: string): void {
  workerToOrchestrator.set(workerSessionId, orchestratorSessionId);
}

export function unregisterWorker(workerSessionId: string): void {
  workerToOrchestrator.delete(workerSessionId);
}

// Hydrate from disk on startup. The planner is restartable mid-project,
// so on (re)connect we walk every project's board, repopulate the
// orchestrator map, and reconstruct the worker map from each board's
// workers field.
export function rehydrate(orchestratorSessionByProject: Map<string, string>, boards: Map<string, Board>): void {
  sessionStates.clear();
  workerToOrchestrator.clear();
  for (const [projectId, board] of boards) {
    const orchestratorSessionId = orchestratorSessionByProject.get(projectId);
    if (!orchestratorSessionId) continue;
    sessionStates.set(orchestratorSessionId, {
      projectId,
      decompositionAccumulator: "",
      awaitingDecomposition: board.state === "decomposing",
      addAccumulator: "",
      awaitingAdd: false,
      awaitingOrchestratorReview: false,
      orchestratorReviewTaskId: null,
      orchestratorReviewAccumulator: "",
    });
    for (const workerId of Object.keys(board.workers)) {
      workerToOrchestrator.set(workerId, orchestratorSessionId);
    }
  }
}
