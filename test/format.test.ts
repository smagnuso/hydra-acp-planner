import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectFindings, formatBoardContext, formatCompletionFindings, formatSessionsTable, formatStatus } from "../src/format.ts";
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
    assert.match(out, /\[x\] T1/);
    assert.match(out, /\[~\] T2/);
    assert.match(out, /\[ \] T3/);
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
    assert.match(out, /\{code-claude·opus-4-7\}/);
  });

  it("renders a model-only tag when only model is set", () => {
    const out = formatStatus(
      board({ tasks: [task("T1", { model: "opus-4-7" })] }),
      true,
    );
    assert.match(out, /\{opus-4-7\}/);
  });

  it("appends a Sessions table when an orchestrator id is provided", () => {
    const out = formatStatus(
      board({
        workers: {
          hydra_session_AAAAAAAABBBBBBBB: { currentTaskId: "T1", tasksCompleted: [] },
        },
        tasks: [task("T1", { status: "assigned", assignedTo: "hydra_session_AAAAAAAABBBBBBBB" })],
      }),
      true,
      "hydra_session_ORCHESTRATORXXXX",
    );
    assert.match(out, /Sessions:/);
    assert.match(out, /ROLE\s+SESSION\s+TASK\s+STATE\s+AGENT·MODEL\s+DONE\s+COST\s+TOKENS\s+TITLE/);
    assert.match(out, /orchestrator/);
    assert.match(out, /worker\s+\S*BBBBBBBB\s+T1/);
  });

  it("omits the Sessions table when no orchestrator id is given and no workers exist", () => {
    const out = formatStatus(board(), true);
    assert.doesNotMatch(out, /Sessions:/);
  });

  it("places the Planner line before task list and Sessions header", () => {
    const out = formatStatus(
      board({
        tasks: [task("T1", { status: "pending" })],
        workers: { hydra_session_WORKER1: { currentTaskId: null, tasksCompleted: [] } },
      }),
      true,
      "hydra_session_ORCHXXXXYYYY",
    );
    const lines = out.split("\n");
    const plannerIdx = lines.findIndex((l) => l.startsWith("   Planner:"));
    const taskLineIdx = lines.findIndex((l) => /\[ \] T1/.test(l));
    const sessionsIdx = lines.findIndex((l) => l.startsWith("   Sessions:"));
    assert.ok(plannerIdx >= 0, "should have a Planner line");
    assert.ok(taskLineIdx >= 0, "should have a task line");
    assert.ok(sessionsIdx >= 0, "should have a Sessions header");
    assert.ok(
      plannerIdx < taskLineIdx,
      `Planner line (line ${plannerIdx}) must appear before task list (line ${taskLineIdx})`,
    );
    assert.ok(
      plannerIdx < sessionsIdx,
      `Planner line (line ${plannerIdx}) must appear before Sessions header (line ${sessionsIdx})`,
    );
  });

  it("renders a distill task with header, summary, findings (with sources), and recommended_action", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "superseded" }),
          task("T1a", { status: "superseded" }),
          task("T1b", { status: "superseded" }),
          task("T2", {
            kind: "review",
            reviews: ["T1", "T1a", "T1b"],
            status: "done",
          }),
          task("T2d", {
            kind: "distill",
            reviews: ["T1", "T1a", "T1b"],
            distillOf: "T2",
            status: "done",
            artifacts: {
              summary: "Three approaches; T1a is correct on hashing",
              findings: [
                {
                  claim: "T1a uses bcrypt; T1/T1b use sha256",
                  sources: ["T1", "T1a", "T1b"],
                  verdict: "keep",
                },
                {
                  claim: "T1b lacks rate limiting",
                  sources: ["T1b"],
                  verdict: "drop",
                },
              ],
              recommended_action: "apply T1a",
            } as unknown as Task["artifacts"],
          }),
        ],
      }),
      true,
    );
    assert.match(out, /T2d\s+Task T2d.*Distilled from T1, T1a, T1b/);
    assert.match(out, /summary: Three approaches; T1a is correct on hashing/);
    assert.match(out, /findings:/);
    assert.match(
      out,
      /- T1a uses bcrypt; T1\/T1b use sha256 \(keep\)\s+sources: \[T1, T1a, T1b\]/,
    );
    assert.match(
      out,
      /- T1b lacks rate limiting \(drop\)\s+sources: \[T1b\]/,
    );
    assert.match(out, /recommended_action: apply T1a/);
  });

  it("does not regress competition review rendering when a distill is also present", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "awaiting_review" }),
          task("T1a", { status: "awaiting_review" }),
          task("T2", {
            kind: "review",
            reviews: ["T1", "T1a"],
            status: "done",
          }),
        ],
      }),
      true,
    );
    assert.match(out, /T2\s+Task T2.*reviewees: \[T1, T1a\]/);
    assert.doesNotMatch(out, /Distilled from/);
  });

  it("renders a multi-reviewee review as a peer of its reviewees, after the last one", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "awaiting_review" }),
          task("T2", { status: "awaiting_review" }),
          task("T3", { status: "awaiting_review" }),
          task("T4", { kind: "review", reviews: ["T1", "T2", "T3"], status: "pending" }),
        ],
      }),
      true,
    );
    const lines = out.split("\n");
    const idxT3 = lines.findIndex((l) => /\bT3\b\s+Task T3/.test(l));
    const idxT4 = lines.findIndex((l) => /\bT4\b\s+Task T4/.test(l));
    assert.ok(idxT3 >= 0 && idxT4 >= 0, "T3 and T4 should both render");
    assert.ok(idxT4 > idxT3, `T4 (line ${idxT4}) must render after T3 (line ${idxT3})`);
    // Peer indent: same leading whitespace as a work task line (3 spaces before glyph).
    assert.match(lines[idxT4]!, /^   \[ \] T4\s+Task T4.*reviewees: \[T1, T2, T3\]$/);
    assert.match(lines[idxT3]!, /^   \[\*\] T3\s+Task T3/);
  });

  it("renders a multi-source distill task at peer level with 'Distilled from' annotation", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "done" }),
          task("T2", { status: "done" }),
          task("T3", { status: "done" }),
          task("T4", {
            kind: "distill",
            reviews: ["T1", "T2", "T3"],
            distillOf: "T2",
            status: "done",
          }),
        ],
      }),
      true,
    );
    const lines = out.split("\n");
    const idxT3 = lines.findIndex((l) => /\bT3\b\s+Task T3/.test(l));
    const idxT4 = lines.findIndex((l) => /\bT4\b\s+Task T4/.test(l));
    assert.ok(idxT4 > idxT3, "distill must render after last reviewee");
    assert.match(lines[idxT4]!, /^   \[x\] T4\s+Task T4.*Distilled from T1, T2, T3$/);
  });

  it("keeps single-reviewee synthesized reviews nested under their reviewee", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "awaiting_review" }),
          task("review-T1", {
            title: "Review T1",
            kind: "review",
            reviews: "T1",
            status: "pending",
          }),
        ],
      }),
      true,
    );
    const lines = out.split("\n");
    const idxT1 = lines.findIndex((l) => /\bT1\b\s+Task T1/.test(l));
    const idxR = lines.findIndex((l) => /review-T1/.test(l));
    assert.ok(idxR > idxT1, "review renders after its parent");
    // Nested indent: 4 spaces before glyph.
    assert.match(lines[idxR]!, /^    \[ \] review-T1\s+Review T1/);
    assert.doesNotMatch(lines[idxR]!, /reviewees:/);
  });

  it("coexists: single-reviewee reviews nest while multi-reviewee referees render at peer level", () => {
    const out = formatStatus(
      board({
        tasks: [
          task("T1", { status: "awaiting_review" }),
          task("review-T1", { kind: "review", reviews: "T1", status: "pending" }),
          task("T2", { status: "awaiting_review" }),
          task("T3", { status: "awaiting_review" }),
          task("Tref", {
            title: "Referee",
            kind: "review",
            reviews: ["T2", "T3"],
            status: "pending",
          }),
        ],
      }),
      true,
    );
    const lines = out.split("\n");
    const idxNested = lines.findIndex((l) => /review-T1/.test(l));
    const idxPeer = lines.findIndex((l) => /Tref\b/.test(l));
    assert.match(lines[idxNested]!, /^    \[ \] review-T1/);
    assert.match(lines[idxPeer]!, /^   \[ \] Tref\s+Referee.*reviewees: \[T2, T3\]$/);
  });

  it("places the Planner line before task list when no Sessions table", () => {
    const out = formatStatus(
      board({ tasks: [task("T1", { status: "pending" })] }),
      false,
    );
    const lines = out.split("\n");
    const plannerIdx = lines.findIndex((l) => l.startsWith("   Planner:"));
    const taskLineIdx = lines.findIndex((l) => /\[ \] T1/.test(l));
    assert.ok(plannerIdx < taskLineIdx, `Planner line (line ${plannerIdx}) must appear before task list (line ${taskLineIdx})`);
  });
});

