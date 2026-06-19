# hydra-acp-planner

A multi-agent project orchestrator that lives inside the
[hydra-acp](https://github.com/smagnuso/hydra-acp) daemon. You describe
a project to your agent in chat; your agent decomposes it into a task
DAG and runs it. Workers run as plain ACP agents — no special protocol,
no special system message — driven entirely by prompt management.
Progress streams back into the same chat session you started from.

The planner exposes its capabilities to your agent as schema-validated
MCP tools (`set_plan`, `start`, `get_status`, `get_findings`, …). The
agent calls them directly; you stay in the conversation. Slash commands
(`/hydra planner …`) exist as a direct-invocation power-user path, but
the main mode is conversational.

## How you use it

You describe a project. Your agent proposes a task DAG and calls
`set_plan`. You say go. Workers run; progress streams back to your chat.

```
user> I want to build a Python web scraper that fetches a list of URLs,
      parses links, and writes them to CSV.

agent> Here's a plan I'd run with three tasks: T1 fetch, T2 parse, T3
       write. T2 and T3 depend on T1. I'll set this up.
       [calls set_plan with the DAG]
       Plan is ready. Want me to start it?

user> Go.

agent> [calls start]
       ✓ T1 fetch — 50 URLs fetched, 2 retries
       ✓ T2 parse — 412 links extracted
       ✓ T3 write — links.csv written
       Done. Want me to summarize what each task did?
```

The agent drives the planner through MCP tools: `set_plan`, `start`,
`get_status`, `get_findings`, `retry`, `add_task`, `skip`, `pause`,
`resume`, `update_task`, and others. These are first-class,
schema-validated calls — the agent is not screen-scraping a CLI.

You can also invoke directly with `/hydra planner create <description>`
followed by `/hydra planner start` when you want to skip the
conversational step. Both paths are first-class.

## Modes of operation

Three worked examples covering the patterns the planner is built for.

### a) Plain DAG build

The basic case: a project decomposes into a handful of work tasks with
dependencies, and workers run them in topological order under a
concurrency cap.

```
user> Build a todo app with auth.

agent> I'll set up a 7-task DAG.
       [calls set_plan]
       [calls start]

  T1  Design auth schema       —  no deps
  T2  Implement signup         —  depends on T1
  T3  Implement login          —  depends on T1
  T4  Frontend scaffold        —  no deps
  T5  Integrate auth UI        —  depends on T2, T3, T4
  T6  Tests                    —  depends on T2, T3
  T7  Docs                     —  depends on T5

▶ T1 → worker fa3c
▶ T4 → worker 8b91
✓ T1  bcrypt cost 12, sessions in redis
▶ T2 → worker fa3c
✓ T4
…
🎉 7 tasks complete
```

Concurrency defaults to a sweep-line analysis of the DAG; override
with `concurrency` in `set_plan` or `--workers N` on the slash form.

### b) Multi-angle PR review with distill

Use case: review an external artifact (a PR diff, a design doc, a
benchmark) from multiple independent perspectives, then collapse the
results into one cited merge report.

```
user> I want three independent reviews of this PR — one for security,
      one for API design, one for tests — and then a fourth pass that
      merges them with citations.

agent> Setting up four tasks: T1/T2/T3 as independent work-kind
       reviews, T4 as a distill that merges them.
       [calls set_plan]
```

The resulting plan:

```
  T1  Security review of the PR     —  no deps
  T2  API-design review of the PR   —  no deps
  T3  Test-coverage review of the PR—  no deps
  T4  Distill from T1, T2, T3       —  deps: T1,T2,T3   reviews: T1,T2,T3
```

`T4` carries `kind: "distill"`; its `reviews` list defines the
citation domain it is allowed to source from. The distill output is
parser-validated for source citations by construction, and lands on
`T4`'s artifacts (visible via `get_findings`). YAML form:

```yaml
tasks:
  - id: T1
    kind: work
    what: Review the attached PR diff for security issues. Cite line ranges.
  - id: T2
    kind: work
    what: Review the attached PR diff for API design. Cite line ranges.
  - id: T3
    kind: work
    what: Review the attached PR diff for test coverage. Cite line ranges.
  - id: T4
    kind: distill
    deps: [T1, T2, T3]
    reviews: [T1, T2, T3]
    what: Merge the three angle-specific reviews into one cited report.
```

User-authored distill differs from the bridge-synthesized competition
distill in one way: `recommended_action` is informational only —
nothing is superseded, no follow-up task is spawned. See **Reviews,
competitions, distill** below for the competition-driven variant.

### c) Tiered agents with senior review

Use case: workers run on a fast/cheap agent; reviewers run on a more
capable agent. Useful when you want a lot of parallel exploration but
a careful gate.

```
user> Use sonnet for the work and opus for the reviews. Review every
      task.

agent> Setting fleet defaults: work on sonnet, reviews on opus, and
       reviewPolicy.mode = "all" so every work task gets a review.
       [calls set_plan]
```

The relevant `set_plan` fields:

```yaml
fleetDefaults:
  work:    { agent: claude, model: claude-sonnet-4 }
  review:  { agent: claude, model: claude-opus-4 }
reviewPolicy:
  mode: all
contractBrief: |
  Cross-cutting invariants every task (work AND review) must respect.
  Workers implement against this brief; reviewers check the
  implementation against it. Keep it short and concrete.
```

`contractBrief` is rendered above per-task context in both worker and
reviewer prompts, which is how you make the cheap workers and the
senior reviewer check against the same set of invariants.

Slash-command equivalent:

```text
/hydra planner create \
  --work-model claude-sonnet-4 \
  --review-model claude-opus-4 \
  --review-policy all \
  <description>
```

This composes with the competition pattern: `--compete true` together
with tiered agents gives you cheap parallel workers and a senior
referee that picks the winner.

## Reviewing the work

After a project finishes (or while it's in flight), your agent calls
`get_findings` to surface what needs attention: failed tasks, review
verdicts that asked for fixes, worker-captured follow-ups. It's a
two-call pattern — calling `get_findings` with no arguments returns a
directory of which tasks have findings; calling it again per task
returns full notes, follow-ups, and a `verified_diff` descriptor where
applicable.

In conversational use you don't have to ask for this by name — you
can just say "what's left?" or "why did T3 choose bcrypt cost 12?".
When the current session owns an active project, every non-slash
prompt is rewritten with a board-context preamble before reaching the
agent, so it answers from the board it can see without calling any
tools.

`/hydra planner status` is the slash equivalent of a one-shot
snapshot — it prints the board without opening a live view, useful
when you just want a quick check.

For failed or rejected tasks, `/hydra planner retry [<taskId>]` resets
the task to pending and resumes work. With no argument it retries
every failed task in the current project.

## Reviews, competitions, distill

The planner supports a second task kind, `review`, that evaluates the
output of a work task before it's considered done. Synthesized reviews
ship with an adversarial-but-honest system prompt: search for the
specific way the implementation might be wrong about contracts outside
the diff, but if the search turns up nothing of substance, approve.

### Review decisions

| Decision | Effect |
|----------|--------|
| `approve` | The reviewed work task transitions to `done`; dependents unblock. |
| `reject`  | Work task stays pending (or resets per strategy); feedback attaches. |
| `amend`   | Same as reject, but the reviewer can also supply corrected artifacts. |
| `fix`     | Orchestrator-lane only — the reviewer patches artifacts in-place. |

### Review lanes

Reviews run on one of two lanes:

| Lane | Worker | Can apply fixes? |
|------|--------|------------------|
| `orchestrator` (default) | Host session's agent | Yes (`canApplyFixes=true`) |
| `worker` | Dedicated review worker | No |

Orchestrator-lane reviews stream into your active chat and can apply
fixes without spawning a new worker. Worker-lane reviews are fully
isolated — useful when the reviewer should be a different agent.

### `onReject` strategies

| Strategy | Behavior |
|----------|----------|
| `fresh` (default) | Reset the task to pending with accumulated feedback; a worker retries from scratch. |
| `continue` | Keep current state but bump `attemptCount`; the next worker sees feedback and continues. |
| `escalate` | Spawn a new task targeting a different agent/model (requires `onReject.escalateTo`). |

All strategies respect `onReject.maxAttempts` (default 3), after which
the work task fails with all accumulated feedback attached. The
default can be raised board-wide via `reviewPolicy.maxAttempts` in
`set_plan`; per-task `onReject.maxAttempts` overrides it.

### Competition pattern

The competition pattern lets multiple workers tackle the same task in
parallel; the first review to approve wins and the others are marked
`superseded`. Useful when you want diverse approaches — e.g., two
agents independently designing a schema, then a single reviewer picks
the best one.

```
  T1  Design auth schema        —  no deps         ← two workers spawn
  T2  Review T1                 —  reviews: T1     ← competition review
  T3  Implement signup          —  depends on T1   ← blocked until T1 done
```

With `--compete true`, the decomposer emits multiple parallel work
tasks for the same dependency and a single competition review that
picks a winner. Superseded tasks are persisted but don't block
dependents.

### Distill

`distill` is a task kind that merges N inputs into one source-cited
report. It comes in two flavors:

- **Bridge-synthesized** — emitted automatically as the terminal step
  in a competition flow, merging the per-attempt reviews into one
  report; `recommended_action` here can mutate state (`apply Tx`
  picks a winner; `rework` spawns a fix-up task).
- **User-authored** — declared directly in `set_plan` with a
  non-empty `reviews` list as the citation domain. Use this for the
  multi-angle PR review pattern shown above. `recommended_action` is
  informational only; nothing is superseded and no follow-up task is
  spawned. Use `noop` when the report is purely informational.

In both flavors, the distill output is parser-validated for source
citations and lands on the distill task's artifacts, visible via
`get_findings`.

## Setup

### Install

From npm (recommended):

```sh
npm install -g @hydra-acp/cli @hydra-acp/planner
```

This drops the `hydra-acp` CLI plus an `hydra-acp-planner` binary on
your PATH. The CLI dispatches `hydra-acp <name>` to any
`hydra-acp-<name>` binary on PATH, so the planner is also reachable
as `hydra-acp planner`.

Or from source:

```sh
git clone https://github.com/smagnuso/hydra-acp-planner.git ~/dev/hydra-acp/planner
cd ~/dev/hydra-acp/planner
npm install
npm run build
```

### Register as a transformer

```sh
hydra-acp transformer add hydra-acp-planner
hydra-acp daemon restart
```

Or pointed at a local build:

```sh
hydra-acp transformer add hydra-acp-planner \
  --command node \
  --args ~/dev/hydra-acp/planner/dist/index.js
hydra-acp daemon restart
```

You do not need to add the planner to `defaultTransformers`. The
first `/hydra planner` invocation (or first MCP tool call) installs
the planner into the session it was invoked from via
`hydra-acp/transformer/attach`. Sessions where you never invoke the
planner stay free of its intercepts entirely.

## Reference

### Slash commands

These are the direct-invocation forms. In conversational use your
agent calls the equivalent MCP tools (next subsection).

| Command | Effect |
|---------|--------|
| `/hydra planner create [flags] <description>` | Form a plan from `<description>` and stop — no workers spawned. Iterate by re-running `create`; commit with `start`. |
| `/hydra planner start [flags]` | Run the current ready plan. If no plan exists, decompose from conversation and run in one step. |
| `/hydra planner status` | One-shot snapshot of the current session's board. |
| `/hydra planner findings [<taskId>]` | Human-readable view of failures, review verdicts that asked for fixes, and worker-captured follow-ups. With no arg shows everything; with a taskId shows the full block for that task. |
| `/hydra planner continue` | Open the live view on this session's running project. |
| `/hydra planner add <description>` | Slot a new task into the current project. |
| `/hydra planner retry [<taskId>]` | Reset a task to pending and resume work. No arg = retry all failed tasks. |
| `/hydra planner skip <taskId>` | Mark a task done without running it. |
| `/hydra planner kill <workerId>` | Close a specific worker session; requeue its task. |
| `/hydra planner pause` | Stop scheduling new tasks. In-flight workers run to completion. |
| `/hydra planner resume` | Resume scheduling on a paused project. |
| `/hydra planner cancel [<projectId>]` | Force-stop the project. Board freezes; sessions are kept for inspection. |
| `/hydra planner remove [<projectId>]` | Delete the project and close its worker sessions. |

### CLI flags (create / start)

Both commands accept the same leading flags, which override fleet
defaults for the spawned workers.

| Flag | Effect |
|------|--------|
| `--workers N` | Cap concurrent workers at N. |
| `--agent ID` / `--model ID` | Default agent / model for spawned workers. |
| `--work-agent ID` / `--work-model ID` | Agent / model for work tasks specifically. |
| `--review-agent ID` / `--review-model ID` | Agent / model for review tasks. |
| `--review-policy MODE` | Synthesize reviews: `off`, `hints` (default), `all`, `high-only`. |
| `--override-hint true\|false` | Synthesize a review even if the agent's hint says skip. |
| `--compete true\|false` | Enable the competition pattern in decomposition. |
| `--review-run-on orchestrator\|worker` | Default lane for synthesized reviews. |
| `--attach <path>` | Inline the contents of `<path>` into every worker's prompt. Repeatable. Tilde-expanded. |

Examples:

```text
/hydra planner create --workers 5 build a todo app with auth
/hydra planner create --review-policy all --compete true implement the spec in SPEC.md
/hydra planner start --review-run-on worker --review-agent code-reviewer
```

### MCP tools

The tools your agent calls. Names match `src/mcp-tools.ts`.

| Tool | Effect |
|------|--------|
| `list_agents`  | List agents available to spawn workers on. |
| `set_plan`     | Declare or replace the DAG: tasks, deps, kinds, fleetDefaults, reviewPolicy, contractBrief. |
| `get_plan`     | Read the current plan. |
| `start`        | Transition the ready plan to running and spawn workers. |
| `get_status`   | One-shot snapshot of the board. |
| `get_findings` | Two-call drill-down for failed tasks, review verdicts, follow-ups, and `verified_diff` descriptors. |
| `add_task`     | Slot a new task into the running project. |
| `update_task`  | Mutate fields on an existing task. |
| `retry`        | Reset a task to pending and resume work. |
| `skip`         | Mark a task done without running it. |
| `pause`        | Stop scheduling new tasks. |
| `resume`       | Resume scheduling on a paused project. |
| `restart`      | Restart a worker session for a task. |
| `stop`         | Force-stop the project; freeze the board. |
| `remove`       | Delete the project and close its worker sessions. |

### Hydra-acp CLI

The CLI inspects the planner's on-disk state without needing the
daemon to be up:

```text
hydra-acp planner                       # list projects (live + recent terminal)
hydra-acp planner list [--all] [--json]
hydra-acp planner info <projectId> [--json]
hydra-acp planner remove <projectId>
```

There is no `hydra-acp planner create` CLI form — creation is
intrinsically tied to a host session.

## Internals

The planner is a hydra-acp **transformer**: it lives inside the
daemon's message pipeline. Slash commands route through it; MCP tool
calls route through it; worker spawns go out via
`hydra-acp/child_session/spawn`.

```
              hydra-acp daemon
              ┌──────────────────────────┐
   /hydra ──► │  message chain           │
   planner    │   ├─ planner transformer │◄── attaches to orchestrator
   create     │   └─ ...                 │    session on first invocation
              │                          │
              │  spawns child sessions ──┼──► worker session 1 (T1)
              │  via child_session/spawn │    worker session 2 (T4)
              │                          │    ...
              └──────────────────────────┘
                         │
                  ~/.hydra-acp/planner/
                  └─ projects/<id>/
                       ├─ board.json
                       └─ orchestrator   ← session id pointer
```

If the planner (or the daemon) restarts, it rehydrates non-terminal
boards from disk, re-attaches to orchestrator sessions when they come
back live, and resumes any in-flight worker tasks.

### On-disk layout

```
~/.hydra-acp/planner/
└── projects/
    └── proj_a3f9b1.../
        ├── board.json     # full DAG state, worker pointers, fleet defaults
        └── orchestrator   # text file: the session id that owns this project
```

`board.json` is the source of truth; the in-memory state mirrors it
and writes through on every transition. Sessions referenced by the
board live in hydra-acp's own session store, not here.

### Environment

The planner reads its connection info from env vars injected by the
daemon when spawned as a transformer. You don't normally set these
by hand.

| Env var | Default | Notes |
|---------|---------|-------|
| `HYDRA_ACP_TOKEN` | (required) | Bearer token. Injected by the daemon. |
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:55514` | HTTP base of the hydra daemon. |
| `HYDRA_ACP_WS_URL` | derived from `HYDRA_ACP_DAEMON_URL` | WebSocket endpoint. |
| `HYDRA_ACP_TRANSFORMER_NAME` | (set by daemon) | Presence flips the binary into transformer mode; absence runs the CLI. |
| `DEBUG` | `false` | Verbose logging. |

### Tests

```sh
npm test         # board, decomposition, formatter, task-protocol, smoke
npm run lint     # tsc --noEmit
npm run build    # tsup → dist/index.js
npm run watch    # rebuild on change
```

## Status

In active development. Functional for create/start/status/add/skip/
retry/kill/pause/resume/cancel/remove flows with worker spawning,
dependency-aware scheduling, reviews, competitions, distill, and
restart-rehydration. Rough edges around long-tail error cases; open
issues at the project repo.

## License

MIT.
