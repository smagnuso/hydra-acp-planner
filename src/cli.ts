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
} from "./board.js";
import { formatStatusBody } from "./format.js";
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
      "  hydra-acp planner [list]              List active projects (--all includes done/failed)",
      "  hydra-acp planner info <projectId>    Show one project's board",
      "  hydra-acp planner remove <projectId>  Delete a project (closes worker sessions; orchestrator session untouched)",
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
  const all = argv.includes("--all");
  const everything = listProjects();
  // Default view: hide terminal projects (done / failed). Same idea as
  // `hydra-acp session` filtering to live + recent. --all to include.
  const projects = all
    ? everything
    : everything.filter((p) => p.state !== "done" && p.state !== "failed");
  const hiddenCount = everything.length - projects.length;

  if (json) {
    process.stdout.write(JSON.stringify(projects, null, 2) + "\n");
    return;
  }
  if (projects.length === 0) {
    if (hiddenCount > 0) {
      process.stdout.write(
        `No active planner projects. (${hiddenCount} terminal — re-run with --all to see them.)\n`,
      );
      return;
    }
    process.stdout.write(
      "No planner projects yet. Start one with:\n  /hydra planner create <description>\nin any hydra-acp session.\n",
    );
    return;
  }
  // Compact, scannable. Columns: short projectId, state, tasks-done/total,
  // age, description (truncated). Prefix is stripped for display; the
  // full id can be re-derived from the bare suffix in CLI args.
  const idW = Math.max(10, ...projects.map((p) => shortProjectId(p.projectId).length));
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
      `${shortProjectId(p.projectId).padEnd(idW)}  ${p.state.padEnd(stateW)}  ${tasks}  ${age}  ${desc}\n`,
    );
  }
  if (hiddenCount > 0) {
    process.stdout.write(
      `\n(${hiddenCount} terminal project${hiddenCount === 1 ? "" : "s"} hidden — re-run with --all to include.)\n`,
    );
  }
}

function runInfo(projectId: string | undefined, argv: readonly string[]): void {
  if (!projectId) {
    process.stderr.write("hydra-acp-planner info: requires a projectId\n");
    process.exit(2);
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
  process.stdout.write(`${shortProjectId(board.projectId)}  (${board.state})\n`);
  process.stdout.write(`${board.description}\n\n`);

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
  // Close each worker session via the daemon CLI. Best-effort —
  // if a worker is already gone we still want to drop the planner record.
  for (const workerId of Object.keys(board.workers)) {
    spawnSync("hydra-acp", ["session", "remove", workerId], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  rmSync(projectDir(canonical), { recursive: true, force: true });
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
