import type { Board, Task, TaskArtifacts } from "./board.js";

// ── Types ────────────────────────────────────────────────────────────────

export type TaskKind = "work" | "review";

/** Shape of a review result emitted by a worker agent. */
export interface ReviewResult {
  decision: "approve" | "reject" | "amend";
  notes: string;
  follow_ups?: string[];
  applied?: boolean;
}

export interface PromptRegistryEntry {
  buildPrompt(task: Task, board: Board): string;
  extractResult(text: string): unknown;
  normalizeResult(raw: unknown, reviewsList?: string[]): NormalizedResult | undefined;
  buildResumePrompt(task: Task): string;
  buildRepromptPrompt(task: Task): string;
}

// ── Registry ─────────────────────────────────────────────────────────────

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

const REVIEW_SYSTEM = `You are a reviewer agent on a multi-agent coding project. You have been given one completed work task to review. Examine the work, decide whether it meets the spec, then end your message with a structured \`hydra-result\` block recording your decision. The planner CANNOT proceed without that block.`;

// Trailing instructions for the single-reviewee review prompt. This is
// the last thing the reviewer sees before its turn — placed at the
// bottom (not mixed in with general result instructions) because chatty
// TUI agents that write long prose reviews often forget to emit the
// structured block. Repeating the schema here, after all the review
// guidance, makes "emit the fence" the freshest instruction in context.
const REVIEW_RESULT_INSTRUCTIONS = `## How to respond

**THE FINAL CONTENT OF YOUR REPLY MUST BE A \`hydra-result\` BLOCK.** Without
it the planner cannot record your decision and the work task will be
re-run from scratch — your review is wasted.

Write whatever prose / evidence-citing you need first, then end with:

\`\`\`hydra-result
{
  "decision":   "approve|reject|amend|fix",
  "notes":      "your reasoning, citing specific evidence from verified_diff",
  "follow_ups": ["optional: any deferred work to capture (amend only)"],
  "applied":    true
}
\`\`\`

(\`follow_ups\` and \`applied\` are optional. \`applied: true\` is for the
\`fix\` decision when you've made the corrections yourself this turn.)

This block MUST be the literal last thing in your reply — after any prose,
tool-call output, or code samples. The fence must be exactly \`\`\`hydra-result
(not \`\`\`json, not unfenced JSON). The planner parses this fence; nothing
else.`;

const REVIEW_RESULT_INSTRUCTIONS_COMPETITION = `## How to respond

**THE FINAL CONTENT OF YOUR REPLY MUST BE A \`hydra-result\` BLOCK.** Without
it the planner cannot record your verdict and the competition is wasted.

Write whatever prose / per-candidate analysis you need first, then end with:

\`\`\`hydra-result
{
  "decision": "winner|synthesize",
  "winner":   "Tx",
  "notes":    "specific evidence-cited reasoning"
}
\`\`\`

(\`winner\` is required for \`decision: "winner"\`; omit for \`synthesize\`.)

This block MUST be the literal last thing in your reply — after any prose,
tool-call output, or code samples. The fence must be exactly \`\`\`hydra-result
(not \`\`\`json, not unfenced JSON). The planner parses this fence; nothing
else.`;

// Render project-level attachments (--attach files) as a context
// block. Each file's path is shown so the worker knows what it is,
// followed by its full contents. Returns "" when there are no
// attachments so callers can conditionally include the section
// header. Inlined ahead of dependency context so spec/plan docs
// frame the task before per-dependency artifacts narrow it down.
function formatAttachments(board: Board): string {
  if (!board.attachments || board.attachments.length === 0) return "";
  const parts: string[] = [];
  parts.push("## Attached files");
  parts.push(
    "These files were attached at project create time. They are the source of truth for the project's spec / plan / context. Read them here — do NOT try to open them with the read tool; you likely don't have permission to their original paths.",
  );
  for (const att of board.attachments) {
    parts.push("");
    parts.push(`### ${att.path}`);
    parts.push("```");
    parts.push(att.content);
    parts.push("```");
  }
  return parts.join("\n");
}

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

