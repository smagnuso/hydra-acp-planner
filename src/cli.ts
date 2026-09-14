// User-facing CLI surface. Invoked indirectly via `hydra-acp planner ...`
// (which execs `hydra-acp-planner ...` from PATH per the git-style
// fallback), or directly as `hydra-acp-planner ...`.
//
// M1 ships `list` and `show` reading directly from disk — no daemon
// roundtrip required, works even when the daemon is down.

import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  canonicalProjectId,
  listProjects,
  loadBoard,
  shortProjectId,
  shortSessionId,
} from "./board.js";
import {
  collectFindings,
  formatFindingBlock,
  formatStatusBody,
} from "./format.js";
import { orchestratorPointerPath, projectDir } from "./paths.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "hydra-acp-planner — multi-agent project orchestrator for hydra-acp",
      "",
      "Usage:",
      "  hydra-acp planner [list]              List projects (live + recent terminal; --all for everything)",
      "  hydra-acp planner info [projectId]    Show one project's board (defaults to the sole active project)",
      "  hydra-acp planner remove <projectId>  Delete a project (closes worker sessions; orchestrator session untouched)",
      "  hydra-acp planner --version",
      "  hydra-acp planner --help",
      "",
    ].join("\n"),
  );
}

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const TERMINAL_PROJECT_LIMIT = 20;

function runList(argv: readonly string[]): void {
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const everything = listProjects();

  if (json) {
    process.stdout.write(JSON.stringify(everything, null, 2) + "\n");
    return;
  }
  if (everything.length === 0) {
    process.stdout.write(
      "No planner projects yet. Start one with:\n  /hydra planner create <description>\nin any hydra-acp session.\n",
    );
    return;
  }
  // Mirror `hydra-acp session list`: always show live (non-terminal)
  // rows; cap terminal (done/failed) rows to the N most recent unless
  // --all is passed. listProjects() is already sorted most-recent-first.
  const isTerminal = (s: string) => s === "done" || s === "failed";
  let projects = everything;
  let truncated = 0;
  if (!all) {
    const live = everything.filter((p) => !isTerminal(p.state));
    const terminal = everything.filter((p) => isTerminal(p.state));
    const terminalShown = terminal.slice(0, TERMINAL_PROJECT_LIMIT);
    truncated = terminal.length - terminalShown.length;
    projects = [...live, ...terminalShown];
  }
  // Compact, scannable. Columns: short projectId, state, tasks-done/total,
  // age, description (truncated). Prefix is stripped for display; the
  // full id can be re-derived from the bare suffix in CLI args.
  const idW = Math.max(10, ...projects.map((p) => shortProjectId(p.projectId).length));
  const stateW = Math.max(8, ...projects.map((p) => p.state.length));
  // Owning session id (short form). "-" when the orchestrator pointer
  // file is missing — happens for in-flight imports and very old
  // projects that predate the pointer.
  const sessW = Math.max(
    7,
    ...projects.map((p) => (p.orchestratorSessionId ? shortSessionId(p.orchestratorSessionId).length : 1)),
  );
  const header = `${"PROJECTID".padEnd(idW)}  ${"STATE".padEnd(stateW)}  TASKS  AGE   ${"SESSION".padEnd(sessW)}  DESCRIPTION`;
  process.stdout.write(header + "\n");
  // Fit description column to remaining terminal width. Fall back to 60
  // when stdout isn't a TTY (piped output) so non-interactive consumers
  // still get a stable column.
  const termCols = process.stdout.isTTY ? (process.stdout.columns ?? 80) : 0;
  const prefixW = idW + 2 + stateW + 2 + 5 + 2 + 5 + 2 + sessW + 2;
  const descW = termCols > 0 ? Math.max(20, termCols - prefixW) : 0;
  for (const p of projects) {
    const tasks = `${p.tasksDone}/${p.tasksTotal}`.padEnd(5);
    const age = ageString(p.updatedAt).padEnd(5);
    const sess = (p.orchestratorSessionId ? shortSessionId(p.orchestratorSessionId) : "-").padEnd(sessW);
    const desc = descW > 0 && p.description.length > descW
      ? p.description.slice(0, descW - 3) + "..."
      : p.description;
    process.stdout.write(
      `${shortProjectId(p.projectId).padEnd(idW)}  ${p.state.padEnd(stateW)}  ${tasks}  ${age}  ${sess}  ${desc}\n`,
    );
  }
  if (truncated > 0) {
    process.stdout.write(
      `\n... ${truncated} more terminal project${truncated === 1 ? "" : "s"} hidden. Use --all to show.\n`,
    );
  }
}