describe("formatSessionsTable", () => {
  it("returns empty string when there's nothing to show", () => {
    const out = formatSessionsTable(board(), undefined);
    assert.equal(out, "");
  });

  it("includes the orchestrator row when an id is given", () => {
    const out = formatSessionsTable(board({ description: "do a thing" }), "hydra_session_OOOOOOOOPPPPPPPP");
    assert.match(out, /orchestrator/);
    assert.match(out, /OOOOOOOOPPPPPPPP/);
    assert.match(out, /do a thing/);
  });

  it("rolls up tasksCompleted per worker into a DONE count", () => {
    const out = formatSessionsTable(
      board({
        workers: {
          hydra_session_WORKER1: { currentTaskId: null, tasksCompleted: ["T1", "T2"] },
        },
      }),
      undefined,
    );
    assert.match(out, /worker\s+\S*WORKER1\s+-\s+-\s+-\s+2/);
  });

  it("surfaces the AGENT|MODEL tag for the worker's current task", () => {
    const out = formatSessionsTable(
      board({
        workers: { hydra_session_WORKER2: { currentTaskId: "T7", tasksCompleted: [] } },
        tasks: [
          task("T7", { status: "assigned", assignedTo: "hydra_session_WORKER2", agent: "code-claude", model: "opus" }),
        ],
      }),
      undefined,
    );
    assert.match(out, /code-claude·opus/);
  });
});

