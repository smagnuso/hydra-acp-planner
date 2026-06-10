import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAddTaskPrompt,
  buildDecompositionPrompt,
  buildExecuteDecompositionPrompt,
  buildResumeDecompositionPrompt,
  extractAddTaskBlock,
  extractJsonBlock,
  formatPlanSummary,
  normalizeAddedTasks,
  normalizeDecomposition,
  sweepLineConcurrencyCap,
} from "../src/decomposition.ts";
import type { Board, Task } from "../src/board.ts";

// ─── prompt builder ──────────────────────────────────────────────────────

describe("buildDecompositionPrompt", () => {
  it("embeds the project description verbatim", () => {
    const p = buildDecompositionPrompt("build a todo app with auth");
    assert.match(p, /build a todo app with auth/);
  });

  it("instructs the agent not to specify HOW", () => {
    const p = buildDecompositionPrompt("anything");
    assert.match(p, /Do NOT specify/);
    assert.match(p, /library/);
    assert.match(p, /algorithm/);
  });

  it("asks for a fenced JSON block in the reply", () => {
    const p = buildDecompositionPrompt("anything");
    assert.match(p, /```json/);
    assert.match(p, /tasks/);
  });

  it("mentions the optional agent field in the schema", () => {
    const p = buildDecompositionPrompt("anything");
    assert.match(p, /agent \(optional\)/);
  });

  it("mentions the optional model field in the schema", () => {
    const p = buildDecompositionPrompt("anything");
    assert.match(p, /model \(optional\)/);
  });

  it("omits the Available agents block when none provided", () => {
    const p = buildDecompositionPrompt("anything");
    assert.doesNotMatch(p, /Available specialist agents/);
  });

  it("lists provided agents with their descriptions", () => {
    const p = buildDecompositionPrompt("anything", [
      { id: "code-claude", description: "Claude coding agent" },
      { id: "code-codex" },
    ]);
    assert.match(p, /Available specialist agents/);
    assert.match(p, /code-claude — Claude coding agent/);
    assert.match(p, /code-codex/);
  });

  it("omits competition instructions when compete is false (default)", () => {
    const p = buildDecompositionPrompt("anything");
    assert.doesNotMatch(p, /Competition pattern/i);
    assert.doesNotMatch(p, /competition/i);
  });

  it("includes competition instructions when compete is true", () => {
    const p = buildDecompositionPrompt("anything", undefined, true);
    assert.match(p, /Competition pattern/i);
    assert.match(p, /N sibling work tasks/i);
    assert.match(p, /review task of kind "review"/i);
    assert.match(p, /reviews set to the array/i);
  });

  it("competition block does not appear for non-compete prompts", () => {
    const p = buildDecompositionPrompt("anything", undefined, false);
    assert.doesNotMatch(p, /integration point/i);
  });
});

describe("buildExecuteDecompositionPrompt", () => {
  it("instructs the agent to decompose what was discussed in this conversation", () => {
    const p = buildExecuteDecompositionPrompt();
    assert.match(p, /discussing a software project/);
    assert.match(p, /Decompose THAT project/);
  });

  it("asks for a top-level description field in the JSON", () => {
    const p = buildExecuteDecompositionPrompt();
    assert.match(p, /"description": "\.\.\."/);
    assert.match(p, /summary of the project/);
  });

  it("carries the agent-list block when one is provided", () => {
    const p = buildExecuteDecompositionPrompt([
      { id: "code-claude", description: "Claude" },
    ]);
    assert.match(p, /Available specialist agents/);
    assert.match(p, /code-claude/);
  });

  it("omits the agent-list block when none provided", () => {
    const p = buildExecuteDecompositionPrompt();
    assert.doesNotMatch(p, /Available specialist agents/);
  });

  it("omits competition instructions when compete is false (default)", () => {
    const p = buildExecuteDecompositionPrompt();
    assert.doesNotMatch(p, /Competition pattern/i);
  });

  it("includes competition instructions when compete is true", () => {
    const p = buildExecuteDecompositionPrompt(undefined, true);
    assert.match(p, /Competition pattern/i);
    assert.match(p, /N sibling work tasks/i);
  });
});

// ─── extractJsonBlock ────────────────────────────────────────────────────

describe("extractJsonBlock", () => {
  it("returns the parsed object when the reply is just the block", () => {
    const text = "```json\n{\"tasks\":[{\"id\":\"T1\"}]}\n```";
    const got = extractJsonBlock(text) as { tasks: Array<{ id: string }> };
    assert.equal(got.tasks[0]?.id, "T1");
  });

  it("tolerates leading prose before the block", () => {
    const text = "Here's the plan:\n\n```json\n{\"tasks\":[]}\n```\nThanks!";
    const got = extractJsonBlock(text) as { tasks: unknown[] };
    assert.deepEqual(got.tasks, []);
  });

  it("accepts unlabeled fences", () => {
    const text = "```\n{\"x\":1}\n```";
    assert.deepEqual(extractJsonBlock(text), { x: 1 });
  });

  it("returns undefined for no fence", () => {
    assert.equal(extractJsonBlock("no fences here"), undefined);
  });

  it("returns undefined for unparsable content inside the fence", () => {
    assert.equal(extractJsonBlock("```json\n{not valid\n```"), undefined);
  });

  it("picks the first block when multiple are present", () => {
    const text =
      "```json\n{\"first\":true}\n```\nand\n```json\n{\"second\":true}\n```";
    assert.deepEqual(extractJsonBlock(text), { first: true });
  });
});

// ─── normalizeDecomposition ──────────────────────────────────────────────

describe("normalizeDecomposition", () => {
  it("happy path: returns tasks with defaults filled in", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "first", deps: [] },
        { id: "T2", title: "second", deps: ["T1"] },
      ],
    });
    assert.ok(got);
    assert.equal(got!.tasks.length, 2);
    assert.equal(got!.tasks[0]!.status, "pending");
    assert.equal(got!.tasks[0]!.attemptCount, 0);
    assert.equal(got!.warnings.length, 0);
  });

  it("drops tasks with no id", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "", title: "no id" },
        { id: "T1", title: "ok" },
      ],
    });
    assert.equal(got!.tasks.length, 1);
    assert.equal(got!.tasks[0]!.id, "T1");
    assert.equal(got!.warnings.length, 1);
  });

  it("preserves an optional agent string per task", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "ok", deps: [], agent: "code-claude" },
        { id: "T2", title: "default", deps: [] },
      ],
    });
    assert.equal(got!.tasks[0]!.agent, "code-claude");
    assert.equal(got!.tasks[1]!.agent, null);
  });

  it("preserves an optional model string per task", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "ok", deps: [], model: "opus-4-7" },
        { id: "T2", title: "default", deps: [] },
      ],
    });
    assert.equal(got!.tasks[0]!.model, "opus-4-7");
    assert.equal(got!.tasks[1]!.model, null);
  });

  it("preserves reviewAgent/reviewModel per task", () => {
    const got = normalizeDecomposition({
      tasks: [
        {
          id: "T1",
          title: "ok",
          deps: [],
          reviewAgent: "security-expert",
          reviewModel: "opus",
        },
        { id: "T2", title: "default", deps: [] },
      ],
    });
    assert.equal(got!.tasks[0]!.reviewAgent, "security-expert");
    assert.equal(got!.tasks[0]!.reviewModel, "opus");
    assert.equal(got!.tasks[1]!.reviewAgent, null);
    assert.equal(got!.tasks[1]!.reviewModel, null);
  });

  it("preserves kind and reviews for hand-authored review tasks", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "impl A", deps: [] },
        { id: "T2", title: "impl B", deps: [] },
        {
          id: "R",
          title: "pick winner",
          deps: ["T1", "T2"],
          kind: "review",
          reviews: ["T1", "T2"],
          agent: "referee-agent",
        },
      ],
    });
    const r = got!.tasks.find((t) => t.id === "R")!;
    assert.equal(r.kind, "review");
    assert.deepEqual(r.reviews, ["T1", "T2"]);
    assert.equal(r.agent, "referee-agent");
  });

  it("ignores invalid kind values (treats as work / undefined)", () => {
    const got = normalizeDecomposition({
      tasks: [{ id: "T1", title: "x", deps: [], kind: "bogus" }],
    });
    assert.equal(got!.tasks[0]!.kind, undefined);
  });

  it("surfaces a top-level description (trimmed) when present", () => {
    const got = normalizeDecomposition({
      description: "  build a todo app  ",
      tasks: [{ id: "T1", title: "ok", deps: [] }],
    });
    assert.equal(got!.description, "build a todo app");
  });

  it("leaves description undefined when missing, blank, or non-string", () => {
    const a = normalizeDecomposition({ tasks: [{ id: "T1", title: "ok" }] });
    assert.equal(a!.description, undefined);
    const b = normalizeDecomposition({ description: "   ", tasks: [{ id: "T1", title: "ok" }] });
    assert.equal(b!.description, undefined);
    const c = normalizeDecomposition({ description: 42, tasks: [{ id: "T1", title: "ok" }] });
    assert.equal(c!.description, undefined);
  });

  it("drops duplicate ids (keeps first)", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "first" },
        { id: "T1", title: "duplicate" },
      ],
    });
    assert.equal(got!.tasks.length, 1);
    assert.equal(got!.tasks[0]!.title, "first");
    assert.equal(got!.warnings.length, 1);
  });

  it("strips deps that don't exist", () => {
    const got = normalizeDecomposition({
      tasks: [
        { id: "T1", title: "a", deps: ["T2", "T99"] },
        { id: "T2", title: "b", deps: [] },
      ],
    });
    assert.deepEqual(got!.tasks[0]!.deps, ["T2"]);
    assert.equal(got!.warnings.length, 1);
    assert.match(got!.warnings[0]!, /unknown deps: T99/);
  });

  it("returns undefined for missing tasks array", () => {
    assert.equal(normalizeDecomposition({}), undefined);
    assert.equal(normalizeDecomposition({ tasks: [] }), undefined);
    assert.equal(normalizeDecomposition(null), undefined);
  });

  it("preserves why/what/constraints when present", () => {
    const got = normalizeDecomposition({
      tasks: [
        {
          id: "T1",
          title: "build the thing",
          why: "users need it",
          what: "outcome description",
          constraints: "must not break X",
          deps: [],
        },
      ],
    });
    const t = got!.tasks[0]!;
    assert.equal(t.why, "users need it");
    assert.equal(t.what, "outcome description");
    assert.equal(t.constraints, "must not break X");
  });
});

