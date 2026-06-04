import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  listProjects,
  loadBoard,
  newBoard,
  newProjectId,
  saveBoard,
} from "../src/board.ts";

// board.ts derives all paths from $HOME/.hydra-acp/planner — to avoid
// stomping a developer's real planner state during tests, we redirect
// $HOME to a tempdir for each test case.

let originalHome: string;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("newProjectId", () => {
  it("produces a proj_-prefixed identifier", () => {
    const id = newProjectId();
    assert.match(id, /^proj_[0-9a-f]+$/);
  });

  it("returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProjectId()));
    assert.equal(ids.size, 50);
  });
});

describe("newBoard", () => {
  it("starts with state=decomposing and empty tasks/workers", () => {
    const b = newBoard({ description: "x" });
    assert.equal(b.state, "decomposing");
    assert.equal(b.tasks.length, 0);
    assert.deepEqual(b.workers, {});
    assert.equal(b.concurrencyCap, 1);
  });

  it("captures the description", () => {
    const b = newBoard({ description: "build a todo app" });
    assert.equal(b.description, "build a todo app");
  });
});

describe("saveBoard / loadBoard", () => {
  it("persists and round-trips a board", () => {
    const b = newBoard({ description: "round trip" });
    b.tasks = [
      {
        id: "T1",
        title: "test",
        deps: [],
        status: "pending",
        attemptCount: 0,
      },
    ];
    saveBoard(b, "hydra_session_abc");
    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.projectId, b.projectId);
    assert.equal(loaded!.tasks.length, 1);
    assert.equal(loaded!.tasks[0]!.title, "test");
  });

  it("writes an orchestrator pointer alongside the board", () => {
    const b = newBoard({ description: "x" });
    saveBoard(b, "hydra_session_xyz");
    const pointer = readFileSync(
      join(tmpHome, ".hydra-acp", "planner", "projects", b.projectId, "orchestrator"),
      "utf8",
    );
    assert.equal(pointer.trim(), "hydra_session_xyz");
  });

  it("bumps updatedAt on each save", async () => {
    const b = newBoard({ description: "x" });
    saveBoard(b, "s1");
    const first = b.updatedAt;
    // setTimeout-await for ≥1ms so the ISO ts differs
    await new Promise((r) => setTimeout(r, 5));
    saveBoard(b, "s1");
    assert.notEqual(b.updatedAt, first);
  });

  it("returns undefined for an unknown projectId", () => {
    assert.equal(loadBoard("proj_nonexistent"), undefined);
  });

  it("is crash-safe — partial temp files don't break loadBoard", () => {
    // Manually drop a stray .tmp file in the project dir; loadBoard
    // should still find the real board.json (or correctly return
    // undefined when it isn't there).
    const b = newBoard({ description: "x" });
    saveBoard(b, "s1");
    const projDir = join(tmpHome, ".hydra-acp", "planner", "projects", b.projectId);
    mkdirSync(projDir, { recursive: true });
    // Touch a stray .tmp — should not affect anything
    writeFileSync(join(projDir, "board.json.tmp.99999"), "garbage");
    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
  });
});

describe("listProjects", () => {
  it("returns empty array when no projects exist", () => {
    assert.deepEqual(listProjects(), []);
  });

  it("returns a summary entry per saved board", () => {
    const a = newBoard({ description: "alpha" });
    a.tasks = [
      { id: "T1", title: "x", deps: [], status: "done", attemptCount: 0 },
      { id: "T2", title: "y", deps: [], status: "pending", attemptCount: 0 },
    ];
    saveBoard(a, "s1");
    const b = newBoard({ description: "beta" });
    saveBoard(b, "s2");

    const list = listProjects();
    assert.equal(list.length, 2);
    const aEntry = list.find((p) => p.projectId === a.projectId);
    assert.ok(aEntry);
    assert.equal(aEntry!.tasksTotal, 2);
    assert.equal(aEntry!.tasksDone, 1);
    assert.equal(aEntry!.description, "alpha");
    assert.equal(aEntry!.orchestratorSessionId, "s1");
  });

  it("sorts most-recent-first", async () => {
    const a = newBoard({ description: "older" });
    saveBoard(a, "s1");
    await new Promise((r) => setTimeout(r, 5));
    const b = newBoard({ description: "newer" });
    saveBoard(b, "s2");

    const list = listProjects();
    assert.equal(list[0]!.description, "newer");
    assert.equal(list[1]!.description, "older");
  });

  it("skips directories without a parsable board.json", () => {
    const a = newBoard({ description: "good" });
    saveBoard(a, "s1");
    // Create a junk dir under projects/
    mkdirSync(
      join(tmpHome, ".hydra-acp", "planner", "projects", "junk-dir"),
      { recursive: true },
    );
    const list = listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.projectId, a.projectId);
  });
});
