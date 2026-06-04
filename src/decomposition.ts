import type { Board, Task } from "./board.js";
import { formatBoardContext } from "./format.js";

// The decomposition prompt is the single most product-defining piece of
// text in the planner. It needs to elicit a JSON DAG that's executable
// by autonomous workers AND respects the project's WHAT/WHY/CONSTRAINTS
// discipline — task descriptions specify desired outcomes, not
// mechanisms. Two workers handed the same task should be able to
// produce legitimately different implementations.

export interface AgentChoice {
  id: string;
  description?: string | undefined;
}

const DECOMPOSITION_SYSTEM = `You are helping plan a software project that will be executed by parallel coding agents. Your job is to break the project into a minimal task DAG and respond with structured JSON.

For each task specify:
  - id: short identifier like "T1", "T2", "T3"
  - title: 4 to 8 words, action-oriented
  - why: one sentence on user value or system constraint
  - what: one short paragraph describing the desired outcome — NOT the mechanism
  - constraints: hard requirements (compatibility, performance, security, file boundaries)
                 that bound the solution space without dictating one implementation
  - deps: array of task ids that must complete before this one can start
  - agent (optional): id of a specialist agent that should execute this task, drawn
                      from the list below. Omit (or set null) when the default agent fits.
  - model (optional): model id to apply on the worker session at bootstrap (e.g. a
                      stronger model for harder tasks). Omit when the default model fits.

Do NOT specify:
  - library, framework, or algorithm choices
  - file paths, directory structure, or module organization
  - variable names, function signatures, or pseudocode
  - phrasing like "use X" or "implement using Y"

Two coding agents handed the same task should be able to produce legitimately different implementations. If you catch yourself writing pseudocode, the task is too specified — back off and describe the outcome instead.

Keep the DAG minimal. Prefer fewer larger tasks over many tiny ones. Aim for 3 to 12 tasks for most projects; only exceed that when the project genuinely requires it. Dependencies should be the truth of what blocks what, not a vague ordering preference.

Reply with ONLY a fenced JSON block matching this schema, and no other prose:

\`\`\`json
{
  "tasks": [
    {
      "id": "T1",
      "title": "...",
      "why": "...",
      "what": "...",
      "constraints": "...",
      "deps": [],
      "agent": null,
      "model": null
    }
  ]
}
\`\`\``;

// Render an "Available agents:" block to splice into a prompt. Returns
// an empty string when no agents are known so the prompt can be built
// either way.
export function formatAgentChoices(agents: AgentChoice[] | undefined): string {
  if (!agents || agents.length === 0) return "";
  const lines = ["Available specialist agents (pick by id, or omit for default):"];
  for (const a of agents) {
    const desc = a.description ? ` — ${a.description}` : "";
    lines.push(`  - ${a.id}${desc}`);
  }
  return lines.join("\n");
}

export function buildDecompositionPrompt(
  description: string,
  agents?: AgentChoice[],
): string {
  const agentsBlock = formatAgentChoices(agents);
  const tail = agentsBlock ? `\n\n${agentsBlock}` : "";
  return `${DECOMPOSITION_SYSTEM}${tail}\n\nProject to decompose:\n${description}`;
}

// Variant of buildDecompositionPrompt used by `/hydra planner execute`:
// instead of taking a verbatim project description, asks the agent to
// decompose the project it has been discussing with the user in the
// current conversation, and to include a `description` field
// summarizing that project in the response. The board's description
// field is filled in from that summary after parsing.
export function buildExecuteDecompositionPrompt(
  agents?: AgentChoice[],
): string {
  const agentsBlock = formatAgentChoices(agents);
  const tail = agentsBlock ? `\n\n${agentsBlock}` : "";
  return [
    `${DECOMPOSITION_SYSTEM}${tail}`,
    ``,
    `You and the user have been discussing a software project in this conversation. Decompose THAT project — what you have been planning together — into the task DAG.`,
    ``,
    `Additionally, include a top-level "description" field in the JSON block: a one-sentence summary of the project we've been planning, suitable for showing alongside the project id in status displays.`,
    ``,
    "```json",
    `{`,
    `  "description": "...",`,
    `  "tasks": [`,
    `    { "id": "T1", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [], "agent": null, "model": null }`,
    `  ]`,
    `}`,
    "```",
  ].join("\n");
}

// Prompt sent on planner startup when a project board was in the
// `decomposing` state at the time of the last shutdown. Hydra
// auto-resurrects the orchestrator session and seeds the prior
// transcript as takeover; this prompt tells the agent to either
// re-emit the decomposition it already produced (if it had finished)
// or continue from where it left off.
export function buildResumeDecompositionPrompt(description: string): string {
  return [
    `[hydra-acp-planner: resuming decomposition after restart]`,
    ``,
    `You were in the middle of decomposing this project:`,
    ``,
    `  ${description}`,
    ``,
    `If you already emitted a JSON task DAG, re-emit it verbatim now (don't redo the planning). Otherwise, continue from where you left off.`,
    ``,
    `Reply with ONLY a fenced \`\`\`json block matching the schema:`,
    ``,
    "```json",
    `{ "tasks": [{ "id": "T1", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [] }] }`,
    "```",
  ].join("\n");
}

