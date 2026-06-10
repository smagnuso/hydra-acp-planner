import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgent, resolveModel, resolveRunOn, type FleetDefaults, type Task } from "../src/board.ts";

function makeTask(opts: Partial<Task> & { id?: string; kind?: "work" | "review" }): Task {
  return {
    id: opts.id ?? "T1",
    title: "test task",
    deps: [],
    status: "pending",
    attemptCount: 0,
    agent: opts.agent ?? undefined,
    model: opts.model ?? undefined,
    runOn: opts.runOn ?? undefined,
    kind: opts.kind,
  };
}

// Helper to build a board-shaped arg with fleetDefaults sub-buckets.
// resolveAgent/resolveModel now take a board (for orchestratorAgent
// fallback); callers in this file pass the result of `fd(...)` directly.
function fd(opts: Partial<FleetDefaults> & {
  work?: Record<string, string | undefined>;
  review?: Record<string, string | "orchestrator" | "worker" | undefined>;
  orchestratorAgent?: string | null;
  orchestratorModel?: string | null;
}): { fleetDefaults: FleetDefaults; orchestratorAgent?: string | null; orchestratorModel?: string | null } {
  const fleetDefaults: FleetDefaults = {
    agent: opts.agent ?? null,
    model: opts.model ?? null,
    work: Object.keys(opts.work ?? {}).length > 0 ? opts.work as FleetDefaults["work"] : undefined,
    review: Object.keys(opts.review ?? {}).length > 0 ? opts.review as FleetDefaults["review"] : undefined,
  };
  return {
    fleetDefaults,
    orchestratorAgent: opts.orchestratorAgent ?? null,
    orchestratorModel: opts.orchestratorModel ?? null,
  };
}

