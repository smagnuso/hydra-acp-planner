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
  - reviewAgent (optional): agent id to use for THIS task's review (when one is synthesized).
                              Use when the reviewer needs different expertise than the worker —
                              e.g. a security specialist reviewing crypto code written by a generalist.
                              Omit when the fleet-wide review agent (or default) fits.
  - reviewModel (optional): model id for THIS task's review. Use for stronger reasoning on
                              high-risk reviews. Omit when the default fits.
  - riskLevel: one of "low", "medium", or "high" — how risky is this task?
  - reviewHint: one of "skip", "optional", "recommended", or "required" — how strongly
                  should a human review be applied after the work is done?

Rubric for riskLevel / reviewHint:
  - Schema changes, security-sensitive code, or public-API surface changes → high / required
  - Integration with new services, complex business logic, or cross-module refactors → medium / recommended
  - Mechanical refactors (naming, formatting, dead-code removal) → low / skip
  - When in doubt, default to medium / optional.

When adding onReject configuration to a task, consider these strategies:
  - continue: use for iterative refinement where review feedback is expected to lead to quick fixes by the same agent — e.g., polishing code, adjusting logic after reviewer comments, or tasks with large context that benefit from keeping the worker session alive.
  - escalate: use when the current agent or model has hit a capability ceiling — e.g., a task assigned to a generalist that requires specialist knowledge, or a cheap/fast model that produces subpar results on complex reasoning tasks. Swap to a stronger agent/model via escalateTo.
  - fresh (default): standard retask with same agent/model and a closed worker session. Use when you want a clean slate.

Do NOT specify:
  - library, framework, or algorithm choices
  - file paths, directory structure, or module organization
  - variable names, function signatures, or pseudocode
  - phrasing like "use X" or "implement using Y"

Two coding agents handed the same task should be able to produce legitimately different implementations. If you catch yourself writing pseudocode, the task is too specified — back off and describe the outcome instead.

Keep the DAG minimal. Prefer fewer larger tasks over many tiny ones. Aim for 3 to 12 tasks for most projects; only exceed that when the project genuinely requires it. Dependencies should be the truth of what blocks what, not a vague ordering preference.

Be especially careful with dep-less roots. A task with deps: [] claims it could legitimately start right now, in parallel with every other root, with no information it needs from any sibling. If two "root" tasks share an implicit design decision (data shape, interface, scaffolding, naming convention, foundational config), one of them should depend on whichever establishes that decision — otherwise reviewers can't catch a flawed decision in T1 before T2 commits to the same mistake, and parallel workers waste compute building on an approach the reviewer would have rejected. When in doubt about whether to parallelize or serialize independent-looking tasks, prefer the dep edge.

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
      "model": null,
      "riskLevel": "medium",
      "reviewHint": "optional"
    }
  ]
}
\`\`\``;

// Competition-pattern instruction block, inlined verbatim into prompt
// builders that support the --compete flag. Defined once to keep the
// three callers (buildDecompositionPrompt, buildExecuteDecompositionPrompt,
// and the resume variant) in sync without pulling a full renderer.
const COMPETITION_PROMPT_BLOCK = `

Competition pattern (use when appropriate):
  When the project has a clear integration point where multiple independent implementations would be valuable, emit a competition:
    - N sibling work tasks (T1..TN) that each implement the same interface/endpoint independently (same deps, no deps between them).
    - A review task of kind "review" with reviews set to the array of those sibling ids, title like "Review and pick winner for [feature]". The review picks one implementation as winner; others are superseded.
  Competition tasks must include all standard fields (id, title, why, what, constraints, deps, riskLevel, reviewHint). The review task's reviews field is a JSON array of strings: ["T1", "T2", ...].
  Only use competitions when there is a genuine integration point worth evaluating multiple approaches — not for every feature.`;

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
  compete = false,
): string {
  const agentsBlock = formatAgentChoices(agents);
  const tail = agentsBlock ? `\n\n${agentsBlock}` : "";
  const competeBlock = compete ? COMPETITION_PROMPT_BLOCK : "";
  return `${DECOMPOSITION_SYSTEM}${tail}${competeBlock}\n\nProject to decompose:\n${description}`;
}

