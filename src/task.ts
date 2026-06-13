import type { Board, Task, TaskArtifacts } from "./board.js";

// ── Types ────────────────────────────────────────────────────────────────

export type TaskKind = "work" | "review" | "distill";

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

const REVIEW_SYSTEM = `You are a reviewer agent on a multi-agent coding project. Your job has two parts that must NOT be conflated.

**Search adversarially.** Assume the implementation contains an integration bug — a real one that would break the system in practice. Reviews that rubber-stamp surface-plausible code are worse than no review at all; that is the failure mode we're guarding against. Don't read the diff looking for it to be correct; read it looking for the specific way it might be wrong about contracts with code OUTSIDE the diff.

**Then judge honestly.** If your adversarial search turns up nothing of substance, approve. Do NOT invent a finding to justify the time you spent searching. A thorough review that ends in approval — with evidence of what you actually checked — is the correct outcome when the code is correct. Inventing nits to seem rigorous is just a different way of being unreliable.

To search adversarially:

  1. **Verify every external reference is real.** For every method name, notification name, event name, RPC name, status string, or wire-shape literal this code references that's defined OUTSIDE the diff, grep the codebase to confirm it actually exists the way this code assumes. Quote the file:line where it's defined. If you cannot find a definition, the reference is likely fabricated — that is a blocker.
  2. **Verify every API call matches the actual contract.** For every call into a shared utility, daemon endpoint, or existing module, read the implementation of that API and verify the call site matches its real parameter shapes, return shapes, error behavior, and side effects. Quote line numbers as evidence.
  3. **Run the tests this code adds.** Execute them and paste the actual runner output, including any failures. Approval based on assumed test correctness is not acceptable. If you cannot execute, say so explicitly.
  4. **Walk the user-visible scenario end-to-end.** If the change affects UI, terminal output, or any observable behavior, trace what the user will actually see end-to-end.

Then classify each finding by severity:

  - \`blocker\` — the change is wrong in a way that will fail at runtime, violate a contract, or visibly misbehave for the user. Block on these; emit a \`reject\` (or \`amend\` if a fix is obvious).
  - \`concern\` — non-obvious risk, code-smell, or contract you weren't able to verify. Surface in \`notes\`; emit \`approve\` unless the concern compounds with others into a blocker.
  - \`nit\` — minor stylistic / preference. Capture in \`follow_ups\` and \`approve\`.
  - none — the adversarial search turned up nothing. \`approve\` and list what you searched for as evidence in \`contracts_verified\` / \`tests_executed\`. This is a valid and honest outcome.

End your message with a structured \`hydra-result\` block recording your decision. The planner CANNOT proceed without that block.`;

const DISTILL_SYSTEM = `You are a distiller agent on a multi-agent coding project. A competition reviewer was asked to pick a winner from N candidate implementations and could not — it returned \`synthesize\`. Your job is to read those candidates plus the reviewer's notes and emit a **source-cited** merge report.

You do not write code. You do not merge diffs. You produce a structured report whose every finding cites the specific candidate(s) it came from, and whose \`recommended_action\` tells the planner what to do next (apply one candidate as winner, rework it, or start fresh).

Every claim you make MUST be tied to one or more candidate task ids via \`sources\`. Findings with empty or unknown sources will be rejected by the parser and this turn will be re-run from scratch — ungrounded prose is the failure mode we're designing against.`;

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
  "decision":           "approve|reject|amend|fix",
  "notes":              "your reasoning, citing specific evidence from verified_diff",
  "contracts_verified": [
    { "claim": "session/update sessionUpdate kinds include 'turn_complete'", "evidence": "core/render-update.ts:178" }
  ],
  "tests_executed":     [
    { "command": "npm test -- --grep btw", "exit_code": 0, "output_excerpt": "12 passing" }
  ],
  "follow_ups":         ["optional: any deferred work to capture (amend only)"],
  "applied":            true
}
\`\`\`

\`contracts_verified\` and \`tests_executed\` are how you prove you actually
did the work the REVIEW_SYSTEM clause demands. For an \`approve\` decision
both SHOULD be non-empty — empty arrays mean either "I didn't check" or
"there was nothing to check" (be honest about which). \`follow_ups\` and
\`applied\` are optional. \`applied: true\` is for the \`fix\` decision when
you've made the corrections yourself this turn.

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

const REVIEW_RESULT_INSTRUCTIONS_DISTILL = `## How to respond