function runInfo(projectId: string | undefined, argv: readonly string[]): void {
  if (!projectId) {
    // No id given: prefer the sole running project. If there's exactly
    // one of those, use it. Otherwise fall back to "the only non-terminal
    // project" (covers single paused/stopped case). Only error when the
    // choice is genuinely ambiguous.
    const all = listProjects();
    const running = all.filter((p) => p.state === "running");
    const nonTerminal = all.filter((p) => p.state !== "done" && p.state !== "failed");
    let pick: typeof all[number] | undefined;
    if (running.length === 1) {
      pick = running[0];
    } else if (running.length === 0 && nonTerminal.length === 1) {
      pick = nonTerminal[0];
    }
    if (pick) {
      projectId = pick.projectId;
    } else if (nonTerminal.length === 0) {
      process.stderr.write(
        "hydra-acp-planner info: no active projects (pass a projectId, or `planner list --all` to see terminal ones)\n",
      );
      process.exit(2);
    } else {
      const candidates = running.length > 1 ? running : nonTerminal;
      const label = running.length > 1 ? "running" : "active";
      process.stderr.write(
        `hydra-acp-planner info: ${candidates.length} ${label} projects — specify which:\n`,
      );
      for (const p of candidates) {
        process.stderr.write(`  ${shortProjectId(p.projectId)}  ${p.state}  ${p.description}\n`);
      }
      process.exit(2);
    }
  }
  const canonical = canonicalProjectId(projectId);
  const board = loadBoard(canonical);
  if (!board) {
    process.stderr.write(`hydra-acp-planner info: no project '${projectId}'\n`);
    process.exit(1);
  }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(board, null, 2) + "\n");
    return;
  }

  // Show the orchestrator session this project lives in, so the user
  // can hydra-acp --session <id> to attach and chat with it.
  let orchestratorSessionId: string | undefined;
  try {
    orchestratorSessionId = readFileSync(
      orchestratorPointerPath(canonical),
      "utf8",
    ).trim();
  } catch {
    orchestratorSessionId = undefined;
  }

  process.stdout.write(formatStatusBody(board, orchestratorSessionId) + "\n");

  // For terminal-state projects (done/failed), append the same findings
  // block that `/hydra planner findings` emits so `planner info` works
  // as the post-mortem entry point without re-attaching to the
  // orchestrator session. Non-terminal states (running/paused/stopped/
  // ready/decomposing) are unchanged.
  if (board.state === "done" || board.state === "failed") {
    const findings = collectFindings(board);
    if (findings.length === 0) {
      const msg =
        board.state === "done"
          ? "No findings — project finished cleanly."
          : "No findings recorded — project failed without per-task feedback.";
      process.stdout.write(msg + "\n");
    } else {
      const blocks = findings.map(formatFindingBlock).join("\n\n");
      process.stdout.write(`\n## Findings\n\n${blocks}\n`);
    }
  }
}

