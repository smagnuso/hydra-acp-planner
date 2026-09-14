# Worktree isolation, layer 1: daemon provisioning

Status: **proposal**, not implemented. Reviewable independently of
[the planner-side topology design](./worktree-isolation-planner.md), which
consumes this but does not require it to land first (see Sequencing).

Owner surface: `hydra-acp` daemon + `cli/PROTOCOL.md`. Nothing in this
document is planner-specific.

## Problem

Two hydra sessions opened against the same working directory edit the same
files. Nothing detects it, warns about it, or prevents it. This is not a
planner problem: it happens whenever a user runs a second session in a repo
they already have one in, and hydra is explicitly a multi-client session
daemon, so concurrent sessions per repo is the designed-for case.

The planner makes it worse (it spawns N workers into one tree by design)
but planner is a symptom, not the cause.

## Why this belongs in the daemon

`cwd` is already a first-class session property throughout the protocol:

| Fact | Reference |
| --- | --- |
| `session/new` accepts `cwd`, falls back to daemon config | `cli/PROTOCOL.md:309`, `:315` |
| `session/list` returns `cwd` as a spec-required top-level field | `:1261`, `:1266` |
| `session/list` supports `cwd=<path>` filtering | `:210` |
| fork defaults `cwd` to the source session's | `:480` |
| `cwd` is documented as "effective working directory" | `:1228` |

The `cwd=<path>` filter is the decisive one: the daemon can already
enumerate every session sharing a tree. That is precisely the collision
query, and it is unavailable to any single client or transformer, which
only knows about sessions it spawned itself.

Three capabilities follow that only the daemon can provide:

1. **Port allocation.** A client can avoid collisions among its own
   children. It cannot know another session already holds 3000.
2. **Teardown on external removal.** Any client can `hydra session remove`
   a session. If a client owns the worktree, that leaks. If the daemon owns
   it, teardown rides the existing removal path.
3. **Collision detection.** "This tree already has a live session" is
   worth saying, and only the daemon can say it.

Prior art points the same way: Pi's dependency-isolation answer is
`pi-worktree` at the session-launch level, separate from (and because of a
gap in) its orchestrator extension, and Claude Code's is a harness-level
primitive plus `settings.json` hooks rather than something inside its
workflow tool. Both ecosystems put this below the orchestrator.

## Scope

**In:** worktree creation and removal as a property of a session; repo-declared
setup/carry/teardown; port allocation; branch and path visibility in session
info and `session list`; lifecycle reconciliation across daemon restart.

**Out:** branch topology (what branches off what, when things merge), merge
conflict handling, integration policy. Those are orchestrator concerns and
live in the planner document. The daemon should have no opinion about a task
DAG.

**Explicitly out:** session-less worktrees. See "Known asymmetry".

## Provider interface

Git is **one implementation**, not the design. Everything above this line is
expressed in git terms because git is what we will ship first; everything below
defines the contract that keeps it replaceable.

A note on vocabulary: the prose in this document says "worktree", "branch", and
"commit" for concreteness, because a doc written entirely in abstract nouns is
unreadable. The **protocol payloads and the interface below are the contract**,
and those are VCS-neutral. Where prose and interface disagree, the interface
wins.

### The forcing cases

An interface designed against git alone will be git with extra ceremony. Two
implementations keep it honest, and both are plausible enough to actually build:

1. **A foreign VCS** (Perforce, SVN, Mercurial, jj). Different nouns: client
   workspaces and changelists, not branches; some cannot produce a second
   working copy without a server round trip.
2. **A `copy` provider with no VCS at all.** Clone the directory (`cp
   --reflink=auto`, APFS clonefile, or plain copy), no history, integrate by
   file-level three-way merge or refusal. This one matters more than it looks:
   it works in a directory that is not a repository, and for competition
   candidates history is not actually required, only isolation plus a diff.

If both implement the interface without contortion, the abstraction is real. If
`copy` has to fake commits to satisfy it, we have leaked git.

### Vocabulary

| Interface term | git | Perforce | `copy` |
| --- | --- | --- | --- |
| Workspace | worktree | client workspace | a directory |
| Snapshot (opaque token) | commit sha | changelist number | a stored copy id |
| Line | branch | stream / changelist chain | a directory lineage |
| Integrate | merge | integrate / resolve | 3-way file merge |

**Snapshot ids are opaque.** Never parsed, never assumed to be hex, fixed
length, orderable, or globally unique across providers. Any code that pattern
matches a snapshot id has broken the abstraction.

### Interface

```ts
interface IsolationProvider {
  readonly kind: string;                    // "git" | "copy" | "perforce" | …
  capabilities(): Capabilities;

  // Materialization
  createWorkspace(o: { from: SnapshotId | "current"; label: string })
    : Promise<Workspace>;
  removeWorkspace(ws: Workspace, o: { force: boolean }): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;   // what the provider itself believes

  // State
  status(ws: Workspace)
    : Promise<{ clean: boolean; changedPaths: string[]; hasRecordedWork: boolean }>;
  changedPaths(ws: Workspace, since: SnapshotId): Promise<PathChange[]>;

  // Recording
  captureWorkingState(path: string, message: string): Promise<SnapshotId>;
  record(ws: Workspace, message: string): Promise<SnapshotId>;

  // Integration
  integrate(o: { from: SnapshotId; into: Workspace })
    : Promise<{ ok: true; snapshot: SnapshotId }
             | { ok: false; conflicts: string[] }>;

  // Concurrency
  lock(ws: Workspace, reason: string): Promise<void>;
  unlock(ws: Workspace): Promise<void>;

  // Agent-facing caveats about this workspace, conditional on inspected
  // repo state. See "Environment notes".
  environmentNotes(ws: Workspace): Promise<string[]>;
}
```

