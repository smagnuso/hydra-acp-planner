import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAsciiPlanEnvelope,
  buildAsciiPlanText,
  buildPlanUpdateEnvelope,
  getPlanRenderMode,
} from "../src/plan-update.ts";
import type { Board, Task } from "../src/board.ts";

function task(id: string, opts: Partial<Task> = {}): Task {
  return {
    id,
    title: opts.title ?? `Task ${id}`,
    deps: opts.deps ?? [],
    status: opts.status ?? "pending",
    attemptCount: opts.attemptCount ?? 0,
    ...opts,
  };
}

function board(opts: Partial<Board> = {}): Board {
  return {
    version: 1,
    projectId: "hydra_plan_abc123",
    description: "test project",
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    fleetDefaults: { agent: null, model: null },
    tasks: [],
    workers: {},
    concurrencyCap: 1,
    ...opts,
  };
}

describe("buildPlanUpdateEnvelope", () => {
  it("produces an ACP plan session/update envelope", () => {
    const b = board({
      tasks: [
        task("T1", { status: "done" }),
        task("T2", { status: "assigned" }),
        task("T3", { status: "pending", deps: ["T2"] }),
      ],
    });
    const env = buildPlanUpdateEnvelope({ sessionId: "sess_x", board: b });
    assert.equal(env.sessionId, "sess_x");
    assert.equal(env.update.sessionUpdate, "plan");
    const entries = (env.update as { entries: unknown[] }).entries;
    assert.equal(entries.length, 3);
  });

  it("maps task statuses to ACP plan-entry statuses", () => {
    const b = board({
      tasks: [
        task("T1", { status: "done" }),
        task("T2", { status: "assigned" }),
        task("T3", { status: "pending" }),
        task("T4", { status: "failed" }),
        task("T5", { status: "blocked" }),
      ],
    });
    const env = buildPlanUpdateEnvelope({ sessionId: "s", board: b });
    const entries = (env.update as { entries: Array<{ status: string }> }).entries;
    assert.equal(entries[0]!.status, "completed");
    assert.equal(entries[1]!.status, "in_progress");
    assert.equal(entries[2]!.status, "pending");
    // failed surfaces as completed (ACP has no failed) — content carries the marker
    assert.equal(entries[3]!.status, "completed");
    assert.equal(entries[4]!.status, "pending");
  });

  it("prefixes failed tasks with a [FAILED] marker in content", () => {
    const b = board({ tasks: [task("T1", { status: "failed", title: "Boom" })] });
    const env = buildPlanUpdateEnvelope({ sessionId: "s", board: b });
    const entries = (env.update as { entries: Array<{ content: string }> }).entries;
    assert.ok(entries[0]!.content.startsWith("[FAILED]"));
    assert.ok(entries[0]!.content.includes("Boom"));
  });

  it("assigns high priority to entry-point tasks and frequently-blocked tasks", () => {
    const b = board({
      tasks: [
        task("T1"), // no deps → high
        task("T2", { deps: ["T1"] }), // single dep, not blocking many → medium
        task("T3", { deps: ["T2"] }), // blocked by T2; not blocking → medium
        task("T4", { deps: ["T2"] }), // blocked by T2; T2 now blocks 2 → T2 should be high
      ],
    });
    const env = buildPlanUpdateEnvelope({ sessionId: "s", board: b });
    const entries = (env.update as { entries: Array<{ priority: string }> }).entries;
    assert.equal(entries[0]!.priority, "high"); // T1 no deps
    assert.equal(entries[1]!.priority, "high"); // T2 blocks 2 dependents
    assert.equal(entries[2]!.priority, "medium"); // T3
    assert.equal(entries[3]!.priority, "medium"); // T4
  });
});

describe("buildAsciiPlanText", () => {
  it("includes a header with project id, state, and counts", () => {
    const b = board({
      tasks: [task("T1", { status: "done" }), task("T2", { status: "assigned" })],
    });
    const out = buildAsciiPlanText(b);
    const firstLine = out.split("\n")[0]!;
    assert.ok(firstLine.includes("abc123"));
    assert.ok(firstLine.includes("running"));
    assert.ok(firstLine.includes("1/2 done"));
    assert.ok(firstLine.includes("1 running"));
  });

  it("renders one line per task with a status glyph", () => {
    const b = board({
      tasks: [
        task("T1", { status: "done" }),
        task("T2", { status: "assigned" }),
        task("T3", { status: "pending" }),
        task("T4", { status: "failed" }),
      ],
    });
    const lines = buildAsciiPlanText(b).split("\n");
    assert.equal(lines.length, 5); // header + 4 tasks
    assert.match(lines[1]!, /\[x\]\s+T1/);
    assert.match(lines[2]!, /\[~\]\s+T2/);
    assert.match(lines[3]!, /\[ \]\s+T3/);
    assert.match(lines[4]!, /\[!\]\s+T4/);
  });

  it("includes a failed count in the header when applicable", () => {
    const b = board({ tasks: [task("T1", { status: "failed" })] });
    const out = buildAsciiPlanText(b);
    assert.ok(out.split("\n")[0]!.includes("1 failed"));
  });
});

describe("buildAsciiPlanEnvelope", () => {
  it("wraps the ASCII text in an agent_message_chunk envelope", () => {
    const env = buildAsciiPlanEnvelope({
      sessionId: "s",
      board: board({ tasks: [task("T1")] }),
    });
    assert.equal(env.update.sessionUpdate, "agent_message_chunk");
    const content = (env.update.content as { text: string }).text;
    assert.ok(content.includes("T1"));
  });
});

describe("getPlanRenderMode", () => {
  it("defaults to plan", () => {
    const old = process.env.PLANNER_RENDER;
    delete process.env.PLANNER_RENDER;
    try {
      assert.equal(getPlanRenderMode(), "plan");
    } finally {
      if (old !== undefined) process.env.PLANNER_RENDER = old;
    }
  });

  it("returns ascii when PLANNER_RENDER=ascii", () => {
    const old = process.env.PLANNER_RENDER;
    process.env.PLANNER_RENDER = "ascii";
    try {
      assert.equal(getPlanRenderMode(), "ascii");
    } finally {
      if (old === undefined) {
        delete process.env.PLANNER_RENDER;
      } else {
        process.env.PLANNER_RENDER = old;
      }
    }
  });

  it("falls back to plan for unrecognized values", () => {
    const old = process.env.PLANNER_RENDER;
    process.env.PLANNER_RENDER = "weird";
    try {
      assert.equal(getPlanRenderMode(), "plan");
    } finally {
      if (old === undefined) {
        delete process.env.PLANNER_RENDER;
      } else {
        process.env.PLANNER_RENDER = old;
      }
    }
  });
});
