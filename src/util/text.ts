// Helpers for working with ACP `prompt` arrays and `session/update`
// envelopes. ACP prompts are `Array<ContentBlock>` (text / image / audio /
// resource / resource_link). Planner only cares about text content —
// everything else is opaque pass-through.
//
// The "envelope" passed through hydra-acp's transformer intercepts and
// expected by `hydra-acp/message/emit` is the **flat ACP params shape**,
// i.e. for session/prompt it's `{ sessionId, prompt: [...] }` directly,
// not wrapped in another `{ params: ... }`. That's what
// session.forwardRequest receives as its params arg, what gets handed
// to agent.connection.request(method, envelope), and what response
// intercepts see for session/update notifications.

export interface ContentBlock {
  type?: string;
  text?: string;
}

export interface PromptEnvelope {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

export interface UpdateEnvelope {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: ContentBlock;
    [key: string]: unknown;
  };
}

// Concatenate the text portion of every text-shaped content block, in
// order. Returns "" if the prompt has no text — e.g. an image-only prompt
// that planner shouldn't try to interpret as a command.
export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (!Array.isArray(prompt)) {
    return "";
  }
  let out = "";
  for (const part of prompt) {
    if (part && typeof part === "object" && typeof (part as ContentBlock).text === "string") {
      out += (part as ContentBlock).text;
    }
  }
  return out;
}

// Build a session/prompt envelope around a single text body. Optional
// `ancillary: true` keeps the resulting session non-interactive on first
// prompt (matches hydra-acp's session promotion rules).
export function buildTextPromptEnvelope(opts: {
  sessionId: string;
  text: string;
  ancillary?: boolean;
}): PromptEnvelope {
  const env: PromptEnvelope = {
    sessionId: opts.sessionId,
    prompt: [{ type: "text", text: opts.text }],
  };
  if (opts.ancillary) {
    env._meta = { "hydra-acp": { ancillary: true } };
  }
  return env;
}

// Build a session/update envelope carrying a synthesized
// agent_message_chunk. The transformer uses this to surface progress
// and plan summaries to attached clients without involving the agent
// process — the agent's own conversation memory is unaffected because
// session/update flows outward only.
//
// Optional `meta` rides under the update's `_meta` field per the ACP
// extensibility convention. Used by the planner to stamp
// `hydra-acp.planner.{taskId,event}` on event-class synthetic messages
// (task-completed, task-failed, …) so clients can render attribution
// from metadata rather than from ASCII prefixes in the text.
export function buildAgentMessageChunkEnvelope(opts: {
  sessionId: string;
  text: string;
  meta?: Record<string, unknown>;
}): UpdateEnvelope {
  const update: UpdateEnvelope["update"] = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: opts.text },
  };
  if (opts.meta) {
    update._meta = opts.meta;
  }
  return {
    sessionId: opts.sessionId,
    update,
  };
}

// Read the sessionUpdate kind from a session/update envelope. Returns
// undefined for malformed envelopes. Useful for branching on update
// type (agent_message_chunk, turn_complete, tool_call, etc).
export function updateKind(envelope: unknown): string | undefined {
  const env = envelope as { update?: { sessionUpdate?: string } } | undefined;
  const kind = env?.update?.sessionUpdate;
  return typeof kind === "string" ? kind : undefined;
}

// Extract the fields planner cares about from a usage_update envelope.
// Returns undefined for non-usage updates. Individual fields are
// optional — agents emit varying subsets, callers should merge onto
// prior state. Cost rides in update.cost.amount as a collapsed lifetime
// total.
export function extractUsageUpdate(envelope: unknown): {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
} | undefined {
  const env = envelope as { update?: Record<string, unknown> } | undefined;
  const update = env?.update;
  if (!update || update.sessionUpdate !== "usage_update") {
    return undefined;
  }
  const out: { used?: number; size?: number; costAmount?: number; costCurrency?: string } = {};
  if (typeof update.used === "number") out.used = update.used;
  if (typeof update.size === "number") out.size = update.size;
  const cost = update.cost as { amount?: unknown; currency?: unknown } | undefined;
  if (cost && typeof cost === "object") {
    if (typeof cost.amount === "number") out.costAmount = cost.amount;
    if (typeof cost.currency === "string") out.costCurrency = cost.currency;
  }
  // Deliberately does NOT consult _meta["hydra-acp"].cumulativeCost. hydra has
  // never emitted that field (verified across all daemon revisions), and under
  // hydra's split ledger it means "spend on retired agent lives" — a COMPONENT
  // of lifetime cost, not the total. Per PROTOCOL.md "Cost ledger scope" every
  // wire shape collapses the split into cost.amount, so cost.amount is
  // authoritative. Honouring cumulativeCost here would under-report any
  // session that had rotated its agent.
  return out;
}

// Extract the agentId from a session_info_update envelope (hydra
// stamps it under update._meta["hydra-acp"].agentId). Returns
// undefined for other update kinds or when the field is absent.
export function extractAgentIdUpdate(envelope: unknown): string | undefined {
  const env = envelope as { update?: Record<string, unknown> } | undefined;
  const update = env?.update;
  if (!update || update.sessionUpdate !== "session_info_update") return undefined;
  const meta = update._meta as Record<string, unknown> | undefined;
  const ns = meta?.["hydra-acp"] as Record<string, unknown> | undefined;
  const id = ns?.agentId;
  return typeof id === "string" ? id : undefined;
}

// Extract currentModel from a current_model_update envelope.
export function extractCurrentModelUpdate(envelope: unknown): string | undefined {
  const env = envelope as { update?: Record<string, unknown> } | undefined;
  const update = env?.update;
  if (!update || update.sessionUpdate !== "_hydra_current_model_update") return undefined;
  const m = update.currentModel;
  return typeof m === "string" ? m : undefined;
}

// Pull the text content out of an inbound session/update envelope —
// used to accumulate the agent's reply chunks during decomposition.
// Returns "" for non-text updates (tool calls, plans, mode changes).
export function extractUpdateText(envelope: unknown): string {
  const env = envelope as { update?: { sessionUpdate?: string; content?: ContentBlock } } | undefined;
  const update = env?.update;
  if (!update) {
    return "";
  }
  if (update.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  const content = update.content;
  if (content && typeof content.text === "string") {
    return content.text;
  }
  return "";
}
