import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bin = resolve(here, "..", "dist", "index.js");

interface BoardOpts {
  state: "running" | "done" | "failed";
  withFinding?: boolean;
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
    env: { ...process.env, HOME: home },
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
    assert.match(r.stdout, /\/hydra planner findings/);
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