const PROMPTS: Partial<Record<TaskKind, PromptRegistryEntry>> = {
  work: {
    buildPrompt(task: Task, board: Board): string {
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
      const attachments = formatAttachments(board);
      if (attachments) {
        parts.push("");
        parts.push(attachments);
      }
      parts.push("");
      parts.push("## Context from completed dependencies");
      parts.push(formatDependencyContext(task, board));
      parts.push("");
      if (task.attemptCount > 0 && task.reviewFeedback?.length) {
        parts.push("## Previous attempt feedback");
        for (const entry of task.reviewFeedback) {
          parts.push(`- ${entry}`);
        }
        parts.push("");
      }
      parts.push(RESULT_INSTRUCTIONS);
      return parts.join("\n");
    },

    extractResult(text: string): unknown {
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
    },

    normalizeResult(raw: unknown): NormalizedResult | undefined {
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
    },

    buildResumePrompt(task: Task): string {
      return [
        `[hydra-acp-planner: resuming after restart]`,
        ``,
        `You were previously working on **${task.id} — ${task.title}**.`,
        ``,
        `Continue from where you left off. If you were mid-write, finish that file. If you were already done but never emitted your hydra-result block, emit it now (don't redo the work).`,
        ``,
        `When finished, end your message with the same fenced \`\`\`hydra-result block format described earlier:`,
        ``,
        "```hydra-result",
        `{ \"summary\": \"...\", \"files_changed\": [...], \"decisions\": [...] }`,
        "```",
      ].join("\n");
    },

    buildRepromptPrompt(task: Task): string {
      return [
        `STOP. Your last reply for ${task.id} did not end with a \`hydra-result\` block. The planner cannot record your work without it.`,
        ``,
        `Do NOT redo the task. Do NOT call any tools. Do NOT explain. Reply with exactly one fenced block and nothing else:`,
        ``,
        "```hydra-result",
        `{"summary":"<one-line description of what you did or what blocked you>","files_changed":[],"decisions":[],"assumptions":[],"follow_ups":[]}`,
        "```",
        ``,
        `The block must be the entire content of your next reply. Even if the task failed or was blocked, emit the block — use "summary" to describe the outcome.`,
      ].join("\n");
    },
  },

  review: {
    buildPrompt(task: Task, board: Board): string {
      const parts: string[] = [];
      parts.push(REVIEW_SYSTEM);
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
      const attachments = formatAttachments(board);
      if (attachments) {
        parts.push("");
        parts.push(attachments);
      }
      parts.push("");
      parts.push("## Context from completed dependencies");
      parts.push(formatDependencyContext(task, board));
      parts.push("");
      const isCompetition = Array.isArray(task.reviews) && task.reviews.length > 1;
      if (isCompetition) {
        const reviewees: Task[] = [];
        for (const revieweeId of task.reviews as string[]) {
          const reviewee = board.tasks.find((t) => t.id === revieweeId);
          if (reviewee && reviewee.status === "done" && reviewee.artifacts) {
            reviewees.push(reviewee);
          }
        }
        parts.push(
          `## Review instructions`,
          `You are the judge in a competition. Below are N implementations for this task. Each implementation is listed with its artifacts, including \`verified_diff\` — the daemon-audited list of files each worker actually edited plus a sample of the hunks.`,
          ``,
          `**Do this in order:**`,
          `  1. Read the reviewed task's \`what\` / \`why\` / \`constraints\` for the spec the competitors were given.`,
          `  2. For each implementation, look at \`verified_diff.files\` and \`verified_diff.sample\`. The worker's \`summary\` and \`files_changed\` are claims; \`verified_diff\` is evidence.`,
          `  3. If you need the full diff for any candidate, fetch \`hydra session diff <workerSessionId> --json\` for that worker. Compare them on correctness against the spec, not stylistic preference.`,
          ``,
          `**Decisions:**`,
          `- \`winner\` — pick the best implementation. Set \`winner\` to its task ID (e.g. "Tx"). \`notes\` MUST cite specific evidence from \`verified_diff\` for why it wins (and ideally why the others fall short).`,
          `- \`synthesize\` — no single implementation is clearly best; describe what a combined solution would look like, naming which parts come from which candidate.`,
        );
        for (const rev of reviewees) {
          parts.push("");
          parts.push(`### ${rev.id} — ${rev.title}`);
          parts.push(JSON.stringify(rev.artifacts, null, 2));
        }
        parts.push("");
        parts.push(REVIEW_RESULT_INSTRUCTIONS_COMPETITION);
        return parts.join("\n");
      }
      parts.push(
        `## Review instructions`,
        `You are reviewing the work that the reviewed task ABOVE (under "Context from completed dependencies") performed. Your job is to verify the actual code change matches the task's spec — not to rubber-stamp the worker's self-report.`,
        ``,
        `**Do this in order:**`,
        `  1. Read the reviewed task's \`what\` / \`why\` / \`constraints\` carefully — this is the spec the worker was given.`,
        `  2. Look at \`artifacts.verified_diff\` on the reviewed task. This is the daemon-audited, per-session list of files actually edited (\`files\`), the total \`hunkCount\`, and a \`sample\` preview. It is NOT self-reported — it comes from the recorded tool-call history.`,
        `  3. Compare. The worker also self-reports \`artifacts.files_changed\` and \`artifacts.summary\` — those are claims, not evidence. If \`files_changed\` lists paths but \`verified_diff.files\` is empty or different, that is a red flag: the worker may have lied or produced nothing.`,
        `  4. If you need to see the full diff (the sample is truncated), fetch it directly: \`hydra session diff <workerSessionId> --json\` — the worker session id is the key under which the worker is registered. Look at the actual oldText/newText hunks and judge whether they implement the spec.`,
        ``,
        `**Decisions:**`,
        `  - \`approve\` — diff implements the spec, no follow-up needed.`,
        `  - \`reject\` — diff is wrong, missing, or contradicts the spec. \`notes\` MUST cite the specific gap (e.g. "spec asked for X but verified_diff shows only Y").`,
        `  - \`amend\` — diff is acceptable but needs follow-on work captured in \`follow_ups\`. Task gets marked done with notes appended.`,
        `  - \`fix\` — you applied the corrections yourself in this turn (only valid for orchestrator-lane reviews where you can edit the workspace). Set \`applied: true\`.`,
        ``,
        `Your \`notes\` must reference concrete evidence from \`verified_diff\` (or the full diff fetch). Generic praise without code-specific reasoning means you didn't do the review.`,
      );
      parts.push("");
      parts.push(REVIEW_RESULT_INSTRUCTIONS);
      return parts.join("\n");
    },

    extractResult(text: string): unknown {
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
    },

    normalizeResult(raw: unknown, reviewsList?: string[]): NormalizedResult | undefined {
      if (!raw || typeof raw !== "object") {
        return undefined;
      }
      const obj = raw as Record<string, unknown>;
      const decision = obj.decision;
      if (decision !== "approve" && decision !== "reject" && decision !== "amend" && decision !== "fix" && decision !== "winner" && decision !== "synthesize") {
        return undefined;
      }

      const warnings: string[] = [];
      const notes = typeof obj.notes === "string" ? obj.notes : "";
      if (!notes) {
        warnings.push("review missing notes");
      }

      const artifacts: TaskArtifacts & { review_decision?: string; applied?: boolean } = {};
      artifacts.summary = String(decision);
      (artifacts as Record<string, unknown>).review_decision = decision;
      if (notes) {
        (artifacts as Record<string, unknown>).notes = notes;
      }

      const followUps = Array.isArray(obj.follow_ups)
        ? obj.follow_ups.filter((v): v is string => typeof v === "string")
        : undefined;
      if (followUps && followUps.length > 0) {
        artifacts.follow_ups = followUps;
      }

      const applied = obj.applied;
      if (typeof applied === "boolean") {
        (artifacts as Record<string, unknown>).applied = applied;
      }

      const winner = typeof obj.winner === "string" ? obj.winner : undefined;
      if (winner) {
        if (reviewsList && !reviewsList.includes(winner)) {
          warnings.push(`winner "${winner}" not found in reviews list`);
        }
        (artifacts as Record<string, unknown>).winner = winner;
      }

      return { artifacts, warnings };
    },

    buildResumePrompt(task: Task): string {
      return [
        `[hydra-acp-planner: resuming after restart]`,
        ``,
        `You were previously working on **${task.id} — ${task.title}**.`,
        ``,
        `Continue from where you left off. If you were mid-review, finish that review. If you were already done but never emitted your hydra-result block, emit it now (don't redo the review).`,
        ``,
        `When finished, end your message with the same fenced \`\`\`hydra-result block format described earlier:`,
        ``,
        "```hydra-result",
        `{ \"decision\": \"approve|reject|amend|fix\", \"notes\": \"...\" }`,
        "```",
      ].join("\n");
    },

    buildRepromptPrompt(task: Task): string {
      return [
        `Your previous reply for ${task.id} didn't end with the required \`hydra-result\` block.`,
        ``,
        `Please emit it now — do NOT redo the review, just emit a structured summary of your decision:`,
        ``,
        "```hydra-result",
        `{ \"decision\": \"<approve|reject|amend|fix>\", \"notes\": \"<reasoning>\" }`,
        "```",
        ``,
        `If the task itself failed or you couldn't complete it, still emit the block — set "summary" to describe what blocked you.`,
      ].join("\n");
    },
  },
};

