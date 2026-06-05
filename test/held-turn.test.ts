import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearHeldTurn,
  createHeldTurn,
  getHeldTurn,
  resolveHeldTurn,
} from "../src/held-turn.ts";

describe("held turn lifecycle", () => {
  beforeEach(() => {
    clearHeldTurn("s1");
    clearHeldTurn("s2");
  });

  it("creates a held turn keyed by orchestrator session id", () => {
    const held = createHeldTurn({
      orchestratorSessionId: "s1",
      projectId: "p_abc",
      commandsInvokeReqId: 42,
    });
    assert.equal(held.orchestratorSessionId, "s1");
    assert.equal(held.projectId, "p_abc");
    assert.equal(held.commandsInvokeReqId, 42);
    assert.equal(held.resolved, false);
    assert.equal(getHeldTurn("s1"), held);
  });

  it("resolves the held turn's promise with the resolution payload", async () => {
    const held = createHeldTurn({
      orchestratorSessionId: "s1",
      projectId: "p_abc",
      commandsInvokeReqId: 1,
    });
    const ok = resolveHeldTurn("s1", { reason: "complete", text: "done" });
    assert.equal(ok, true);
    const res = await held.promise;
    assert.equal(res.reason, "complete");
    assert.equal(res.text, "done");
  });

  it("is idempotent — second resolve is a no-op, promise resolves once", async () => {
    const held = createHeldTurn({
      orchestratorSessionId: "s1",
      projectId: "p_abc",
      commandsInvokeReqId: 1,
    });
    resolveHeldTurn("s1", { reason: "complete", text: "first" });
    resolveHeldTurn("s1", { reason: "cancelled", text: "second" });
    const res = await held.promise;
    assert.equal(res.text, "first");
    assert.equal(held.resolved, true);
  });

  it("resolveHeldTurn returns false when no turn is held", () => {
    assert.equal(resolveHeldTurn("nonexistent", { reason: "complete", text: "x" }), false);
  });

  it("clearHeldTurn removes the entry without resolving the promise", () => {
    createHeldTurn({
      orchestratorSessionId: "s1",
      projectId: "p_abc",
      commandsInvokeReqId: 1,
    });
    clearHeldTurn("s1");
    assert.equal(getHeldTurn("s1"), undefined);
    // The promise is still unresolved at this point — handleCreate's
    // try/finally pattern reaches the finally only after the promise
    // settles, so clearHeldTurn typically runs after a prior resolve.
    // Just confirm the map entry is gone.
  });

  it("separate sessions get independent held turns", async () => {
    const a = createHeldTurn({
      orchestratorSessionId: "s1",
      projectId: "p1",
      commandsInvokeReqId: 1,
    });
    const b = createHeldTurn({
      orchestratorSessionId: "s2",
      projectId: "p2",
      commandsInvokeReqId: 2,
    });
    resolveHeldTurn("s2", { reason: "cancelled", text: "B cancelled" });
    const rb = await b.promise;
    assert.equal(rb.text, "B cancelled");
    assert.equal(a.resolved, false);
    resolveHeldTurn("s1", { reason: "complete", text: "A done" });
    const ra = await a.promise;
    assert.equal(ra.text, "A done");
  });
});
