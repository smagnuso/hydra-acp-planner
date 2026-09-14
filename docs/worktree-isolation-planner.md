# Worktree isolation, layer 2: planner branch topology

Status: **proposal**, not implemented. Consumes
[the daemon provisioning design](./worktree-isolation-daemon.md) but can be
prototyped before it lands (see Sequencing).

Scope: branch topology, integration policy, and the competition soundness bug.
Provisioning mechanics (creating worktrees, setup hooks, ports, teardown) are
the daemon's and are not repeated here.

## Motivating bug: competition is not sound today

Two verified facts that combine badly:

1. Workers spawn with `cwd` omitted, inheriting the orchestrator's tree
   (`src/bridge.ts:4540`). Every worker on a project shares one working tree.
2. `handleReviewWinner` sets losing candidates to `superseded`, but that is a
   pure bookkeeping status change. There is **no VCS mutation anywhere in
   `src/`**: no `git checkout`, `revert`, `stash`, `worktree`, or `commit`. The
   only subprocess in the codebase is `spawnSync("hydra-acp", ["session",
   "remove", …])` at `src/cli.ts:228`.

So in the competition lane, N workers implement the same task concurrently in
one tree. Their edits interleave, and when the judge picks a winner the losers'
edits are still present. `superseded` undoes nothing.

The judge can still attribute authorship, because `verified_diff` is derived
from per-session tool-call history rather than from the tree
(`src/task.ts:535`), so it knows who edited what. But no tree state exists in
which exactly one candidate is applied, which means the `REVIEW_SYSTEM` clause
instructing reviewers to run the tests (`src/task.ts:52`) is unsatisfiable
during a competition.

Not empirically reproduced; this is from reading the source. The two facts
above are unambiguous.

## Model: plan branch, line branches, integration worktree

- At project start, planner creates a **plan branch** from the user's HEAD and
  its own **integration worktree** for it. The user's checkout is never
  touched for the duration of the run.
- Each **dependency line** (a linear chain of tasks) gets a branch off the plan
  branch, in its own worktree, provisioned by the daemon as part of the worker
  session.
- Lines merge **into the plan branch** and never into each other.
- On project completion, the plan branch is either left for the user to inspect
  (default) or integrated into their branch.

Two properties fall out of this that the earlier per-task designs did not have:

**No base drift.** Nothing lands on the user's branch mid-run, so every line
branches from a stable plan-branch tip.

**Isolation stops being per-task.** It is a plan-level mode. An earlier draft
made it a per-task flag, which required propagating the flag through each
task's transitive downstream closure (otherwise a non-isolated dependent reads
a stale tree and produces plausible garbage). That problem does not exist here.

## Starting state: snapshotting a dirty tree

Workers usually *should* see the user's uncommitted work. The naive
implementation, `git stash push`, yanks their changes out of their working
tree, which is an unacceptable surprise. `git stash create` does not mutate
anything but omits untracked files, which is exactly where fresh work lives.

Zero-mutation snapshot including untracked files:

```
GIT_INDEX_FILE=$tmp git add -A
GIT_INDEX_FILE=$tmp git write-tree
git commit-tree <tree> -p HEAD -m "planner: starting snapshot"
```

The user's real index and working tree are untouched. The resulting commit
becomes the plan branch's first commit.