// ─── sweepLineConcurrencyCap ─────────────────────────────────────────────

function task(id: string, deps: string[] = []): Task {
  return {
    id,
    title: id,
    deps,
    status: "pending",
    attemptCount: 0,
  };
}

describe("sweepLineConcurrencyCap", () => {
  it("returns 1 for an empty task set", () => {
    assert.equal(sweepLineConcurrencyCap([]), 1);
  });

  it("returns 1 for a pure chain", () => {
    const tasks = [task("T1"), task("T2", ["T1"]), task("T3", ["T2"])];
    assert.equal(sweepLineConcurrencyCap(tasks), 1);
  });

  it("returns N for N independent tasks", () => {
    const tasks = [task("T1"), task("T2"), task("T3"), task("T4")];
    assert.equal(sweepLineConcurrencyCap(tasks), 4);
  });

  it("computes the max width of a fan-out DAG", () => {
    // T1 → {T2, T3, T4} → T5
    // Layer 0: 1
    // Layer 1: 3   ← max width
    // Layer 2: 1
    const tasks = [
      task("T1"),
      task("T2", ["T1"]),
      task("T3", ["T1"]),
      task("T4", ["T1"]),
      task("T5", ["T2", "T3", "T4"]),
    ];
    assert.equal(sweepLineConcurrencyCap(tasks), 3);
  });

  it("respects the cap", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`T${i + 1}`));
    assert.equal(sweepLineConcurrencyCap(tasks, 6), 6);
  });

  it("handles cycles without infinite-looping (treats them as layer 0)", () => {
    // T1 ↔ T2 (cycle, malformed DAG)
    const tasks = [task("T1", ["T2"]), task("T2", ["T1"])];
    const cap = sweepLineConcurrencyCap(tasks);
    // The exact answer is less important than "doesn't loop forever"
    assert.ok(cap >= 1);
  });
});