// The session the daemon would have this project's board loaded under,
// or undefined when the pointer is missing.
function orchestratorPointerFor(projectId: string): string | undefined {
  try {
    const id = readFileSync(orchestratorPointerPath(projectId), "utf8").trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// Whether a reachable daemon still knows that session.
//
// Returns false both when the daemon is down and when it is up but has
// no such session — the two are equivalent for our purposes (nothing is
// holding the board in memory), and conflating them keeps the offline
// path, which is the reason this CLI reads from disk at all, working.
function daemonKnowsSession(sessionId: string): boolean {
  const res = spawnSync("hydra-acp", ["session", "list", "--all", "--json"], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout) {
    return false;
  }
  try {
    const rows = JSON.parse(res.stdout) as Array<{ sessionId?: string }>;
    return rows.some((r) => r.sessionId === sessionId);
  } catch {
    return false;
  }
}

// Tear a worker's workspace down before its session goes away, and
// report any branch that had to be kept.
//
// `session remove` alone is not enough: it removes the checkout but
// NEVER the branch (the daemon's releaseWorkspace says so in as many
// words), so removing a project used to leave one `hydra/<label>` ref
// per isolated worker in the user's repo, forever.
//
// `workspace remove` is the verb that knows the difference. It reclaims
// a branch holding nothing the source lacks, and KEEPS one that still
// holds unlanded commits — which for a project being thrown away is the
// last copy of that work, so it is reported rather than deleted. Run
// BEFORE the session is removed, because afterwards the binding is gone
// and there is nothing left to name the workspace by.
function removeWorkerWorkspace(workerId: string): string | undefined {
  const res = spawnSync(
    "hydra-acp",
    ["workspace", "remove", workerId, "--force"],
    { encoding: "utf8" },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  // "no such workspace" is the normal answer for an unisolated worker.
  const kept = out
    .split("\n")
    .filter((l) => l.includes("kept") || l.includes("if you want it back"))
    .map((l) => l.trim());
  return kept.length > 0 ? kept.join("\n  ") : undefined;
}

function runRemove(projectId: string | undefined): void {
  if (!projectId) {
    process.stderr.write("hydra-acp-planner remove: requires a projectId\n");
    process.exit(2);
  }
  const canonical = canonicalProjectId(projectId);
  const board = loadBoard(canonical);
  if (!board) {
    process.stderr.write(`hydra-acp-planner remove: no project '${projectId}'\n`);
    process.exit(1);
  }
  // Refuse rather than half-work. A running daemon holds this board in
  // memory and re-persists it on the next mutation, so deleting the
  // directory from out here removes the workers and then watches the
  // record come back — the user is told it worked and `list` still
  // shows the project. The in-daemon handler drops the in-memory copy
  // too, which is the only way for the removal to stick.
  const orchestrator = orchestratorPointerFor(canonical);
  if (orchestrator !== undefined && daemonKnowsSession(orchestrator)) {
    process.stderr.write(
      `hydra-acp-planner remove: project ${shortProjectId(canonical)} is live in the running daemon ` +
        `(orchestrator session ${shortSessionId(orchestrator)}).\n` +
        `Removing it from here would be undone the next time the daemon persists its copy.\n` +
        `Run \`/hydra planner remove ${shortProjectId(canonical)}\` from any hydra session instead, ` +
        `or stop the daemon first.\n`,
    );
    process.exit(1);
  }
  // Workspace first, then the session: see removeWorkerWorkspace.
  // Best-effort throughout — a worker that is already gone should not
  // block dropping the planner record.
  const notes: string[] = [];
  for (const workerId of Object.keys(board.workers)) {
    const kept = removeWorkerWorkspace(workerId);
    if (kept !== undefined) {
      notes.push(`${shortSessionId(workerId)}: ${kept}`);
    }
    spawnSync("hydra-acp", ["session", "remove", workerId], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  rmSync(projectDir(canonical), { recursive: true, force: true });
  process.stdout.write(`Removed project ${shortProjectId(canonical)}.\n`);
  if (notes.length > 0) {
    // Named, not silently left behind: these refs are the only remaining
    // copy of work that never landed.
    process.stdout.write(
      `\nKept, because they still hold work the source does not:\n  ${notes.join("\n  ")}\n`,
    );
  }
}

export function runCli(argv: readonly string[]): void {
  if (argv.includes("--describe")) {
    process.stdout.write(
      "multi-agent project orchestrator: decompose, dispatch, coordinate\n",
    );
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-planner ${readVersion()}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  // Default to list when there's no positional verb (either no args at
  // all, or the user passed only flags like `--all` / `--json`).
  // Matches `git status` / `hydra-acp session` patterns.
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === undefined || sub.startsWith("-") || sub === "list") {
    runList(sub === "list" ? rest : argv);
    return;
  }
  if (sub === "info") {
    runInfo(rest[0], rest.slice(1));
    return;
  }
  if (sub === "remove") {
    runRemove(rest[0]);
    return;
  }
  if (
    sub === "board" ||
    sub === "attach" ||
    sub === "export" ||
    sub === "import" ||
    sub === "archive"
  ) {
    process.stderr.write(
      `hydra-acp-planner: '${sub}' is not implemented yet (planned for later milestone)\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`hydra-acp-planner: unknown subcommand: ${sub}\n`);
  printHelp();
  process.exit(2);
}