describe("formatCompletionFindings", () => {
  it("returns empty string when nothing to surface", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("T1", { status: "done", artifacts: { summary: "did the thing" } }),
        ],
      }),
    );
    assert.equal(out, "");
  });

  it("surfaces work-task follow_ups (the T8-style hand-rolled review case)", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("T8", {
            title: "Final code review",
            status: "done",
            artifacts: {
              summary: "2 failures found; 24 checks pass",
              follow_ups: [
                "missing success message at agent-auth.ts:48",
                "WS not closed on error path at agent-auth.ts:198-207",
              ],
            },
          }),
        ],
      }),
    );
    assert.match(out, /^Findings:/);
    assert.match(out, /T8 {2}Final code review/);
    assert.match(out, /2 failures found/);
    assert.match(out, /agent-auth\.ts:48/);
    assert.match(out, /agent-auth\.ts:198-207/);
  });

  it("surfaces review-kind tasks with non-approve decisions, including notes", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("review-T3", {
            kind: "review",
            reviews: "T3",
            status: "done",
            artifacts: {
              summary: "reject",
              ...({ review_decision: "reject", notes: "spec says X but diff shows Y" } as object),
            },
          }),
        ],
      }),
    );
    assert.match(out, /\[reject\] review-T3/);
    assert.match(out, /spec says X but diff shows Y/);
  });

  it("omits approved review-kind tasks", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("review-T1", {
            kind: "review",
            reviews: "T1",
            status: "done",
            artifacts: {
              summary: "approve",
              ...({ review_decision: "approve", notes: "lgtm" } as object),
            },
          }),
        ],
      }),
    );
    assert.equal(out, "");
  });

  it("surfaces completed distill tasks with their report", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("distill-review-T3", {
            title: "Distill of T3 reviews",
            kind: "distill",
            status: "done",
            reviews: ["review-T3a", "review-T3b"],
            artifacts: {
              summary: "merged 2 reviews; both agree on missing teardown",
              ...({
                findings: [
                  {
                    claim: "WS not closed on error path",
                    sources: ["review-T3a", "review-T3b"],
                    verdict: "keep",
                    evidence: "review-T3a:agent-auth.ts:198",
                  },
                ],
                recommended_action: "apply review-T3a",
                applied_winner: "review-T3a",
              } as object),
            },
          }),
        ],
      }),
    );
    assert.match(out, /\[distill\] distill-review-T3/);
    assert.match(out, /recommended_action: apply review-T3a/);
    assert.match(out, /applied_winner: review-T3a/);
    assert.match(out, /\[keep\] WS not closed/);
    assert.match(out, /sources: review-T3a,review-T3b/);
  });

  it("surfaces failed tasks with their summary", () => {
    const out = formatCompletionFindings(
      board({
        tasks: [
          task("T4", {
            status: "failed",
            artifacts: { summary: "compile error in foo.ts" },
          }),
        ],
      }),
    );
    assert.match(out, /\[!\] T4/);
    assert.match(out, /compile error in foo\.ts/);
  });
});