Deliberately **absent**, because these are either git-specific or unnecessary:
branch naming, remotes (fetch/push/pull), history topology (rebase,
cherry-pick, ancestry queries), and any network concept. The design never needs
a remote: line workspaces fork from the plan snapshot, which is local. Keeping
the network out of the interface is a feature, not an omission.

### Capabilities, and why they carry weight

```ts
interface Capabilities {
  cheapWorkspaces:     boolean;  // shared store vs. full fetch per workspace
  sharedHistory:       boolean;  // is a recording in one workspace visible to others locally
  nonMutatingCapture:  boolean;  // can we snapshot a dirty tree without touching it
  conflictReporting:   boolean;  // does integrate name conflicting paths, or just fail
  locking:             boolean;
  requiresServer:      boolean;
}
```

This is the part that prevents a lowest-common-denominator design. Rather than
every provider pretending to do everything, callers negotiate:

- `cheapWorkspaces: false` means a five-way competition is a bad idea. The
  planner should reduce fan-out or refuse isolation, and **say so**, instead of
  quietly issuing five network fetches.
- `nonMutatingCapture: false` means `dirtyTree: "snapshot"` must be **refused**,
  not approximated. The whole point of that mode is that the user's files are
  untouched; a provider that cannot promise it must not be allowed to try.
- `conflictReporting: false` degrades an integrate failure from "these three
  paths conflict" to "integration failed", which changes what a conflict task
  can even ask an agent to do.
- `sharedHistory: false` means record-then-integrate is not a local operation,
  which changes the cost model for every line tail.

Capability negotiation is also how this composes with the existing fail-open
rule: a provider that cannot satisfy what the caller requires produces a clean
refusal at request time, rather than a surprise at integration time.

### The second adapter: agents

There are **two** adapter layers, and conflating them will hurt. The provider
abstracts the VCS; an **agent adapter** abstracts per-agent capabilities reached
through `agentArgs`. Two things depend on it, and neither is available
universally:

| Capability | Used for |
| --- | --- |
| system-prompt-append flag | durable hint delivery (layer 1, strong tier) |
| native worktree-isolation flag | engaging the agent's own write enforcement (layer 4) |

Both are per-agent knowledge, both are expressed as `agentArgs`, and both must
degrade cleanly when absent: no system-prompt flag means fall back to a first-
prompt preamble, and no isolation flag means the session runs unenforced and we
say so rather than claiming isolation we do not have.

Keep this table in one place. Scattering "if agentId === 'claude' then …"
through the worktree code is how the git assumptions we just factored out come
back wearing a different hat.

### Two extension levels

- **In-process provider**: implement the interface. For anything real.
- **Hook-based provider**: `workspaceCreate` / `workspaceRemove` commands in
  repo config, receiving JSON on stdin and printing a path on stdout. Covers
  simple foreign-VCS cases without writing TypeScript. This is the shape Claude
  Code uses for non-git version control, and its limits are instructive: a hook
  that replaces creation cannot also participate in the declarative copy path,
  which is why ours runs strictly post-create and why a hook provider reports
  reduced capabilities rather than claiming the full set.

## Protocol change

### Constraint

`PROTOCOL.md:1200` states the ACP spec `NewSessionRequest` carries only `cwd`
and `mcpServers`, and that hydra emits **no** non-spec fields at the top level
of `session/new`. An isolation request therefore cannot be a top-level
parameter. It rides under `_meta["hydra-acp"]`, alongside agent selection and
the session title.

### `session/new`

Neutral core, with provider specifics confined to a typed extension block:

```jsonc
{
  "cwd": "/repo",              // the source tree; unchanged semantics
  "_meta": {
    "hydra-acp": {
      "workspace": {
        "label":    "feature-x",   // optional; generated when omitted
        "from":     "current",     // "current" | <opaque SnapshotId>
        "required": false,         // see Failure semantics
        "provider": "git"          // optional; daemon default when omitted
      }
    }
  }
}
```

`from` is `"current"` or an **opaque** snapshot token previously handed out by
the same provider. Callers do not construct these and must not parse them, so
there is no `"HEAD"` and no rev syntax in the protocol.

The daemon creates the workspace, runs post-create setup, and the session's
**effective `cwd` becomes the workspace path**. The agent runs there: relative
paths resolve against the workspace, and shell commands inherit it. Only
absolute source-tree paths need translation, which is what the path-identity
layers handle.

### `cwd` means two things, and that has consequences

Note the asymmetry, because it is easy to miss and one consequence is a real
bug:

| Position | Meaning |
| --- | --- |
| `cwd` in the `session/new` **request** | the tree to create a workspace *of* |
| `cwd` **reported** by `session/new` and `session/list` (`:1228`, `:1261`) | where the agent actually is: the workspace |

