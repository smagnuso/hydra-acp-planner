# Workspace isolation, v2: task-owned workspaces, user-owned integration tree

Status: **proposal**. Supersedes the design implemented in commits
`5b46e7c` (cli), `cc6536f`, `063a054`, `729606d`, `3082253`, `9eb1e96`.
That implementation ships behind `isolation.mode`, which defaults to
`"off"`, so nothing in it is live — but `"per-task"` is **not safe to
enable** as built.

## Policy vs. mechanism

v1's defects were mechanical: landings raced, partial landings reported
success, reviewers couldn't see their subject, and handoff never worked.
"Work lands in the user's checkout" was *not* one of them — that is a
**policy**, and it belongs to the user, not the planner.

An earlier draft of this document got that wrong: it introduced a
planner-owned "plan workspace" (plus an idle session to hold it) to force
quarantine. That takes a decision away from the user and reimplements a
primitive they already have — they can `/hydra workspace start` in their
own session before planning, run the plan, and merge out when satisfied.
v1 already had the right instinct here and this document keeps it:

> A worker spawned under an isolated orchestrator forks from *that*
> workspace and lands back into it — no special-casing needed.

## The model

**The integration tree is the orchestrator lane's effective `cwd`,
whatever the user made it.**

- Orchestrator session running in the user's checkout → tasks land there.
- Orchestrator session started in a workspace (`/hydra workspace start`,
  `hydra session new --worktree`) → tasks land into that workspace, and the
  user's checkout is untouched until they merge it out themselves.

The planner never chooses. It reports what the integration tree is at
project start and lands into it.

**A workspace belongs to a task, not to a session.** It is created once, on
the task's first spawn, labeled `<shortProjectId>-<taskId>`. Every session
that subsequently needs that tree — a retry worker, a reviewer, a reviewer
applying a fix — **joins** it (`/hydra workspace start <label>`, the same
chat-text mechanism already used for merge/discard). It is discarded when
the task is superseded, and folded into the integration tree when accepted.

Joining requires the verb; it cannot be done by spawning with a matching
label. `resolveWorkspace` (`cli/src/core/session-manager.ts:967-990`) has no
join branch — it always calls `createWorkspace`, which routes the label
through `findFreeLabel` and **suffixes** it when taken. That is deliberate
(`provider.ts:695-704`): *"What must never happen is handing back an
EXISTING workspace: two sessions in one checkout is the failure this whole
mechanism exists to prevent."*

Two consequences:

- **The wrong path fails silently.** Requesting an existing label yields a
  valid but empty `<label>-2`; the only signal is `workspaceInfo.label`
  differing from what was asked. Compare them at every spawn and treat a
  mismatch as a bug — it means we requested a label we believed was free.
  This is exactly the live bug in v1: a rejected task's retry re-requests
  `T1`, gets `T1-2`, and silently orphans the rejected attempt's work.
- **Labels are single-use per repo.** A label is taken if *either* the
  directory or the `hydra/<label>` branch exists, and a branch outlives its
  checkout (`git-provider.ts:425-448`), so a label cannot be reclaimed by
  cleaning up the directory. Bare task ids would therefore collide across
  two plans in one repo that both contain a `T1` — hence the project-scoped
  prefix above.

## Which tasks get a workspace

Isolation buys exactly one thing: keeping concurrent writers off each
other. So it is **derived from DAG shape, not applied blanket**. A plan
that cannot produce two simultaneous writers gets no workspaces at all and
behaves precisely as the planner does today — no new machinery, no new
failure modes, no cost.

- **Work tasks** — isolated only when they can overlap another writing
  task. `concurrencyCap` is already derived from the DAG's sweep-line
  width (`sweepLineConcurrencyCap`), so `cap === 1` means a chain, and a
  chain isolates nothing. Competition siblings overlap by construction and
  are always isolated (and always `required: true`, since a silent
  fallback would put candidates back in one tree — the soundness bug).
- **Review tasks** — never get their own workspace. A review joins its
  subject's workspace when the subject has one, and otherwise runs in the
  integration tree exactly as it does today. Reviews are read-mostly, and
  the one case that writes (`fix`) belongs in the subject's tree anyway.