export { PROMPTS };

// ── Public helpers ───────────────────────────────────────────────────────

/** Resolve a prompt registry entry for the given task kind. */
export function promptsFor(kind: TaskKind): PromptRegistryEntry {
  const entry = PROMPTS[kind] ?? PROMPTS.work;
  if (!entry) {
    throw new Error(`No prompt registry entry for kind=${kind}`);
  }
  return entry;
}

// ── Legacy top-level exports (thin wrappers) ─────────────────────────────
// These delegate to PROMPTS.work so that existing call sites in bridge.ts
// and elsewhere keep compiling without changes.

export function buildTaskPrompt(task: Task, board: Board): string {
  return promptsFor("work").buildPrompt(task, board);
}

export function extractResultBlock(text: string): unknown {
  return promptsFor("work").extractResult(text);
}

export interface NormalizedResult {
  artifacts: TaskArtifacts;
  warnings: string[];
}

export function normalizeResult(raw: unknown): NormalizedResult | undefined {
  return promptsFor("work").normalizeResult(raw);
}

export function buildResumeTaskPrompt(task: Task): string {
  return promptsFor("work").buildResumePrompt(task);
}

export function buildRepromptForResultPrompt(task: Task): string {
  return promptsFor("work").buildRepromptPrompt(task);
}

// ── Review helpers (thin wrappers) ───────────────────────────────────────

export function buildReviewPrompt(task: Task, board: Board): string {
  return promptsFor("review").buildPrompt(task, board);
}

export function extractReviewBlock(text: string): unknown {
  return promptsFor("review").extractResult(text);
}

export function normalizeReview(raw: unknown, reviewsList?: string[]): NormalizedResult | undefined {
  return promptsFor("review").normalizeResult(raw, reviewsList);
}

export function buildResumeReviewPrompt(task: Task): string {
  return promptsFor("review").buildResumePrompt(task);
}

export function buildRepromptForReviewPrompt(task: Task): string {
  return promptsFor("review").buildRepromptPrompt(task);
}
