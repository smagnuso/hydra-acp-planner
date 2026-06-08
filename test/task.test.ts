import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepromptForResultPrompt,
  buildRepromptForReviewPrompt,
  buildResumeTaskPrompt,
  buildResumeReviewPrompt,
  buildTaskPrompt,
  buildReviewPrompt,
  extractResultBlock,
  extractReviewBlock,
  normalizeResult,
  normalizeReview,
  promptsFor,
  PROMPTS,
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

  it("omits the attached-files section when board.attachments is empty/undefined", () => {
    const t = task("T1");
    const p = buildTaskPrompt(t, board([t]));
    assert.doesNotMatch(p, /## Attached files/);
  });

  it("inlines attachments into the prompt under '## Attached files'", () => {
    const t = task("T1");
    const b = board([t]);
    b.attachments = [
      { path: "/abs/path/spec.md", content: "# spec\n\nphase 1: do the thing" },
      { path: "/abs/path/plan.md", content: "phase 2: review" },
    ];
    const p = buildTaskPrompt(t, b);
    assert.match(p, /## Attached files/);
    assert.match(p, /### \/abs\/path\/spec\.md/);
    assert.match(p, /phase 1: do the thing/);
    assert.match(p, /### \/abs\/path\/plan\.md/);
    assert.match(p, /phase 2: review/);
    // Warns the worker not to try reading it via tools (the common
    // failure mode this feature exists to fix).
    assert.match(p, /do NOT try to open them with the read tool/);
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

// ─── buildResumeTaskPrompt ──────────────────────────────────────────────

describe("buildResumeTaskPrompt", () => {
  it("identifies the task by id and title", () => {
    const p = buildResumeTaskPrompt(task("T3", { title: "Implement signup" }));
    assert.match(p, /T3 — Implement signup/);
  });

  it("calls out the resumption context", () => {
    const p = buildResumeTaskPrompt(task("T1"));
    assert.match(p, /resuming after restart/);
  });

  it("tells the agent not to redo the work if already done", () => {
    const p = buildResumeTaskPrompt(task("T1"));
    assert.match(p, /don't redo the work/);
  });

  it("still asks for the hydra-result block at end-of-message", () => {
    const p = buildResumeTaskPrompt(task("T1"));
    assert.match(p, /```hydra-result/);
  });
});

// ─── buildRepromptForResultPrompt ───────────────────────────────────────

describe("buildRepromptForResultPrompt", () => {
  it("identifies the task that's missing its result", () => {
    const p = buildRepromptForResultPrompt(task("T5"));
    assert.match(p, /T5 did not end with a `hydra-result` block/);
  });

  it("explicitly tells the worker not to redo the task", () => {
    const p = buildRepromptForResultPrompt(task("T1"));
    assert.match(p, /Do NOT redo the task/);
  });

  it("covers the failed-task case", () => {
    const p = buildRepromptForResultPrompt(task("T1"));
    assert.match(p, /Even if the task failed or was blocked/);
  });

  it("forbids tool calls and prose so a thinking-mode model emits only the block", () => {
    const p = buildRepromptForResultPrompt(task("T1"));
    assert.match(p, /Do NOT call any tools/);
    assert.match(p, /Do NOT explain/);
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

// ─── promptsFor ───────────────────────────────────────────────────────────

describe("promptsFor", () => {
  it("work entry produces identical output to legacy exports", () => {
    const t = task("T42", {
      title: "verify registry",
      why: "because tests",
      what: "no-op",
      constraints: "must be deterministic",
    });
    const b = board([t]);

    assert.equal(
      promptsFor("work").buildPrompt(t, b),
      buildTaskPrompt(t, b),
    );
    assert.equal(
      promptsFor("work").buildResumePrompt(t),
      buildResumeTaskPrompt(t),
    );
    assert.equal(
      promptsFor("work").buildRepromptPrompt(t),
      buildRepromptForResultPrompt(t),
    );
    assert.deepEqual(
      promptsFor("work").extractResult("```hydra-result\n{\"summary\":\"x\"}\n```"),
      extractResultBlock("```hydra-result\n{\"summary\":\"x\"}\n```"),
    );
    assert.deepEqual(
      promptsFor("work").normalizeResult({ summary: "y" }),
      normalizeResult({ summary: "y" }),
    );
  });

  it("review entry produces valid prompt", () => {
    const t = task("R1", { title: "Review auth PR", kind: "review" });
    const p = promptsFor("review").buildPrompt(t, board([t]));
    assert.match(p, /R1 — Review auth PR/);
    assert.match(p, /Review instructions/);
    assert.match(p, /approve/);
    assert.match(p, /reject/);
    assert.match(p, /amend/);
  });

  it("review promptsFor falls back to work for unknown kind", () => {
    // @ts-expect-error testing runtime fallback
    const entry = promptsFor("nonexistent");
    assert.equal(entry, PROMPTS.work);
  });
});

// ─── buildReviewPrompt ──────────────────────────────────────────────────

describe("buildReviewPrompt", () => {
  it("includes task id and title", () => {
    const t = task("R1", { title: "Review PR" });
    const p = buildReviewPrompt(t, board([t]));
    assert.match(p, /R1 — Review PR/);
  });

  it("includes review instructions", () => {
    const t = task("R1");
    const p = buildReviewPrompt(t, board([t]));
    assert.match(p, /Review instructions/);
    assert.match(p, /approve.*reject.*amend.*fix/s);
  });

  it("includes why/what/constraints when present", () => {
    const t = task("R1", {
      title: "x",
      why: "safety",
      what: "check code quality",
      constraints: "must be thorough",
    });
    const p = buildReviewPrompt(t, board([t]));
    assert.match(p, /\*\*Why:\*\* safety/);
    assert.match(p, /\*\*What:\*\* check code quality/);
    assert.match(p, /\*\*Constraints:\*\* must be thorough/);
  });

  it("includes hydra-result instructions", () => {
    const t = task("R1");
    const p = buildReviewPrompt(t, board([t]));
    assert.match(p, /```hydra-result/);
  });
});

// ─── extractReviewBlock ─────────────────────────────────────────────────

describe("extractReviewBlock", () => {
  it("parses a clean review result from hydra-result block", () => {
    const text = "Reviewed.\n\n```hydra-result\n{\"decision\":\"approve\",\"notes\":\"looks good\"}\n```";
    const r = extractReviewBlock(text) as { decision: string; notes: string };
    assert.equal(r.decision, "approve");
    assert.equal(r.notes, "looks good");
  });

  it("falls back to json block", () => {
    const text = "```json\n{\"decision\":\"reject\",\"notes\":\"needs work\"}\n```";
    const r = extractReviewBlock(text) as { decision: string };
    assert.equal(r.decision, "reject");
  });

  it("returns undefined for no fenced blocks", () => {
    assert.equal(extractReviewBlock("just prose"), undefined);
  });
});

// ─── normalizeReview ────────────────────────────────────────────────────

describe("normalizeReview", () => {
  it("normalizes approve decision", () => {
    const r = normalizeReview({ decision: "approve", notes: "LGTM" }) as {
      artifacts: { summary: string; review_decision?: string };
      warnings: string[];
    };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "approve");
    assert.equal(r.artifacts.review_decision, "approve");
    assert.equal(r.warnings.length, 0);
  });

  it("normalizes reject decision", () => {
    const r = normalizeReview({ decision: "reject", notes: "broken tests" }) as {
      artifacts: { summary: string; review_decision?: string };
      warnings: string[];
    };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "reject");
    assert.equal(r.artifacts.review_decision, "reject");
  });

  it("normalizes amend decision", () => {
    const r = normalizeReview({ decision: "amend", notes: "change API shape" }) as {
      artifacts: { summary: string; review_decision?: string };
      warnings: string[];
    };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "amend");
    assert.equal(r.artifacts.review_decision, "amend");
  });

  it("normalizes fix decision", () => {
    const r = normalizeReview({ decision: "fix", notes: "patched auth flow" }) as {
      artifacts: { summary: string; review_decision?: string };
      warnings: string[];
    };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "fix");
    assert.equal(r.artifacts.review_decision, "fix");
  });

  it("normalizes fix decision with applied flag", () => {
    const r = normalizeReview({
      decision: "fix",
      notes: "applied directly",
      applied: true,
    }) as { artifacts: { summary: string; review_decision?: string; applied?: boolean }; warnings: string[] };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "fix");
    assert.equal(r.artifacts.review_decision, "fix");
    assert.equal(r.artifacts.applied, true);
  });

  it("includes follow_ups when present", () => {
    const r = normalizeReview({
      decision: "approve",
      notes: "good",
      follow_ups: ["add tests", "update docs"],
    }) as { artifacts: { follow_ups?: string[] }; warnings: string[] };
    assert.deepEqual(r.artifacts.follow_ups, ["add tests", "update docs"]);
  });

  it("includes applied flag when present", () => {
    const r = normalizeReview({
      decision: "amend",
      notes: "applied locally",
      applied: true,
    }) as { artifacts: { applied?: boolean }; warnings: string[] };
    assert.equal(r.artifacts.applied, true);
  });

  it("warns when notes is missing", () => {
    const r = normalizeReview({ decision: "approve" }) as { warnings: string[] };
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /missing notes/);
  });

  it("returns undefined for invalid decision", () => {
    assert.equal(
      normalizeReview({ decision: "unknown" as unknown as "approve", notes: "x" }),
      undefined,
    );
  });

  it("returns undefined for non-object input", () => {
    assert.equal(normalizeReview(null), undefined);
    assert.equal(normalizeReview(undefined), undefined);
    assert.equal(normalizeReview("string"), undefined);
    assert.equal(normalizeReview([]), undefined);
  });

  it("filters non-string follow_ups entries", () => {
    const r = normalizeReview({
      decision: "approve",
      notes: "ok",
      follow_ups: ["valid", 42, "also valid"],
    }) as { artifacts: { follow_ups?: string[] }; warnings: string[] };
    assert.deepEqual(r.artifacts.follow_ups, ["valid", "also valid"]);
  });

  it("omits empty follow_ups array", () => {
    const r = normalizeReview({
      decision: "approve",
      notes: "ok",
      follow_ups: [],
    }) as { artifacts: { follow_ups?: string[] }; warnings: string[] };
    assert.equal(r.artifacts.follow_ups, undefined);
  });

  it("review entry matches review wrappers", () => {
    const t = task("R99", { title: "verify registry" });
    const b = board([t]);

    assert.equal(
      promptsFor("review").buildPrompt(t, b),
      buildReviewPrompt(t, b),
    );
    assert.equal(
      promptsFor("review").buildResumePrompt(t),
      buildResumeReviewPrompt(t),
    );
    assert.equal(
      promptsFor("review").buildRepromptPrompt(t),
      buildRepromptForReviewPrompt(t),
    );
    assert.deepEqual(
      promptsFor("review").extractResult("```hydra-result\n{\"decision\":\"approve\",\"notes\":\"ok\"}\n```"),
      extractReviewBlock("```hydra-result\n{\"decision\":\"approve\",\"notes\":\"ok\"}\n```"),
    );
    assert.deepEqual(
      promptsFor("review").normalizeResult({ decision: "reject", notes: "nope" }),
      normalizeReview({ decision: "reject", notes: "nope" }),
    );
  });
});

// ─── buildResumeReviewPrompt ────────────────────────────────────────────

describe("buildResumeReviewPrompt", () => {
  it("identifies the task by id and title", () => {
    const p = buildResumeReviewPrompt(task("R3", { title: "Review login" }));
    assert.match(p, /R3 — Review login/);
  });

  it("calls out the resumption context", () => {
    const p = buildResumeReviewPrompt(task("R1"));
    assert.match(p, /resuming after restart/);
  });

  it("still asks for the hydra-result block", () => {
    const p = buildResumeReviewPrompt(task("R1"));
    assert.match(p, /```hydra-result/);
  });
});

// ─── buildRepromptForReviewPrompt ───────────────────────────────────────

describe("buildRepromptForReviewPrompt", () => {
  it("identifies the task that's missing its result", () => {
    const p = buildRepromptForReviewPrompt(task("R5"));
    assert.match(p, /R5 didn't end with the required `hydra-result` block/);
  });

  it("explicitly says don't redo the review", () => {
    const p = buildRepromptForReviewPrompt(task("R1"));
    assert.match(p, /do NOT redo the review/);
  });
});

// ─── buildReviewPrompt — competition mode (Phase 8) ─────────────────────

describe("buildReviewPrompt — competition mode", () => {
  it("uses judge-mode template when multiple reviewees are listed", () => {
    const impl1 = task("T1", {
      status: "done",
      artifacts: { summary: "wrote auth.py" },
    });
    const impl2 = task("T2", {
      status: "done",
      artifacts: { summary: "used bcrypt instead" },
    });
    const judge = task("R1", {
      title: "Pick best auth",
      reviews: ["T1", "T2"],
    });
    const p = buildReviewPrompt(judge, board([impl1, impl2, judge]));
    assert.match(p, /You are the judge in a competition/);
    assert.match(p, /pick the best implementation/i);
    assert.match(p, /winner/i);
    assert.match(p, /synthesize/i);
  });

  it("lists each implementation's artifacts under its id", () => {
    const impl1 = task("T1", {
      status: "done",
      artifacts: { summary: "wrote auth.py", files_changed: ["src/auth.py"] },
    });
    const impl2 = task("T2", {
      status: "done",
      artifacts: { summary: "used bcrypt instead" },
    });
    const judge = task("R1", { reviews: ["T1", "T2"] });
    const p = buildReviewPrompt(judge, board([impl1, impl2, judge]));
    assert.match(p, /### T1 — T1/);
    assert.match(p, /wrote auth\.py/);
    assert.match(p, /### T2 — T2/);
    assert.match(p, /bcrypt instead/);
  });

  it("skips implementations that are not done or have no artifacts", () => {
    const impl1 = task("T1", {
      status: "done",
      artifacts: { summary: "wrote auth.py" },
    });
    const pending = task("T2", { status: "pending" });
    const doneNoArtifacts = task("T3", { status: "done" });
    const judge = task("R1", { reviews: ["T1", "T2", "T3"] });
    const p = buildReviewPrompt(judge, board([impl1, pending, doneNoArtifacts, judge]));
    assert.match(p, /### T1 — T1/);
    assert.doesNotMatch(p, /### T2 — T2/);
    assert.doesNotMatch(p, /### T3 — T3/);
  });

  it("uses single-reviewee template when only one reviewee", () => {
    const impl1 = task("T1", {
      status: "done",
      artifacts: { summary: "wrote auth.py" },
    });
    const judge = task("R1", { reviews: ["T1"] });
    const p = buildReviewPrompt(judge, board([impl1, judge]));
    assert.doesNotMatch(p, /You are the judge in a competition/);
    assert.match(p, /approve/);
    assert.match(p, /reject/);
  });

  it("uses single-reviewee template when reviews is not an array", () => {
    const impl1 = task("T1", {
      status: "done",
      artifacts: { summary: "wrote auth.py" },
    });
    const judge = task("R1", { reviews: "T1" as unknown as string[] });
    const p = buildReviewPrompt(judge, board([impl1, judge]));
    assert.doesNotMatch(p, /You are the judge in a competition/);
  });
});

// ─── normalizeReview — competition winner validation (Phase 8) ──────────

describe("normalizeReview — competition", () => {
  it("accepts decision 'winner'", () => {
    const r = normalizeReview(
      { decision: "winner", notes: "T1 is faster", winner: "T1" },
      ["T1", "T2"],
    ) as { artifacts: { summary: string; review_decision?: string; winner?: string }; warnings: string[] };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "winner");
    assert.equal(r.artifacts.review_decision, "winner");
    assert.equal(r.artifacts.winner, "T1");
    assert.equal(r.warnings.length, 0);
  });

  it("accepts decision 'synthesize'", () => {
    const r = normalizeReview(
      { decision: "synthesize", notes: "combine T1 speed with T2 security" },
      ["T1", "T2"],
    ) as { artifacts: { summary: string; review_decision?: string }; warnings: string[] };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "synthesize");
    assert.equal(r.artifacts.review_decision, "synthesize");
  });

  it("warns when winner is not in reviews list", () => {
    const r = normalizeReview(
      { decision: "winner", notes: "T3 wins", winner: "T3" },
      ["T1", "T2"],
    ) as { warnings: string[] };
    assert.ok(r);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /winner.*not found in reviews list/);
  });

  it("accepts winner when it is in reviews list", () => {
    const r = normalizeReview(
      { decision: "winner", notes: "T2 wins", winner: "T2" },
      ["T1", "T2"],
    ) as { artifacts; warnings: string[] };
    assert.ok(r);
    assert.equal(r.warnings.length, 0);
    assert.equal((r.artifacts as Record<string, unknown>).winner, "T2");
  });

  it("works without reviewsList (backward compatible)", () => {
    const r = normalizeReview(
      { decision: "winner", notes: "some winner", winner: "Tx" },
    ) as { artifacts; warnings: string[] };
    assert.ok(r);
    assert.equal(r.artifacts.summary, "winner");
    assert.equal((r.artifacts as Record<string, unknown>).winner, "Tx");
    assert.equal(r.warnings.length, 0);
  });

  it("rejects unknown decision values", () => {
    assert.equal(
      normalizeReview({ decision: "maybe" as unknown as "approve", notes: "x" }, ["T1"]),
      undefined,
    );
  });
});