// Parse a fenced ```json block out of the agent's reply. The agent is
// instructed to emit only the JSON block, but models sometimes wrap it
// in introductory prose anyway, so we tolerate that. Returns undefined
// if no parsable block is found.
export function extractJsonBlock(text: string): unknown {
  // Permissive: match ```json or ``` followed by JSON. Capture greedy
  // to the next fence so prose after the block doesn't poison the
  // match. We pick the FIRST block — additional blocks (if any) are
  // ignored.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/;
  const m = text.match(fenceRe);
  if (!m || m[1] === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

export interface DecompositionResult {
  tasks: Task[];
  warnings: string[];
  // Optional summary of the project the agent decomposed. Populated only
  // by the `execute` path, where the user didn't supply a description
  // up front — the agent emits one in the JSON block and we use it as
  // the board's description.
  description?: string;
}

// Build the prompt sent to the orchestrator agent when the user invokes
// `/hydra planner add <description>`. Gives the agent the current board
// context plus the user's add request and asks for a fenced
// hydra-add-task block describing one or more new tasks to slot into
// the DAG. The agent is instructed not to modify existing tasks — only
// to ADD.
export function buildAddTaskPrompt(
  description: string,
  board: Board,
  agents?: AgentChoice[],
): string {
  const existingIds = board.tasks.map((t) => t.id).join(", ");
  const nextN = nextTaskNumber(board);
  const agentsBlock = formatAgentChoices(agents);
  return [
    `You are extending an in-flight multi-agent project plan. The user wants to add work to it.`,
    ``,
    `User's request:`,
    `  "${description}"`,
    ``,
    formatBoardContext(board),
    ``,
    `Decide:`,
    `  1. Does this add one task or several?`,
    `  2. Where does it fit in the dependency graph? (\`deps\` may reference existing task ids: ${existingIds || "(none)"}.)`,
    `  3. What id(s) to use? Continue the existing T-numbering — next free id is T${nextN}.`,
    `  4. Does any task warrant a specialist \`agent\` or a non-default \`model\`? Omit (or null) for the defaults.`,
    ``,
    `Reply with ONLY a fenced JSON block — same task schema as the original decomposition (id, title, why, what, constraints, deps, optional agent). Do NOT modify any existing task. Do NOT specify implementation mechanism (libraries, algorithms, file structure). Keep the WHAT/WHY/CONSTRAINTS discipline.`,
    ...(agentsBlock ? ["", agentsBlock] : []),
    ``,
    "```hydra-add-task",
    `{`,
    `  "tasks": [`,
    `    { "id": "T${nextN}", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [], "agent": null, "model": null }`,
    `  ]`,
    `}`,
    "```",
  ].join("\n");
}

// Compute the next sequential task number for new tasks. Looks at all
// existing task ids of the shape "T<n>" and returns max+1, defaulting
// to 1 for empty boards.
function nextTaskNumber(board: Board): number {
  let max = 0;
  for (const t of board.tasks) {
    const m = t.id.match(/^T(\d+)$/);
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

// Pull a fenced ```hydra-add-task block from the agent's reply. Falls
// back to any other fenced block so we still parse when the agent
// ignores the label hint. Returns undefined if no parsable block found.
export function extractAddTaskBlock(text: string): unknown {
  const labelled = /```hydra-add-task\s*\n([\s\S]*?)\n```/;
  const m = text.match(labelled);
  if (m && m[1] !== undefined) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // fall through
    }
  }
  // Fallback: pick the LAST fenced block (instructions say end-of-message).
  const fallback = /```(?:[a-zA-Z-]*)?\s*\n([\s\S]*?)\n```/g;
  let last: string | undefined;
  for (const match of text.matchAll(fallback)) {
    if (match[1] !== undefined) last = match[1];
  }
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

// Normalize the agent's add-task emission. Like normalizeDecomposition
// but with awareness of existing task ids — new tasks must NOT collide,
// and their deps may reference existing OR newly-added tasks. Returns
// the new tasks plus warnings.
export function normalizeAddedTasks(
  raw: unknown,
  existingIds: Set<string>,
): DecompositionResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const tasksRaw = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return undefined;

  const warnings: string[] = [];
  const newIds = new Set<string>();
  const tasks: Task[] = [];

  for (const rawTask of tasksRaw) {
    if (!rawTask || typeof rawTask !== "object") continue;
    const t = rawTask as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id.trim() : "";
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!id) {
      warnings.push(`skipped task with no id (title="${title}")`);
      continue;
    }
    if (existingIds.has(id)) {
      warnings.push(`skipped task ${id}: collides with an existing task id`);
      continue;
    }
    if (newIds.has(id)) {
      warnings.push(`skipped duplicate new task id ${id}`);
      continue;
    }
    if (!title) {
      warnings.push(`task ${id} has no title`);
    }
    const deps = Array.isArray(t.deps)
      ? t.deps.filter((d): d is string => typeof d === "string")
      : [];
    newIds.add(id);
    tasks.push({
      id,
      title: title || `Task ${id}`,
      why: typeof t.why === "string" ? t.why : undefined,
      what: typeof t.what === "string" ? t.what : undefined,
      constraints: typeof t.constraints === "string" ? t.constraints : undefined,
      deps,
      agent: typeof t.agent === "string" ? t.agent : null,
      model: typeof t.model === "string" ? t.model : null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  // Drop deps that don't resolve to existing or newly-added tasks.
  const allKnown = new Set([...existingIds, ...newIds]);
  for (const t of tasks) {
    const bad = t.deps.filter((d) => !allKnown.has(d));
    if (bad.length > 0) {
      warnings.push(`task ${t.id} had unknown deps: ${bad.join(", ")}`);
      t.deps = t.deps.filter((d) => allKnown.has(d));
    }
  }

  if (tasks.length === 0) return undefined;
  return { tasks, warnings };
}

// Validate and normalize the parsed JSON into Task records. The agent
// follows the schema mostly, but we defend against missing fields,
// duplicate ids, dangling deps, and id ordering issues.
export function normalizeDecomposition(raw: unknown): DecompositionResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const tasksRaw = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) return undefined;

  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const tasks: Task[] = [];

  for (const rawTask of tasksRaw) {
    if (!rawTask || typeof rawTask !== "object") continue;
    const t = rawTask as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id.trim() : "";
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!id) {
      warnings.push(`skipped task with no id (title="${title}")`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(`skipped duplicate task id ${id}`);
      continue;
    }
    if (!title) {
      warnings.push(`task ${id} has no title`);
    }
    const deps = Array.isArray(t.deps)
      ? t.deps.filter((d): d is string => typeof d === "string")
      : [];
    seenIds.add(id);
    tasks.push({
      id,
      title: title || `Task ${id}`,
      why: typeof t.why === "string" ? t.why : undefined,
      what: typeof t.what === "string" ? t.what : undefined,
      constraints: typeof t.constraints === "string" ? t.constraints : undefined,
      deps,
      agent: typeof t.agent === "string" ? t.agent : null,
      model: typeof t.model === "string" ? t.model : null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  // Drop deps that point to ids not present in the task set. Agents
  // sometimes hallucinate forward refs ("depends on T9" when there's
  // no T9). Keep the task but flag the bad dep.
  for (const t of tasks) {
    const bad = t.deps.filter((d) => !seenIds.has(d));
    if (bad.length > 0) {
      warnings.push(`task ${t.id} had unknown deps: ${bad.join(", ")}`);
      t.deps = t.deps.filter((d) => seenIds.has(d));
    }
  }

  if (tasks.length === 0) return undefined;
  const rawDesc = (raw as { description?: unknown }).description;
  const description =
    typeof rawDesc === "string" && rawDesc.trim().length > 0
      ? rawDesc.trim()
      : undefined;
  return { tasks, warnings, ...(description ? { description } : {}) };
}

// Compute the maximum number of tasks that can run concurrently at any
// point in the DAG by topological-layer sweep. Each task's "earliest
// start layer" is 1 + max(deps' layers); the width at each layer is
// the bucket size. The fleet's optimal worker count is the max width.
// Capped at `cap` to avoid pathological fan-outs blowing past sane
// limits.
export function sweepLineConcurrencyCap(tasks: Task[], cap = 6): number {
  if (tasks.length === 0) return 1;
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  const layers = new Map<string, number>();

  function layerOf(id: string, stack: Set<string>): number {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) {
      // Cycle — break it by treating this edge as a layer-0 dep. The
      // resulting cap is still safe (cycles violate the DAG invariant
      // and the worker assignment loop will refuse to schedule a
      // mutually-blocked group anyway).
      return 0;
    }
    const t = byId.get(id);
    if (!t) return 0;
    stack.add(id);
    let m = 0;
    for (const d of t.deps) {
      m = Math.max(m, layerOf(d, stack) + 1);
    }
    stack.delete(id);
    layers.set(id, m);
    return m;
  }

  for (const t of tasks) {
    layerOf(t.id, new Set());
  }

  const widthByLayer = new Map<number, number>();
  for (const layer of layers.values()) {
    widthByLayer.set(layer, (widthByLayer.get(layer) ?? 0) + 1);
  }
  let max = 1;
  for (const w of widthByLayer.values()) {
    if (w > max) max = w;
  }
  return Math.max(1, Math.min(max, cap));
}

// Render a short, scannable summary of the plan as a single string.
// Used for the synthetic agent_message_chunk emitted to clients after
// successful decomposition. Keep it readable in a TUI line-wrap.
export function formatPlanSummary(tasks: Task[], concurrencyCap: number): string {
  const lines: string[] = [];
  lines.push(`🧩 Decomposed into ${tasks.length} task${tasks.length === 1 ? "" : "s"} (concurrency cap ${concurrencyCap}).`);
  lines.push("");
  for (const t of tasks) {
    const depStr = t.deps.length === 0 ? "no deps" : `depends on ${t.deps.join(", ")}`;
    lines.push(`  ${t.id}  ${t.title}  —  ${depStr}`);
  }
  return lines.join("\n");
}
