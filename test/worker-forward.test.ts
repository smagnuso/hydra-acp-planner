import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  WorkerForwarder,
  buildFlushedTextEnvelope,
  buildForwardedToolEnvelope,
  type ForwardedEnvelope,
} from "../src/worker-forward.ts";

function workerMetaOf(env: ForwardedEnvelope): {
  sourceSessionId: string;
  sourceToolCallId?: string;
  taskId: string;
  sourceKind: string;
} {
  const meta = env.update._meta as {
    "hydra-acp"?: {
      sourceSessionId?: string;
      sourceToolCallId?: string;
      planner?: { taskId?: string; sourceKind?: string };
    };
  };
  const sourceSessionId = meta?.["hydra-acp"]?.sourceSessionId;
  const sourceToolCallId = meta?.["hydra-acp"]?.sourceToolCallId;
  const taskId = meta?.["hydra-acp"]?.planner?.taskId;
  const sourceKind = meta?.["hydra-acp"]?.planner?.sourceKind;
  if (!sourceSessionId || !taskId || !sourceKind) {
    throw new Error("missing hydra-acp worker meta");
  }
  return { sourceSessionId, sourceToolCallId, taskId, sourceKind };
}

describe("buildForwardedToolEnvelope", () => {
  it("returns undefined for a non-tool kind", () => {
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T1",
      workerSessionId: "w1",
      kind: "agent_message_chunk",
      envelope: { update: { sessionUpdate: "agent_message_chunk" } },
    });
    assert.equal(out, undefined);
  });

  it("rewrites sessionId to the orchestrator and preserves kind", () => {
    for (const kind of ["tool_call", "tool_call_update"]) {
      const out = buildForwardedToolEnvelope({
        orchestratorSessionId: "orch",
        taskId: "T1",
        workerSessionId: "w1",
        kind,
        envelope: { sessionId: "w", update: { sessionUpdate: kind } },
      });
      assert.equal(out!.sessionId, "orch");
      assert.equal(out!.update.sessionUpdate, kind);
    }
  });

  it("namespaces toolCallId with the task id (idempotent)", () => {
    const a = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T2",
      workerSessionId: "w1",
      kind: "tool_call",
      envelope: {
        sessionId: "w",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_001",
          title: "Read file",
        },
      },
    });
    assert.equal(a!.update.toolCallId, "T2:call_001");

    const b = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T2",
      workerSessionId: "w1",
      kind: "tool_call_update",
      envelope: {
        sessionId: "w",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "T2:call_001",
        },
      },
    });
    assert.equal(b!.update.toolCallId, "T2:call_001");
  });

  it("does not modify tool titles (attribution lives in _meta now)", () => {
    // Previously we prefixed descriptive titles with [Tn], but that
    // produced asymmetric output (kind-name titles like "bash" stayed
    // unprefixed). With _meta.hydra-acp.planner.taskId carrying the
    // attribution cleanly, the ASCII prefix is redundant.
    for (const title of [
      "List files",          // multi-word descriptive
      "bash",                // single-word kind
      "Read file foo.py",    // multi-word with path
      "fetch_url.py",        // filename
    ]) {
      const out = buildForwardedToolEnvelope({
        orchestratorSessionId: "orch",
        taskId: "T2",
        workerSessionId: "w1",
        kind: "tool_call",
        envelope: {
          sessionId: "w",
          update: { sessionUpdate: "tool_call", toolCallId: "c", title },
        },
      });
      assert.equal(out!.update.title, title);
    }
  });

  it("namespacing keeps call+update pairs coherent across concurrent workers", () => {
    const a = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T3",
      workerSessionId: "w_a",
      kind: "tool_call",
      envelope: {
        sessionId: "w_a",
        update: { sessionUpdate: "tool_call", toolCallId: "call_001" },
      },
    });
    const b = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T4",
      workerSessionId: "w_b",
      kind: "tool_call",
      envelope: {
        sessionId: "w_b",
        update: { sessionUpdate: "tool_call", toolCallId: "call_001" },
      },
    });
    assert.notEqual(a!.update.toolCallId, b!.update.toolCallId);
  });

  it("stamps the original (un-namespaced) toolCallId into _meta.hydra-acp.sourceToolCallId", () => {
    // Allows clients to lazy-fetch the freshest tool state from the
    // source session by (sourceSessionId, sourceToolCallId) without
    // having to parse our `<taskId>:` namespacing convention.
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T2",
      workerSessionId: "w7",
      kind: "tool_call",
      envelope: {
        sessionId: "w7",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_001",
          title: "Read file",
        },
      },
    });
    const meta = out!.update._meta as { "hydra-acp": { sourceToolCallId: string } };
    assert.equal(meta["hydra-acp"].sourceToolCallId, "call_001");
    // The rewritten toolCallId on the wire is still namespaced for
    // collision-safety; sourceToolCallId carries the original.
    assert.equal(out!.update.toolCallId, "T2:call_001");
  });

  it("sourceToolCallId is robust against already-namespaced inputs (idempotent path)", () => {
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T2",
      workerSessionId: "w7",
      kind: "tool_call_update",
      envelope: {
        sessionId: "w7",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "T2:call_001",
        },
      },
    });
    const meta = out!.update._meta as { "hydra-acp": { sourceToolCallId: string } };
    // After stripping the `T2:` prefix the un-namespaced id is "call_001".
    assert.equal(meta["hydra-acp"].sourceToolCallId, "call_001");
  });

  it("stamps hydra-acp.planner metadata into _meta", () => {
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T7",
      workerSessionId: "hydra_session_w7",
      kind: "tool_call",
      envelope: {
        sessionId: "w",
        update: { sessionUpdate: "tool_call", toolCallId: "c" },
      },
    });
    const w = workerMetaOf(out!);
    assert.equal(w.taskId, "T7");
    assert.equal(w.sourceSessionId, "hydra_session_w7");
    assert.equal(w.sourceKind, "tool_call");
  });

  it("merges with existing _meta on the source envelope", () => {
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T7",
      workerSessionId: "w7",
      kind: "tool_call",
      envelope: {
        sessionId: "w",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c",
          _meta: { "some-other-vendor": { customField: 42 } },
        },
      },
    });
    const meta = out!.update._meta as Record<string, unknown>;
    assert.deepEqual(
      (meta["some-other-vendor"] as Record<string, unknown>),
      { customField: 42 },
    );
    assert.ok(meta["hydra-acp"]);
  });
});

