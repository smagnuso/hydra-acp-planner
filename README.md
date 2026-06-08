# hydra-acp-planner

Multi-agent project orchestrator for [hydra-acp](https://github.com/smagnuso/hydra-acp).
You describe a project; the planner asks the host session's agent to
decompose it into a task DAG, spawns N worker sessions, and coordinates
them by prompt management — progress streams back into your original
chat session.

```
user> /hydra planner create build a todo app with auth

🧩 Planning project proj_a3f9b1 — asking the agent to decompose.
🧩 Decomposed into 7 tasks (concurrency cap 3).

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

The planner is a hydra-acp **transformer** — it lives inside the
daemon's message pipeline. The user invokes it through hydra-acp's
slash-command convention (`/hydra planner <verb>`); the planner drives
decomposition via the host session's own agent, then spawns worker
sessions to execute tasks in parallel. Workers need no special protocol
or system message — they're plain ACP agents driven by prompt
management.

## How it works

```
              hydra-acp daemon
              ┌──────────────────────────┐
   /hydra ──► │  message chain           │
   planner    │   ├─ planner transformer │◄── attaches to orchestrator
   create     │   └─ ...                 │    session on first /hydra
              │                          │    planner invocation
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

1. You're in a normal hydra-acp session. The planner transformer is
   registered with the daemon (added once via `hydra-acp transformer add`).
2. You type `/hydra planner create <description>`. Hydra dispatches the
   slash command to the planner.
3. The planner mints a project, persists `board.json` under
   `~/.hydra-acp/planner/projects/<id>/`, self-attaches to the session's
   transformer chain, and fires a decomposition sub-prompt at the host
   agent.
4. The agent returns a fenced JSON task DAG. The transformer parses it,
   updates the board, and spawns worker sessions via
   `hydra-acp/child_session/spawn`.
5. Each worker gets one task prompt at a time. On reply, the
   transformer parses a fenced ```hydra-result block, marks the task
   done, and assigns the next eligible task (respecting dependencies
   and concurrency cap).
6. You can keep chatting with the host session throughout. Plan
   mutations come through additional `/hydra planner <verb>` commands.
7. If the planner (or the daemon) restarts, it rehydrates non-terminal
   boards from disk, re-attaches to orchestrator sessions when they
   come back live, and resumes any in-flight worker tasks.

## Setup

### 1. Install or build

From npm (recommended):

```sh
npm install -g @hydra-acp/cli @hydra-acp/planner
```

This drops the `hydra-acp` CLI plus an `hydra-acp-planner` binary on
your PATH. The CLI dispatches `hydra-acp <name>` to any
`hydra-acp-<name>` binary on PATH, so the planner is also reachable as
`hydra-acp planner`.

Or from source:

```sh
git clone https://github.com/smagnuso/hydra-acp-planner.git ~/dev/hydra-acp/planner
cd ~/dev/hydra-acp/planner
npm install
npm run build
```

### 2. Register as a transformer with hydra-acp

If installed via npm:

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

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "transformers": {
    "hydra-acp-planner": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp/planner/dist/index.js"],
      "enabled": true
    }
  }
}
```

On `hydra-acp daemon start`, hydra spawns hydra-acp-planner with these
env vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`,
`HYDRA_ACP_WS_URL`, `HYDRA_ACP_TRANSFORMER_NAME`. The presence of
`HYDRA_ACP_TRANSFORMER_NAME` is what flips the binary from CLI mode
into transformer mode. Stdout/stderr land in
`~/.hydra-acp/transformers/hydra-acp-planner.log`.

> **You do not need to add the planner to `defaultTransformers`.** The
> slash command itself triggers the planner to install into the session
> it was invoked from, via `hydra-acp/transformer/attach`. Sessions
> where you never invoke planner stay free of its intercepts entirely.

### 3. Use it

In any hydra-acp session:

```text
/hydra planner create build a hello-world CLI in Python
```

## Slash commands

All commands run inside a hydra-acp session. The `/hydra` prefix routes
through hydra's slash registry; the planner registers these verbs at
daemon connect time so they show up in tab-complete.

| Command                                              | Effect |
|------------------------------------------------------|--------|
| `/hydra planner create [flags] <description>`        | **Form a plan** from `<description>`. Asks the host agent to decompose into a task DAG, shows you the plan, and stops — no workers spawned. Review the plan; iterate by running `create` again with a revised description; commit by running `execute` when you're satisfied. See **flags** below. |
| `/hydra planner execute [flags]`                     | **Run the plan.** If a `create` plan is already ready on this session, kick it off (transition to running, spawn workers, open the live view). If there's no plan yet, decompose from the current conversation and run in one step (the original execute behavior). |
| `/hydra planner status`                              | One-shot snapshot of the current session's board (tasks, states, worker assignments). Doesn't open the live view — safe to type anytime without affecting an in-flight project. |
| `/hydra planner continue`                            | Open the live view on this session's running project. Plan panel re-renders, worker output streams, banner stays busy until the project completes (or the user amends/cancels). Used both manually and auto-injected by the planner after every amend on `create`/`execute`/`continue`. |
| `/hydra planner add <description>`                   | Slot a new task into the current project. Asks the orchestrator agent where it fits in the DAG; appends and schedules. |
| `/hydra planner retry [<taskId>]`                    | Reset a task to pending and resume work. Closes its current worker (if any), bumps `attemptCount`. If the project was `stopped`, also flips it back to running and re-opens the live view. With no arg, retries every failed task. |
| `/hydra planner skip <taskId>`                       | Mark a task done without running it (artifacts: `skipped by user`). Frees its worker. |
| `/hydra planner kill <workerId>`                     | Close a specific worker session. Requeues its current task as pending. |
| `/hydra planner pause`                               | Stop scheduling new tasks. In-flight workers run to completion; their results land normally but no new tasks dispatch until resume. |
| `/hydra planner resume`                              | Resume scheduling on a paused project. |
| `/hydra planner cancel [<projectId>]`                | Force-stop the current session's project (or another by id). Cancels in-flight workers via `force_cancel`; pending tasks freeze on the board; sessions are kept for inspection. |
| `/hydra planner remove [<projectId>]`                | Delete the current session's project (or another by id) and close its worker sessions. The orchestrator session is left intact. |

### `create` / `execute` flags

Both commands accept a few leading flags that override fleet defaults
for the spawned workers:

| Flag             | Effect |
|------------------|--------|
| `--workers N`    | Cap concurrent workers at N (overrides the sweep-line analysis of the DAG). |
| `--agent ID`     | Agent id used when spawning workers (defaults to the orchestrator's agent). Must match an entry in `hydra-acp agents list`. |
| `--model ID`     | Model id passed through to spawned workers. |

Examples:

```text
/hydra planner create --workers 5 build a todo app with auth
/hydra planner create --agent codex --model gpt-5 implement the spec in SPEC.md
/hydra planner execute --workers 2
```

### Natural-language Q&A on a board

When the current session owns an active project, any non-slash prompt
you type is rewritten before reaching the agent with a board-context
preamble. That means you can ask things like:

```text
> what's left?
> why did T3 choose bcrypt cost 12?
> which tasks are blocking T7?
```

…and the agent answers using the board it can see, without needing
MCP tools. Slash commands (`/hydra …`) are unaffected.

### Workflow: form a plan, then execute

Project lifecycle is two-phase:

1. **Form** with `/hydra planner create <description>`. The planner asks the agent to decompose into a task DAG, saves the plan to disk, shows it to you, and stops. No workers spawned yet. State: `ready`. Revise by running `create` again with a different description — the previous ready plan is replaced.
2. **Run** with `/hydra planner execute`. Transitions the ready plan to `running`, spawns workers, opens the live view. Banner busy until the project completes.

If you skip step 1 and just run `/hydra planner execute` on a fresh session, the planner decomposes from the current conversation and kicks off in one step (the original single-shot behavior).

```text
> /hydra planner create build a Python web scraper
   (decomposes; plan panel shows; turn ends)
   ...you read the plan, decide it looks good...

> /hydra planner execute
   (workers start, live view engages, banner stays busy)
```

### Live view, yield, and re-acquire

`/hydra planner create` and `/hydra planner execute` open a **held
turn** on your session — your slash command stays in flight in
hydra's queue, plan updates and worker output stream into it, and
the busy indicator stays on for the project's lifetime.

Your slash command renders as a regular user prompt in the
transcript (with the standard `⚙ thinking…` placeholder while
decomposition runs, then a live tools panel as workers fire tool
calls), so there's no asymmetry between starting a planner project
and any other agent prompt.

While the live view is held, **^C / Esc** cancels the project
(force-cancels workers, freezes the board, ends the turn). To chat
with the agent without killing the project, just type a non-slash
prompt and hit Enter: the planner **yields** the live view —
releases the held turn with a "stepping aside" message — and your
prompt runs against the agent normally. Workers keep going in the
background; plan updates continue to emit but don't anchor to a
held turn until you re-acquire.

To re-acquire the live view while a project is running in
background mode, run `/hydra planner continue`. The planner also
**auto-injects** `/hydra planner continue` after every amend, so
the live view re-engages right after your amended turn ends — you
don't have to remember to run it yourself. `/hydra planner status`
is a separate verb that prints a one-shot snapshot without
opening the live view, for when you just want a quick check.

The lifecycle in a nutshell:

| Action                                        | Effect on held turn | Effect on project |
|-----------------------------------------------|---------------------|-------------------|
| Project completes                             | resolved (`complete`) | done              |
| `^C` / Esc                                    | resolved (`cancelled`) | force-cancelled, board frozen |
| `/hydra planner cancel`                       | resolved (`cancelled`) | force-cancelled, board frozen |
| Typing a non-slash prompt (Enter, default amend) | resolved (`yielded`) + auto-injects `/hydra planner continue` after the amended turn | continues in background |
| `/hydra planner continue` (running project)   | new held turn opens | unchanged          |
| `/hydra planner status`                       | no change (one-shot snapshot) | unchanged    |
| `/hydra planner remove`                       | resolved (`removed`) | board deleted     |

## Reviews and Competitions

The planner supports **review tasks** — a second task kind that evaluates
the output of a work task before it's considered done. A review is a task
with `kind: "review"` and a `reviews` reference pointing at the work task
it evaluates.

### Review decisions

When a review completes, the planner reads the decision from the agent's
response:

| Decision | Effect |
|----------|--------|
| `approve` | The reviewed work task transitions to `done`; its dependents unblock. |
| `reject` | Work task stays pending (or resets per strategy); feedback attaches. |
| `amend` | Same as reject, but the agent can also supply corrected artifacts. |
| `fix` | Orchestrator-lane only — the reviewer patches artifacts in-place. |

### Review lanes (`runOn`)

Reviews run on one of two lanes:

| Lane | Worker | Can apply fixes? |
|------|--------|------------------|
| `orchestrator` (default) | Host session's agent | Yes (`canApplyFixes=true`) |
| `worker` | Dedicated review worker | No |

Orchestrator-lane reviews stream into your active chat; the reviewer can
see the board context and apply fixes without spawning a new worker.
Worker-lane reviews are fully isolated — useful when you want a separate
agent to do the review.

### `onReject` strategies

When a review rejects a work task, the planner applies one of three
strategies (configurable per-task via `onReject.strategy`):

| Strategy | Behavior |
|----------|----------|
| `fresh` (default) | Reset the task to pending with accumulated rejection feedback; a worker retries from scratch. |
| `continue` | Keep the task in its current state but bump `attemptCount`; the next worker sees the feedback and continues from where it left off. |
| `escalate` | Spawn a new task targeting a different agent/model (requires `onReject.escalateTo`). |

All strategies respect `onReject.maxAttempts` (default 3), after which
the work task fails with all accumulated review feedback attached.

### Competition pattern

The competition pattern lets multiple workers tackle the same task in
parallel; the first review to approve wins and the others are marked
`superseded`. This is useful when you want diverse approaches — e.g.,
two agents independently designing a database schema, then a single
reviewer picks the best one.

```text
  T1  Design auth schema        —  no deps         ← two workers spawn
  T2  Review T1                 —  reviews: T1      ← competition review
  T3  Implement signup          —  depends on T1    ← blocked until T1 done
```

With `--compete true`, the decomposer knows to emit multiple parallel
work tasks for the same dependency and a single competition review that
picks a winner. Superseded tasks are persisted but don't block
dependents.

### CLI flags

| Flag | Effect |
|------|--------|
| `--review-policy MODE` | Synthesize review tasks automatically. Modes: `off`, `hints` (default, honors agent hints), `all` (every work task), `high-only` (risk=high tasks). |
| `--override-hint true\|false` | When `true`, synthesize a review even if the agent's hint says "skip". |
| `--compete true\|false` | Enable competition pattern instructions in decomposition. |
| `--review-agent ID` | Agent for spawned review workers (overrides fleet default). |
| `--review-model ID` | Model for spawned review workers. |
| `--review-run-on orchestrator\|worker` | Default lane for synthesized reviews. |
| `--work-agent ID` | Agent for spawned work tasks. |
| `--work-model ID` | Model for spawned work tasks. |

Examples:

```text
/hydra planner create --review-policy all --compete true build a todo app with auth
/hydra planner execute --review-run-on worker --review-agent code-reviewer
```

## CLI

The CLI inspects the planner's on-disk state. It works even when the
daemon is down — no roundtrip required.

```text
hydra-acp planner                     # list active projects (default)
hydra-acp planner list [--all] [--json]
hydra-acp planner info <projectId> [--json]
hydra-acp planner remove <projectId>
hydra-acp planner --version
hydra-acp planner --help
```

| Verb     | Flags          | Effect |
|----------|----------------|--------|
| `list`   | `--all`        | Include `done` / `failed` projects (hidden by default). |
|          | `--json`       | Emit raw JSON instead of a table. |
| `info`   | `--json`       | Show the full board: orchestrator session, workers, tasks with deps, state, concurrency cap. |
| `remove` |                | Delete a project's directory and close its worker sessions (via `hydra-acp session remove`). The orchestrator session is left intact. |

`hydra-acp planner foo` dispatches through hydra-acp's git-style
subcommand fallback: it's exec'd as `hydra-acp-planner foo` if the
`hydra-acp-planner` binary is on PATH. Installing this package globally
(`npm i -g`) puts it on PATH automatically.

To start a new project, use the slash command — there is no
`hydra-acp planner create` CLI form, because creation is intrinsically
tied to a host session.

## On-disk layout

The planner owns one directory: `~/.hydra-acp/planner/`.

```
~/.hydra-acp/planner/
└── projects/
    └── proj_a3f9b1.../
        ├── board.json     # full DAG state, worker pointers, fleet defaults
        └── orchestrator   # text file: the session id that owns this project
```

`board.json` is the source of truth on disk; the planner mirrors it in
memory while running and writes through on every state transition.
Sessions referenced by the board (orchestrator + workers) live in
hydra-acp's own session store, not here.

## Configuration

The planner reads its connection info from env vars injected by the
daemon when spawned as a transformer. You don't normally set these by
hand.

| Env var                       | Default                            | Notes |
|-------------------------------|------------------------------------|-------|
| `HYDRA_ACP_TOKEN`             | (required)                         | Bearer token for hydra. Injected by the daemon. |
| `HYDRA_ACP_DAEMON_URL`        | `http://127.0.0.1:55514`           | HTTP base of the hydra daemon. Injected by the daemon. |
| `HYDRA_ACP_WS_URL`            | derived from `HYDRA_ACP_DAEMON_URL`| WebSocket endpoint. Defaults to `ws[s]://<host>:<port>/acp`. |
| `HYDRA_ACP_TRANSFORMER_NAME`  | (set by daemon)                    | Presence flips the binary into transformer mode; absence runs the CLI. |
| `DEBUG`                       | `false`                            | Verbose logging. |

## Tests

```sh
npm test
```

Runs the board, decomposition, formatter, task-protocol, text-helper,
and smoke tests with the built-in Node test runner.

```sh
npm run lint    # tsc --noEmit
npm run build   # tsup → dist/index.js
npm run watch   # rebuild on change
```

## Status

In active development. Functional for create/execute/status/add/skip/
retry/kill/pause/resume/cancel/remove flows with worker spawning,
dependency-aware scheduling, and restart-rehydration. Rough edges
around long-tail error cases; open issues at the project repo.

## License

MIT.
