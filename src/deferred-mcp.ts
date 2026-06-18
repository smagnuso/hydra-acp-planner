// Deferred MCP tool-call replies.
//
// Sibling to held-turn.ts. The `execute_plan` MCP tool needs the same
// "hold until the project terminates" behavior that slash-command held
// turns get, but driven by an `hydra-acp/mcp_tools/invoke` reqId instead
// of a `commands/invoke` reqId. The slash held-turn struct has a bunch
// of slash-specific fields (slashMessageId, slashVerb, amend detection);
// rather than overload it, we keep a parallel map keyed by the same
// orchestrator sessionId.
//
// The contract is dead simple: register a reqId+projectId on the
// session, and the bridge fires a CallToolResult reply against that
// reqId when the project reaches a terminal state (done / failed /
// stopped / cancelled / removed). Idempotent: a second resolve is a
// no-op.
//
// Plan-panel rendering is independent of this facility — emitPlanUpdate
// routes session/update envelopes by sessionId, not by turn-holder, so
// the live view renders into whichever turn is currently open on the
// session (MCP tool call or slash command).

export interface DeferredMcpReply {
  orchestratorSessionId: string;
  projectId: string;
  reqId: number | string;
  resolved: boolean;
}

const deferred = new Map<string, DeferredMcpReply>();

export function setDeferredMcpReply(
  orchestratorSessionId: string,
  reqId: number | string,
  projectId: string,
): DeferredMcpReply {
  const entry: DeferredMcpReply = {
    orchestratorSessionId,
    projectId,
    reqId,
    resolved: false,
  };
  deferred.set(orchestratorSessionId, entry);
  return entry;
}

export function getDeferredMcpReply(
  orchestratorSessionId: string,
): DeferredMcpReply | undefined {
  return deferred.get(orchestratorSessionId);
}

export function clearDeferredMcpReply(orchestratorSessionId: string): void {
  deferred.delete(orchestratorSessionId);
}

// Take ownership of the deferred reply for resolution. Returns the
// entry if there was one and it hasn't been resolved yet; marks it
// resolved and removes it from the map. Returns undefined otherwise.
// Caller is responsible for sending the actual MCP reply.
export function takeDeferredMcpReply(
  orchestratorSessionId: string,
): DeferredMcpReply | undefined {
  const entry = deferred.get(orchestratorSessionId);
  if (!entry || entry.resolved) return undefined;
  entry.resolved = true;
  deferred.delete(orchestratorSessionId);
  return entry;
}
