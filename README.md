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
hydra-acp transformer add hydra-acp-planner --command hydra-acp-planner
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
| `/hydra planner create [flags] <description>`        | Plan a fresh project from `<description>`. Asks the host agent to decompose, then spawns workers. See **flags** below. |
| `/hydra planner execute [flags]`                     | Plan from the conversation so far — no description needed. Asks the host agent to decompose what you've been discussing into a task DAG and spawns workers. |
| `/hydra planner status`                              | Render the current session's board (tasks, states, worker assignments, attached status). |
| `/hydra planner add <description>`                   | Slot a new task into the current project. Asks the orchestrator agent where it fits in the DAG; appends and schedules. |
| `/hydra planner retask <taskId>`                     | Reset a task to pending. Closes its current worker (if any), bumps `attemptCount`, schedules a fresh attempt. |
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
retask/kill/pause/resume/cancel/remove flows with worker spawning,
dependency-aware scheduling, and restart-rehydration. Rough edges
around long-tail error cases; open issues at the project repo.

## License

MIT.
