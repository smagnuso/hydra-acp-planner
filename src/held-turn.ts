// Held-turn lifecycle for the orchestrator session.
//
// The planner's create/execute slash commands hold their `commands/invoke`
// reply open for the entire project lifetime, not just the decomposition
// turn. That keeps the user's slash-command turn in flight in hydra's
// queue, which:
//
//   1. enables ACP plan updates emitted via message/emit to render inside
//      that turn's UI region (ticking checkboxes in place rather than a
//      growing log of progress lines), and
//   2. makes Enter default to "amend" (per hydra's tui.defaultEnterAction),
//      letting the user redirect mid-project without ending the plan, and
//   3. makes ^C / session/cancel route through our request:session/cancel
//      intercept which we use to force-cancel workers, freeze the board,
//      and finally close the held turn with a cancelled summary.
//
// State here is purely transient: a map of orchestratorSessionId -> the
// pending commands/invoke reqId, the project it owns, and a promise the
// command handler awaits before responding. Cleared when the held turn
// resolves (success / cancel / remove).
//
// Rehydrated projects (daemon-restart resume) do NOT have a held turn —
// there's no commands/invoke to hold. They run in degraded mode (plan
// updates emit but don't group under any user turn) until next user
// interaction, where any subsequent /hydra planner command opens its own
// short-lived held turn for that op.

export type HeldTurnReason =
  | "complete"
  | "cancelled"
  | "removed"
  | "failed"
  // The held turn was released because the user submitted a non-slash
  // prompt while it was active — we step aside so they can chat with
  // the host agent. The project itself keeps running; workers continue
  // and plan updates still emit. The user can re-acquire the live
  // view via `/hydra planner status` (which opens a fresh held turn
  // when the project is still running).
  | "yielded";

export interface HeldTurnResolution {
  reason: HeldTurnReason;
  text: string;
}

export interface HeldTurn {
  orchestratorSessionId: string;
  projectId: string;
  // The commands/invoke reqId that handleCreate / handleExecute is
  // holding. We reply to it when the project terminates.
  commandsInvokeReqId: number | string;
  // The slash command's user-prompt queue entry messageId — passed
  // through commands/invoke params by the daemon (Stage A). Used to
  // recognize amend events targeting THIS slash command (the queue
  // notification's _meta.hydra-acp.amending matches this). Undefined
  // if the daemon predates Stage A (commands/invoke without
  // messageId); in that case amend-distinction degrades gracefully
  // to "yield on any queue-added," matching the pre-Stage-A
  // behavior.
  slashMessageId?: string;
  // Promise the handler awaits before replying.
  promise: Promise<HeldTurnResolution>;
  // Resolver. Idempotent: extra calls after the first are no-ops.
  resolve: (r: HeldTurnResolution) => void;
  // True once resolve() has been called. Guards against double-resolve.
  resolved: boolean;
}

const heldTurns = new Map<string, HeldTurn>();

export function createHeldTurn(opts: {
  orchestratorSessionId: string;
  projectId: string;
  commandsInvokeReqId: number | string;
  slashMessageId?: string;
}): HeldTurn {
  let resolveFn: (r: HeldTurnResolution) => void = () => undefined;
  const promise = new Promise<HeldTurnResolution>((resolve) => {
    resolveFn = resolve;
  });
  const held: HeldTurn = {
    orchestratorSessionId: opts.orchestratorSessionId,
    projectId: opts.projectId,
    commandsInvokeReqId: opts.commandsInvokeReqId,
    slashMessageId: opts.slashMessageId,
    promise,
    resolved: false,
    resolve: (r) => {
      if (held.resolved) return;
      held.resolved = true;
      resolveFn(r);
    },
  };
  heldTurns.set(opts.orchestratorSessionId, held);
  return held;
}

export function getHeldTurn(orchestratorSessionId: string): HeldTurn | undefined {
  return heldTurns.get(orchestratorSessionId);
}

export function clearHeldTurn(orchestratorSessionId: string): void {
  heldTurns.delete(orchestratorSessionId);
}

// Resolve a held turn if one exists for the given session. Returns
// true if a turn was resolved, false if none was held. Idempotent —
// double-resolve is a no-op (resolve() guards internally).
export function resolveHeldTurn(
  orchestratorSessionId: string,
  resolution: HeldTurnResolution,
): boolean {
  const held = heldTurns.get(orchestratorSessionId);
  if (!held) return false;
  held.resolve(resolution);
  return true;
}