// ─── formatPlanSummary ───────────────────────────────────────────────────

// ─── buildResumeDecompositionPrompt ─────────────────────────────────────

describe("buildResumeDecompositionPrompt", () => {
  it("embeds the project description", () => {
    const p = buildResumeDecompositionPrompt("build a todo app");
    assert.match(p, /build a todo app/);
  });

  it("identifies as a restart resumption", () => {
    const p = buildResumeDecompositionPrompt("anything");
    assert.match(p, /resuming decomposition after restart/);
  });

  it("tells the agent to re-emit verbatim if already done", () => {
    const p = buildResumeDecompositionPrompt("x");
    assert.match(p, /re-emit it verbatim/);
  });

  it("asks for the same JSON schema as fresh decomposition", () => {
    const p = buildResumeDecompositionPrompt("x");
    assert.match(p, /tasks/);
    assert.match(p, /```json/);
  });

  it("omits competition hint when compete is false (default)", () => {
    const p = buildResumeDecompositionPrompt("build a todo app");
    assert.doesNotMatch(p, /competition/i);
  });

  it("includes competition context when compete is true", () => {
    const p = buildResumeDecompositionPrompt("build a todo app", true);
    assert.match(p, /competition pattern/i);
    assert.match(p, /compete flag was set/i);
    assert.match(p, /do NOT invent new competition tasks/i);
  });
});

// ─── buildAddTaskPrompt + extractAddTaskBlock + normalizeAddedTasks ──────

function board(tasks: Task[]): Board {
  return {
    version: 1,
    projectId: "hydra_plan_t",
    description: "test",
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    fleetDefaults: { agent: null, model: null },
    tasks,
    workers: {},
    concurrencyCap: 1,
  };
}

describe("buildAddTaskPrompt", () => {
  it("embeds the user's add description", () => {
    const p = buildAddTaskPrompt("rate limiting on login", board([]));
    assert.match(p, /rate limiting on login/);
  });

  it("suggests the next free T-number", () => {
    const p = buildAddTaskPrompt("anything", board([task("T1"), task("T2"), task("T3")]));
    assert.match(p, /next free id is T4/);
  });

  it("starts T-numbering at T1 for empty boards", () => {
    const p = buildAddTaskPrompt("first task", board([]));
    assert.match(p, /next free id is T1/);
  });

  it("includes existing task ids in the deps hint", () => {
    const p = buildAddTaskPrompt("x", board([task("T1"), task("T2")]));
    assert.match(p, /existing task ids: T1, T2/);
  });

  it("asks for a fenced hydra-add-task block", () => {
    const p = buildAddTaskPrompt("x", board([]));
    assert.match(p, /```hydra-add-task/);
  });

  it("warns the agent not to specify HOW", () => {
    const p = buildAddTaskPrompt("x", board([]));
    assert.match(p, /Do NOT specify implementation mechanism/);
  });
});

