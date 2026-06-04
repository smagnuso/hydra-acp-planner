// User-facing CLI surface. Invoked indirectly via `hydra-acp planner ...`
// (which execs `hydra-acp-planner ...` from PATH per the git-style
// fallback), or directly as `hydra-acp-planner ...`.
//
// M1 ships `list` and `show` reading directly from disk — no daemon
// roundtrip required, works even when the daemon is down.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjects, loadBoard } from "./board.js";

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
      "  hydra-acp planner [list]              List active projects",
      "  hydra-acp planner show <projectId>    Show one project's board",
      "  hydra-acp planner --version",
      "  hydra-acp planner --help",
      "",
      "To start a new project, from inside any hydra-acp session type:",
      "  /hydra planner create <description>",
      "",
      "When invoked by the hydra-acp daemon as a transformer (env var",
      "HYDRA_ACP_TRANSFORMER_NAME set), this binary runs in transformer",
      "mode instead — it connects to the daemon over WSS, registers its",
      "intercepts, and drives orchestration. The user-facing CLI verbs",
      "are dispatched only when those env vars are absent.",
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

function runList(argv: readonly string[]): void {
  const json = argv.includes("--json");
  const projects = listProjects();
  if (json) {
    process.stdout.write(JSON.stringify(projects, null, 2) + "\n");
    return;
  }
  if (projects.length === 0) {
    process.stdout.write(
      "No planner projects yet. Start one with:\n  /hydra planner create <description>\nin any hydra-acp session.\n",
    );
    return;
  }
  // Compact, scannable. Columns: projectId, state, tasks-done/total,
  // age, description (truncated).
  const idW = Math.max(10, ...projects.map((p) => p.projectId.length));
  const stateW = Math.max(8, ...projects.map((p) => p.state.length));
  const header = `${"PROJECTID".padEnd(idW)}  ${"STATE".padEnd(stateW)}  TASKS  AGE   DESCRIPTION`;
  process.stdout.write(header + "\n");
  for (const p of projects) {
    const tasks = `${p.tasksDone}/${p.tasksTotal}`.padEnd(5);
    const age = ageString(p.updatedAt).padEnd(5);
    const desc = p.description.length > 60
      ? p.description.slice(0, 57) + "..."
      : p.description;
    process.stdout.write(
      `${p.projectId.padEnd(idW)}  ${p.state.padEnd(stateW)}  ${tasks}  ${age}  ${desc}\n`,
    );
  }
}

function runShow(projectId: string | undefined, argv: readonly string[]): void {
  if (!projectId) {
    process.stderr.write("hydra-acp-planner show: requires a projectId\n");
    process.exit(2);
  }
  const board = loadBoard(projectId);
  if (!board) {
    process.stderr.write(`hydra-acp-planner show: no project '${projectId}'\n`);
    process.exit(1);
  }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(board, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${board.projectId}  (${board.state})\n`);
  process.stdout.write(`${board.description}\n\n`);
  process.stdout.write(
    `Tasks: ${board.tasks.length} total, ${board.tasks.filter((t) => t.status === "done").length} done, ${board.tasks.filter((t) => t.status === "assigned").length} in flight\n`,
  );
  process.stdout.write(`Concurrency cap: ${board.concurrencyCap}\n\n`);
  if (board.tasks.length === 0) {
    process.stdout.write("(no tasks yet)\n");
    return;
  }
  const idW = Math.max(3, ...board.tasks.map((t) => t.id.length));
  const stateW = Math.max(7, ...board.tasks.map((t) => t.status.length));
  for (const t of board.tasks) {
    const deps = t.deps.length === 0 ? "" : `  ← ${t.deps.join(", ")}`;
    process.stdout.write(
      `  ${t.id.padEnd(idW)}  ${t.status.padEnd(stateW)}  ${t.title}${deps}\n`,
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
  if (argv.length === 0) {
    // Default: list — matches `git status` / `hydra-acp session` pattern.
    runList(argv);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") {
    runList(rest);
    return;
  }
  if (sub === "show") {
    runShow(rest[0], rest.slice(1));
    return;
  }
  if (
    sub === "board" ||
    sub === "attach" ||
    sub === "export" ||
    sub === "import" ||
    sub === "archive" ||
    sub === "remove"
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
