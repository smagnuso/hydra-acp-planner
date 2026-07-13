// MCP tool specs the planner advertises to agents via
// hydra-acp/mcp_tools/register. Agents see these as native tools they
// can call from any conversational turn, eliminating the need for the
// user to use `/hydra planner ...` slash syntax (though slash commands
// remain available for explicit control).
//
// Each tool's handler is wired in bridge.ts where it has access to
// board state, the scheduler, and the held-turn machinery. The specs
// live here so the registration payload is data, not code.

export const PLANNER_MCP_INSTRUCTIONS = `\
Tools for coordinating multi-agent project work via the hydra-acp \
planner extension.

When the user asks you to build, fix, refactor, or otherwise execute \
work that decomposes into multiple parallelizable tasks, use these \
tools to form and run plans. Iterate the plan in dialog: the user \
proposes changes, you regenerate the DAG and call set_plan \
again. Don't dump task JSON into chat — pass it as the tool's input.

Workflow:

  1. When the user describes work, decompose into a task DAG \
     (id like T1, T2, …; title; why; what; constraints; deps; \
     optional per-task agent / model). Identify what can run in \
     parallel via task dependencies. Tag each task with riskLevel \
     and reviewHint so the planner knows which tasks need reviews \
     (the default policy is 'hints': everything gets a synthesized \
     review unless reviewHint='skip'). High-risk tasks should be \
     reviewHint='required' and usually want a reviewAgent / \
     reviewModel stronger than the default.

  2. Call set_plan with the DAG to materialize it as a \
     ready plan. Use list_agents first if you want to know \
     what agents are available for per-task overrides.

  3. Narrate the plan to the user in plain language. Don't repeat \
     the raw task data — summarize structure (how many tasks, what \
     can parallelize, key per-task choices).

  4. If the user wants to revise BEFORE work has started (board \
     state is ready), regenerate the DAG and call set_plan again \
     — the new plan replaces the old draft. AFTER work has started, \
     prefer update_task for single-task edits (switching a pending \
     task's agent or model, tweaking its brief); set_plan is \
     refused on a running/paused board. Only fall back to \
     stop → set_plan → start when structural changes are too \
     sweeping for update_task / add_task / skip / retry to express.

  5. When the user agrees, call execute_plan to kick off workers \
     AND keep the live view anchored to your own turn for the \
     duration of the project (the call blocks until the project \
     terminates, returning the completion summary). Use start \
     instead only when the user explicitly wants to start-and-go \
     ('start it and let me do something else'); start returns \
     immediately and the live view appears in a separately-injected \
     follow-up turn. Never ask the user to type \`/hydra planner \
     start\` themselves once they've already approved.

  6. While running, call get_status when the user asks about \
     progress, add_task to slot in mid-flight additions, \
     update_task to rebind a pending task's agent / model / brief \
     without disturbing the rest of the board, skip / retry for \
     per-task corrections, or stop / pause / resume to control \
     execution overall.

  7. After a project completes (or if the user asks about review \
     failures, follow-ups, or what came up in a finished task), \
     call get_findings to retrieve the structured list of tasks \
     that need attention — failed tasks, reviews that didn't \
     approve, and follow-ups recorded by work tasks. The \
     project-complete summary mentions get_findings when there's \
     something to surface; reach for it then.

User-stated preferences (worker count, preferred agent/model, \
specific overrides for particular tasks) MUST be embedded in your \
set_plan call exactly as specified — concurrencyCap for \
worker count, fleetDefaults for session-wide preferences, per-task \
agent/model for specific overrides. Never silently override what \
the user requested.

Never call start without the user's explicit go-ahead.

Do NOT maintain your own TodoWrite / todo list for planner work. \
The plan IS the todo list: set_plan stores it, the live plan panel \
renders it with ticking checkboxes as tasks progress, and \
get_status / get_plan / get_findings expose it on demand. A \
parallel TodoWrite duplicates the same information in the \
transcript, drifts out of sync with the board, and adds noise. \
Use set_plan to materialize the plan for user review and \
execute_plan / start to run it — that's the whole tracking story.\
`;