describe("extractAddTaskBlock", () => {
  it("returns parsed JSON for a labelled hydra-add-task block", () => {
    const text = "ok\n```hydra-add-task\n{\"tasks\":[{\"id\":\"T8\"}]}\n```";
    const r = extractAddTaskBlock(text) as { tasks: Array<{ id: string }> };
    assert.equal(r.tasks[0]?.id, "T8");
  });

  it("falls back to plain ```json block", () => {
    const text = "no label this time\n```json\n{\"tasks\":[]}\n```";
    const r = extractAddTaskBlock(text) as { tasks: unknown[] };
    assert.deepEqual(r.tasks, []);
  });

  it("picks the LAST block when multiple unlabelled ones exist", () => {
    const text =
      "first\n```\n{\"tasks\":[{\"id\":\"first\"}]}\n```\nlast\n```\n{\"tasks\":[{\"id\":\"last\"}]}\n```";
    const r = extractAddTaskBlock(text) as { tasks: Array<{ id: string }> };
    assert.equal(r.tasks[0]?.id, "last");
  });

  it("returns undefined when there's no parseable block", () => {
    assert.equal(extractAddTaskBlock("just prose"), undefined);
    assert.equal(extractAddTaskBlock("```hydra-add-task\nnot valid\n```"), undefined);
  });
});