Reporting the workspace is correct: it is the session's real working directory,
it is what the ACP field means, and Claude Code does the same (it records a
session under its new working directory when entering a worktree, as `/cd`
does). But it breaks two things unless handled explicitly.

**1. `cwd=<path>` filtering must match either.** `session/list` supports
`cwd=<path>` filtering (`:210`), and that query is the whole basis for the
collision detection this design claims as the daemon's advantage. If reported
`cwd` is the workspace path, filtering by the repo path returns **no isolated
sessions at all**, which is precisely backwards: the sessions most worth
knowing about become the ones the query cannot see.

So the filter must match a session when the supplied path equals its effective
`cwd` **or** its `sourceCwd`. The result is asymmetric, which is what you want:

| Query | Plain session in `/repo` | Isolated session with `sourceCwd: "/repo"` |
| --- | --- | --- |
| `cwd=/repo` | match | **match** |
| `cwd=<workspace path>` | no match | match |

Querying a source tree returns everything derived from it; querying a specific
workspace returns only that workspace. No special-casing is needed, this falls
out of the two-field rule.

**Do not implement this as a prefix match.** `path.startsWith(sourceCwd)` is
the obvious approach and it is wrong under the workspaces-outside-the-repo
layout (see Open questions), where a workspace shares no prefix with its source
at all. The relationship is a recorded *derivation* edge, not path containment,
so the comparison must consult `sourceCwd` explicitly.

**Normalize both sides** (realpath, trailing separator, symlinked repo paths).
Matching two fields doubles the surface where a near-miss returns nothing, and
an empty result reads exactly like "nothing is running here", which is the
conclusion this query exists to prevent someone from reaching wrongly.

This is a compat-affecting semantic change to an existing parameter. The union
should be the default, because the cost of hiding isolated sessions (concluding
a tree is idle and starting conflicting work) is worse than the cost of
returning more than a caller expected, and every result carries its own `cwd`
and `sourceCwd` so callers can always disambiguate. Decide it deliberately
rather than inheriting it from this document.

**2. `sourceCwd` has to be reported.** Otherwise nothing can map a workspace
back to the tree it came from, which every path-identity layer and the outbound
display mapping depend on. Added to the payload below.

### Response and session info additions

Under `_meta["hydra-acp"]` on `session/new` and `session/list` (top level
stays spec-shaped per `:1261`):

```jsonc
"workspace": {
  "path":      "/repo/.hydra/workspaces/feature-x",  // == effective top-level cwd
  "sourceCwd": "/repo",                              // the tree this came from
  "label":     "feature-x",
  "snapshot":  "a1b2c3d…",          // opaque
  "provider":  "git",
  "ports":     { "PORT": 3117 },
  "vcs": {                          // provider-specific; readers must tolerate absence
    "kind":   "git",
    "branch": "hydra/feature-x",
    "base":   "a1b2c3d"
  }
}
```

Absent for non-isolated sessions. The `vcs` block is the escape hatch: clients
that want to show a git branch name can, while nothing in the core contract
requires a branch to exist. A `copy` provider omits it entirely, and a client
that depends on it is a client that will break on the second provider.

This is what makes `hydra session list` show which workspace and (where the
concept exists) which branch each session is on, useful independent of any
orchestrator.

### `session/remove`

Runs teardown and removes the worktree. Add `keepWorktree: true` to retain it
(the branch survives either way; only the checkout is removed). Removal must
not fail the session removal: log and report, leave the directory.

### Carrying WIP into a workspace: copy, not move

**Superseded decision.** `/hydra workspace start` originally *moved* the
user's uncommitted work: snapshot it, apply it into the workspace, reset
the source. The argument was that a copy leaves the source dirty with the
same edit, and a dirty source blocks the fast-forward at `end`.

That argument is real but it optimises the wrong thing. The source tree is
not private to the session that ran the command. The user's editor is open
on it, other sessions are working in it, and — decisively — the next
`workspace start` snapshots whatever is present at that moment. Under move
semantics, two sessions isolating from the same dirty tree get *different
baselines*, chosen by whoever typed first and reported to nobody. For
competition siblings, whose entire purpose is to be identical at t=0, that
is not a surprising default but a wrong answer, and one that no test of a
single workspace can catch.

So `start` copies and leaves the source exactly as it found it. The
duplicate is settled at `end`. The first attempt at that was a **gate**:
compare the source against the start snapshot, proceed only on a
byte-for-byte match, refuse otherwise. It was wrong in the same
direction the move semantics were. Under copy semantics, continuing to
work in the source IS the intended workflow — keeping it usable is the
entire reason we stopped taking the work — so a gate refusing on any
difference refuses the ordinary case, and it refused even when the
source-side edit touched a file the workspace never saw.

The gate is replaced by **capture, then replay**:

1. Snapshot the source's working state, retained under
   `refs/hydra/landing/<sessionId>`. No mutation yet, so a refusal up to
   here has changed nothing.
2. `reset --hard`. Not destructive: its input is captured.
3. `merge --ff-only`, so the agent's commits arrive as commits.
4. Apply the workspace's uncommitted remainder.
5. Apply `diff(startSnapshot, sourceCapture)` — whatever the source had
   that the workspace never saw. Empty in the common case, because work
   copied in at `start` sits in both trees and cancels out of the diff.