Configurable via `isolation.dirtyTree`: `"snapshot"` (default), `"ignore"`
(branch from HEAD, user's in-progress work invisible to workers), `"refuse"`
(fail at start).

## Topology rules

Dependency gating already requires deps to be `done` or `superseded`
(`src/board.ts:952`), and approve marks the reviewed task `done`. So the real
order is already T1, then review(T1), then T2. A reviewer inheriting T1's
worktree gets it to itself, with no in-progress T2 edits blended in. The
inheritance rule below is safe on that axis without new sequencing.

**Inheritance rule:**

> A task inherits its predecessor's worktree only when it has exactly one
> dependency **and** that dependency has exactly one dependent. Otherwise it
> forks a fresh worktree from the plan-branch tip, which requires its parents
> to have merged.

Consequences:

- **Linear chain:** one worktree, one branch, passed down the line. One merge
  at the tail.
- **Fan-out** (T2, T3 both depend on T1): each forks its own branch from T1's
  tip. Two lines, two merges. The second merge may conflict with the first,
  which is legitimate and visible.
- **Fan-in** (T4 depends on T2 and T3): T4 forks fresh from the plan-branch
  tip after both parents' merges complete. **Worktree-to-worktree merging
  never happens.** Every merge is line into plan branch.

That last point is the main simplification the plan-branch model buys. An
earlier draft merged converging worktrees into each other at fan-in, which is
strictly harder and has no single integration point.

The rule is a pure DAG-shape function and belongs beside
`sweepLineConcurrencyCap` (`src/decomposition.ts:552`).

## Merge as a synthesized task

Merges are **tasks on the board**, synthesized the way reviews already are per
policy, not scheduler internals. A `kind: "merge"` task sits at each line tail,
with `deps` set to `[chain tail, chain tail's review]` so nothing merges
unreviewed.

Why this shape:

- Conflicts become a visible task state instead of a scheduler exception. The
  plan panel shows `T7 merge: conflict` rather than the project wedging
  somewhere opaque.
- `retry` and `skip` work on it for free, because they operate on tasks.
- Conflict resolution has somewhere to live: an agent turn in the worktree with
  the conflict markers in front of it. No new machinery.
- Merge cost and merge failure surface through `get_findings` like everything
  else.
- It preserves the invariant that all work is tasks on a board, which is what
  makes the planner legible.

**Readiness:** a line is ready to merge when no unfinished task, including
synthesized reviews, is bound to its worktree. Refcount, not a special case.

## The commit question

Nothing in the planner commits today, and workers do not commit. So at merge
time a line worktree holds dirty, uncommitted changes on a branch with no
commits. `git merge` has nothing to work with.

Options:

| Approach | Trade-off |
| --- | --- |
| Commit on the task's behalf, then merge | Clean, gives per-task history and rollback points. Planner starts making commits in the user's repo. |
| `git diff` + `git apply` | No commits, but lossy around renames, mode changes, binaries, and untracked files, and can silently no-op. |
| Temp commit, cherry-pick, reset | Keeps history clean; a crash strands a commit on a branch nobody will look for. |

**Recommendation:** commit on the task's behalf, gated behind the same
plan-level opt-in as isolation itself, with `--no-verify` on intermediate
commits and hooks running only at final integration. In a `lint-staged` repo,
running pre-commit at every task boundary is punishing.

Note that `pi-dynamic-workflows` recommends a clean working tree "for
predictable patch integration," which suggests it takes the patch route and has
no answer for a dirty start. The snapshot commit above closes that gap.

## Integration policy

`isolation.onComplete`:

- `"leave-branch"` (**default**): leave the plan branch, print the exact
  command to integrate. Long plans plus multi-session hydra means the user's
  branch has probably moved during the run, so final integration is a real
  merge, not a fast-forward. Reporting honestly beats guessing.
- `"merge-ff-only"`: integrate only when it is trivially safe.
- `"merge"`: full merge into the user's branch.

**`"merge"` must be gated by user-level planner config, not by the plan.** The
DAG author is an agent. Dirty-tree handling and per-worktree setup are
reasonable agent judgment; auto-mutating the human's git state is not. The
agent may propose; the ceiling is the user's.

This is the only moment planner goes near the user's checkout.

## Competition stops being a special case

Under this model competition is fan-out with N lines and a discard policy: N
branches off the plan branch, the judge visits each worktree and can genuinely
run each candidate's tests, the winner's branch merges, and the losers'
branches and worktrees are deleted. `superseded` becomes real deletion.

The soundness bug is fixed as a side effect of the general mechanism rather
than by special-casing, which is a good sign about the design.

**Competition sets `required: true`** on its daemon worktree requests. The
daemon's default fail-open (fall back to the shared tree) would silently make
the N candidates non-independent and quietly invalidate the comparison. Fail
open for ordinary tasks; fail closed here.

## Nesting: when the orchestrator is itself isolated

Workers currently spawn with `cwd` omitted, inheriting the orchestrator's
(`src/bridge.ts:4540`). Since an isolated session's `cwd` is its *workspace*,
that inheritance changes meaning the moment the user launches the orchestrator
session in a workspace of their own (`hydra session new --worktree`, or the plan
is run from inside an existing worktree).

Two questions follow, and they need answering before phase 1 rather than after:

- **What does the plan branch fork from?** It must fork from the orchestrator's
  *effective* tree, not the user's main checkout. A plan run from inside a
  workspace is planning against that workspace's state, and forking from the
  main checkout would silently plan against different code than the user is
  looking at.
- **What does `onComplete` integrate into?** The orchestrator's workspace, not
  the user's main checkout. Integrating past the tree the user is actually in
  would be a surprise write to a tree they did not mention, which is the one
  thing this design promises never to do.

So "the user's checkout" throughout this document means **the orchestrator
session's effective `cwd`**, whatever that is, and the source tree it derives
from is the daemon's concern rather than the planner's. Resolving it as the
literal repo root is wrong in the nested case.

Corollary for worker spawning: once isolation exists, omitting `cwd` and
inheriting is no longer a safe default, because it would place a worker
directly in the orchestrator's own workspace. Workers must be given an explicit
workspace or explicitly none.

## Required provider capabilities

The topology above is written in git terms for readability, but it consumes the
daemon's VCS-neutral provider interface (see
[the daemon design](./worktree-isolation-daemon.md), "Provider interface").
What the planner actually requires, and how it degrades when a provider cannot
offer it:

