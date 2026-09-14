# Distiller role for competition reviews

## Goal

Turn `decision: "synthesize"` from a competition reviewer into a real
merge step instead of the current dead branch (which fails all
reviewees). A new `kind: "distill"` task consumes N candidate outputs
and the reviewer's "no clear winner" rationale, and emits a structured,
source-cited report.

## Background

- Competition today: N work tasks + 1 `kind:"review"` referee with
  `reviews: string[]` (src/decomposition.ts:82, src/task.ts:406).
- Referee returns `winner` or `synthesize` (src/task.ts:109).
- `winner` works (src/bridge.ts:4787). `synthesize` is a stub: it falls
  through `handleReviewWinner` with no `winnerId` and fails all
  reviewees (src/bridge.ts:4504, 4847).

This plan wires `synthesize` to spawn a new distiller task that produces
a cited merge report, then unblocks dependents.

## Non-goals (v1)

- Auto-merging diffs. Distiller produces a **report** plus an optional
  `rework_brief` that seeds a follow-up work task. Code merge is left
  to that follow-up.
- Distillation of multiple reviewers on one work task. Same primitive,
  but requires review-policy fan-out work; out of scope.
- Distiller-of-distillers.

## Design decisions (locked)

1. `fleetDefaults.distill` falls through to `fleetDefaults.review` for
   agent/model defaults.
2. Distiller may override the judge: `recommended_action: "apply Tx"`
   is honored (treat Tx as winner, supersede the rest).
3. Distill report is also surfaced as `artifacts.distill` on the
   originating review task so consumers that only know the review id
   still find the merged output.
4. Distill max-attempts exhaustion fails all reviewees with feedback
   `"distill <id>: max attempts exceeded"` — matches existing
   no-valid-winner safety net.
5. Distiller authorship is **bridge-only**. Decomposer cannot emit
   `kind:"distill"` tasks; they're synthesized from `synthesize`
   decisions.
6. Findings carry mandatory `sources: string[]` citations validated
   against `task.reviews`. Unciteable prose is the failure mode we're
   designing against.

## Task DAG

T1, T1a, T1b — work tasks (competition siblings, authored by decomposer)
T2          — review referee, `reviews:[T1,T1a,T1b]` (authored by decomposer)

When T2 returns `synthesize`, the bridge synthesizes:

T2d         — distill, `reviews:[T1,T1a,T1b]`, `distillOf:T2`, deps same

Any task that had `T2` in its deps gets `T2d` appended.

## Plan

### T1 — Schema + fleet defaults

**Files:** src/board.ts, src/mcp-tools.ts, src/types or wherever
`fleetDefaults` lives.

- Extend `Task.kind` to `"work" | "review" | "distill"` (src/board.ts:98).
- Add `Task.distillOf?: string` (id of the originating review task).
- Add `fleetDefaults.distill` (agent, model) with fall-through to
  `fleetDefaults.review` resolved at dispatch time, not at config load.
- Update `mcp-tools.ts` `kind` enum docs (src/mcp-tools.ts:208) to
  state `distill` is bridge-synthesized and decomposer must not emit it.
- Add validator in the plan-acceptance path that rejects decomposer
  output containing `kind:"distill"`.

**Acceptance:** unit tests cover (a) board can persist a distill task,
(b) `fleetDefaults.distill` falls through to review, (c) decomposer
emitting `kind:"distill"` is rejected.

**No deps.**

### T2 — Decision split + `handleReviewSynthesize` skeleton

**Files:** src/bridge.ts.

- Split `case "winner" | "synthesize":` at src/bridge.ts:4528-4530 into
  two cases.
- Remove the `synthesize`-treated-as-bad-winner log at
  src/bridge.ts:4507-4513; `synthesize` is now valid by construction.
- Add `handleReviewSynthesize(reviewTask, normalized, notes, board, sid)`:
  - Mark `reviewTask` `done`.
  - Leave reviewees in their current status (typically
    `awaiting_review`).
  - Synthesize distill task: `id = ${reviewTask.id}d`,
    `kind:"distill"`, `deps:[...reviews]`, `reviews:[...reviews]`,
    `distillOf:reviewTask.id`, agent/model from fleet defaults.
  - Walk every task whose `deps` includes `reviewTask.id` and append
    the distill id (preserve `reviewTask.id` so history stays
    readable; the distill is just an additional gate).
  - Save board, emit plan update.

**Acceptance:** unit test (no LLM): inject a `synthesize` normalized
result via the same surface as today's competition tests; assert
distill task exists with right shape, dependents are rewired,
reviewees untouched.

**Deps:** T1.

### T3 — Distiller prompt + parser + validator

**Files:** src/task.ts.

