import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskPrompt,
  extractResultBlock,
  normalizeResult,
} from "../src/task.ts";
import type { Board, Task } from "../src/board.ts";

function task(id: string, opts: Partial<Task> = {}): Task {
  return {
    id,
    title: opts.title ?? id,
    deps: opts.deps ?? [],
    status: opts.status ?? "pending",
    attemptCount: opts.attemptCount ?? 0,
    ...opts,
  };
}

function board(tasks: Task[]): Board {
  return {
    version: 1,
    projectId: "proj_test",
    description: "test project",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fleetDefaults: { agent: null, model: null },
    tasks,
    workers: {},
    concurrencyCap: 1,
  };
}

// ─── buildTaskPrompt ────────────────────────────────────────────────────

describe("buildTaskPrompt", () => {
  it("includes title and id", () => {
    const t = task("T1", { title: "Build the thing" });
    const p = buildTaskPrompt(t, board([t]));
    assert.match(p, /T1/);
    assert.match(p, /Build the thing/);
  });

  it("omits why/what/constraints lines when those fields are absent", () => {
    const t = task("T1", { title: "minimal" });
    const p = buildTaskPrompt(t, board([t]));
    assert.doesNotMatch(p, /\*\*Why:\*\*/);
    assert.doesNotMatch(p, /\*\*What:\*\*/);
    assert.doesNotMatch(p, /\*\*Constraints:\*\*/);
  });

  it("includes why/what/constraints when present", () => {
    const t = task("T1", {
      title: "x",
      why: "user value",
      what: "outcome description",
      constraints: "must not break X",
    });
    const p = buildTaskPrompt(t, board([t]));
    assert.match(p, /\*\*Why:\*\* user value/);
    assert.match(p, /\*\*What:\*\* outcome description/);
    assert.match(p, /\*\*Constraints:\*\* must not break X/);
  });

  it("renders '(none)' when no completed dependencies exist", () => {
    const t = task("T1");
    const p = buildTaskPrompt(t, board([t]));
    assert.match(p, /no satisfied dependencies/);
  });

  it("inlines artifacts from completed dependencies", () => {
    const dep = task("T1", {
      status: "done",
      artifacts: {
        summary: "wrote auth.py",
        files_changed: ["src/auth.py"],
        decisions: ["bcrypt cost 12"],
      },
    });
    const t = task("T2", { deps: ["T1"] });
    const p = buildTaskPrompt(t, board([dep, t]));
    assert.match(p, /### T1 — T1/);
    assert.match(p, /wrote auth\.py/);
    assert.match(p, /bcrypt cost 12/);
  });

  it("skips deps that aren't done or have no artifacts", () => {
    const pending = task("T1");
    const failed = task("T2", { status: "failed" });
    const t = task("T3", { deps: ["T1", "T2"] });
    const p = buildTaskPrompt(t, board([pending, failed, t]));
    assert.match(p, /no satisfied dependencies/);
  });

  it("instructs the agent to emit a hydra-result block at end of message", () => {
    const t = task("T1");
    const p = buildTaskPrompt(t, board([t]));
    assert.match(p, /```hydra-result/);
    assert.match(p, /summary/);
    assert.match(p, /files_changed/);
    assert.match(p, /MUST appear at the very end/);
  });
});

// ─── extractResultBlock ─────────────────────────────────────────────────

describe("extractResultBlock", () => {
  it("returns parsed JSON for a clean hydra-result block", () => {
    const text = "Did the thing.\n\n```hydra-result\n{\"summary\":\"ok\"}\n```";
    const r = extractResultBlock(text) as { summary: string };
    assert.equal(r.summary, "ok");
  });

  it("falls back to a json block when hydra-result label is absent", () => {
    const text = "result:\n```json\n{\"summary\":\"fell back\"}\n```";
    const r = extractResultBlock(text) as { summary: string };
    assert.equal(r.summary, "fell back");
  });

  it("picks the LAST json block when multiple are present (instructions say last)", () => {
    const text =
      "first ```json\n{\"summary\":\"first\"}\n``` then ```json\n{\"summary\":\"last\"}\n```";
    const r = extractResultBlock(text) as { summary: string };
    assert.equal(r.summary, "last");
  });

  it("prefers hydra-result over json fallback even if json appears later", () => {
    const text =
      "```hydra-result\n{\"summary\":\"real\"}\n```\nside note:\n```json\n{\"summary\":\"side\"}\n```";
    const r = extractResultBlock(text) as { summary: string };
    assert.equal(r.summary, "real");
  });

  it("returns undefined for no fenced blocks at all", () => {
    assert.equal(extractResultBlock("just prose"), undefined);
  });

  it("returns undefined for malformed JSON inside the fence", () => {
    const text = "```hydra-result\n{not valid\n```";
    assert.equal(extractResultBlock(text), undefined);
  });
});

// ─── normalizeResult ────────────────────────────────────────────────────

describe("normalizeResult", () => {
  it("returns artifacts when summary is present", () => {
    const r = normalizeResult({ summary: "did it" });
    assert.ok(r);
    assert.equal(r!.artifacts.summary, "did it");
    assert.equal(r!.warnings.length, 0);
  });

  it("trims summary whitespace", () => {
    const r = normalizeResult({ summary: "  done  " });
    assert.equal(r!.artifacts.summary, "done");
  });

  it("returns undefined when summary is missing", () => {
    assert.equal(normalizeResult({ files_changed: ["a"] }), undefined);
  });

  it("returns undefined when summary is empty after trim", () => {
    assert.equal(normalizeResult({ summary: "   " }), undefined);
  });

  it("preserves string-array fields", () => {
    const r = normalizeResult({
      summary: "s",
      files_changed: ["a.py", "b.py"],
      decisions: ["chose X"],
      assumptions: ["assumed Y"],
      follow_ups: ["do Z later"],
    });
    assert.deepEqual(r!.artifacts.files_changed, ["a.py", "b.py"]);
    assert.deepEqual(r!.artifacts.decisions, ["chose X"]);
    assert.deepEqual(r!.artifacts.assumptions, ["assumed Y"]);
    assert.deepEqual(r!.artifacts.follow_ups, ["do Z later"]);
  });

  it("warns and ignores non-array values", () => {
    const r = normalizeResult({ summary: "s", files_changed: "not an array" });
    assert.equal(r!.artifacts.files_changed, undefined);
    assert.equal(r!.warnings.length, 1);
    assert.match(r!.warnings[0]!, /files_changed should be an array/);
  });

  it("filters non-string entries and warns", () => {
    const r = normalizeResult({
      summary: "s",
      files_changed: ["a.py", 42, "b.py"],
    });
    assert.deepEqual(r!.artifacts.files_changed, ["a.py", "b.py"]);
    assert.equal(r!.warnings.length, 1);
    assert.match(r!.warnings[0]!, /non-string entries/);
  });

  it("omits empty arrays from artifacts", () => {
    const r = normalizeResult({
      summary: "s",
      files_changed: [],
      decisions: [],
    });
    assert.equal(r!.artifacts.files_changed, undefined);
    assert.equal(r!.artifacts.decisions, undefined);
  });

  it("returns undefined for non-object input", () => {
    assert.equal(normalizeResult(null), undefined);
    assert.equal(normalizeResult(undefined), undefined);
    assert.equal(normalizeResult("string"), undefined);
    assert.equal(normalizeResult([]), undefined);
  });
});