- **Distill tasks** — never isolated. `DISTILL_SYSTEM` is explicit: *"You
  do not write code. You do not merge diffs."* A distiller reads its
  candidates' paths and emits a report.

A useful consequence: concurrent landings only exist where there was
concurrency to begin with, which bounds the blast radius of the
landing-race rules below.

## Lifecycle

**Project start.** Resolve the integration tree (orchestrator's effective
cwd). Report it and its cleanliness to the user, because isolation changes
what workers can see (below). Refuse or warn per `isolation.required`.

**Task spawn.** A task that needs isolation (see *Which tasks get a
workspace*) spawns with a `workspace` request labeled by task id —
atomically, at session creation, via the `child_session/spawn` threading
added in `5b46e7c`. Orchestrator-lane work is by definition *in* the
integration tree and is never isolated.

Creation is deliberately **not** routed through `/hydra workspace start`.
That verb is a *swap*: it respawns the agent in the new cwd, so creating
this way would boot an agent in the integration tree and immediately tear
it down and reboot it in the workspace — double startup per task — and it
opens a window where the agent exists in the integration tree, closed only
by trusting prompt-queue ordering. Atomic creation has neither problem.
`start` is used only for **joining** (below), which is a distinct,
carry-free path (`cli/src/core/session-manager.ts:3837`: *"the join carries
no risk at all, because there is nothing to carry"*).

**Workers commit.** The work prompt gains an explicit instruction to commit
in the workspace before emitting its `hydra-result` block. Without this,
landings replay work as *loose, uncommitted* edits, and the next
`clean: true` fork discards them — which is why v1's handoff failed even
for a strictly sequential chain. There is no commit verb on the wire, so
this has to be a prompt-contract change rather than something the planner
does on the task's behalf.

**Review joins the subject's workspace.** Under isolation, reviews run on
the **worker lane** (only a spawned session can be given a directory; the
orchestrator's cwd is fixed at session creation), and the reviewer joins
its subject's workspace. It therefore sees exactly the change under review,
isolated from every other task, and can run its tests — which is what
`REVIEW_SYSTEM` has always assumed.

**Iteration stays in the worker lane.** Reject → retask → rework → re-review
all happen inside the task's own workspace. Nothing reaches the integration
tree until the review accepts.

**Acceptance folds it in.** On approval, the work lands into the
integration tree, issued by whichever session holds the binding — normally
the reviewer, so no cold-worker resurrection is needed. Tasks with no
review land at `markTaskDone`, issued by their own worker.

**Competition.** N candidates, N workspaces, all forked from the same
integration-tree state. The judge cannot join N workspaces, so it runs in
the integration tree with every candidate's path in its prompt and reads
and tests each in place. Winner folds in; losers' workspaces are discarded.

## Two follow-ups this dissolves

- **`canApplyFixes` + isolation.** A reviewer sharing its subject's tree can
  legitimately apply `fix` edits — they land in the right tree and fold in
  on approval, as part of the same landing. The two-turn
  "describe-then-apply" dance is unnecessary. The rule reduces to: *fixes
  are allowed when the reviewer shares the reviewee's tree* — true
  unisolated (shared cwd) and true under isolation (joined workspace).
- **Cold-worker resurrection.** The joined reviewer holds a real binding and
  issues the landing itself.

## Workspace lifecycle and teardown

Every lane of work needs a defined terminal transition for its workspace,
including the abnormal ones. v1 specified two (land on accept, discard on
supersede) and left the rest undefined, which is how a workspace ends up in
a state that breaks whatever touches it next.

### Terminal transitions

| Task outcome | Workspace |
| --- | --- |
| accepted (approved, or done with no review) | land into the integration tree, then discard; the work now lives in the integration tree and the label is freed |
| superseded (competition loser, distill-superseded) | discard |
| failed (review rejected past `maxAttempts`, or hard worker failure) | **retain and report** — this holds the only copy of real work; never auto-delete it |
| project stopped / cancelled | retain; record on the board so a resume rejoins rather than re-creates |
| landing declined or unconfirmed | retain, project pauses, finding raised (see *Correctness rules*) |

The rule underneath: **a workspace is only ever discarded when its contents
are provably redundant** — either landed, or explicitly superseded by a
winner. Anything else is retained, because the alternative is destroying
the only copy of work an agent produced.

### Abnormal paths

- **Cancel mid-landing.** The daemon's landing is not atomic (capture →
  integrate → `reset --hard` → replay). A cancel between the reset and the
  replay would leave the integration tree reset but not replayed — work
  gone from the tree and present only in the workspace. The landing mutex
  therefore **drains rather than interrupts**: an in-flight landing runs to
  completion, and cancellation only prevents new ones from starting.
- **In-progress integration.** `sync` deliberately leaves a conflicted merge
  in place for an agent to resolve. A workspace in that state must be
  detected (`/hydra workspace status`, or the provider's
  `integrationInProgress`) and **refused** rather than operated on; piling
  a landing onto a half-finished merge is how a tree gets wedged.
- **Crash between creation and board write.** Creation is atomic at spawn,
  so the workspace exists before the planner records it; a crash in that
  window leaves a directory nothing points at. The project-scoped label
  makes these findable: enumerate workspaces and match the
  `<shortProjectId>-` prefix.
- **Project restart** (`/hydra planner restart`, which resets every task to
  pending): existing workspaces are stale attempts. Retain and report them;
  do not silently reuse them for the new run and do not auto-delete them.
- **Project remove.** `src/cli.ts`'s `runRemove` shells out to
  `session remove` per worker and knows nothing about workspaces, so today
  it would leak every one. It needs to discard them, or explicitly report
  what it is leaving behind.

### Rehydrate reconciliation

On (re)attach, every task with a recorded workspace is checked against
reality. This mirrors the recovery table the earlier design doc worked out,
which is still right:

| Observed | Action |
| --- | --- |
| bound to an unfinished task, directory present | keep; a retry rejoins it |
| landed already, nothing references it | prune |
| orphaned but holding uncommitted work | **keep and report** — never auto-delete |
| recorded but directory missing | clear the record; report, since the branch may still hold the work |

### Integration tree end-state

Project completion reports the integration tree's path *and* its state —
clean, or holding unlanded work from a paused landing. A run that ends with
a declined landing must say so at the top of the summary rather than only
in `get_findings`, because the user's next action (commit? inspect? rerun?)
depends on it.

## Correctness rules

These are model-independent and must not be dropped again:

1. **Serialize landings, and serialize workspace creation against them.**
   The daemon is explicit (`cli/src/core/workspace/refs.ts:56-61`): *"Two
   landings into one source tree are hazardous… both `reset --hard` the
   same directory. Serialize merges yourself."* Landing hard-resets the
   target, so a fork taken mid-reset captures a torn state — guarding
   landings against each other is only half of it.
2. **Treat any `WARNING:` in a merge reply as not-landed.** A failed replay
   still returns a reply head-lined `Merged …`; v1 classified that as
   `landed`, and has a test asserting it. Invert both.
3. **Gate dependents on a clean confirmation.** Anything other than a
   warning-free `Merged …` pauses the project and raises a finding naming
   the task, its workspace path, and its live session. Do not mark the task
   `failed` (the work exists); do not let dependents proceed (they would
   build on a tree missing their dependency).

## The user's uncommitted work

The two creation paths differ deliberately:

- **`session/new` + `workspace` request** — clean by construction.
  `resolveWorkspace` (`cli/src/core/session-manager.ts:1052-1058`):
  *"Isolation at session/new never copies the source's uncommitted work
  (unlike mid-session `start`), so this is a clean workspace by
  construction and its anchor is the base commit."*
- **mid-session `/hydra workspace start`** — carries the source's
  uncommitted work in (`startWorkspace`, `:3970-4014`, via
  `captureWorkingState`), with `--clean` as the opt-out.

This design takes the clean path, deliberately. Carrying WIP into N
parallel workspaces means N copies of the user's half-finished edits, each
task free to modify them, each landing replaying against an anchor while
the original still sits in the integration tree — handled by the daemon
(that is what the overlap warning at `:3301-3314` is for) but it is the
messy path. Clean-from-HEAD means every task starts from a known committed
state and the user's WIP stays theirs.

The cost is a real behavior change from today, and must be surfaced rather
than buried: **under isolation, workers do not see the user's uncommitted
changes**, where unisolated they would. Report it at project start —
"isolation on; N tasks start from HEAD and will not see your uncommitted
changes" — so the user can commit or stash first if the plan was meant to
build on WIP.

If that turns out to bite in practice, the fix is to ask the daemon for a
way to fork from a dirty snapshot (`WorkspaceRequestMeta.from` already
exists; what is missing is any wire path to *obtain* such a snapshot), not
to reintroduce a two-step spawn.

## Behavior changes the user should be told about

- **Workers do not see uncommitted changes** in the integration tree
  (above). Report at project start.
- **Reviews get slower and costlier under isolation**, since they are forced
  onto the worker lane instead of running inline on the orchestrator. This
  applies only to reviews of isolated tasks; in a linear plan nothing is
  isolated and reviews stay inline.

## What survives from v1

Reusable as-is: the `child_session/spawn` workspace threading (`5b46e7c`)
— still exactly the protocol needed, no further daemon changes required —
the board schema fields, `sendWorkspaceCommand` and the one-shot
`session/update` reply listener, `classifyMergeReply` /
`classifyDiscardReply` (with the warning fix), `discardSupersededTaskWorkspace`,
the `workspace_unmerged` finding category, and the `⚠ unmerged` panel tag.

Changes: isolation scoped by DAG shape rather than applied to every task,
task-owned workspaces with join-on-reuse for retries and reviews, review
forced to the worker lane and joined to its subject, judge prompt carrying
candidate paths, the landing/creation mutex, dependent gating, warning
handling, and a start-of-run report of the integration tree and its
isolation semantics.

**Workers must commit** — and this is a direct consequence of choosing
atomic/clean creation over the carry-in path. The two decisions are
coupled, and it is worth being explicit about why, because getting it wrong
is what broke v1's handoff:

- An agent that never commits leaves its branch empty, so landing's
  integrate is a no-op and the daemon replays the work into the
  integration tree as **loose, uncommitted** edits.
- The next task's workspace is created `clean: true` — forked from **HEAD**
  — which does not include those loose edits.
- Therefore the dependent cannot see its dependency's work.

Committing in the workspace makes the landing a real fast-forward, so the
integration tree's HEAD actually advances and the next clean fork inherits
everything. There is no commit verb on the wire, so this has to be a
prompt-contract change in the work prompt rather than something the planner
does on the task's behalf.

(Under the rejected carry-in creation path this would have been optional,
since a carried fork picks up loose edits. That is the one real argument
for carry-in, and it is not enough to outweigh double agent startup and the
ordering window.)

## Prerequisite spikes

1. **Does `/hydra workspace start <label>` work from a transformer-spawned
   child — both to create and to join — and can such a session then issue
   the landing?** This is now the single most load-bearing unknown, since
   every workspace in this design is created and attached through that one
   verb. The daemon has a test for two sessions sharing a workspace;
   confirm it holds for a child session, that the joined session gets a
   real binding, and that the injected `start` can be sequenced ahead of
   the task prompt so the agent never takes a turn in the integration tree.
2. **Does `merge` refuse on a *shared* workspace?** `discard` does. If merge
   does too, the subject's worker must be closed before the reviewer joins
   — true on the default path already, but not under
   `onReject.strategy: "continue"`, which deliberately keeps the worker
   alive.
3. **Provider behavior when `sourceCwd` is itself a workspace** (the
   orchestrator-in-a-workspace case). The git primitive works — verified by
   spike: a worktree forked from another worktree fast-forwards back into
   it and leaves the original checkout untouched — but `createWorkspace`
   bookkeeping and `workspaceRootFor` hashing on a worktree source are
   unverified.

## Open questions

- Should a `"fresh"` `onReject` strategy get a clean workspace rather than
  joining the existing one? Joining matches today's unisolated semantics
  (a rejected attempt stays in the tree and is iterated on), so joining is
  the default here; a true clean-slate retry would be a separate option.
- What happens to task workspaces when a project is stopped, restarted, or
  forked? Restart should probably rejoin; fork should probably branch fresh
  ones from the integration tree.
- Is warning the user about a dirty integration tree enough, or should
  `isolation.required` refuse to start on one?

## Interim guardrail

Until this lands, `set_plan` should reject `isolation.mode: "per-task"`
with a message pointing here, so an agent reading the tool schema cannot
reasonably conclude the feature works and turn it on.