**THE FINAL CONTENT OF YOUR REPLY MUST BE A \`hydra-result\` BLOCK.** Without
it the planner cannot record the distilled report and the work is wasted.

Write whatever prose / per-candidate analysis you need first, then end with:

\`\`\`hydra-result
{
  "summary":            "one-paragraph overview of the merged picture",
  "findings": [
    {
      "claim":    "what is true across / between the candidates",
      "sources":  ["Tx", "Ty"],
      "verdict":  "keep|drop|defer",
      "evidence": "Tx:path hunk N; Ty:path hunk M"
    }
  ],
  "recommended_action": "apply Tx | rework | new-work | noop",
  "rework_brief":       "required when recommended_action is rework or new-work",
  "unresolved":         ["open questions, if any"]
}
\`\`\`

**Citation rules — these are enforced by the parser:**
- Every \`finding\` MUST carry a non-empty \`sources\` array.
- Every entry in \`sources\` MUST be the id of one of the candidate tasks
  listed above (see the \`## Candidate Tx\` sections).
- For \`recommended_action: "apply Tx"\`, Tx MUST be one of the candidates.
- For \`recommended_action: "rework"\` or \`"new-work"\`, \`rework_brief\`
  MUST be a non-empty string describing what the follow-up work task
  should do.
- \`noop\` — the report is purely informational; the planner takes no
  action on reviewees. Only meaningful for user-authored distill tasks.

Findings without sources or with unknown source ids will be rejected and
this turn will be re-run. Don't paraphrase — cite.

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

// Render the board's project-wide contract brief as a context block.
// Applied to every task (work AND review) above attachments, so every
// worker checks against the same set of invariants and every reviewer
// has the same brief to verify the implementation against. Returns ""
// when no brief is set so callers can conditionally include the
// section.
function formatContractBrief(board: Board): string {
  const brief = board.contractBrief?.trim();
  if (!brief) return "";
  return [
    "## Project contracts (apply to every task)",
    "These contracts describe non-obvious invariants that the surrounding system depends on. Treat them as authoritative — code that violates them is wrong, even when it looks plausible. If you are reviewing, verify the implementation against these specifically.",
    "",
    brief,
  ].join("\n");
}

// Parse an array of evidence objects from a reviewer's hydra-result block.
// Each entry must be an object with at least the named keys, all strings
// (exit_code is allowed as a number). Returns a normalized array of the
// objects with only string/number-valued recognized keys; pushes warnings
// for malformed entries.
function parseEvidenceArray(
  value: unknown,
  field: string,
  keys: string[],
  warnings: string[],
): Array<Record<string, string | number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${field} should be an array; ignoring`);
    return undefined;
  }
  const out: Array<Record<string, string | number>> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`${field}: skipping non-object entry`);
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const normalized: Record<string, string | number> = {};
    for (const key of keys) {
      const v = rec[key];
      if (typeof v === "string" || typeof v === "number") {
        normalized[key] = v;
      }
    }
    if (Object.keys(normalized).length === 0) continue;
    out.push(normalized);
  }
  return out;
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
      const workBrief = formatContractBrief(board);
      if (workBrief) {
        parts.push("");
        parts.push(workBrief);
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
      const reviewBrief = formatContractBrief(board);
      if (reviewBrief) {
        parts.push("");
        parts.push(reviewBrief);
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

      const contractsVerified = parseEvidenceArray(obj.contracts_verified, "contracts_verified", ["claim", "evidence"], warnings);
      if (contractsVerified && contractsVerified.length > 0) {
        (artifacts as Record<string, unknown>).contracts_verified = contractsVerified;
      }
      const testsExecuted = parseEvidenceArray(obj.tests_executed, "tests_executed", ["command", "exit_code", "output_excerpt"], warnings);
      if (testsExecuted && testsExecuted.length > 0) {
        (artifacts as Record<string, unknown>).tests_executed = testsExecuted;
      }
      if (decision === "approve") {
        const cvCount = contractsVerified?.length ?? 0;
        const teCount = testsExecuted?.length ?? 0;
        if (cvCount === 0 && teCount === 0) {
          warnings.push(
            "approve decision with empty contracts_verified AND tests_executed: reviewer provided no evidence",
          );
        }
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
        `{ \"decision\": \"<approve|reject|amend|fix>\", \"notes\": \"<reasoning>\", \"contracts_verified\": [{ \"claim\": \"...\", \"evidence\": \"file:line\" }], \"tests_executed\": [{ \"command\": \"...\", \"exit_code\": 0, \"output_excerpt\": \"...\" }] }`,
        "```",
        ``,
        `For an \`approve\` decision, \`contracts_verified\` and \`tests_executed\` SHOULD be non-empty — they're how the planner records that you actually checked, not just looked. Empty arrays are fine for cases where nothing was actually checkable. If the task itself failed or you couldn't complete it, still emit the block — set "notes" to describe what blocked you.`,
      ].join("\n");
    },
  },
  distill: {
    buildPrompt(task: Task, board: Board): string {
      const parts: string[] = [];
      parts.push(DISTILL_SYSTEM);
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
      const brief = formatContractBrief(board);
      if (brief) {
        parts.push("");
        parts.push(brief);
      }
      const attachments = formatAttachments(board);
      if (attachments) {
        parts.push("");
        parts.push(attachments);
      }

      const reviewsList = Array.isArray(task.reviews) ? task.reviews : [];
      parts.push("");
      parts.push("## Why no winner was picked");
      const distillOfId = task.distillOf;
      const originatingReview = distillOfId
        ? board.tasks.find((t) => t.id === distillOfId)
        : undefined;
      if (originatingReview && originatingReview.artifacts) {
        const a = originatingReview.artifacts as Record<string, unknown>;
        const notes = typeof a.notes === "string" ? a.notes : "";
        parts.push(
          `The reviewer (${originatingReview.id} — ${originatingReview.title}) returned \`synthesize\` rather than picking a single winner.`,
        );
        if (notes) {
          parts.push("");
          parts.push("Reviewer notes:");
          parts.push("```");
          parts.push(notes);
          parts.push("```");
        } else {
          parts.push("");
          parts.push("(Reviewer left no notes.)");
        }
      } else {
        parts.push(
          "(No originating review notes available — proceed from the candidate artifacts alone.)",
        );
      }

      parts.push("");
      parts.push("## Candidates");
      parts.push(
        `Each \`## Candidate Tx\` section below contains that worker's full \`artifacts\` block — including the same daemon-audited \`verified_diff\` (files actually edited + sample hunks) that the judge saw. Treat \`verified_diff\` as evidence; the worker's \`summary\` / \`files_changed\` are claims.`,
      );
      for (const revId of reviewsList) {
        const rev = board.tasks.find((t) => t.id === revId);
        parts.push("");
        parts.push(`### Candidate ${revId}${rev?.title ? ` — ${rev.title}` : ""}`);
        if (rev && rev.status === "done" && rev.artifacts) {
          parts.push(JSON.stringify(rev.artifacts, null, 2));
        } else {
          parts.push("(no artifacts available)");
        }
      }

      parts.push("");
      parts.push("## Distill instructions");
      parts.push(
        `Produce a structured, **source-cited** report that merges what's salvageable across the candidates and recommends a next step.`,
        ``,
        `**Do this in order:**`,
        `  1. Read each candidate's \`verified_diff\` and compare against the reviewed spec (\`what\` / \`why\` / \`constraints\` of the task they were attempting).`,
        `  2. Extract \`findings\` — concrete claims about the candidates. Each finding cites \`sources\` (candidate ids) and a \`verdict\` (keep / drop / defer).`,
        `  3. Pick a \`recommended_action\`:`,
        `     - \`apply Tx\` — one candidate is good enough as-is; name it. Mirrors the judge's "winner" path.`,
        `     - \`rework\` — fix one of the candidates; \`rework_brief\` describes what changes.`,
        `     - \`new-work\` — start fresh from scratch; \`rework_brief\` describes the work.`,
        `     - \`noop\` — the report is purely informational; no action on reviewees. Only meaningful for user-authored distill tasks (where reviewees are inputs, not work-to-supersede).`,
        `  4. List \`unresolved\` questions that couldn't be answered from the artifacts.`,
      );
      if (task.attemptCount > 0 && task.reviewFeedback?.length) {
        parts.push("");
        parts.push("## Previous attempt feedback");
        for (const entry of task.reviewFeedback) {
          parts.push(`- ${entry}`);
        }
      }
      parts.push("");
      parts.push(REVIEW_RESULT_INSTRUCTIONS_DISTILL);
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
      if (last === undefined) return undefined;
      try {
        return JSON.parse(last);
      } catch {
        return undefined;
      }
    },

    normalizeResult(raw: unknown, reviewsList?: string[]): NormalizedResult | undefined {
      if (!raw || typeof raw !== "object") return undefined;
      const obj = raw as Record<string, unknown>;
      const warnings: string[] = [];

      const summary =
        typeof obj.summary === "string" && obj.summary.trim().length > 0
          ? obj.summary.trim()
          : undefined;
      if (!summary) {
        warnings.push("distill missing summary");
        return undefined;
      }

      const findingsRaw = obj.findings;
      if (!Array.isArray(findingsRaw) || findingsRaw.length === 0) {
        warnings.push("distill findings must be a non-empty array");
        return undefined;
      }

      const findings: Array<{
        claim: string;
        sources: string[];
        verdict: string;
        evidence: string;
      }> = [];
      const reviewSet = new Set(reviewsList ?? []);
      for (let i = 0; i < findingsRaw.length; i++) {
        const f = findingsRaw[i];
        if (!f || typeof f !== "object" || Array.isArray(f)) {
          warnings.push(`findings[${i}] should be an object`);
          return undefined;
        }
        const fr = f as Record<string, unknown>;
        const claim = typeof fr.claim === "string" ? fr.claim : "";
        if (!claim) {
          warnings.push(`findings[${i}] missing claim`);
          return undefined;
        }
        const verdict = fr.verdict;
        if (verdict !== "keep" && verdict !== "drop" && verdict !== "defer") {
          warnings.push(`findings[${i}] verdict must be keep|drop|defer`);
          return undefined;
        }
        const evidence = typeof fr.evidence === "string" ? fr.evidence : "";
        if (!evidence) {
          warnings.push(`findings[${i}] missing evidence`);
          return undefined;
        }
        const sourcesRaw = fr.sources;
        if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
          warnings.push(`findings[${i}] has empty sources`);
          return undefined;
        }
        const sources: string[] = [];
        for (const s of sourcesRaw) {
          if (typeof s !== "string") {
            warnings.push(`findings[${i}] sources had non-string entry`);
            return undefined;
          }
          if (reviewsList && !reviewSet.has(s)) {
            warnings.push(`findings[${i}] source "${s}" not found in reviews list`);
            return undefined;
          }
          sources.push(s);
        }
        findings.push({ claim, sources, verdict, evidence });
      }

      const action = obj.recommended_action;
      if (typeof action !== "string" || action.trim().length === 0) {
        warnings.push("distill missing recommended_action");
        return undefined;
      }
      const applyMatch = /^apply\s+(\S+)$/.exec(action.trim());
      const reworkBrief =
        typeof obj.rework_brief === "string" ? obj.rework_brief.trim() : "";
      let normalizedAction = action.trim();
      let appliedWinner: string | undefined;
      if (applyMatch) {
        const tx = applyMatch[1]!;
        if (reviewsList && !reviewSet.has(tx)) {
          warnings.push(`recommended_action "apply ${tx}" references non-reviewee`);
          return undefined;
        }
        appliedWinner = tx;
        normalizedAction = `apply ${tx}`;
      } else if (normalizedAction === "rework" || normalizedAction === "new-work") {
        if (!reworkBrief) {
          warnings.push(
            `recommended_action "${normalizedAction}" requires rework_brief`,
          );
          return undefined;
        }
      } else if (normalizedAction === "noop") {
        // noop is informational: no winner, no rework_brief required.
        // Bridge enforces the user-authored-only restriction in
        // handleDistillComplete; the parser accepts it unconditionally
        // so citation enforcement still applies.
      } else {
        warnings.push(
          `recommended_action must be "apply Tx" | "rework" | "new-work" | "noop"`,
        );
        return undefined;
      }

      const unresolved = Array.isArray(obj.unresolved)
        ? obj.unresolved.filter((v): v is string => typeof v === "string")
        : undefined;

      const artifacts: TaskArtifacts = { summary };
      const rec = artifacts as Record<string, unknown>;
      rec.findings = findings;
      rec.recommended_action = normalizedAction;
      if (appliedWinner) rec.applied_winner = appliedWinner;
      if (reworkBrief) rec.rework_brief = reworkBrief;
      if (unresolved && unresolved.length > 0) rec.unresolved = unresolved;

      return { artifacts, warnings };
    },

    buildResumePrompt(task: Task): string {
      return [
        `[hydra-acp-planner: resuming after restart]`,
        ``,
        `You were previously distilling **${task.id} — ${task.title}**.`,
        ``,
        `Continue from where you left off. If you were mid-analysis, finish it. If you were already done but never emitted your hydra-result block, emit it now (don't redo the distillation).`,
        ``,
        `When finished, end your message with the same fenced \`\`\`hydra-result block format described earlier (summary + findings[] with non-empty sources + recommended_action).`,
      ].join("\n");
    },

    buildRepromptPrompt(task: Task): string {
      return [
        `Your previous reply for ${task.id} didn't end with the required \`hydra-result\` block, or the block failed validation.`,
        ``,
        `Please emit it now — do NOT redo the analysis. Every \`finding\` must have a non-empty \`sources\` array drawn from the candidate ids listed in the prompt. \`recommended_action\` must be \`apply Tx\`, \`rework\`, \`new-work\`, or \`noop\` (rework/new-work require \`rework_brief\`; noop means informational only and is only valid for user-authored distill):`,
        ``,
        "```hydra-result",
        `{"summary":"...","findings":[{"claim":"...","sources":["Tx"],"verdict":"keep","evidence":"Tx:path hunk N"}],"recommended_action":"apply Tx"}`,
        "```",
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

// ── Distill helpers (thin wrappers) ──────────────────────────────────────

export function buildDistillPrompt(task: Task, board: Board): string {
  return promptsFor("distill").buildPrompt(task, board);
}

export function extractDistillBlock(text: string): unknown {
  return promptsFor("distill").extractResult(text);
}

export function normalizeDistill(
  raw: unknown,
  reviewsList?: string[],
): NormalizedResult | undefined {
  return promptsFor("distill").normalizeResult(raw, reviewsList);
}

export function buildResumeDistillPrompt(task: Task): string {
  return promptsFor("distill").buildResumePrompt(task);
}

export function buildRepromptForDistillPrompt(task: Task): string {
  return promptsFor("distill").buildRepromptPrompt(task);
}
