import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join, delimiter } from "node:path";
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bin = resolve(here, "..", "dist", "index.js");

interface BoardOpts {
  state: "running" | "done" | "failed";
  withFinding?: boolean;
  withRichFinding?: boolean;
}

function makeBoard(projId: string, opts: BoardOpts): Record<string, unknown> {
  const tasks: Array<Record<string, unknown>> = [];
  if (opts.withFinding) {
    tasks.push({
      id: "t1",
      title: "do the thing",
      deps: [],
      status: "failed",
      attemptCount: 1,
      kind: "work",
      artifacts: { summary: "it broke because of X" },
    });
  }
  if (opts.withRichFinding) {
    tasks.push({
      id: "t2",
      title: "rich task",
      deps: [],
      status: "failed",
      attemptCount: 2,
      kind: "work",
      artifacts: {
        summary: "rich summary line",
        notes: "DETAILED_NOTE_TOKEN about failure",
        follow_ups: ["FOLLOWUP_TOKEN_A", "FOLLOWUP_TOKEN_B"],
        verified_diff: {
          files: ["src/a.ts", "src/b.ts"],
          hunkCount: 5,
          sample: "diff --git a/src/a.ts b/src/a.ts\n+SAMPLE_DIFF_TEXT_SHOULD_NOT_APPEAR",
        },
      },
    });
  }
  return {
    version: 2,
    projectId: projId,
    description: "cli findings test board",
    state: opts.state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fleetDefaults: { agent: null, model: null },
    tasks,
    workers: {},
    concurrencyCap: 1,
  };
}