describe("resolveAgent", () => {
  describe("8 combinations of (task.agent) x (fleetDefaults[kind]) x (fleetDefaults.flat)", () => {
    it("task.agent=yes, kind agent=yes, flat=yes → task.agent wins", () => {
      const task = makeTask({ id: "T1", agent: "override-agent" });
      const fleet = fd({ work: { agent: "kind-agent" }, agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "override-agent");
    });

    it("task.agent=yes, kind agent=yes, flat=no → task.agent wins", () => {
      const task = makeTask({ id: "T2", agent: "override-agent" });
      const fleet = fd({ work: { agent: "kind-agent" } });
      assert.equal(resolveAgent(task, fleet), "override-agent");
    });

    it("task.agent=yes, kind agent=no, flat=yes → task.agent wins", () => {
      const task = makeTask({ id: "T3", agent: "override-agent" });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "override-agent");
    });

    it("task.agent=yes, kind agent=no, flat=no → task.agent wins", () => {
      const task = makeTask({ id: "T4", agent: "override-agent" });
      const fleet = fd({});
      assert.equal(resolveAgent(task, fleet), "override-agent");
    });

    it("task.agent=no, kind agent=yes, flat=yes → kind agent wins", () => {
      const task = makeTask({ id: "T5", kind: "work" });
      const fleet = fd({ work: { agent: "kind-agent" }, agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "kind-agent");
    });

    it("task.agent=no, kind agent=yes, flat=no → kind agent wins", () => {
      const task = makeTask({ id: "T6", kind: "work" });
      const fleet = fd({ work: { agent: "kind-agent" } });
      assert.equal(resolveAgent(task, fleet), "kind-agent");
    });

    it("task.agent=no, kind agent=no, flat=yes → flat agent wins", () => {
      const task = makeTask({ id: "T7", kind: "work" });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("task.agent=no, kind agent=no, flat=no → null", () => {
      const task = makeTask({ id: "T8", kind: "work" });
      const fleet = fd({});
      assert.equal(resolveAgent(task, fleet), null);
    });
  });

  describe("review task resolves review sub-bucket", () => {
    it("task.kind=review picks fleetDefaults.review.agent over flat", () => {
      const task = makeTask({ id: "R1", kind: "review" });
      const fleet = fd({ review: { agent: "reviewer-agent" }, agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "reviewer-agent");
    });

    it("task.kind=review falls through to flat when no review.agent", () => {
      const task = makeTask({ id: "R2", kind: "review" });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("task.kind=review returns null when no review.agent and no flat", () => {
      const task = makeTask({ id: "R3", kind: "review" });
      const fleet = fd({});
      assert.equal(resolveAgent(task, fleet), null);
    });
  });

  describe("task.kind fallback to 'work'", () => {
    it("task with no kind defaults to work sub-bucket resolution", () => {
      const task = makeTask({ id: "T9" }); // no kind set
      const fleet = fd({ work: { agent: "kind-agent" }, agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "kind-agent");
    });

    it("task with no kind falls through to flat when no work.agent", () => {
      const task = makeTask({ id: "T10" });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("task with no kind returns null when nothing set", () => {
      const task = makeTask({ id: "T11" });
      const fleet = fd({});
      assert.equal(resolveAgent(task, fleet), null);
    });
  });

  describe("undefined vs null agent on task", () => {
    it("task.agent=undefined falls through to fleet defaults", () => {
      const task = makeTask({ id: "T12" }); // agent is undefined
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("task.agent=null falls through to fleet defaults", () => {
      const task = makeTask({ id: "T13", agent: null as unknown as string });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("task.agent=empty string falls through (falsy in JS)", () => {
      const task = makeTask({ id: "T14", agent: "" as unknown as string });
      const fleet = fd({ agent: "flat-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });
  });

  describe("orchestratorAgent fallback", () => {
    it("no task/fleet → falls through to orchestratorAgent", () => {
      const task = makeTask({ id: "O1" });
      const fleet = fd({ orchestratorAgent: "orch-agent" });
      assert.equal(resolveAgent(task, fleet), "orch-agent");
    });

    it("fleet.agent wins over orchestratorAgent", () => {
      const task = makeTask({ id: "O2" });
      const fleet = fd({ agent: "flat-agent", orchestratorAgent: "orch-agent" });
      assert.equal(resolveAgent(task, fleet), "flat-agent");
    });

    it("kind agent wins over orchestratorAgent", () => {
      const task = makeTask({ id: "O3", kind: "work" });
      const fleet = fd({ work: { agent: "kind-agent" }, orchestratorAgent: "orch-agent" });
      assert.equal(resolveAgent(task, fleet), "kind-agent");
    });

    it("task.agent wins over orchestratorAgent", () => {
      const task = makeTask({ id: "O4", agent: "task-agent" });
      const fleet = fd({ orchestratorAgent: "orch-agent" });
      assert.equal(resolveAgent(task, fleet), "task-agent");
    });

    it("no task/fleet/orchestrator → null", () => {
      const task = makeTask({ id: "O5" });
      const fleet = fd({});
      assert.equal(resolveAgent(task, fleet), null);
    });
  });
});

describe("resolveModel", () => {
  describe("8 combinations of (task.model) x (fleetDefaults[kind]) x (fleetDefaults.flat)", () => {
    it("task.model=yes, kind model=yes, flat=yes → task.model wins", () => {
      const task = makeTask({ id: "T1", model: "override-model" });
      const fleet = fd({ work: { model: "kind-model" }, model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "override-model");
    });

    it("task.model=yes, kind model=yes, flat=no → task.model wins", () => {
      const task = makeTask({ id: "T2", model: "override-model" });
      const fleet = fd({ work: { model: "kind-model" } });
      assert.equal(resolveModel(task, fleet), "override-model");
    });

    it("task.model=yes, kind model=no, flat=yes → task.model wins", () => {
      const task = makeTask({ id: "T3", model: "override-model" });
      const fleet = fd({ model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "override-model");
    });

    it("task.model=yes, kind model=no, flat=no → task.model wins", () => {
      const task = makeTask({ id: "T4", model: "override-model" });
      const fleet = fd({});
      assert.equal(resolveModel(task, fleet), "override-model");
    });

    it("task.model=no, kind model=yes, flat=yes → kind model wins", () => {
      const task = makeTask({ id: "T5", kind: "work" });
      const fleet = fd({ work: { model: "kind-model" }, model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "kind-model");
    });

    it("task.model=no, kind model=yes, flat=no → kind model wins", () => {
      const task = makeTask({ id: "T6", kind: "work" });
      const fleet = fd({ work: { model: "kind-model" } });
      assert.equal(resolveModel(task, fleet), "kind-model");
    });

    it("task.model=no, kind model=no, flat=yes → flat model wins", () => {
      const task = makeTask({ id: "T7", kind: "work" });
      const fleet = fd({ model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "flat-model");
    });

    it("task.model=no, kind model=no, flat=no → null", () => {
      const task = makeTask({ id: "T8", kind: "work" });
      const fleet = fd({});
      assert.equal(resolveModel(task, fleet), null);
    });
  });

  describe("review task resolves review sub-bucket", () => {
    it("task.kind=review picks fleetDefaults.review.model over flat", () => {
      const task = makeTask({ id: "R1", kind: "review" });
      const fleet = fd({ review: { model: "reviewer-model" }, model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "reviewer-model");
    });

    it("task.kind=review falls through to flat when no review.model", () => {
      const task = makeTask({ id: "R2", kind: "review" });
      const fleet = fd({ model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "flat-model");
    });

    it("task.kind=review returns null when no review.model and no flat", () => {
      const task = makeTask({ id: "R3", kind: "review" });
      const fleet = fd({});
      assert.equal(resolveModel(task, fleet), null);
    });
  });

  describe("task.kind fallback to 'work'", () => {
    it("task with no kind defaults to work sub-bucket resolution", () => {
      const task = makeTask({ id: "T9" });
      const fleet = fd({ work: { model: "kind-model" }, model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "kind-model");
    });

    it("task with no kind falls through to flat when no work.model", () => {
      const task = makeTask({ id: "T10" });
      const fleet = fd({ model: "flat-model" });
      assert.equal(resolveModel(task, fleet), "flat-model");
    });

    it("task with no kind returns null when nothing set", () => {
      const task = makeTask({ id: "T11" });
      const fleet = fd({});
      assert.equal(resolveModel(task, fleet), null);
    });
  });

  describe("orchestratorModel fallback", () => {
    it("no task/fleet → falls through to orchestratorModel", () => {
      const task = makeTask({ id: "O1" });
      const fleet = fd({ orchestratorModel: "orch-model" });
      assert.equal(resolveModel(task, fleet), "orch-model");
    });

    it("fleet.model wins over orchestratorModel", () => {
      const task = makeTask({ id: "O2" });
      const fleet = fd({ model: "flat-model", orchestratorModel: "orch-model" });
      assert.equal(resolveModel(task, fleet), "flat-model");
    });

    it("task.model wins over orchestratorModel", () => {
      const task = makeTask({ id: "O3", model: "task-model" });
      const fleet = fd({ orchestratorModel: "orch-model" });
      assert.equal(resolveModel(task, fleet), "task-model");
    });

    it("no task/fleet/orchestrator → null", () => {
      const task = makeTask({ id: "O4" });
      const fleet = fd({});
      assert.equal(resolveModel(task, fleet), null);
    });
  });
});

describe("resolveRunOn", () => {
  describe("task.runOn takes priority", () => {
    it("task.runOn=worker wins over all fleet defaults", () => {
      const task = makeTask({ id: "T1", runOn: "worker" });
      const fleet = fd({ review: { runOn: "orchestrator" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "worker");
    });

    it("task.runOn=orchestrator wins over fleetDefaults.review.runOn", () => {
      const task = makeTask({ id: "T2", runOn: "orchestrator" });
      const fleet = fd({ review: { runOn: "worker" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });
  });

  describe("fleetDefaults.review.runOn fallback", () => {
    it("no task.runOn + review.runOn=worker → worker", () => {
      const task = makeTask({ id: "T3" });
      const fleet = fd({ review: { runOn: "worker" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "worker");
    });

    it("no task.runOn + review.runOn=orchestrator → orchestrator", () => {
      const task = makeTask({ id: "T4" });
      const fleet = fd({ review: { runOn: "orchestrator" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });

    it("no task.runOn + no review.runOn → orchestrator (default)", () => {
      const task = makeTask({ id: "T5" });
      const fleet = fd({});
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });

    it("no task.runOn + flat agent but no review.runOn → orchestrator (default)", () => {
      const task = makeTask({ id: "T6" });
      const fleet = fd({ agent: "some-agent" });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });
  });

  describe("works with review tasks", () => {
    it("review task without runOn uses fleetDefaults.review.runOn", () => {
      const task = makeTask({ id: "R1", kind: "review" });
      const fleet = fd({ review: { runOn: "worker" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "worker");
    });

    it("review task without runOn and no fleetDefaults.review.runOn → orchestrator", () => {
      const task = makeTask({ id: "R2", kind: "review" });
      const fleet = fd({});
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });
  });

  describe("works with work tasks", () => {
    it("work task without runOn → orchestrator (default)", () => {
      const task = makeTask({ id: "W1", kind: "work" });
      const fleet = fd({});
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "orchestrator");
    });

    it("work task without runOn + review.runOn set → review.runOn wins (kind-agnostic fallback)", () => {
      // resolveRunOn does not differentiate by kind — it always checks
      // fleetDefaults.review.runOn as the sole fleet default path.
      const task = makeTask({ id: "W2", kind: "work" });
      const fleet = fd({ review: { runOn: "worker" } });
      assert.equal(resolveRunOn(task, fleet.fleetDefaults), "worker");
    });
  });
});
