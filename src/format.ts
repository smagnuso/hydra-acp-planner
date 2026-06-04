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

// Tabular render of the sessions involved in a project: the
// orchestrator (the conversation session the user is in) plus one row
// per worker session. Used by both `/hydra planner status` (slash) and
// `hydra-acp planner info` (CLI). Disk-only — works without a daemon
// connection. Columns:
//   ROLE         orchestrator | worker
//   SESSION      short session id (prefix stripped)
//   TASK         task id assigned to that worker, or "-"
//   STATE        task status, or "-" for the orchestrator
//   AGENT|MODEL  the effective override for that worker, or "-"
//   DONE         tasksCompleted count from board.workers, or "-"
//   TITLE        truncated task title
export function formatSessionsTable(
  board: Board,
  orchestratorSessionId: string | undefined,
  options: { indent?: string; titleMaxWidth?: number } = {},
): string {
  const indent = options.indent ?? "";
  const titleMax = options.titleMaxWidth ?? 60;

  type Row = {
    role: string;
    session: string;
    task: string;
    state: string;
    agent: string;
    done: string;
    title: string;
  };

  const rows: Row[] = [];
  if (orchestratorSessionId) {
    rows.push({
      role: "orchestrator",
      session: shortSessionId(orchestratorSessionId),
      task: "-",
      state: "-",
      agent: "-",
      done: "-",
      title: board.description,
    });
  }

  // Index tasks by worker id so we can attach task metadata to each
  // worker row. A worker may have completed past tasks; we render the
  // CURRENT assignment (if any), else the most recent completed task.
  const taskByWorker = new Map<string, Task>();
  for (const t of board.tasks) {
    if (t.assignedTo) taskByWorker.set(t.assignedTo, t);
  }
  for (const [workerId, w] of Object.entries(board.workers)) {
    const t = taskByWorker.get(workerId);
    const agentTag = t ? formatTaskTag(t).trim().replace(/^\{|\}$/g, "") : "";
    rows.push({
      role: "worker",
      session: shortSessionId(workerId),
      task: t?.id ?? "-",
      state: t?.status ?? "-",
      agent: agentTag.length > 0 ? agentTag : "-",
      done: String(w.tasksCompleted.length),
      title: t?.title ?? "-",
    });
  }

  if (rows.length === 0) return "";

  const header: Row = {
    role: "ROLE",
    session: "SESSION",
    task: "TASK",
    state: "STATE",
    agent: "AGENT|MODEL",
    done: "DONE",
    title: "TITLE",
  };

  const cols: Array<keyof Row> = ["role", "session", "task", "state", "agent", "done", "title"];
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(header[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof Row, number>;

  const renderRow = (r: Row): string =>
    cols
      .map((c, i) => {
        if (c === "title") {
          const t = r[c].length > titleMax ? r[c].slice(0, titleMax - 1) + "…" : r[c];
          return i === cols.length - 1 ? t : t.padEnd(widths[c]);
        }
        return r[c].padEnd(widths[c]);
      })
      .join("  ");

  const lines = [renderRow(header), ...rows.map(renderRow)];
  return lines.map((l) => indent + l).join("\n");
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
export function formatStatus(
  board: Board,
  attached: boolean,
  orchestratorSessionId?: string,
): string {
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

  const sessionsTable = formatSessionsTable(board, orchestratorSessionId, {
    indent: "   ",
  });
  if (sessionsTable.length > 0) {
    lines.push("");
    lines.push("   Sessions:");
    lines.push(sessionsTable);
  }
  return lines.join("\n");
}