export interface PlannerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Short instructions block registered alongside the gateway tool set.
// Kept intentionally minimal — the full planner workflow prose only
// materializes once the agent has activated (and thus committed to the
// planning context). Idle sessions that never plan pay only this ~250-
// token surface plus the single `activate` tool.
export const PLANNER_MCP_GATEWAY_INSTRUCTIONS = `\
Multi-agent planning is available on this session but not currently \
loaded. If the user asks you to build, fix, refactor, or otherwise \
execute work that would benefit from being broken into a parallel task \
DAG, call \`activate\` on this MCP server first — that unlocks the full \
planning toolset (set_plan, execute_plan, get_status, and the rest). \
Until activated, this MCP server exposes only that one tool.\
`;

// Gateway tool set. Registered at boot. Kept to one tool so the fixed
// per-session cost is minimal — non-planning sessions pay only this.
// Once the agent calls `activate`, the planner's per-session state
// marks the session activated and the daemon-forwarded list_tools
// handler returns the full PLANNER_MCP_TOOLS spec on the next
// tools/list (triggered by the eviction-forced transport reset).
export const PLANNER_MCP_GATEWAY_TOOLS: PlannerMcpTool[] = [
  {
    name: "activate",
    description:
      "Unlock the full planner toolset on this session. Call this once when the user first asks for multi-agent planning, decomposition, or coordinated parallel work. After activation the tool list grows to include set_plan, execute_plan, get_status, and the rest — you'll see them on your next turn. No arguments; the activation state is per-session and idempotent (calling again is harmless).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const PLANNER_MCP_TOOLS: PlannerMcpTool[] = [
  {
    name: "list_agents",
    description:
      "List the agents available for spawning workers on this session's tasks. Returns an array of {id, description} pairs. Call this when you're deciding per-task agent overrides and want to know what's installed. The default agent (used when no per-task or fleet override is set) is whatever this session was created with — usually the same agent that's currently talking.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_plan",
    description:
      "Persist a task DAG as a ready plan for this session. Replaces any existing ready plan. Use this when the user has settled on what they want built, or wants to revise a draft. Returns a summary the user-facing turn can narrate. Does NOT start execution — call start separately when the user agrees. By default the planner synthesizes a review task for every work task (reviewPolicy.mode='hints'); tag trivial tasks with reviewHint='skip' to opt out, and high-risk tasks with reviewHint='required' (optionally pairing reviewAgent / reviewModel with a stronger reviewer). Use reviewPolicy.mode='off' only when the user explicitly doesn't want reviews.",
    inputSchema: {
      type: "object",
      required: ["description", "tasks"],
      properties: {
        description: {
          type: "string",
          description:
            "One-line project summary for the plan header (e.g. 'build a Python web scraper that fetches URLs, parses links, writes CSV').",
        },
        concurrencyCap: {
          type: "integer",
          description:
            "Optional. Maximum concurrent workers. Defaults to a sweep-line cap derived from DAG shape (the right answer for most cases — adding more workers wouldn't help beyond what dependencies allow). Set explicitly only when the user has stated a constraint ('use 3 workers', '--workers 5').",
        },
        reviewPolicy: {
          type: "object",
          description:
            "Optional. Controls whether review tasks are synthesized after decomposition. Defaults to { mode: 'hints', overrideHint: false, maxAttempts: 3 }.",
          properties: {
            mode: {
              type: "string",
              enum: ["off", "hints", "all", "high-only"],
              description:
                "Which tasks get review tasks synthesized. 'hints' honors the agent's reviewHint; 'all' reviews everything; 'high-only' reviews only high-risk tasks.",
            },
            overrideHint: {
              type: "boolean",
              description:
                "When true, overrides the agent's 'skip' hint to still synthesize a review task.",
            },
            maxAttempts: {
              type: "integer",
              description:
                "Default number of attempts a work task is allowed before its review marking it failed. Defaults to 3. Applies to every synthesized review unless the task carries its own onReject.maxAttempts.",
            },
          },
        },
        contractBrief: {
          type: "string",
          description:
            "Optional. A user-authored markdown block describing cross-cutting contracts and invariants that every task (work AND review) must respect. Use for non-obvious facts about the surrounding system — protocol/wire-shape constraints, framework gotchas, binding rules, etc. Rendered above any per-task context, so every worker checks against the same spec and every reviewer has the same brief to verify against.",
        },
        fleetDefaults: {
          type: "object",
          description:
            "Optional. Session-level defaults applied to tasks that don't carry per-task overrides. Set when the user expresses a session-wide preference ('use claude for everything', 'prefer haiku where possible'). The `work`, `review`, and `distill` sub-objects scope defaults to a kind; `distill` falls through to `review` for agent/model when unset.",
          properties: {
            agent: {
              type: "string",
              description:
                "Default agent id. Use list_agents to discover valid ids.",
            },
            model: {
              type: "string",
              description: "Default model id passed through to spawned workers.",
            },
            work: {
              type: "object",
              description:
                "Optional. Defaults applied only to kind='work' tasks.",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
              },
            },
            review: {
              type: "object",
              description:
                "Optional. Defaults applied only to kind='review' tasks. Leave runOn UNSET unless you specifically need to override the inferred lane: when agent or model is set here, the bridge auto-routes the review to a worker so those values take effect; when neither is set, reviews default to the orchestrator lane (inline, fast). Setting runOn='orchestrator' alongside agent or model makes those values dead config — orchestrator-lane tasks run inline in the host session and ignore the configured agent/model. Only set runOn when the desired lane disagrees with the auto-routing.",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
                runOn: { type: "string", enum: ["orchestrator", "worker"] },
              },
            },
            distill: {
              type: "object",
              description:
                "Optional. Defaults applied only to bridge-synthesized kind='distill' tasks. Falls through to fleetDefaults.review.{agent,model,runOn} per-field when unset. Leave runOn UNSET unless you need to override: distill auto-routes to a worker when any agent/model is configured (here or in review), and defaults to worker even without one. Setting runOn='orchestrator' alongside agent or model strands those values — orchestrator-lane tasks ignore configured agent/model and run inline on the host session.",
              properties: {
                agent: { type: "string" },
                model: { type: "string" },
                runOn: { type: "string", enum: ["orchestrator", "worker"] },
              },
            },
          },
        },
        tasks: {
          type: "array",
          description:
            "The task DAG. Each task must declare id, title, and deps (possibly empty). Other fields are optional but recommended — they help the worker agent know what to do.",
          items: {
            type: "object",
            required: ["id", "title", "deps"],
            properties: {
              id: {
                type: "string",
                description:
                  "Stable identifier, conventionally T1, T2, T3, …",
              },
              title: {
                type: "string",
                description: "Short human-readable name.",
              },
              why: {
                type: "string",
                description:
                  "Why this task exists — context for the worker agent.",
              },
              what: {
                type: "string",
                description: "What the worker should produce or do.",
              },
              constraints: {
                type: "string",
                description:
                  "Hard constraints the worker must respect (language, dependencies, file layout, etc.).",
              },
              deps: {
                type: "array",
                description:
                  "Task ids this task depends on. Empty array = can run from the start.",
                items: { type: "string" },
              },
              agent: {
                type: "string",
                description:
                  "Optional per-task agent override. Use a value from list_agents. Falls through to fleetDefaults.agent then daemon default.",
              },
              model: {
                type: "string",
                description: "Optional per-task model override.",
              },
              reviewAgent: {
                type: "string",
                description:
                  "Optional agent override for the synthesized review of this task. Falls through to fleetDefaults.review.agent. Ignored on tasks with kind='review'.",
              },
              reviewModel: {
                type: "string",
                description:
                  "Optional model override for the synthesized review of this task. Falls through to fleetDefaults.review.model.",
              },
              kind: {
                type: "string",
                enum: ["work", "review", "distill"],
                description:
                  "Task kind. Defaults to 'work'. Use 'review' to author a hand-rolled review task (e.g. a competition referee); pair with `reviews` to point at the work tasks being reviewed. Use 'distill' to merge N independent inputs into one source-cited findings report — requires a non-empty `reviews` field naming the source task ids (typically also listed in `deps`). User-authored distill produces an informational cited report; its `recommended_action` does NOT mutate the reviewees (they are inputs, not work-to-supersede). Bridge-spawned distill (from competition reviewer decision='synthesize') still applies winners and spawns rework follow-ups via its own internal `distillOf` linkage.",
              },
              reviews: {
                description:
                  "For kind='review' tasks: the work-task id (string) or ids (array) this review evaluates. Used by the competition pattern to nominate a single referee for sibling implementations.",
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
              riskLevel: {
                type: "string",
                enum: ["low", "medium", "high"],
                description:
                  "How risky is this task? Rubric: schema changes, security-sensitive code, or public-API surface changes → 'high'; integration with new services, complex business logic, or cross-module refactors → 'medium'; mechanical refactors (naming, formatting, dead-code removal) → 'low'. Defaults to 'medium'. Drives reviewPolicy.mode='high-only' and may influence reviewAgent/reviewModel choice.",
              },
              reviewHint: {
                type: "string",
                enum: ["skip", "optional", "recommended", "required"],
                description:
                  "How strongly should a human-style review be applied after this task completes? Rubric pairs with riskLevel: high → 'required', medium → 'recommended', low → 'skip', uncertain → 'optional'. Defaults to 'optional' (which synthesizes a review under the default 'hints' policy). Set 'skip' to opt this task out of review synthesis under 'hints' mode. Tasks marked 'required' should usually also carry a reviewAgent/reviewModel for stronger reasoning.",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "start",
    description:
      "Kick off the ready plan on this session and return immediately once the worker scheduler is started. Use this when the user wants to start the work but continue chatting (the live view appears in a separately-injected `/hydra planner continue` turn after your turn ends). For the more common case where the user has just approved kickoff and wants to watch it run, prefer execute_plan — it blocks until the project finishes and keeps the live view inside your own turn.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "execute_plan",
    description:
      "Kick off the ready plan AND block until the project terminates (done / failed / stopped). The live plan view renders inside your own turn for its entire duration, so the user sees ticking checkboxes without any extra slash command. Use this whenever the user has approved kickoff in the current turn ('go for it', 'run it', 'looks good'). On termination the tool returns the same completion summary the slash command would emit (including findings, if any). If the user halts via `/hydra planner stop`, this returns with a stopped summary; if they amend / yield mid-flight, this returns with a 'paused live view' note while the project keeps running in the background.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_plan",
    description:
      "Return the current plan for this session as structured data. Useful for inspecting what's there before revising, or for answering user questions about the plan structure. Returns the same shape that set_plan accepts plus runtime fields like task status and assigned worker.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_findings",
    description:
      "Return the structured list of tasks that need attention — failed tasks, reviews that rejected/amended/required fixes, and completed tasks that captured follow_ups. Use this after a project completes (or any time during a run) when the user asks to address review failures, fix what came up, or read the reviewer's notes. Each finding includes the taskId, a category (failed | review_reject | review_amend | review_fix | follow_ups), summary, notes, follow-ups, and verified_diff when available. Two-call pattern: call with no args to list findings, then call again with `taskId` set to get the full notes and follow-ups for a specific task in content[0].text. Pass includeApproved=true to also list approved reviews (audit / debugging only).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Optional. Restrict the result to one task id (e.g. 'T8'). When set, returns either that task's finding or an empty list if it has none.",
        },
        includeApproved: {
          type: "boolean",
          description:
            "Optional. Default false. When true, also include approve/winner/synthesize review tasks in the result (otherwise they are filtered as nothing-to-do).",
        },
      },
    },
  },
  {
    name: "get_status",
    description:
      "Return the current execution status: task counts (pending / in-flight / done / failed), in-flight workers and what task each is on, recent completions with their result summaries. Use when the user asks 'where are we' or 'what's happening now.'",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "add_task",
    description:
      "Slot a new task into a running or ready plan. The agent will be asked to figure out where it fits in the DAG. Use when the user adds a requirement mid-flight ('also make sure to retry HTTP failures').",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: {
          type: "string",
          description: "Description of the task to add.",
        },
      },
    },
  },
  {
    name: "update_task",
    description:
      "Rebind fields on a pending task without disturbing the rest of the board. Use when the user wants to change which agent or model handles an upcoming task, or to tweak its brief, mid-run ('switch T5 to opus', 'have T7 use the rust-expert agent'). Only pending tasks may be updated — for in-flight or finished tasks, use retry or restart. To change a review task's agent/model, either set reviewAgent/reviewModel on the work task (the change propagates to the live review-Tx task automatically) or target the review task directly by its id (e.g., taskId='review-T1', agent='pi-local'). The new values take effect when the task is next scheduled. Pass an empty string to clear an override and fall through to fleetDefaults.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "Id of the task to update (e.g. 'T5').",
        },
        agent: {
          type: "string",
          description:
            "New worker agent id. Empty string clears the override and falls through to fleetDefaults.",
        },
        model: {
          type: "string",
          description: "New worker model id. Empty string clears.",
        },
        reviewAgent: {
          type: "string",
          description: "Agent override for the synthesized review of this task.",
        },
        reviewModel: {
          type: "string",
          description: "Model override for the synthesized review of this task.",
        },
        what: {
          type: "string",
          description: "Revised 'what to produce' brief.",
        },
        why: {
          type: "string",
          description: "Revised rationale.",
        },
        constraints: {
          type: "string",
          description: "Revised hard constraints.",
        },
        riskLevel: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "Revised risk classification. Empty string clears back to the implicit default ('medium').",
        },
        reviewHint: {
          type: "string",
          enum: ["skip", "optional", "recommended", "required"],
          description:
            "Revised review intent. Changing from 'skip' to anything else under the default 'hints' policy will cause a review-task to be synthesized for this task if one doesn't already exist. Empty string clears back to the implicit default ('optional').",
        },
      },
    },
  },
  {
    name: "restart",
    description:
      "Reset every task on the board to pending and run the whole plan from scratch. Closes any in-flight workers, clears artifacts and reviewFeedback, and re-engages the scheduler. The plan structure (titles, deps, agents, reviews) stays intact — only per-task runtime state is wiped. Use when the user wants to redo a project end-to-end after the source tree has changed underneath the plan (e.g. stashed/applied a patch).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "stop",
    description:
      "Stop the running project. Force-cancels in-flight workers and reverts those tasks to pending; the project moves to state 'stopped' and is resumable via start. Use when the user wants to halt work but might come back to it. Distinct from remove (which deletes the project) and pause (which lets in-flight workers finish).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "pause",
    description:
      "Stop scheduling new tasks. In-flight workers run to completion; their results land normally; no new tasks dispatch until resume. Use when the user wants to take a break or inspect intermediate state.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "resume",
    description: "Resume scheduling on a paused project.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "skip",
    description:
      "Mark a task done without running it (artifacts: 'skipped by user'). Frees its worker if assigned. Use when the user has decided a task isn't needed after all.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "Id of the task to skip (e.g. 'T3').",
        },
      },
    },
  },
  {
    name: "retry",
    description:
      "Reset a task to pending and resume work. If it's currently assigned, closes its worker (work is discarded), bumps attemptCount, schedules a fresh attempt. If the project was in `stopped` state, also flips it back to running. Use when a task got into a bad state and the user wants to try again from scratch. Omit `taskId` to retry every task currently in `failed` status — the common recovery flow after a stuck-board notice.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Id of the task to retry. Omit to retry all failed tasks.",
        },
      },
    },
  },
  {
    name: "remove",
    description:
      "Delete this session's project. Closes worker sessions; orchestrator session is left intact. Use only when the user is done with the project entirely — for stopping work without deleting, use stop.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