describe("buildFlushedTextEnvelope", () => {
  it("forwards text content without a per-emission prefix", () => {
    const env = buildFlushedTextEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T1",
      workerSessionId: "w1",
      kind: "agent_thought_chunk",
      sourceKind: "agent_thought_chunk",
      text: "I'm building a module.",
    });
    assert.equal(env.sessionId, "orch");
    assert.equal(env.update.sessionUpdate, "agent_thought_chunk");
    assert.equal(
      (env.update.content as { text: string }).text,
      "I'm building a module.",
    );
  });

  it("stamps _meta with the original sourceKind so translations are recoverable", () => {
    const env = buildFlushedTextEnvelope({
      orchestratorSessionId: "orch",
      taskId: "T1",
      workerSessionId: "w1",
      kind: "agent_thought_chunk",
      sourceKind: "agent_message_chunk", // translated
      text: "x",
    });
    assert.equal(workerMetaOf(env).sourceKind, "agent_message_chunk");
  });
});

describe("WorkerForwarder", () => {
  let emitted: ForwardedEnvelope[];
  let fwd: WorkerForwarder;

  beforeEach(() => {
    emitted = [];
    fwd = new WorkerForwarder({
      orchestratorSessionId: "orch",
      workerSessionId: "w1",
      taskId: "T1",
      emit: (env) => emitted.push(env),
      flushDelayMs: 30,
      maxHoldMs: 200,
    });
  });

  afterEach(() => {
    fwd.dispose();
  });

  it("buffers streaming chunks and flushes one cohesive thought after debounce", async () => {
    fwd.ingestText("I'm ", "agent_thought_chunk");
    fwd.ingestText("building ", "agent_thought_chunk");
    fwd.ingestText("a module.", "agent_thought_chunk");
    assert.equal(emitted.length, 0, "no emit before debounce expires");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.update.sessionUpdate, "agent_thought_chunk");
    assert.equal(
      (emitted[0]!.update.content as { text: string }).text,
      "I'm building a module.",
    );
  });

  it("does not inject a per-emission prefix (TUI would weld them mid-message)", async () => {
    fwd.ingestText("I'm ", "agent_thought_chunk");
    fwd.ingestText("running ", "agent_thought_chunk");
    fwd.ingestText("tests.", "agent_thought_chunk");
    await new Promise((r) => setTimeout(r, 60));
    const text = (emitted[0]!.update.content as { text: string }).text;
    assert.ok(!text.includes("[T1]"));
    assert.equal(text, "I'm running tests.");
  });

  it("preserves the first chunk's sourceKind in _meta across the burst", async () => {
    fwd.ingestText("first ", "agent_message_chunk");
    fwd.ingestText("second", "agent_thought_chunk"); // ignored — first wins
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(workerMetaOf(emitted[0]!).sourceKind, "agent_message_chunk");
  });

  it("forwards every text emit as agent_thought_chunk regardless of source kind", async () => {
    fwd.ingestText("some text", "agent_message_chunk");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.update.sessionUpdate, "agent_thought_chunk");
  });

  it("flushes pending text BEFORE a tool_call so order is preserved", () => {
    fwd.ingestText("about to call a tool", "agent_thought_chunk");
    fwd.ingestToolUpdate("tool_call", {
      update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "X" },
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.update.sessionUpdate, "agent_thought_chunk");
    assert.equal(emitted[1]!.update.sessionUpdate, "tool_call");
  });

  it("flushAll emits any pending buffer immediately", () => {
    fwd.ingestText("pending", "agent_thought_chunk");
    fwd.flushAll();
    assert.equal(emitted.length, 1);
    assert.equal(
      (emitted[0]!.update.content as { text: string }).text,
      "pending",
    );
  });

  it("dispose drops pending buffer without emitting", async () => {
    fwd.ingestText("abandoned", "agent_thought_chunk");
    fwd.dispose();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(emitted.length, 0);
  });

  it("subsequent stream after a flush emits independently", async () => {
    fwd.ingestText("first", "agent_thought_chunk");
    await new Promise((r) => setTimeout(r, 60));
    fwd.ingestText("second", "agent_thought_chunk");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(emitted.length, 2);
    assert.equal((emitted[0]!.update.content as { text: string }).text, "first");
    assert.equal((emitted[1]!.update.content as { text: string }).text, "second");
  });

  it("forwards tool_call_update with namespaced ids matching tool_call", () => {
    fwd.ingestToolUpdate("tool_call", {
      update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Run" },
    });
    fwd.ingestToolUpdate("tool_call_update", {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
      },
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.update.toolCallId, "T1:c1");
    assert.equal(emitted[1]!.update.toolCallId, "T1:c1");
  });

  it("text emits carry hydra-acp.planner.worker _meta with the right taskId and worker session id", async () => {
    fwd.ingestText("hello", "agent_thought_chunk");
    await new Promise((r) => setTimeout(r, 60));
    const w = workerMetaOf(emitted[0]!);
    assert.equal(w.taskId, "T1");
    assert.equal(w.sourceSessionId, "w1");
  });

  it("tool emits carry hydra-acp.planner.worker _meta", () => {
    fwd.ingestToolUpdate("tool_call", {
      update: { sessionUpdate: "tool_call", toolCallId: "c", title: "X" },
    });
    const w = workerMetaOf(emitted[0]!);
    assert.equal(w.taskId, "T1");
    assert.equal(w.sourceSessionId, "w1");
    assert.equal(w.sourceKind, "tool_call");
  });

  it("max-hold flushes a continuously-streaming buffer even with no idle gap", async () => {
    const localEmitted: ForwardedEnvelope[] = [];
    const local = new WorkerForwarder({
      orchestratorSessionId: "orch",
      workerSessionId: "w1",
      taskId: "T1",
      emit: (env) => localEmitted.push(env),
      flushDelayMs: 500,
      maxHoldMs: 50,
    });
    try {
      for (let i = 0; i < 15; i++) {
        local.ingestText("x", "agent_thought_chunk");
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(localEmitted.length >= 1);
    } finally {
      local.dispose();
    }
  });

  it("max-hold rearms for a new stream after flush", async () => {
    const localEmitted: ForwardedEnvelope[] = [];
    const local = new WorkerForwarder({
      orchestratorSessionId: "orch",
      workerSessionId: "w1",
      taskId: "T1",
      emit: (env) => localEmitted.push(env),
      flushDelayMs: 30,
      maxHoldMs: 500,
    });
    try {
      local.ingestText("first", "agent_thought_chunk");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(localEmitted.length, 1);
      local.ingestText("second", "agent_thought_chunk");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(localEmitted.length, 2);
    } finally {
      local.dispose();
    }
  });
});
