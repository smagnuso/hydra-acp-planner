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
export function buildAgentMessageChunkEnvelope(opts: {
  sessionId: string;
  text: string;
}): UpdateEnvelope {
  return {
    sessionId: opts.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: opts.text },
    },
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
