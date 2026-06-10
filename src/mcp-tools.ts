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
     parallel via task dependencies.

  2. Call set_plan with the DAG to materialize it as a \
     ready plan. Use list_agents first if you want to know \
     what agents are available for per-task overrides.

  3. Narrate the plan to the user in plain language. Don't repeat \
     the raw task data — summarize structure (how many tasks, what \
     can parallelize, key per-task choices).

  4. If the user wants to revise (more parallelism, add/remove \
     tasks, change constraints, switch agents/models), regenerate \
     the DAG and call set_plan again. The new plan replaces \
     the old draft.

  5. When the user agrees, call start to kick off workers.

  6. While running, call get_status when the user asks \
     about progress, add_task to slot in mid-flight \
     additions, or stop / pause / resume \
     to control execution.

User-stated preferences (worker count, preferred agent/model, \
specific overrides for particular tasks) MUST be embedded in your \
set_plan call exactly as specified — concurrencyCap for \
worker count, fleetDefaults for session-wide preferences, per-task \
agent/model for specific overrides. Never silently override what \
the user requested.

Never call start without the user's explicit go-ahead.\
`;

export interface PlannerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
      "Persist a task DAG as a ready plan for this session. Replaces any existing ready plan. Use this when the user has settled on what they want built, or wants to revise a draft. Returns a summary the user-facing turn can narrate. Does NOT start execution — call start separately when the user agrees.",
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
            "Optional. Controls whether review tasks are synthesized after decomposition. Defaults to { mode: 'hints', overrideHint: false }.",
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
          },
        },
        fleetDefaults: {
          type: "object",
          description:
            "Optional. Session-level defaults applied to tasks that don't carry per-task overrides. Set when the user expresses a session-wide preference ('use claude for everything', 'prefer haiku where possible').",
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
            },
          },
        },
      },
    },
  },
  {
    name: "start",
    description:
      "Kick off the ready plan on this session. If no ready plan exists, fails with a hint to call set_plan first. Returns when the worker scheduler is started — progress is observable via subsequent get_status calls or via the live plan rendering in the orchestrator's turn.",
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
