import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentMessageChunkEnvelope,
  buildTextPromptEnvelope,
  extractPromptText,
  extractUpdateText,
  extractUsageUpdate,
} from "../src/util/text.ts";

describe("extractPromptText", () => {
  it("returns a string prompt as-is", () => {
    assert.equal(extractPromptText("hello"), "hello");
  });

  it("concatenates text-shaped content blocks in order", () => {
    assert.equal(
      extractPromptText([
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ]),
      "hello world",
    );
  });

  it("ignores non-text content blocks", () => {
    assert.equal(
      extractPromptText([
        { type: "text", text: "before " },
        { type: "image", data: "..." },
        { type: "text", text: "after" },
      ]),
      "before after",
    );
  });

  it("returns empty for non-array, non-string input", () => {
    assert.equal(extractPromptText(null), "");
    assert.equal(extractPromptText(undefined), "");
    assert.equal(extractPromptText({}), "");
  });
});

describe("buildTextPromptEnvelope", () => {
  it("returns the flat ACP params shape (no {params: ...} wrapping)", () => {
    const env = buildTextPromptEnvelope({
      sessionId: "s1",
      text: "hello",
    });
    assert.deepEqual(env, {
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    });
  });

  it("adds the ancillary _meta when requested", () => {
    const env = buildTextPromptEnvelope({
      sessionId: "s1",
      text: "x",
      ancillary: true,
    });
    assert.deepEqual(env._meta, { "hydra-acp": { ancillary: true } });
  });

  it("omits _meta when ancillary is false/unset", () => {
    const env = buildTextPromptEnvelope({ sessionId: "s1", text: "x" });
    assert.equal(env._meta, undefined);
  });
});

describe("buildAgentMessageChunkEnvelope", () => {
  it("produces a flat session/update envelope with sessionUpdate=agent_message_chunk", () => {
    const env = buildAgentMessageChunkEnvelope({
      sessionId: "s1",
      text: "progress",
    });
    assert.equal(env.sessionId, "s1");
    assert.equal(env.update.sessionUpdate, "agent_message_chunk");
    assert.equal(env.update.content?.type, "text");
    assert.equal(env.update.content?.text, "progress");
  });
});

describe("extractUpdateText", () => {
  it("returns the chunk's text body for agent_message_chunk", () => {
    const env = buildAgentMessageChunkEnvelope({ sessionId: "s1", text: "hi" });
    assert.equal(extractUpdateText(env), "hi");
  });

  it("returns empty for non-agent_message_chunk updates", () => {
    const env = {
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call", content: { type: "text", text: "x" } },
      },
    };
    assert.equal(extractUpdateText(env), "");
  });

  it("returns empty for malformed envelopes", () => {
    assert.equal(extractUpdateText(null), "");
    assert.equal(extractUpdateText({}), "");
    assert.equal(extractUpdateText({ params: {} }), "");
  });
});

describe("extractUsageUpdate", () => {
  it("reads used/size/cost from the envelope", () => {
    const u = extractUsageUpdate({
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 200000,
        cost: { amount: 12.5, currency: "USD" },
      },
    });
    assert.deepEqual(u, {
      used: 100,
      size: 200000,
      costAmount: 12.5,
      costCurrency: "USD",
    });
  });

  // Regression: cost.amount is the authoritative collapsed lifetime total on
  // every hydra wire shape (PROTOCOL.md "Cost ledger scope"). hydra has never
  // emitted _meta["hydra-acp"].cumulativeCost, and under the split ledger it
  // means "retired agent lives only" — a component, not the total. Honouring
  // it would under-report every session that had rotated its agent.
  it("ignores _meta['hydra-acp'].cumulativeCost", () => {
    const u = extractUsageUpdate({
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        cost: { amount: 12.5, currency: "USD" },
        _meta: { "hydra-acp": { cumulativeCost: 3.5 } },
      },
    });
    assert.equal(u?.costAmount, 12.5);
  });

  it("returns undefined for non-usage updates", () => {
    assert.equal(
      extractUsageUpdate({ update: { sessionUpdate: "tool_call" } }),
      undefined,
    );
  });
});