| Capability | Needed for | Degradation when absent |
| --- | --- | --- |
| `createWorkspace(from: snapshot)` | line workspaces forking from the plan snapshot | no isolation at all; `mode: "none"` is the only option |
| `nonMutatingCapture` | `dirtyTree: "snapshot"` | **refuse** that mode; fall back to `"ignore"` only with explicit consent, since silently dropping the user's in-progress work is worse than failing |
| `record` | commit-on-behalf at line tails | integrate must work from working state directly, or isolation is read-only |
| `integrate` | merge tasks | lines cannot converge; the DAG is limited to a single line, which forbids fan-out |
| `conflictReporting` | conflict-resolution task prompts | a merge task can only report "integration failed" with no paths, so an agent has nothing to act on. Merge tasks should fail rather than spawn a blind resolution turn |
| `cheapWorkspaces` | competition, wide fan-out | cap fan-out and **say so in the plan summary**; do not silently issue N expensive workspace creations |
| `locking` | concurrent-cleanup safety | fall back to board records alone, and accept that an external prune can remove a live workspace |
| `changedPaths(since)` | `verified_diff` under isolation | reviewers and judges lose their evidence base, which makes competition judging unsound rather than merely degraded |

Two of these are hard requirements rather than degradations: without
`integrate` there is no fan-out, and without `changedPaths` competition should
be refused outright, because the judge's entire job is comparing evidence it
would no longer have.

The `copy` provider (no VCS, clone the directory) satisfies enough of this to
run competition, which is a useful property: it means a non-git repository can
still get candidate isolation, the one lane where the current shared-tree
behavior is actually unsound.

## Path identity in prompts and artifacts

The daemon injects the worktree hint and rewrites inbound absolute paths (see
[the daemon design](./worktree-isolation-daemon.md), "Path identity"). Three
planner-specific consequences on top of that.

**Worker prompts.** Planner builds worker prompts itself (`src/task.ts`
registry), so it should carry the hint directly rather than rely on the
daemon's first-prompt preamble. Workers get a fresh session per task and the
first prompt is the task brief, so the two would collide anyway. The brief
should also instruct repo-relative paths in the `hydra-result` block.

**`contextPack` must be repo-relative.** The plan-authoring agent explores the
*user's* tree and writes findings into `contextPack`, which is inlined into
worker prompts verbatim. Absolute paths captured during exploration point at
the source tree and will be wrong for every worker. This is a schema-description
fix: the MCP tool description has to say repo-relative explicitly, because the
authoring agent has no way to know its paths will be reinterpreted.

**Artifacts must be normalized, and competition depends on it.** `files_changed`
is self-reported and `verified_diff` is derived from per-session tool-call
history (`src/task.ts:535`), so under isolation both carry whatever prefix the
worker's worktree had. For a competition that is actively corrupting: N
candidates for the same task report N different absolute prefixes for the same
file, and the judge, whose entire job is comparing them, sees paths that look
unrelated. Normalize to repo-relative at result-ingest time, before anything
reads them.

The same normalization makes `get_findings`, the completion summary, and the
live plan panel render paths the user recognizes rather than paths inside
directories that are about to be deleted.

**Never store an absolute path in an artifact.** This is the invariant that
makes rendering tractable: absolute paths are derived at render time from
(repo-relative path + workspace + phase), per the daemon design's outbound
mapping rules. Storing absolutes forces a later search-and-replace, and a
search-and-replace to the source tree yields links that open a file which does
not contain the described change.

Two planner-specific consequences:

- **The live plan panel outlives its targets.** It renders for the project's
  duration and its content stays in the transcript afterward, by which time the
  workspaces are gone. Paths in scrollback must degrade to plain text rather
  than to dead links pointing at swept directories.
- **Findings are read after completion, by definition.** `get_findings` exists
  to be consulted once work has finished, so its paths should resolve against
  whatever survived: the source tree if integration happened, plain
  repo-relative text if the plan branch was left for the user.