describe("normalizeAddedTasks", () => {
  it("returns tasks not colliding with existing ids", () => {
    const r = normalizeAddedTasks(
      { tasks: [{ id: "T3", title: "new" }] },
      new Set(["T1", "T2"]),
    );
    assert.ok(r);
    assert.equal(r!.tasks.length, 1);
    assert.equal(r!.tasks[0]!.id, "T3");
  });

  it("drops new tasks that collide with existing ids and warns", () => {
    const r = normalizeAddedTasks(
      { tasks: [{ id: "T1", title: "collision" }] },
      new Set(["T1", "T2"]),
    );
    assert.equal(r, undefined); // all dropped
  });

  it("drops duplicate new ids within the same emission", () => {
    const r = normalizeAddedTasks(
      {
        tasks: [
          { id: "T3", title: "first" },
          { id: "T3", title: "dup" },
        ],
      },
      new Set(["T1"]),
    );
    assert.equal(r!.tasks.length, 1);
    assert.match(r!.warnings.join(" "), /duplicate/);
  });

  it("allows deps referring to existing or new tasks", () => {
    const r = normalizeAddedTasks(
      {
        tasks: [
          { id: "T3", title: "a", deps: ["T1"] },
          { id: "T4", title: "b", deps: ["T3"] },
        ],
      },
      new Set(["T1", "T2"]),
    );
    assert.deepEqual(r!.tasks[0]!.deps, ["T1"]);
    assert.deepEqual(r!.tasks[1]!.deps, ["T3"]);
    assert.equal(r!.warnings.length, 0);
  });

  it("strips deps that don't resolve", () => {
    const r = normalizeAddedTasks(
      { tasks: [{ id: "T3", title: "a", deps: ["T1", "Tnope"] }] },
      new Set(["T1"]),
    );
    assert.deepEqual(r!.tasks[0]!.deps, ["T1"]);
    assert.match(r!.warnings.join(" "), /unknown deps: Tnope/);
  });

  it("returns undefined for empty/non-array tasks", () => {
    assert.equal(normalizeAddedTasks({}, new Set()), undefined);
    assert.equal(normalizeAddedTasks({ tasks: [] }, new Set()), undefined);
    assert.equal(normalizeAddedTasks(null, new Set()), undefined);
  });
});

describe("formatPlanSummary", () => {
  it("renders task count, cap, and each task line", () => {
    const tasks = [
      task("T1"),
      task("T2", ["T1"]),
    ];
    const out = formatPlanSummary(tasks, 1);
    assert.match(out, /2 tasks/);
    assert.match(out, /cap 1/);
    assert.match(out, /T1/);
    assert.match(out, /T2/);
    assert.match(out, /depends on T1/);
    assert.match(out, /no deps/);
  });

  it("uses singular 'task' for n=1", () => {
    const out = formatPlanSummary([task("T1")], 1);
    assert.match(out, /1 task /);
  });
});