- Add `REVIEW_RESULT_INSTRUCTIONS_DISTILL` near
  `REVIEW_RESULT_INSTRUCTIONS_COMPETITION` (src/task.ts:109). Schema:
  ```json
  {
    "summary": "string",
    "findings": [
      { "claim": "string",
        "sources": ["Tx", ...],     // non-empty, subset of task.reviews
        "verdict": "keep|drop|defer",
        "evidence": "Tx:path hunk N; ..." }
    ],
    "recommended_action": "apply Tx | rework | new-work",
    "rework_brief": "string (required if action != apply)",
    "unresolved": ["string", ...]
  }
  ```
- Add `PROMPTS.distill` entry (src/task.ts:227): assembles per-source
  bundles `## Candidate Tx` with each source's `artifacts` and the
  same `verified_diff` block the judge sees, plus `distillOf`'s
  reviewer notes as "why no winner was picked".
- Parser: mirrors `winner`-in-`reviews` validation at
  src/task.ts:485. Reject if any `findings[i].sources` entry is not
  in `task.reviews`. Reject if any finding has empty `sources`.
  Reject if `recommended_action` is `apply Tx` and `Tx` is not a
  reviewee. Reject if action is `rework`/`new-work` and `rework_brief`
  is missing.

**Acceptance:** task-prompt golden test for the distill prompt;
parser unit tests for each rejection case; happy-path parser test.

**Deps:** T1 (needs `kind:"distill"` to exist).

### T4 — `handleDistillComplete` + follow-up spawning

**Files:** src/bridge.ts, possibly src/review-policy.ts for the
follow-up work task authoring.

- Wire distill task completion into the existing per-kind completion
  switch (same place `handleReviewComplete` is reached today —
  src/bridge.ts:4483 caller).
- On distill complete:
  - If `recommended_action == "apply Tx"`: treat as winner — mark Tx
    `done`, supersede other reviewees, distill itself `done`. Mirror
    `handleReviewWinner` body (src/bridge.ts:4807-4845).
  - If `recommended_action == "rework"` or `"new-work"`: mark all
    reviewees `superseded`, distill `done`, spawn a new work task
    seeded with `rework_brief` whose deps replace the distill task in
    any rewired dependent's deps (or — simpler — make dependents
    depend on the new work task instead of the distill).
  - Surface the structured report onto `reviewTask.artifacts.distill`
    via `distillOf` lookup.
- Failure semantics: distill task hitting `maxAttempts` fails all
  reviewees with feedback `"distill <id>: max attempts exceeded"` and
  marks distill `failed`.

**Acceptance:** unit tests for each `recommended_action` branch and
the max-attempts branch. No live LLM.

**Deps:** T2, T3.

### T5 — Rendering + format constants

**Files:** src/render-reviews.ts, src/format.ts.

- Add distill render path (src/render-reviews.ts:26): header
  `"Distilled from T1, T1a, T1b"`, render `summary`, list `findings`
  with their `sources`, show `recommended_action`.
- `format.ts:533` `APPROVED_DECISIONS` is already correct (includes
  `synthesize`); verify and leave.

**Acceptance:** snapshot test of a distilled review's rendered form.

**Deps:** T1.

### T6 — Integration tests

**Files:** test/distill-integration.test.ts (new), mirroring
test/competition-integration.test.ts.

- `synthesize` → distill task created, deps rewired, reviewees
  untouched, dependents stay blocked.
- Distill completes with `apply Tx` → Tx done, others superseded,
  dependents unblock.
- Distill completes with `rework` → reviewees superseded, follow-up
  work task spawned with `rework_brief`, dependents depend on the new
  work task.
- Distill output with unknown source id → parser rejects, attempt
  count increments, retry.
- Distill output with empty `sources` on a finding → parser rejects.
- Distill max-attempts → all reviewees `failed` with the expected
  feedback string.
- Distill report surfaced on the originating review task's
  `artifacts.distill`.

**Acceptance:** all integration tests pass; `npm test` clean.

**Deps:** T1, T2, T3, T4, T5.

## Concurrency / sequencing notes

T1 is the foundation; T2, T3, T5 can run in parallel after T1. T4
needs T2 and T3. T6 needs everything.

## Risk register

- **Dep rewiring bug.** Easiest place to break the DAG. Mitigation:
  the T2 unit test asserts exact `deps` arrays on every previously
  dependent task.
- **Distiller drift into ungrounded prose.** Mitigated by mandatory
  `sources` + parser rejection. If we see the LLM gaming this with
  always-cite-everything, tighten by requiring `evidence` to name a
  specific file or hunk.
- **Review task already marked done before distill exists.** T2 marks
  the review done *after* synthesizing the distill task; if the
  process crashes between those two ops we restart with an orphan
  review. Add a board-level invariant check on rehydrate: a `done`
  review with `synthesize` decision must have a sibling distill task.