Only step 5 can fail, and only on a genuine overlap in the same lines,
which is the one case a human actually has to arbitrate. That failure is
reported against the retained ref rather than swallowed, and the merge
still stands.

One trap worth recording: the base for step 5 must be a resolved commit
sha, never the symbolic `HEAD`. The replay runs after the fast-forward
has moved HEAD, so a symbolic base diffs against the merged tip; the
patch then reads as "undo what the agent did and restore my version",
applies perfectly cleanly, and silently discards the agent's work.

Two consequences worth stating, because both were bugs before:

- The copy lands in the workspace **unstaged**. Staging it puts the user's
  WIP in the index the agent commits from, so the agent's first bare
  `git commit` sweeps it into a commit nobody asked for.
- `end` replays the workspace's uncommitted remainder as **uncommitted**
  changes rather than committing it. What the agent committed comes back
  as commits; what was left loose comes back loose. Synthesizing a commit
  hands the user something they never chose to create and silently
  promotes their untracked files to tracked ones.

`hydra workspace merge|apply` (the out-of-band CLI) shares the same
classification, via `core/workspace/source-state.ts`. One surface saying
the merge is safe while the other refuses would be worse than either rule
alone.

### New surface

- `GET /v1/worktrees` (or `hydra worktree list`): daemon-tracked worktrees,
  their sessions, and orphan status.
- `hydra worktree prune`: reconcile daemon records against `git worktree list`
  and report divergence. Does not delete anything with uncommitted work.

### CLI

- `hydra session new --worktree [name]`
- `hydra session remove --keep-worktree`
- `hydra worktree list|prune`

## Consumer impact: who else reads `cwd`

Changing what `cwd` reports is not contained to the daemon. A sweep of the
sibling transformers (`grep` for `process.cwd()`, `.cwd` field access, fs reads,
and git subprocesses) found six affected call sites in four repos, in three
classes. No sibling shells out to git at all, which removes one whole category
of risk.

### Class 1: reads repo files (1 site, already correct)

`browser/src/server/routes-files.ts` is the **only** consumer that reads files
out of a session's tree. It is already correct and needs no change: it calls
`lookupSessionCwd(ctx, request, body.sessionId)` per request, then
`resolveScopedPath(cwd, path)`, which resolves against that cwd and verifies
the target stays inside it after symlink resolution before `readFile`.

Because it asks the daemon for the cwd on every request rather than caching or
deriving one, it follows the workspace automatically. **This is the pattern
other consumers should copy**, and it is worth stating in review that its
correctness here is a property of asking rather than assuming.

### Class 2: aggregates by cwd prefix (1 site, silently wrong)

`budgeter/src/cost/aggregate.ts:226`:

```ts
if (r.cwd.startsWith(filterRoot + "/") || r.cwd === filterRoot) {
```

Budgeter does **not** read repo files (its fs access is limited to
`~/.hydra-acp/sessions/*/meta.json` and its own config). Its exposure is cost
attribution: it filters and groups spend by the session's recorded `cwd`,
using a path prefix test, with `dirGroupLabel(r.cwd, …)` at `:559` doing the
same for grouping.

This is **the same prefix-match-on-cwd bug** this document warns about for the
`cwd=` filter, except it already exists in shipped code. The consequence
depends on an open question:

| Workspace location | Effect on budgeter |
| --- | --- |
| Inside the repo (`.hydra/workspaces/…`) | prefix test accidentally still matches; grouping degrades into per-workspace subgroups at depth |
| Outside the repo (`~/.hydra-acp/workspaces/…`) | **isolated sessions vanish from per-directory spend entirely** |

The outside layout is the one currently favoured, so this needs a budgeter fix
shipped alongside, not after. Note where it lands hardest: planner runs are the
largest spenders, and they are exactly the sessions that become invisible, so
per-project cost under-reports most severely precisely when orchestration is in
use. That directly undercuts the recent work on making cumulative cost a
complete view.

### Class 3: displays or groups by cwd (4 sites, cosmetic to confusing)

- `browser/src/ui/views.ts:348` (`const key = s.cwd || "(unknown)"`) and `:368`
  group the session list by cwd. Under isolation, N planner workers each become
  their own group instead of nesting under the repo.
- `approver/src/index.ts:65`, `:72`
- `archiver/src/cold-sweep.ts:42`, `archiver/src/index.ts:188`, `:195`
- `notifier/src/discovery.ts:7`

These pass through or display the value, so they will show workspace paths where
users expect repo paths. Individually cosmetic; collectively this is the reason
the source-tree mapping must be published in session `_meta` rather than left
for each consumer to reconstruct. Four consumers reconstructing it
independently is four chances to get it wrong.

### Also affected: the filter's callers

`browser/src/hydra/client.ts:76` sets `cwd` as a query parameter, so the
union-versus-exact decision above has a real consumer today, not a hypothetical
one. Whichever way that goes, browser's behavior changes.

## Repo configuration

Setup, carry-lists, ports and teardown are properties of a **repo**, not of a
daemon install or a user. So: a committed file at repo root, shared by every
client and transformer, authored once by whoever knows the repo.

