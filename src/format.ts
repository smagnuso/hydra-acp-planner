// Text formatters for board state. Pure functions over Board — no I/O,
// no daemon calls — so they're directly unit-testable.

import { shortProjectId, shortSessionId, type Board, type Task } from "./board.js";

// Inline overrides tag for a task: " {agent-id}", " {agent-id|model}",
// or "" when neither is set. Same shape in both formatters so a task
// reads identically across the board-context preamble and the
// /status view.
function formatTaskTag(task: Task): string {
  const a = task.agent;
  const m = task.model;
  if (!a && !m) return "";
  const inner = a && m ? `${a} | ${m}` : (a ?? m);
  return ` {${inner}}`;
}

export const TASK_STATUS_GLYPH: Record<string, string> = {
  done: "✓",
  assigned: "▶",
  failed: "⨯",
  blocked: "⊘",
  pending: "·",
};

// Render a board as a context preamble injected into the user's prompts
// to the orchestrator agent. Different consumer than formatStatus:
//
//   - formatStatus is for the human (terse glyphs, scannable).
//   - formatBoardContext is for the AGENT (named fields, full artifact
//     bodies, explicit "you may answer questions using this context"
//     instruction so the agent doesn't echo the data verbatim).
//
// The agent receives this immediately before the user's actual prompt
// on every non-slash turn, so it always has fresh project state. Keep
// it reasonably compact — every conversational turn pays the token
// cost.
export function formatBoardContext(board: Board): string {
  const lines: string[] = [];
  lines.push("[hydra-acp-planner: this session is the orchestrator for a multi-agent project.");
  lines.push(`Project ID: ${shortProjectId(board.projectId)} (state: ${board.state})`);
  lines.push(`Description: ${board.description}`);
  lines.push(`Concurrency cap: ${board.concurrencyCap}`);
  if (board.tasks.length === 0) {
    lines.push("Tasks: none yet (decomposition pending).");
  } else {
    const done = board.tasks.filter((t) => t.status === "done").length;
    const total = board.tasks.length;
    lines.push(`Tasks (${done}/${total} done):`);
    for (const task of board.tasks) {
      const glyph = TASK_STATUS_GLYPH[task.status] ?? "?";
      const deps = task.deps.length === 0 ? "" : `, deps: ${task.deps.join(", ")}`;
      const worker =
        task.status === "assigned" && task.assignedTo
          ? `, worker: ${shortSessionId(task.assignedTo)}`
          : "";
      const tag = formatTaskTag(task);
      lines.push(`  ${glyph} ${task.id} ${task.title}${tag} [${task.status}${deps}${worker}]`);
      if (task.what) lines.push(`     what: ${task.what}`);
      if (task.constraints) lines.push(`     constraints: ${task.constraints}`);
      if (task.artifacts?.summary) lines.push(`     result: ${task.artifacts.summary}`);
      if (task.artifacts?.decisions && task.artifacts.decisions.length > 0) {
        lines.push(`     decisions: ${task.artifacts.decisions.join("; ")}`);
      }
      if (task.artifacts?.files_changed && task.artifacts.files_changed.length > 0) {
        lines.push(`     files: ${task.artifacts.files_changed.join(", ")}`);
      }
    }
  }
  lines.push("");
  lines.push("Answer the user's question or follow their instruction using this context. Do NOT echo the context block verbatim. To take action on the project (cancel, add tasks, etc.) suggest the relevant /hydra planner <verb> command.");
  lines.push("]");
  lines.push("");
  lines.push("User's prompt follows:");
  return lines.join("\n");
}

// Render a board as the body of a `/hydra planner status` reply.
// Multi-line plain text; gets emitted as a synthetic agent_message_chunk
// by hydra's emitExtensionReply, so it lands cleanly in any client's
// transcript renderer. The `attached` flag is the planner's
// best-effort belief about whether it's currently in this session's
// transformer chain — true if we've called transformer/attach this
// process lifetime and haven't dropped it.
export function formatStatus(board: Board, attached: boolean): string {
  const lines: string[] = [];
  const done = board.tasks.filter((t) => t.status === "done").length;
  const inFlight = board.tasks.filter((t) => t.status === "assigned").length;
  const failed = board.tasks.filter((t) => t.status === "failed").length;
  lines.push(`📋 ${shortProjectId(board.projectId)}  (${board.state})`);
  lines.push(`   ${board.description}`);
  lines.push("");
  const counts = [`${board.tasks.length} total`, `${done} done`];
  if (inFlight > 0) counts.push(`${inFlight} in flight`);
  if (failed > 0) counts.push(`${failed} failed`);
  lines.push(`   Tasks: ${counts.join(", ")}`);
  lines.push(`   Concurrency cap: ${board.concurrencyCap}`);
  lines.push(
    `   Planner: ${attached ? "attached (intercepts active)" : "not currently attached — next /hydra planner command will re-attach"}`,
  );
  if (board.tasks.length === 0) {
    return lines.join("\n");
  }
  lines.push("");
  for (const task of board.tasks) {
    const glyph = TASK_STATUS_GLYPH[task.status] ?? "?";
    const deps = task.deps.length === 0 ? "" : `  ← ${task.deps.join(", ")}`;
    const worker =
      task.status === "assigned" && task.assignedTo
        ? `  → ${shortSessionId(task.assignedTo)}`
        : "";
    const tag = formatTaskTag(task);
    lines.push(`   ${glyph} ${task.id}  ${task.title}${tag}${deps}${worker}`);
  }
  return lines.join("\n");
}