// Variant of buildDecompositionPrompt used by `/hydra planner start`:
// instead of taking a verbatim project description, asks the agent to
// decompose the project it has been discussing with the user in the
// current conversation, and to include a `description` field
// summarizing that project in the response. The board's description
// field is filled in from that summary after parsing.
export function buildExecuteDecompositionPrompt(
  agents?: AgentChoice[],
  compete = false,
): string {
  const agentsBlock = formatAgentChoices(agents);
  const tail = agentsBlock ? `\n\n${agentsBlock}` : "";
  const competeBlock = compete ? COMPETITION_PROMPT_BLOCK : "";
  return [
    `${DECOMPOSITION_SYSTEM}${tail}${competeBlock}`,
    ``,
    `You and the user have been discussing a software project in this conversation. Decompose THAT project — what you have been planning together — into the task DAG.`,
    ``,
    `Additionally, include a top-level "description" field in the JSON block: a one-sentence summary of the project we've been planning, suitable for showing alongside the project id in status displays.`,
    ``,
    "```json",
    `{`,
    `  "description": "...",`,
    `  "tasks": [`,
    `    { "id": "T1", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [], "agent": null, "model": null, "riskLevel": "medium", "reviewHint": "optional" }`,
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
export function buildResumeDecompositionPrompt(
  description: string,
  compete = false,
): string {
  const competeBlock = compete
    ? `

You were asked to use the competition pattern (--compete flag was set). If you had already described competition tasks, re-emit them verbatim. Otherwise, do NOT invent new competition tasks now — only continue or re-emit what was already planned.`
    : "";
  return [
    `[hydra-acp-planner: resuming decomposition after restart]`,
    ``,
    `You were in the middle of decomposing this project:`,
    ``,
    `  ${description}`,
    ``,
    `If you already emitted a JSON task DAG, re-emit it verbatim now (don't redo the planning). Otherwise, continue from where you left off.`,
    competeBlock,
    ``,
    `Reply with ONLY a fenced \`\`\`json block matching the schema:`,
    ``,
    "```json",
    `{ "tasks": [{ "id": "T1", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [], "agent": null, "model": null, "riskLevel": "medium", "reviewHint": "optional" }] }`,
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
  // by the `start` path, where the user didn't supply a description
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
   `  5. Assign riskLevel ("low"|"medium"|"high") and reviewHint ("skip"|"optional"|"recommended"|"required") using the same rubric as the decomposition prompt.`,
    ``,
    `Reply with ONLY a fenced JSON block — same task schema as the original decomposition (id, title, why, what, constraints, deps, optional agent/model, riskLevel, reviewHint). Do NOT modify any existing task. Do NOT specify implementation mechanism (libraries, algorithms, file structure). Keep the WHAT/WHY/CONSTRAINTS discipline.`,
    ...(agentsBlock ? ["", agentsBlock] : []),
    ``,
    "```hydra-add-task",
    `{`,
    `  "tasks": [`,
    `    { "id": "T${nextN}", "title": "...", "why": "...", "what": "...", "constraints": "...", "deps": [], "agent": null, "model": null, "riskLevel": "medium", "reviewHint": "optional" }`,
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
    const kind = validateKind(t.kind);
    const reviews = validateReviews(t.reviews);
    tasks.push({
      id,
      title: title || `Task ${id}`,
      why: typeof t.why === "string" ? t.why : undefined,
      what: typeof t.what === "string" ? t.what : undefined,
      constraints: typeof t.constraints === "string" ? t.constraints : undefined,
      deps,
      agent: typeof t.agent === "string" ? t.agent : null,
      model: typeof t.model === "string" ? t.model : null,
      reviewAgent: typeof t.reviewAgent === "string" ? t.reviewAgent : null,
      reviewModel: typeof t.reviewModel === "string" ? t.reviewModel : null,
      ...(kind ? { kind } : {}),
      ...(reviews ? { reviews } : {}),
      riskLevel: validateRiskLevel(t.riskLevel),
      reviewHint: validateReviewHint(t.reviewHint),
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

const VALID_RISK_LEVELS = new Set(["low", "medium", "high"]);
const VALID_REVIEW_HINTS = new Set(["skip", "optional", "recommended", "required"]);

function validateRiskLevel(v: unknown): "low" | "medium" | "high" {
  if (typeof v === "string" && VALID_RISK_LEVELS.has(v)) return v as "low" | "medium" | "high";
  return "medium";
}

function validateReviewHint(v: unknown): "skip" | "optional" | "recommended" | "required" {
  if (typeof v === "string" && VALID_REVIEW_HINTS.has(v)) return v as "skip" | "optional" | "recommended" | "required";
  return "optional";
}

// Coerce a `kind` field from raw input. Defaults to undefined (work)
// when missing or invalid — preserves the existing default of "work"
// semantics throughout the planner.
function validateKind(v: unknown): "work" | "review" | "distill" | undefined {
  if (v === "work" || v === "review" || v === "distill") return v;
  return undefined;
}

// Plan-acceptance guard: user-authored kind="distill" is allowed but
// MUST include a non-empty `reviews` field naming the source tasks
// it cites. Without sources, the distiller has no citation domain
// and the prompt has no candidates section. Bridge-spawned distills
// always set `reviews` themselves, so this is purely a sanity check
// on plan input. Throws a clear error naming the offending task ids
// so the caller can fix their output. (Historical name preserved
// for import stability; semantics relaxed per the kind:"distill"
// authorability change.)
export function assertNoDecomposerDistill(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return;
  const offenders: string[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    if (rec.kind !== "distill") continue;
    const reviews = rec.reviews;
    const hasReviews =
      (typeof reviews === "string" && reviews.length > 0) ||
      (Array.isArray(reviews) && reviews.length > 0);
    if (!hasReviews) {
      const id = typeof rec.id === "string" ? rec.id : "<no id>";
      offenders.push(id);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `kind="distill" task(s) ${offenders.join(", ")} missing required non-empty \`reviews\` field; a distill needs source task ids to cite (e.g. reviews: [T1, T2, T3])`,
    );
  }
}

// Coerce a `reviews` field from raw input. Accepts string or array of
// strings (matching the Task.reviews shape). Returns undefined when
// missing or malformed.
function validateReviews(v: unknown): string | string[] | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const out = v.filter((s): s is string => typeof s === "string");
    if (out.length > 0) return out;
  }
  return undefined;
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
    const kind = validateKind(t.kind);
    const reviews = validateReviews(t.reviews);
    tasks.push({
      id,
      title: title || `Task ${id}`,
      why: typeof t.why === "string" ? t.why : undefined,
      what: typeof t.what === "string" ? t.what : undefined,
      constraints: typeof t.constraints === "string" ? t.constraints : undefined,
      deps,
      agent: typeof t.agent === "string" ? t.agent : null,
      model: typeof t.model === "string" ? t.model : null,
      reviewAgent: typeof t.reviewAgent === "string" ? t.reviewAgent : null,
      reviewModel: typeof t.reviewModel === "string" ? t.reviewModel : null,
      ...(kind ? { kind } : {}),
      ...(reviews ? { reviews } : {}),
      riskLevel: validateRiskLevel(t.riskLevel),
      reviewHint: validateReviewHint(t.reviewHint),
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
  lines.push(`Decomposed into ${tasks.length} task${tasks.length === 1 ? "" : "s"} (concurrency cap ${concurrencyCap}).`);
  lines.push("");
  for (const t of tasks) {
    const depStr = t.deps.length === 0 ? "no deps" : `depends on ${t.deps.join(", ")}`;
    lines.push(`  ${t.id}  ${t.title}  —  ${depStr}`);
  }
  return lines.join("\n");
}
