# hydra-acp-planner

> **Status: pre-alpha (M0).** Skeleton transformer + CLI; no orchestration yet.

Multi-agent project orchestrator for [hydra-acp](https://github.com/smagnuso/hydra-acp).
You describe a project; the planner decomposes it into a task DAG, spawns
worker sessions, coordinates them by prompt management, and surfaces progress
in your original chat session.

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

The planner is a hydra-acp **transformer** — it sits inside the daemon's
message pipeline. The user invokes it through hydra-acp's slash-command
convention (`/hydra planner <verb>`); the planner drives decomposition
via the host session's own agent, then spawns N worker sessions to
execute tasks in parallel. Worker agents need no special protocol
prompt or custom system message; they're plain ACP agents being driven
by prompt management.

## How it works

1. You're in a normal hydra-acp session. The planner transformer is in
   its chain (added once via `hydra-acp transformer add`).
2. You type `/hydra planner create <description>`.
3. The planner mints a project, persists `board.json` under
   `~/.hydra-acp/planner/projects/<id>/`, then fires a decomposition
   sub-prompt at the host session's agent.
4. The agent returns a JSON task DAG. The transformer parses it,
   updates the board, and (M2+) spawns worker sessions via
   `hydra-acp/child_session/spawn`.
5. Each worker gets one task prompt at a time. On reply, the
   transformer parses a fenced ```hydra-result block, marks the task
   done, and assigns the next eligible task.
6. You can keep chatting with the host session throughout. Plan
   mutations come through additional `/hydra planner <verb>` commands
   (`status`, `add`, `retask`, `skip`, `kill` — landing in subsequent
   milestones).

See [PLAN.md](./PLAN.md) (TODO) for the milestone breakdown and
[hydra-acp/README.md](https://github.com/smagnuso/hydra-acp) for the
substrate.

## Install

From source (only path right now):

```sh
git clone <repo-url> ~/dev/hydra-acp/planner
cd ~/dev/hydra-acp/planner
npm install
npm run build
```

Register as a transformer with hydra-acp:

```sh
hydra-acp transformer add hydra-acp-planner \
  --command node \
  --args /absolute/path/to/hydra-acp/planner/dist/index.js
hydra-acp daemon restart
```

That's it. **You do not need to add the planner to `defaultTransformers`** —
the slash command itself triggers the planner to install into the
session it was invoked from, via `hydra-acp/transformer/attach`. Sessions
where you never invoke planner stay free of its intercepts entirely.

Then in any hydra-acp session:

```text
/hydra planner create build a hello-world CLI in Python
```

## CLI

```text
hydra-acp planner                     # default: list projects (TODO M3.5)
hydra-acp planner show <id>           # board summary (TODO M3.5)
hydra-acp planner --version
hydra-acp planner --help
```

The CLI dispatches through hydra-acp's git-style subcommand fallback:
`hydra-acp planner foo` is exec'd as `hydra-acp-planner foo` if a
`hydra-acp-planner` binary is on PATH. Installing this package globally
(`npm i -g`) puts it on PATH automatically.

## M1 status

This release ships:

- ✅ Dual-mode binary: transformer when daemon-spawned, CLI otherwise.
- ✅ Slash command: `/hydra planner create <description>` mints a
  project, drives decomposition, persists board.json.
- ✅ Plan summary surfaced in transcript via synthetic
  agent_message_chunk.
- ✅ CLI: `hydra-acp planner` (list), `hydra-acp planner show <id>`.
- ⏳ Worker spawning, dependency-aware scheduling (M2+).
- ⏳ Status / mutation slash commands: `/hydra planner status`,
  `/hydra planner add`, etc.

## License

MIT.
