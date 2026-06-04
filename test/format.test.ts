import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatBoardContext, formatStatus } from "../src/format.ts";
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
    projectId: "hydra_plan_test123",
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

describe("formatBoardContext", () => {
  it("starts with a recognizable preamble bracket", () => {
    const out = formatBoardContext(board());
    assert.ok(out.startsWith("[hydra-acp-planner:"));
  });

  it("ends with the user-prompt anchor and closing bracket", () => {
    const out = formatBoardContext(board());
    assert.match(out, /User's prompt follows:\s*$/);
    assert.match(out, /\]/);
  });

  it("shows shortened project id, not full prefix", () => {
    const out = formatBoardContext(board({ projectId: "hydra_plan_abc123" }));
    assert.match(out, /Project ID: abc123/);
    assert.doesNotMatch(out, /hydra_plan_abc123/);
  });

  it("includes the description and state", () => {
    const out = formatBoardContext(board({ description: "build a thing", state: "running" }));
    assert.match(out, /Description: build a thing/);
    assert.match(out, /state: running/);
  });

  it("reports 'none yet' when no tasks present", () => {
    const out = formatBoardContext(board({ tasks: [] }));
    assert.match(out, /Tasks: none yet/);
  });

  it("renders each task with status glyph and id", () => {
    const out = formatBoardContext(
      board({
        tasks: [
          task("T1", { status: "done" }),
          task("T2", { status: "assigned", assignedTo: "hydra_session_w1" }),
          task("T3", { status: "pending" }),
        ],
      }),
    );
    assert.match(out, /✓ T1/);
    assert.match(out, /▶ T2/);
    assert.match(out, /· T3/);
  });

  it("shows done/total counter", () => {
    const out = formatBoardContext(
      board({
        tasks: [
          task("T1", { status: "done" }),
          task("T2", { status: "done" }),
          task("T3", { status: "pending" }),
        ],
      }),
    );
    assert.match(out, /Tasks \(2\/3 done\)/);
  });

  it("shows dependencies inline", () => {
    const out = formatBoardContext(
      board({
        tasks: [
          task("T1", { status: "done" }),
          task("T2", { status: "pending", deps: ["T1"] }),
        ],
      }),
    );
    assert.match(out, /T2 .* deps: T1/);
  });

  it("shows worker session for assigned tasks (shortened)", () => {
    const out = formatBoardContext(
      board({
        tasks: [task("T1", { status: "assigned", assignedTo: "hydra_session_abc" })],
      }),
    );
    assert.match(out, /worker: abc/);
    assert.doesNotMatch(out, /hydra_session_abc/);
  });

  it("includes artifacts for done tasks", () => {
    const out = formatBoardContext(
      board({
        tasks: [
          task("T1", {
            status: "done",
            artifacts: {
              summary: "wrote auth.py",
              decisions: ["bcrypt cost 12", "redis sessions"],
              files_changed: ["src/auth.py"],
            },
          }),
        ],
      }),
    );
    assert.match(out, /result: wrote auth\.py/);
    assert.match(out, /decisions: bcrypt cost 12; redis sessions/);
    assert.match(out, /files: src\/auth\.py/);
  });

  it("includes what/constraints when present", () => {
    const out = formatBoardContext(
      board({
        tasks: [
          task("T1", {
            what: "outcome description",
            constraints: "must not break X",
          }),
        ],
      }),
    );
    assert.match(out, /what: outcome description/);
    assert.match(out, /constraints: must not break X/);
  });

  it("includes the do-not-echo + suggest-slash instruction", () => {
    const out = formatBoardContext(board());
    assert.match(out, /Do NOT echo the context block verbatim/);
    assert.match(out, /\/hydra planner <verb>/);
  });
});

describe("formatStatus", () => {
  it("includes the attached marker when true", () => {
    const out = formatStatus(board(), true);
    assert.match(out, /Planner: attached/);
    assert.doesNotMatch(out, /not currently attached/);
  });

  it("includes the not-attached hint when false", () => {
    const out = formatStatus(board(), false);
    assert.match(out, /Planner: not currently attached/);
  });

  it("shortens the project id", () => {
    const out = formatStatus(board({ projectId: "hydra_plan_xyz" }), true);
    assert.match(out, /xyz/);
    assert.doesNotMatch(out, /hydra_plan_xyz/);
  });

  it("renders an agent-only tag inline on the task line", () => {
    const out = formatStatus(
      board({ tasks: [task("T1", { agent: "code-claude" })] }),
      true,
    );
    assert.match(out, /T1\s+Task T1\s+\{code-claude\}/);
  });

  it("renders an agent|model tag when both are set", () => {
    const out = formatStatus(
      board({ tasks: [task("T1", { agent: "code-claude", model: "opus-4-7" })] }),
      true,
    );
    assert.match(out, /\{code-claude \| opus-4-7\}/);
  });

  it("renders a model-only tag when only model is set", () => {
    const out = formatStatus(
      board({ tasks: [task("T1", { model: "opus-4-7" })] }),
      true,
    );
    assert.match(out, /\{opus-4-7\}/);
  });
});