describe("collectFindings", () => {
  it("returns empty list for a clean board", () => {
    const out = collectFindings(
      board({
        tasks: [task("T1", { status: "done", artifacts: { summary: "ok" } })],
      }),
    );
    assert.deepEqual(out, []);
  });

  it("categorizes a failed task as 'failed'", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("T1", { status: "failed", artifacts: { summary: "boom" } }),
        ],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].category, "failed");
    assert.equal(out[0].summary, "boom");
    assert.equal(out[0].kind, "work");
  });

  it("categorizes review reject/amend/fix decisions correctly", () => {
    const mk = (id: string, decision: string): Task =>
      task(id, {
        kind: "review",
        reviews: id.replace("review-", ""),
        status: "done",
        artifacts: {
          summary: decision,
          ...({ review_decision: decision, notes: `notes-${decision}` } as object),
        },
      });
    const out = collectFindings(
      board({
        tasks: [mk("review-T1", "reject"), mk("review-T2", "amend"), mk("review-T3", "fix")],
      }),
    );
    assert.equal(out.length, 3);
    assert.equal(out[0].category, "review_reject");
    assert.equal(out[1].category, "review_amend");
    assert.equal(out[2].category, "review_fix");
    for (const f of out) {
      assert.equal(f.kind, "review");
      assert.ok(f.notes && f.notes.startsWith("notes-"));
    }
  });

  it("omits approve/winner/synthesize unless includeApproved=true", () => {
    const tasks: Task[] = [
      task("review-T1", {
        kind: "review",
        reviews: "T1",
        status: "done",
        artifacts: {
          summary: "approve",
          ...({ review_decision: "approve", notes: "lgtm" } as object),
        },
      }),
    ];
    assert.equal(collectFindings(board({ tasks })).length, 0);
    const withApproved = collectFindings(board({ tasks }), { includeApproved: true });
    assert.equal(withApproved.length, 1);
    assert.equal(withApproved[0].decision, "approve");
  });

  it("surfaces work-task follow_ups", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("T8", {
            title: "Final code review",
            status: "done",
            artifacts: {
              summary: "2 failures",
              follow_ups: ["fix:48", "fix:198-207"],
            },
          }),
        ],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].category, "follow_ups");
    assert.deepEqual(out[0].followUps, ["fix:48", "fix:198-207"]);
  });

  it("emits a distill finding for a completed distill task with mirrored report", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("distill-review-T1", {
            title: "Distill of T1 reviews",
            kind: "distill",
            status: "done",
            reviews: ["review-T1a", "review-T1b"],
            artifacts: {
              summary: "merged 2 reviews",
              ...({
                findings: [
                  {
                    claim: "missing teardown",
                    sources: ["review-T1a", "review-T1b"],
                    verdict: "keep",
                    evidence: "review-T1a:foo.ts:10",
                  },
                  {
                    claim: "noisy log",
                    sources: ["review-T1a"],
                    verdict: "drop",
                    evidence: "review-T1a:bar.ts:5",
                  },
                ],
                recommended_action: "apply review-T1a",
                applied_winner: "review-T1a",
                unresolved: ["test coverage for retry path"],
              } as object),
            },
          }),
        ],
      }),
    );
    assert.equal(out.length, 1);
    const f = out[0]!;
    assert.equal(f.category, "distill");
    assert.equal(f.kind, "distill");
    assert.ok(f.distillReport);
    assert.equal(f.distillReport!.recommendedAction, "apply review-T1a");
    assert.equal(f.distillReport!.appliedWinner, "review-T1a");
    assert.equal(f.distillReport!.findings.length, 2);
    assert.deepEqual(f.distillReport!.findings[0]!.sources, ["review-T1a", "review-T1b"]);
    assert.deepEqual(f.distillReport!.unresolved, ["test coverage for retry path"]);
  });

  it("populates reworkBrief on distill findings recommending rework", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("distill-review-T2", {
            kind: "distill",
            status: "done",
            reviews: ["review-T2a"],
            artifacts: {
              summary: "reviews disagree on approach",
              ...({
                findings: [
                  {
                    claim: "approach unclear",
                    sources: ["review-T2a"],
                    verdict: "defer",
                    evidence: "review-T2a:plan.md",
                  },
                ],
                recommended_action: "rework",
                rework_brief: "redo the parser to handle edge case X",
              } as object),
            },
          }),
        ],
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.distillReport!.recommendedAction, "rework");
    assert.equal(out[0]!.distillReport!.reworkBrief, "redo the parser to handle edge case X");
    assert.equal(out[0]!.distillReport!.appliedWinner, undefined);
  });

  it("filters by taskId when provided", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("T1", { status: "failed", artifacts: { summary: "x" } }),
          task("T2", { status: "failed", artifacts: { summary: "y" } }),
        ],
      }),
      { taskId: "T2" },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].taskId, "T2");
  });

  it("includes verified_diff when present", () => {
    const out = collectFindings(
      board({
        tasks: [
          task("T1", {
            status: "failed",
            artifacts: {
              summary: "x",
              verified_diff: { files: ["a.ts"], hunkCount: 2, sample: "..." },
            },
          }),
        ],
      }),
    );
    assert.equal(out[0].verifiedDiff?.files[0], "a.ts");
    assert.equal(out[0].verifiedDiff?.hunkCount, 2);
  });
});