## Board schema v4 to v5

Current version is 4 (`src/board.ts:11`). Migration goes in `migrateBoard`
(`src/board.ts:796`) per the existing versioning invariant.

Plan-level:

```ts
isolation?: {
  mode:        "none" | "plan-branch";
  dirtyTree:   "snapshot" | "ignore" | "refuse";
  onComplete:  "leave-branch" | "merge" | "merge-ff-only";
  planBranch:  string;
  snapshotCommit?: string;
  integrationWorktreePath?: string;
}
```

Task-level: `worktreePath?`, `lineBranch?`, plus `kind: "merge"` in `TaskKind`.

Migration is trivial in the absent direction (no `isolation` means today's
shared-tree behavior), which satisfies "old projects must load on new
versions."

## Failure and recovery

**Ordering.** Record a worktree in the board *before* creating it, so a crash
leaves a known-stale entry rather than an unfindable directory.

**On rehydrate**, each recorded worktree is in one of three states. Only two
are safe to automate:

| State | Action |
| --- | --- |
| Bound to an unfinished task | keep |
| Merged, refcount zero | prune |
| Orphaned with uncommitted work | **keep and report** |

Never auto-delete the third. Claude Code's periodic sweep independently arrived
at the same rule: it removes agent worktrees past a retention window but skips
any that still hold changed files, untracked files, or unpushed commits.

**Interim leak.** Until the daemon owns teardown, an externally-issued
`hydra session remove` on a worker leaks its worktree. Planner reconciles on
rehydrate. Same shape as the existing orphan-recovery paths
(`recoverOrphanSynthesize`), so survivable rather than novel.

## Configuration surface

Plan-level in `set_plan`, since isolation is no longer per-task:

- `isolation.mode`: `"none"` | `"plan-branch"`
- `isolation.dirtyTree`: `"snapshot"` | `"ignore"` | `"refuse"`
- `isolation.onComplete`: `"leave-branch"` | `"merge"` | `"merge-ff-only"`

Per-worktree `setup`, `carry`, `ports` and `teardown` live in the **repo
config** the daemon reads, not in the plan. They are properties of the repo,
authored once by whoever knows it, not re-derived per plan by an agent.

MCP schema descriptions are read by plan-authoring agents and are a protocol
surface (per `AGENTS.md`). The description for `isolation` must state plainly
that it is plan-level and that `onComplete: "merge"` may be refused by user
config, or agents will set it hopefully and misreport the outcome to users.

## Sequencing

0. Provider interface defined on the daemon side with the git implementation
   behind it. The planner should never call git directly; if it does, phases 1
   to 5 will bake git assumptions into topology code that is supposed to be
   provider-agnostic. This ordering is the whole cost of keeping it replaceable,
   and it is cheap only if paid first.
1. Plan branch, snapshot commit, integration worktree. Provably no mutation of
   the user's checkout. No task isolation yet.
2. Line branches, inheritance rule, spawn-site `cwd` (`src/bridge.ts:4538`).
   Prototype `carry`/`setup` locally here to prove the config shape before it
   is fixed in the daemon protocol.
3. Synthesized merge tasks, conflict as a visible task state with retry.
4. Competition on the general mechanism, delete losers, `required: true`.
5. `onComplete` integration, `leave-branch` default, `merge` behind user config.

Steps 1 and 2 are independently testable, which matters because most of this is
filesystem state that has to survive crashes.

Step 4 fixes a real soundness bug and is worth reaching even if step 5 is never
built.

## Open questions

- Does a plan with `mode: "none"` still get a plan branch? Probably not, but
  then `get_findings` and the completion summary need to describe two different
  worlds.
- `add_task` mid-flight into an already-merged line: fresh branch from the plan
  tip, or reopen the line? Fresh is simpler and probably right.
- `retry` on a task whose line already merged: the merge has to be reverted or
  the retry needs a new line. Needs a decided answer before step 3 ships.
- Should the integration worktree be reused as the review lane for merge tasks,
  or does each merge task get its own throwaway worktree? Reuse is cheaper and
  serializes merges, which may be desirable anyway.
- User amends the plan mid-run (held-turn amend path) in a way that changes DAG
  shape: recompute merge-task placement, or freeze topology after start?
- The user's amend text can contain absolute paths into their own tree, and the
  amend lands mid-project when workers are already in worktrees. Does the amend
  path get the same inbound rewriting as a worker prompt, and if the amend names
  a path, which worktree does it mean?
