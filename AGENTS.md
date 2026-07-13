# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-planner` — a multi-agent project orchestrator that lives inside
Hydra. The user describes a project to their agent in chat; the agent
decomposes it into a task DAG and runs it. Workers run as plain ACP agents
— no special protocol, no special system message — driven entirely by
prompt management. Progress streams back into the same chat session the
user started from.

The planner exposes its capabilities to the agent as schema-validated MCP
tools (`set_plan`, `start`, `execute_plan`, `get_status`, `get_findings`,
`add_task`, `update_task`, `retry`, `skip`, `stop`, `pause`, `resume`,
`restart`, `remove`, `list_agents`). Slash commands (`/hydra planner …`)
exist as a power-user path but the main mode is conversational.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`, especially the transformer surface, MCP-tool
registration, and command registration.

This is a **transformer**, not a client extension: it connects to the
daemon once, declares its intercepts, and sits inside the daemon's message
pipeline. It spawns worker sessions via the daemon's own `session/new` and
drives them by injecting prompts and reading their transcripts. Boards
persist under `~/.hydra-acp/planner/projects/<id>/` so plans survive
daemon restarts.

## Layout

- `src/index.ts` — entry point
- `src/bridge.ts` — transformer WS connection (**very large —
  ~7900 lines**; the beating heart. Read the file's section markers
  before editing. Contains the transformer intercept dispatch, worker
  lifecycle, MCP tool dispatch, and the client-side session/attach for
  the amend-then-continue flow, all in one place)
- `src/mcp-tools.ts` — the agent-facing MCP tools (the primary surface)
- `src/cli.ts` — the `/hydra planner …` slash-command handlers
- `src/board.ts`, `src/task.ts`, `src/state.ts` — plan data model and
  persistence
- `src/decomposition.ts` — task-DAG shape helpers
- `src/plan-update.ts`, `src/held-turn.ts` — the live plan-panel render
  and turn-hold machinery
- `src/worker-forward.ts` — spawns and drives worker sessions
- `src/render-reviews.ts`, `src/review-policy.ts` — synthesized review
  tasks
- `src/deferred-mcp.ts`, `src/format.ts`, `src/paths.ts`, `src/config.ts`
- `src/acp/`, `src/util/`

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-planner` on PATH. Registered via
`hydra-acp transformer add hydra-acp-planner`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- MCP tool schemas are user-facing (agents read them). Changes to tool
  names, argument shapes, or descriptions are protocol changes — coordinate
  and version-bump.
- Plan state on disk is versioned. Old projects must load on new versions
  or be migrated explicitly.
- Fail-open: an error in the planner cannot block the host session's turn.
- Reviews are synthesized per policy; respect `reviewHint='skip'` and the
  user's `reviewPolicy.mode`.

## Gotchas

- Worker sessions are real hydra sessions — they show up in `session list`
  and can be attached by any client. Don't leak internal orchestration
  chatter into their transcripts.
- The live plan panel renders inside the orchestrator's turn for the
  duration of `execute_plan`. Long-running plans hold that turn open; the
  user can amend or yield mid-flight per the panel affordances.
- Concurrency cap defaults to the sweep-line width of the DAG. Adding
  workers beyond that is wasted; don't paper over dependency structure with
  more parallelism.
- Distill tasks synthesized from competition reviewers mutate their
  reviewees (apply winners, spawn rework). User-authored distill does not.
  Don't conflate the two lanes.
- **Board schema is versioned + auto-migrated on load** (`board.ts`
  `BOARD_SCHEMA_VERSION`, `migrateBoard`). v2→v3 split `assigned` into
  `assigned`/`running`. A schema bump without an in-place migration
  means old projects silently misread.
- **`recoverOrphanSynthesize`** (`board.ts`) handles the crash window
  between "review→done saved" and "distill sibling persisted". Recovery
  reverts the review to `pending` so a re-run is idempotent — it does
  NOT attempt to skip ahead and spawn distill directly. Don't "optimize
  away" by trusting cross-mutation atomicity.
- **Held-turn is not just UX** (`held-turn.ts`). It keeps
  `commands/invoke` open for the entire project lifetime so (1) Enter
  defaults to amend, (2) plan updates render in-place, (3) ^C routes
  through session/cancel intercept. Rehydrated projects (post-daemon-
  restart) have no held turn and run in degraded mode — check this
  path when adding new turn-scoped features.
- **MCP tool gateway** (`mcp-tools.ts`): only ONE tool (`activate`) is
  registered at daemon boot to minimize per-session token cost. The
  full `PLANNER_MCP_TOOLS` list materializes after `activate` triggers
  an eviction-forced transport reset. Eagerly registering all tools
  breaks that fixed-cost invariant.
- **Two attach registries** (`bridge.ts`): `attachedSessions`
  (transformer-attach, for chain interception) vs. `clientAttachedSessions`
  (peer session/attach, for injecting `/hydra planner status` after
  amend). The planner acts as BOTH transformer and client on the same
  session — mixing the two sets breaks the amend-then-continue flow.
- **`workerForwarders` buffers agent chunks per worker** so streamed
  text isn't split mid-sentence by `[Tn] ` prefixes injected between
  chunks. Boundary flushing lives in `worker-forward.ts`.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
