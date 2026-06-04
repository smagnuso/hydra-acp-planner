// User-facing CLI surface. Invoked indirectly via `hydra-acp planner ...`
// (which execs `hydra-acp-planner ...` from PATH per the git-style
// fallback), or directly as `hydra-acp-planner ...`.
//
// M0 ships --version, --describe, and --help only. Real subcommands
// (list, show, board, attach, export, import, archive, ...) come in
// M3.5 once the transformer side actually produces boards.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      "  hydra-acp planner [list]              List active projects (TODO M3.5)",
      "  hydra-acp planner show <projectId>    Show one project's board (TODO M3.5)",
      "  hydra-acp planner --version",
      "  hydra-acp planner --help",
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

export function runCli(argv: readonly string[]): void {
  // --describe is the convention the hydra-acp dispatcher reads (when we
  // wire up the discovery polish) to show a one-line summary in
  // `hydra-acp --help`. Stable across versions; keep it short.
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
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const sub = argv[0];
  // Placeholders for the M3.5 surface — exit non-zero with a hint so
  // anyone trying these against M0 gets a clear signal.
  if (
    sub === "list" ||
    sub === "show" ||
    sub === "board" ||
    sub === "attach" ||
    sub === "export" ||
    sub === "import" ||
    sub === "archive" ||
    sub === "remove"
  ) {
    process.stderr.write(
      `hydra-acp-planner: '${sub}' is not implemented yet (planned for M3.5)\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`hydra-acp-planner: unknown subcommand: ${sub}\n`);
  printHelp();
  process.exit(2);
}
