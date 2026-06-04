# hydra-acp-planner

> **Status: pre-alpha (M0).** Skeleton transformer + CLI; no orchestration yet.

Multi-agent project orchestrator for [hydra-acp](https://github.com/smagnuso/hydra-acp).
You describe a project; the planner decomposes it into a task DAG, spawns
worker sessions, coordinates them by prompt management, and surfaces progress
in your original chat session.

```
user> /plan build a todo app with auth using 3 agents

🧩 Decomposing project…
   T1 Design auth schema      no deps
   T2 Implement signup        depends on T1
   T3 Implement login         depends on T1
   T4 Frontend scaffold       no deps
   T5 Integrate auth UI       depends on T2, T3, T4
   T6 Tests                   depends on T2, T3
   T7 Docs                    depends on T5

▶ T1 → worker fa3c
▶ T4 → worker 8b91
✓ T1  bcrypt cost 12, sessions in redis
▶ T2 → worker fa3c
✓ T4
…
🎉 7 tasks complete
```

The planner is a hydra-acp **transformer** — it sits inside the daemon's
message pipeline, intercepts the user's prompt, drives decomposition via
the host session's own agent, and spawns N worker sessions to execute
tasks in parallel. Worker agents need no special protocol prompt or
custom system message; they're plain ACP agents being driven by prompt
management.

## How it works

1. You're in a normal hydra-acp session. The planner transformer is in
   its chain (added once via `hydra-acp transformer add`).
2. You type `/plan <description>`.
3. The transformer intercepts the prompt, rewrites it as a decomposition
   request, sends it to the host session's agent.
4. The agent returns a JSON task DAG. The transformer parses it,
   persists a `board.json` under `~/.hydra-acp/planner/projects/<id>/`,
   and spawns worker sessions via `hydra-acp/child_session/spawn`.
5. Each worker gets one task prompt at a time. On reply, the
   transformer parses a fenced ```hydra-result block, marks the task
   done, and assigns the next eligible task.
6. You can keep chatting with the host session throughout. Prompts that
   look like plan mutations ("add a task for rate limiting") get
   forwarded to the agent with board context; `/plan ...` slash commands
   are handled directly by the transformer.

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
```

Edit `~/.hydra-acp/config.json` to add the planner to `defaultTransformers`:

```json
{
  "transformers": {
    "hydra-acp-planner": {
      "command": ["node"],
      "args": ["/absolute/path/to/hydra-acp/planner/dist/index.js"]
    }
  },
  "defaultTransformers": ["hydra-acp-planner"]
}
```

```sh
hydra-acp daemon restart
```

Then in any hydra-acp session:

```text
/plan build a hello-world CLI in Python
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

## M0 status

This release ships:

- ✅ Dual-mode binary: transformer when daemon-spawned, CLI otherwise.
- ✅ Transformer connects, registers intercepts, logs traffic, never
  modifies anything.
- ✅ `--version`, `--help`, `--describe`.
- ⏳ Everything else.

## License

MIT.
