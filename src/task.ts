import type { Board, Task, TaskArtifacts } from "./board.js";

// The worker task prompt and the structured result block it must emit.
// Workers are plain ACP agents that get one user prompt per task — the
// prompt describes the task in WHAT/WHY/CONSTRAINTS terms and instructs
// the agent to end its reply with a fenced ```hydra-result block carrying
// a JSON object the planner parses.

const TASK_SYSTEM = `You are a worker agent on a multi-agent coding project. You have been given one task to complete. Do the work, then end your message with a structured result block so the planner can record what you did.`;

const RESULT_INSTRUCTIONS = `## How to respond

When finished, end your message with a fenced \`\`\`hydra-result block
containing a JSON object with these fields (all optional except \`summary\`):

\`\`\`hydra-result
{
  "summary":       "one-line description of what you accomplished",
  "files_changed": ["path/to/file", "..."],
  "decisions":     ["any architectural choices worth recording for later tasks"],
  "assumptions":   ["assumptions you had to make due to ambiguity in the task"],
  "follow_ups":    ["work you noticed should be done but is out of scope here"]
}
\`\`\`

The block MUST appear at the very end of your reply, after any other prose,
code blocks, or tool-call output. If you cannot complete the task, still
emit the block and explain what blocked you in \`summary\`.`;

// Render a task's dependency artifacts as context the worker can read.
// Each completed dependency's artifacts are inlined verbatim so the
// worker has the same view of "what other workers decided" that the
// orchestrator agent does.
function formatDependencyContext(task: Task, board: Board): string {
  const deps = task.deps
    .map((id) => board.tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status === "done" && !!t.artifacts);
  if (deps.length === 0) {
    return "(none — this task has no satisfied dependencies)";
  }
  const blocks: string[] = [];
  for (const dep of deps) {
    blocks.push(
      `### ${dep.id} — ${dep.title}\n${JSON.stringify(dep.artifacts, null, 2)}`,
    );
  }
  return blocks.join("\n\n");
}

export function buildTaskPrompt(task: Task, board: Board): string {
  const parts: string[] = [];
  parts.push(TASK_SYSTEM);
  parts.push("");
  parts.push("## Task");
  parts.push(`**${task.id} — ${task.title}**`);
  if (task.why) {
    parts.push("");
    parts.push(`**Why:** ${task.why}`);
  }
  if (task.what) {
    parts.push("");
    parts.push(`**What:** ${task.what}`);
  }
  if (task.constraints) {
    parts.push("");
    parts.push(`**Constraints:** ${task.constraints}`);
  }
  parts.push("");
  parts.push("## Context from completed dependencies");
  parts.push(formatDependencyContext(task, board));
  parts.push("");
  parts.push(RESULT_INSTRUCTIONS);
  return parts.join("\n");
}

// Pull a fenced ```hydra-result block out of the agent's reply. The agent
// is instructed to emit one at end-of-message; we tolerate trailing
// whitespace / prose. Returns undefined if no parsable block is found.
export function extractResultBlock(text: string): unknown {
  // Same shape as decomposition's extractJsonBlock but matches the
  // hydra-result fence label specifically. We also accept the more
  // generic ```json label as a fallback since some models will use it
  // by reflex even when told otherwise.
  const labelled = /```hydra-result\s*\n([\s\S]*?)\n```/;
  const fallback = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  const m = text.match(labelled);
  if (m && m[1] !== undefined) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // fall through to fallback
    }
  }
  // Walk every ```json block, pick the LAST one — instructions say the
  // result must be at the end, so the last block is the right one.
  let last: string | undefined;
  for (const match of text.matchAll(fallback)) {
    if (match[1] !== undefined) {
      last = match[1];
    }
  }
  if (last === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

export interface NormalizedResult {
  artifacts: TaskArtifacts;
  warnings: string[];
}

// Validate and normalize the parsed result into the TaskArtifacts shape
// the board expects. Tolerates missing optional fields; requires that
// `summary` be present and non-empty (the agent has to tell us SOMETHING).
export function normalizeResult(raw: unknown): NormalizedResult | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim().length > 0
      ? obj.summary.trim()
      : undefined;
  if (!summary) {
    return undefined;
  }

  const warnings: string[] = [];
  const stringArray = (
    field: string,
    value: unknown,
  ): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      warnings.push(`${field} should be an array; ignoring`);
      return undefined;
    }
    const filtered = value.filter((v): v is string => typeof v === "string");
    if (filtered.length !== value.length) {
      warnings.push(`${field} had non-string entries; filtered`);
    }
    return filtered.length > 0 ? filtered : undefined;
  };

  const artifacts: TaskArtifacts = { summary };
  const filesChanged = stringArray("files_changed", obj.files_changed);
  if (filesChanged) artifacts.files_changed = filesChanged;
  const decisions = stringArray("decisions", obj.decisions);
  if (decisions) artifacts.decisions = decisions;
  const assumptions = stringArray("assumptions", obj.assumptions);
  if (assumptions) artifacts.assumptions = assumptions;
  const followUps = stringArray("follow_ups", obj.follow_ups);
  if (followUps) artifacts.follow_ups = followUps;

  return { artifacts, warnings };
}
