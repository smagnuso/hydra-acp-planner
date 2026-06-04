import type { Task } from "./board.js";

// The decomposition prompt is the single most product-defining piece of
// text in the planner. It needs to elicit a JSON DAG that's executable
// by autonomous workers AND respects the project's WHAT/WHY/CONSTRAINTS
// discipline — task descriptions specify desired outcomes, not
// mechanisms. Two workers handed the same task should be able to
// produce legitimately different implementations.

const DECOMPOSITION_SYSTEM = `You are helping plan a software project that will be executed by parallel coding agents. Your job is to break the project into a minimal task DAG and respond with structured JSON.

For each task specify:
  - id: short identifier like "T1", "T2", "T3"
  - title: 4 to 8 words, action-oriented
  - why: one sentence on user value or system constraint
  - what: one short paragraph describing the desired outcome — NOT the mechanism
  - constraints: hard requirements (compatibility, performance, security, file boundaries)
                 that bound the solution space without dictating one implementation
  - deps: array of task ids that must complete before this one can start

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
      "deps": []
    }
  ]
}
\`\`\``;

export function buildDecompositionPrompt(description: string): string {
  return `${DECOMPOSITION_SYSTEM}\n\nProject to decompose:\n${description}`;
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
  return { tasks, warnings };
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