```jsonc
// .hydra/worktree.json
{
  "carry":      [".env", ".env.local", "config/local.yml"],
  "postCreate": "npm ci",
  "preRemove":  "docker compose down -v",
  "ports":      { "vars": ["PORT", "VITE_PORT"], "range": [3100, 3199] },
  "root":       ".hydra/worktrees"
}
```

`carry` copies gitignored-but-required files, which are the single most
common reason a fresh worktree cannot run anything. `postCreate` handles
dependencies. `preRemove` exists because setup may have created state outside
the directory (databases, containers, volumes) and deleting a directory does
not undo that.

### Foreign config sources

Users arriving from other tools have often already declared which gitignored
files a worktree needs. We should read those declarations rather than making
them restate it, and rather than inventing a competing file for an identical
job.

**Honor `.worktreeinclude`** (Claude Code's declarative copy-list) by taking the
**union** with `carry`. Union rather than override: both express "this
gitignored file is needed," and there is no reading under which the presence of
one means ignore the other. Hydra config wins only on explicit exclusions.

This composes better here than in its origin. Claude Code stops processing
`.worktreeinclude` as soon as a `WorktreeCreate` hook is defined, because that
hook replaces creation wholesale. Our post-create design applies `carry` before
the hook runs, so declarative and imperative coexist and adopting
`.worktreeinclude` costs nothing in hook expressiveness.

**The boundary: declarative lists yes, foreign hook execution no.**

Hydra runs arbitrary ACP agents. The daemon cannot be the union of every
agent's config schema indefinitely, so foreign files are an *input source*,
never the mechanism. And there is a sharp risk asymmetry:

| Foreign config | Action |
| --- | --- |
| Declarative file list (`.worktreeinclude`, a `carry`-equivalent) | read and union; inert and inspectable |
| Hook commands (`pi-worktree`'s `postCreate` / `preRemove`) | **never auto-execute**; detect, report that it exists, offer to reference it from `.hydra/worktree.json` |

Running `createdb` / `bun install` / `prisma:push` because a file authored for
a different tool happens to be in the repo means executing commands with no
user intent behind them in this context. Copying a listed file does not.

`.worktreeinclude` semantics, per Claude Code's published worktree docs:

- Lives at **project root**.
- Uses **`.gitignore` syntax**.
- **Only files that match a pattern *and* are also gitignored are copied.**
  Tracked files are never duplicated.
- Applies to every worktree Claude Code creates with git (`--worktree`,
  subagent worktrees, desktop parallel sessions), and is skipped entirely when
  a `WorktreeCreate` hook is configured.

The AND-gitignored condition is the part worth adopting deliberately rather
than merely matching. It makes `carry` safe by construction: a pattern can
never shadow a tracked file with a stale copy, because tracked files fail the
second test. Our own `carry` should apply the same rule, which means `carry`
entries are declarations of *intent* that silently no-op when the file turns
out to be tracked, instead of quietly winning over the checkout.

## Hook contract

The hook runs **after** the daemon creates the worktree. It does not replace
creation.

This is deliberate. Claude Code's `WorktreeCreate` hook replaces `git worktree
add` entirely, so using it for environment setup means reimplementing the
tool's undocumented internal worktree logic, and defining it silently disables
the declarative `.worktreeinclude` copy path. There is an open feature request
for a `PostWorktreeCreate` hook for exactly this reason
(anthropics/claude-code#27744). We should not reproduce the mistake we can
see from here.

Contract:

- Runs with cwd set to the new worktree.
- Receives JSON on stdin: `{ path, branch, base, sourceCwd, sessionId, ports }`.
- Same values also injected as env (`HYDRA_WORKTREE_PATH`, `HYDRA_SOURCE_CWD`,
  allocated port vars, …) so trivial hooks need no JSON parsing.
- Non-zero exit is a setup failure, handled per "Failure semantics".
- Configurable timeout, default 120s (`npm ci` on a cold cache is slow).
- `carry` is applied by the daemon **before** the hook runs, so hooks can
  depend on `.env` existing. Declarative and imperative compose; neither
  disables the other. This is what lets us adopt `.worktreeinclude` without
  forcing a choice between it and a setup hook (see "Foreign config sources").

## Port allocation

Allocate from the configured range, skipping ports held by other live sessions
and ports currently bound on the host. Inject as env into the session's agent
process and pass to the hook. Release on session removal.

This is the capability that most clearly cannot be delegated upward: only the
daemon has the full set of live sessions.

## Path identity: the agent must know where it is

A user says "look at `~/dev/mycode/foo.cpp`". The agent is in
`/…/worktrees/feature-x/`. That absolute path resolves to the **source tree**,
not the worktree, and the consequences run from mild to disqualifying:

| Failure | Severity |
| --- | --- |
| Agent reads the source-tree copy, reasons about the wrong branch | wrong answers, looks like a model failure |
| Agent **writes** to the source tree | isolation guarantee is void; the user's checkout is mutated, which the whole design promises never happens |
| Agent reports `~/dev/mycode/foo.cpp` after editing the worktree copy | user looks, sees no change, loses trust |
| Agent reports the worktree path to the user | unrecognizable, and clicking it opens a file that is about to be deleted |
| Carried config contains absolute source-tree paths | tooling silently operates on the wrong tree |

### The enforcement limit, stated plainly

The daemon **cannot** intercept the agent's file I/O. Agents do their own
reads and writes; the daemon observes them as `tool_call` /
`tool_call_update` notifications (`PROTOCOL.md:635`), and the server-side diff
is explicitly reconstructed from those recorded payloads with "no git, no
filesystem read of the workspace" (`:432`). By the time a path is visible to
the daemon, the write has already happened.

So a hint is advisory, and an LLM handed an absolute path will sometimes use
it. Defense has to be layered.

### Layer 1: the hint (advisory)

**Delivery is two-tier, and the tiers differ in durability.**

ACP has no system-prompt concept: there is no such field in `session/new` and no
mention of one anywhere in `PROTOCOL.md`. So there is no universal lever.

But `agentArgs` is "forwarded to the underlying agent's command line" and is
**stored in the resume hints** so a resurrected session re-spawns with the same
args (`PROTOCOL.md:1206`, `:1211`). For any agent exposing a system-prompt-append
flag, that is real system-prompt influence which survives both compaction and
session resume. That is the strong tier and it should be preferred wherever
available.

| Tier | Mechanism | Durability |
| --- | --- | --- |
| Preferred | agent's system-prompt-append flag via `agentArgs` | survives compaction **and** resume |
| Fallback | preamble on the session's first prompt | lost to compaction; needs re-assertion |

Do not assume the strong tier. Whether it exists is per-agent, so the fallback
has to be correct on its own.

Content, in either tier. Four facts:

1. You are working in a git worktree at `<worktree>`.
2. Its source tree is `<sourceCwd>`, checked out on a different branch.
3. Any absolute path under `<sourceCwd>` refers to the corresponding file
   under `<worktree>`. Do not read or write `<sourceCwd>` directly.
4. Prefer repo-relative paths. They are identical in both trees.

Point 4 is the cheapest and most durable mitigation: repo-relative paths make
the problem disappear rather than requiring translation.

Plus **provider environment notes** (below), which are not path-related at all
and exist for a different reason.

### Environment notes: stop the agent repairing the environment

The hint's second job is telling the agent *why* the checkout looks wrong, and
the argument for it is stronger than "the agent is better informed." An agent
that meets an artifact of isolation and does not recognize it will try to
**fix** it, and some of those repairs are destructive to the integration:

| What the agent sees | The repair it may attempt |
| --- | --- |
| `.git` is a file, not a directory | "repair" the repository |
| Submodule directories empty (`git worktree add` does not init submodules) | re-add submodule contents as ordinary tracked files, which corrupts the integration |
| `node_modules` / `.venv` missing | reasonable (install), or unreasonable (conclude the project is misconfigured and edit the manifest) |
| `.env` absent | invent one, or hardcode values into source |
| Its branch is unfamiliar and unpushed | try to push, or reset onto something it recognizes |

The empty-submodule case is the one that motivates this: re-committing
submodule contents as regular files is silent, plausible-looking, and poisons
the merge back to the plan branch.

**Notes come from the provider, not from the daemon.** Hardcoding git caveats in
daemon core re-leaks exactly what the provider interface exists to contain: a
`copy` provider has no `.git` and no submodules, and needs to say something
entirely different (no history exists, do not run VCS commands, integration is
by file merge). So the interface grows:

```ts
environmentNotes(ws: Workspace): Promise<string[]>;
```

**Conditional, not static.** The provider inspects and emits only applicable
notes. Telling an agent that submodules may be uninitialized in a repository
with no submodules is noise that dilutes the notes that do apply, and it is
paid per session. With the planner running N workers and the fallback tier
re-asserting, this text is billed many times over, which is the same token
discipline that motivated the MCP gateway design. Short and conditional, or it
will be the first thing someone turns off.

**Re-assert it.** A one-shot preamble is compacted away on a long session, and
then the agent starts writing to the source tree 200 turns later with no
recollection of why it shouldn't. Re-inject the hint whenever an inbound prompt
contains an absolute path under `sourceCwd`, which is exactly when it matters.

### Layer 2: inbound prompt rewriting (reliable, in our reach)

The daemon *can* see user prompts before they reach the agent. When a prompt
contains an absolute path under `sourceCwd`, rewrite it to the worktree
equivalent and append a short note saying so. This handles the literal case in
the motivating example, and unlike tool-input rewriting it is actually
possible.

Rewrite rather than merely annotate: the agent will otherwise reproduce the
original path in a tool call. Note the substitution so the user is not confused
about why the path changed.

### Layer 3: detect breaches after the fact (safety net)

The `file.edited` event (`PROTOCOL.md:2024`) is edge-triggered per
`(session, path)` and carries `locations[].path`. If a path falls under
`sourceCwd` rather than the worktree, that is an isolation breach: surface it
loudly, immediately, with the offending path. Detection is not prevention, but
silent breach is far worse than a loud one, and this is cheap.

### Layer 4: agent-side enforcement (strong, but must be engaged)

This is stronger than "deny rules where available." Claude Code implements four
non-optional checks while a session is worktree-isolated, and they cover every
subagent spawned from that session:

- Blocks `Edit` / `Write` / `NotebookEdit` targeting a path in the main
  checkout.
- Blocks Bash / PowerShell / Monitor commands whose working directory resolves
  to the main checkout, **or cannot be verified to stay outside it**.
- Blocks git redirected into the main checkout via `git -C`, `--git-dir`,
  `GIT_DIR`, `GIT_WORK_TREE`, or a `cd` before the git call.
- Blocks commands whose shape it cannot statically trace (brace expansion,
  heredocs with unquoted delimiters). Explicitly not disableable.

So for that agent the breach problem is genuinely solved, not mitigated.

**The catch, and it is a real gap.** That enforcement engages when the session
"started with `--worktree`, entered a worktree with `EnterWorktree`, or resumed
a worktree session," and the checks are scoped to "the repository you launched
from." A daemon that merely sets `cwd` to a directory that happens to be a git
worktree may get **none** of it: from the agent's point of view that is just an
ordinary checkout, and there is no main checkout to protect.

We therefore cannot obtain this enforcement by construction. Either the daemon
establishes the session as a worktree session in the agent's own terms (passing
the agent's worktree flag through `agentArgs`, where the agent has one), or the
session runs unenforced and layers 1 to 3 are all we have. **This needs
verifying per agent before we claim isolation is enforced**, and the honest
default is to assume it is not.

Corollary: Claude Code also refuses to adopt a directory as an isolation
worktree when its git identity resolves into the main checkout (a `.git` file
pointing at the main repo's `.git`, or a `core.worktree` redirect), and refuses
symlinked worktree paths outright. If we hand it a path, the path has to
survive those checks.

### Outbound display mapping

The reverse direction matters too, and the obvious approach is a trap.

**Do not search-and-replace workspace paths with source-tree paths.** The
source tree is on a different line of work, so the rewritten path resolves to a
file that does *not* contain the change being described. The link looks correct
and opens the wrong content, which manufactures the "user looks, sees no
change" failure rather than preventing it.

**Do not emit link text and href pointing at different existing absolute
paths** either. It rots (the href targets a directory scheduled for deletion),
it invites editing a file whose changes will be swept, and text-disagrees-with-
target is the shape of a phishing link.

**Rule: store repo-relative, resolve at render.** A repo-relative path is true
in both trees and asserts neither, so it cannot mislead. Absolute paths are
never stored in artifacts, findings, or events; they are computed at render
time, when the phase is known:

| Phase | Href target |
| --- | --- |
| Session live | workspace path, marked ephemeral |
| Work integrated into the source line | source tree; text and target finally agree |
| Workspace retained, not integrated | workspace path, marked ephemeral |
| Workspace removed | **no href**; plain text |

Marking matters: a clickable path into an ephemeral workspace is an invitation
to do work that will be deleted, so it should render visibly differently from a
durable one.

**Agent prose is the exception.** Free text (a worker's summary, a reviewer's
notes) cannot be normalized at ingest, so absolute workspace prefixes appearing
there do need rewriting. Rewrite them to **repo-relative**, not to the source
tree: prose carries no href, so the recognizable-but-wrong-content hazard has
nothing to trade against, and repo-relative makes no claim about which tree.

The mapping (`workspacePath`, `sourceCwd`, current phase) has to be published in
session `_meta` so transformers can apply this; the rendering itself is
transformer-level, not daemon-core.

### Carried-file contamination

`carry` copies gitignored files verbatim, and some of them contain absolute
paths pointing at the source tree: `compile_commands.json`, `.env` files with
absolute roots, cached tool configs, `.venv` activation scripts with baked
prefixes. For C/C++ work this is not incidental: `compile_commands.json` drives
clangd and rtags, so a carried copy silently indexes the wrong tree.

Options: a per-entry substitution rule in the repo config, regenerate rather
than carry (`postCreate` running the generator), or document that
absolute-path-bearing files must be regenerated. Leaning on `postCreate` for
generated files and reserving `carry` for genuine secrets and static config.

### Worktree-shaped gotchas to document

- `.git` is a **file** in a worktree, not a directory. Tooling that assumes
  `.git/` is a directory breaks.
- `git rev-parse --show-toplevel` correctly returns the worktree path, so
  git-aware tools mostly behave.
- Submodules interact poorly with worktrees (already an open question above).
- Agent config discovery: `AGENTS.md` / `CLAUDE.md` are tracked and come along.
  **Do not carry `.claude/settings.local.json`.** Claude Code saves permission
  approvals to the *main checkout's* copy specifically so they apply in every
  worktree of the repository and survive the worktree's removal. Carrying it
  would create a stale divergent copy of state the agent already shares
  correctly.
- A worktree shares the repository's `.git` directory, so `git commit` works
  from inside one even under sandboxing. This matters for the planner's
  commit-on-behalf design, which would otherwise be the first thing to break.
- Worktree creation must refuse symlinked paths (the worktree root or any
  parent we create), since following a committed symlink can place files
  outside the repository.
- On Windows, removing a worktree containing an NTFS junction or directory
  symlink must delete only the link, never its target.

## Failure semantics

Default is **fail-open**: if worktree creation or setup fails, log it, report
it in the session's `_meta`, and run the session in the source `cwd`. A broken
setup hook must never prevent a session from starting. This matches the
planner's existing fail-open principle and matches what
`pi-dynamic-workflows` does (falls back to the shared working directory with a
log).

But fail-open silently reintroduces exactly the stomping the caller asked to
avoid. So callers that cannot tolerate that pass `required: true`, and the
daemon fails `session/new` instead. The planner sets this for competition
siblings, where a silent fallback would make N candidates non-independent and
quietly invalidate the comparison.

Non-git directories, repos with no commits, and dirty source trees are all
fail-open cases, not errors.

## Lifecycle and recovery

**Ordering.** Record the worktree in daemon state *before* calling
`git worktree add`. A crash then leaves a known-stale record rather than an
untracked directory nobody will find.

**On daemon restart**, each recorded worktree is in one of three states:

| State | Action |
| --- | --- |
| Session still live or resumable | keep |
| Session gone, worktree clean | prune (directory + branch if unmerged-empty) |
| Session gone, worktree has uncommitted work | **keep and report** |

Never auto-delete the third. It may hold the only copy of real work.

**Lock instead of relying on records.** Run `git worktree lock` on a worktree
while its session is live, and unlock when the session ends. This is better
than protecting the worktree with our own bookkeeping alone, because it stops
*any* concurrent cleanup (ours, another client's, a stray `git worktree prune`)
rather than only the paths that consult our records. Claude Code does exactly
this for agent worktrees.

Ownership protocol, worth copying wholesale: reconciliation may release a lock
belonging to a session whose process has exited (so a killed session does not
strand its worktree permanently), but must **never** release a lock a human set
manually. Distinguish our locks from theirs in the lock reason string.

**Two registries.** Daemon state and git's own worktree registry can diverge,
and `git worktree prune` mutates the latter without consulting us. Decide
explicitly which is authoritative (proposal: git is authoritative for
existence, daemon for intent) and make reconciliation a named operation
rather than an implicit repair. This is the same failure shape as the existing
`attachedSessions` / `clientAttachedSessions` split in the planner: two sets
that must not be conflated.

## Known asymmetry

The API is "a worktree for a session." The planner's integration worktree
(holding the plan branch) has no session. Rather than distort this API with a
session-less worktree concept, the planner creates and owns that one worktree
itself and the daemon owns the rest. Documented, not erased.

## Sequencing

1. Provisioning + `_meta` plumbing + effective-cwd behavior. No hooks, no
   ports. Sufficient for `hydra session new --worktree`.
2. Repo config: `carry`, `postCreate`, `preRemove`.
3. Port allocation.
4. Reconciliation surface (`worktree list`/`prune`) and restart recovery.

Steps 1 and 3 cannot be prototyped above this layer. Step 2 can be, and the
planner document proposes doing so to prove the config shape against a real
repo before fixing it in the protocol.

## Open questions

- Worktree root inside the repo (`.hydra/worktrees`, needs a `.gitignore`
  entry) or outside (`~/.hydra-acp/worktrees/<repo-hash>/`)? Inside is
  discoverable and survives `git worktree list`; outside keeps the repo clean
  and avoids tooling that walks the tree. Data point: Claude Code chose inside
  (`.claude/worktrees/<name>`, branch `worktree-<name>`) and tells users to
  gitignore it. Still leaning outside, with the path reported in session info,
  but the precedent is worth weighing. **This question now has three
  dependents**: whether the `cwd=` filter can be prefix-based, whether
  budgeter's existing prefix match survives (see Consumer impact), and
  workspace discoverability via `git worktree list`. Decide it early.
- **Base ref semantics.** Claude Code defaults to branching from the remote
  default branch (`worktree.baseRef: "fresh"`) and offers local `HEAD`
  (`"head"`) for the case of "isolating subagents that need to operate on
  in-progress work." That is precisely the planner's case, so a `fresh`-style
  default would be actively wrong for orchestrated work. Whatever we expose,
  the planner's line branches must fork from the plan-branch tip, which is a
  `head`-shaped semantic. Do not inherit `fresh` as a default just because it
  is the safer choice for interactive sessions.
- `session fork` **defaults `cwd` to the source session's** (`:480`). Since an
  isolated session's `cwd` *is* its workspace, the default silently puts the
  fork in the same workspace as its parent, which is exactly the concurrent
  editing this feature exists to prevent, arrived at by inheritance rather than
  by choice. Not merely "probably wrong": it is the failure mode, reintroduced
  through a field that predates workspaces. Options: fork into a new workspace
  from the parent's current snapshot (most useful, matches fork semantics), or
  drop to `sourceCwd` unisolated. Either way the current default cannot stand.
  The same reasoning applies anywhere else `cwd` is inherited rather than
  supplied, including `session import` (`:519`).
- Should the daemon *warn* on a second non-isolated session in a tree that
  already has one, or stay silent? Warning is cheap and this is the pain that
  motivates the whole feature.
- Submodules interact poorly with `git worktree`. Detect and warn, or ignore?
- Copy-on-write: worth using `cp --reflink=auto` / APFS clonefile for
  `node_modules` before falling back to `postCreate` install? It is nearly
  free on btrfs/xfs/APFS and avoids the symlink problems below.
- Symlinking `node_modules` instead of installing is faster but breaks tools
  that resolve realpaths or write into `node_modules/.cache`, and in a
  workspaces monorepo requires discovering per-workspace `node_modules` as
  well as the hoisted root. Probably a documented recipe rather than daemon
  behavior.