function setupBoard(label: string, opts: BoardOpts): { home: string; projId: string } {
  const home = `/tmp/planner-cli-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projId = `hydra_plan_${label}`;
  const projDir = join(home, ".hydra-acp", "planner", "projects", projId);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "board.json"), JSON.stringify(makeBoard(projId, opts)));
  writeFileSync(join(projDir, "orchestrator"), "hydra_session_orch_x\n");
  return { home, projId };
}

function runInfo(home: string, projId: string, extra: string[] = []) {
  return spawnSync("node", [bin, "info", projId, ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

describe("hydra-acp-planner info: findings on terminal-state boards", () => {
  it("state=done with findings: appends findings block after status body", () => {
    const { home, projId } = setupBoard("donewithfind", { state: "done", withFinding: true });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const statusIdx = r.stdout.indexOf("cli findings test board");
    const findIdx = r.stdout.indexOf("finding");
    assert.ok(statusIdx >= 0, "status body present");
    assert.ok(findIdx > statusIdx, `findings block must appear after status body. stdout:\n${r.stdout}`);
    assert.match(r.stdout, /t1/);
    assert.doesNotMatch(r.stdout, /\/hydra planner findings/);
    assert.match(r.stdout, /## Findings/);
    rmSync(home, { recursive: true, force: true });
  });

  it("state=done with rich finding: inlines notes, follow-ups, verified_diff descriptor", () => {
    const { home, projId } = setupBoard("rich", { state: "done", withRichFinding: true });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /## Findings/);
    assert.match(r.stdout, /=== t2 \[failed\] rich task/);
    assert.match(r.stdout, /DETAILED_NOTE_TOKEN/);
    assert.match(r.stdout, /FOLLOWUP_TOKEN_A/);
    assert.match(r.stdout, /FOLLOWUP_TOKEN_B/);
    assert.match(r.stdout, /verified_diff: 2 file\(s\), 5 hunk\(s\)/);
    assert.doesNotMatch(r.stdout, /SAMPLE_DIFF_TEXT_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(r.stdout, /\/hydra planner findings/);
    rmSync(home, { recursive: true, force: true });
  });

  it("state=failed with findings: appends findings block too", () => {
    const { home, projId } = setupBoard("failedwithfind", { state: "failed", withFinding: true });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /finding/);
    assert.match(r.stdout, /t1/);
    rmSync(home, { recursive: true, force: true });
  });

  it("state=done with no findings: prints clean-finish line", () => {
    const { home, projId } = setupBoard("donenofind", { state: "done" });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /No findings — project finished cleanly\./);
    rmSync(home, { recursive: true, force: true });
  });

  it("state=failed with no findings: prints failed-without-feedback line", () => {
    const { home, projId } = setupBoard("failednofind", { state: "failed" });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /No findings recorded — project failed without per-task feedback\./);
    rmSync(home, { recursive: true, force: true });
  });

  it("state=running: no findings block appended", () => {
    const { home, projId } = setupBoard("running1", { state: "running", withFinding: true });
    const r = runInfo(home, projId);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /No findings/);
    assert.doesNotMatch(r.stdout, /\/hydra planner findings/);
    rmSync(home, { recursive: true, force: true });
  });

  it("--json on state=done with findings: raw board JSON only, no findings text", () => {
    const { home, projId } = setupBoard("donejson", { state: "done", withFinding: true });
    const r = runInfo(home, projId, ["--json"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.projectId, projId);
    assert.equal(parsed.state, "done");
    assert.doesNotMatch(r.stdout, /\/hydra planner findings/);
    assert.doesNotMatch(r.stdout, /No findings/);
    rmSync(home, { recursive: true, force: true });
  });
});

// `remove` shells out to `hydra-acp`, so these tests shadow it on PATH
// with a recorder. Without that they would drive the user's real daemon.
//
// The recorder's own logic lives in one Node script so it behaves
// identically on every OS; only the launcher differs. A bare
// extensionless file with a `#!/bin/sh` shebang isn't executable on
// Windows (no shell honors it, and CreateProcess won't run a non-PE
// file), and Windows only matches a PATH entry against `hydra-acp.<ext>`
// for an extension in PATHEXT, never the bare name, so this needs a
// `.cmd` shim there, alongside the POSIX shell wrapper everywhere else.
function fakeHydraBin(dir: string, sessionsJson: string): string {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(dir, "sessions.json"), sessionsJson);
  writeFileSync(
    join(binDir, "hydra-acp.js"),
    [
      'const fs = require("fs");',
      'const path = require("path");',
      "const dir = process.env.HYDRA_ACP_FAKE_DIR;",
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");',
      'if (args[0] === "session" && args[1] === "list") {',
      '  process.stdout.write(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));',
      '} else if (args[0] === "workspace" && args[1] === "remove") {',
      "  process.stdout.write(",
      '    `removed ~/.hydra-acp/workspaces/h/${args[2]} (branch hydra/${args[2]} kept: it has 2 commit(s) not in the source)\\n`,',
      "  );",
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    writeFileSync(join(binDir, "hydra-acp.cmd"), '@node "%~dp0hydra-acp.js" %*\r\n');
  } else {
    writeFileSync(
      join(binDir, "hydra-acp"),
      '#!/bin/sh\nexec node "$(dirname "$0")/hydra-acp.js" "$@"\n',
    );
    chmodSync(join(binDir, "hydra-acp"), 0o755);
  }
  return binDir;
}

function runRemoveCli(home: string, projId: string, binDir: string) {
  return spawnSync("node", [bin, "remove", projId], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HYDRA_ACP_FAKE_DIR: home,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

function setupRemovableBoard(label: string, workers: string[]) {
  const home = `/tmp/planner-cli-rm-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projId = `hydra_plan_${label}`;
  const projDir = join(home, ".hydra-acp", "planner", "projects", projId);
  mkdirSync(projDir, { recursive: true });
  const board = makeBoard(projId, { state: "running" }) as Record<string, unknown>;
  board.workers = Object.fromEntries(
    workers.map((w) => [w, { currentTaskId: null, tasksCompleted: [] }]),
  );
  writeFileSync(join(projDir, "board.json"), JSON.stringify(board));
  writeFileSync(join(projDir, "orchestrator"), "hydra_session_orch_live\n");
  return { home, projId, projDir };
}

describe("hydra-acp-planner remove", () => {
  it("refuses while a running daemon still holds the board", () => {
    // Deleting the directory out here does not stick: the daemon has the
    // board in memory and re-persists it on the next mutation, so the
    // user is told it worked and `list` still shows the project.
    const { home, projId, projDir } = setupRemovableBoard("live", ["hydra_session_w1"]);
    const binDir = fakeHydraBin(home, JSON.stringify([{ sessionId: "hydra_session_orch_live" }]));

    const res = runRemoveCli(home, projId, binDir);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /live in the running daemon/);
    assert.match(res.stderr, /\/hydra planner remove/);
    assert.ok(existsSync(projDir), "the board must survive a refused removal");
    rmSync(home, { recursive: true, force: true });
  });

  it("removes each worker's workspace before its session, and reports kept branches", () => {
    // Order matters: `workspace remove` names the workspace by session,
    // so after `session remove` there is nothing left to name it by, and
    // the branch is orphaned in the user's repo forever.
    const { home, projId, projDir } = setupRemovableBoard("dead", [
      "hydra_session_w1",
      "hydra_session_w2",
    ]);
    // Daemon up, but it has never heard of this orchestrator.
    const binDir = fakeHydraBin(home, JSON.stringify([{ sessionId: "hydra_session_other" }]));

    const res = runRemoveCli(home, projId, binDir);

    assert.equal(res.status, 0, res.stderr);
    const calls = readFileSync(join(home, "calls.log"), "utf8").trim().split("\n");
    const wsIdx = calls.indexOf("workspace remove hydra_session_w1 --force");
    const rmIdx = calls.indexOf("session remove hydra_session_w1");
    assert.ok(wsIdx >= 0, `expected a workspace removal, got: ${calls.join(" | ")}`);
    assert.ok(rmIdx >= 0, "expected the session removal");
    assert.ok(wsIdx < rmIdx, "the workspace must be torn down before the session goes away");
    assert.match(res.stdout, /Kept, because they still hold work the source does not/);
    assert.match(res.stdout, /hydra\/hydra_session_w1 kept/);
    assert.ok(!existsSync(projDir), "the board record should be gone");
    rmSync(home, { recursive: true, force: true });
  });
});
