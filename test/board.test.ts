import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  allTerminal,
  canonicalProjectId,
  inFlightCount,
  listProjects,
  loadBoard,
  newBoard,
  newProjectId,
  pickEligible,
  saveBoard,
  shortProjectId,
  shortSessionId,
  type Board,
  type Task,
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
  it("produces a hydra_plan_-prefixed identifier", () => {
    const id = newProjectId();
    assert.match(id, /^hydra_plan_[0-9a-f]+$/);
  });

  it("returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProjectId()));
    assert.equal(ids.size, 50);
  });
});

describe("canonicalProjectId", () => {
  it("leaves a fully-prefixed id alone", () => {
    assert.equal(canonicalProjectId("hydra_plan_abc123"), "hydra_plan_abc123");
  });

  it("prepends the prefix to a bare suffix", () => {
    assert.equal(canonicalProjectId("abc123"), "hydra_plan_abc123");
  });

  it("does not double-prefix when called twice", () => {
    const once = canonicalProjectId("abc");
    assert.equal(canonicalProjectId(once), once);
  });
});

describe("shortProjectId", () => {
  it("strips the prefix when present", () => {
    assert.equal(shortProjectId("hydra_plan_abc123"), "abc123");
  });

  it("leaves a bare id alone", () => {
    assert.equal(shortProjectId("abc123"), "abc123");
  });

  it("is the inverse of canonicalProjectId", () => {
    assert.equal(shortProjectId(canonicalProjectId("xyz")), "xyz");
    assert.equal(canonicalProjectId(shortProjectId("hydra_plan_xyz")), "hydra_plan_xyz");
  });
});

describe("shortSessionId", () => {
  it("strips the hydra_session_ prefix when present", () => {
    assert.equal(shortSessionId("hydra_session_abc123"), "abc123");
  });

  it("leaves a bare id alone", () => {
    assert.equal(shortSessionId("abc123"), "abc123");
  });

  it("doesn't strip a project prefix (different namespace)", () => {
    assert.equal(shortSessionId("hydra_plan_abc"), "hydra_plan_abc");
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
    assert.equal(loadBoard("hydra_plan_nonexistent"), undefined);
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

describe("pickEligible", () => {
  function makeTask(id: string, opts: Partial<Task> = {}): Task {
    return {
      id,
      title: id,
      deps: opts.deps ?? [],
      status: opts.status ?? "pending",
      attemptCount: 0,
      ...opts,
    };
  }
  function makeBoard(tasks: Task[]): Board {
    return {
      version: 1,
      projectId: "proj_pe",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks,
      workers: {},
      concurrencyCap: 1,
    };
  }

  it("returns undefined for an empty board", () => {
    assert.equal(pickEligible(makeBoard([])), undefined);
  });

  it("returns the first pending task with no deps", () => {
    const b = makeBoard([makeTask("T1"), makeTask("T2")]);
    assert.equal(pickEligible(b)?.id, "T1");
  });

  it("skips tasks whose deps aren't all done", () => {
    const b = makeBoard([
      makeTask("T1", { status: "assigned" }),
      makeTask("T2", { deps: ["T1"] }),
    ]);
    assert.equal(pickEligible(b), undefined);
  });

  it("returns the dependent once its prereq is done", () => {
    const b = makeBoard([
      makeTask("T1", { status: "done" }),
      makeTask("T2", { deps: ["T1"] }),
    ]);
    assert.equal(pickEligible(b)?.id, "T2");
  });

  it("returns the first eligible by declaration order, not by dep-depth", () => {
    const b = makeBoard([
      makeTask("T1", { status: "done" }),
      makeTask("T2", { status: "done" }),
      makeTask("T3", { deps: ["T1", "T2"] }),
      makeTask("T4"),
    ]);
    // Both T3 and T4 are eligible; T3 wins on declaration order.
    assert.equal(pickEligible(b)?.id, "T3");
  });

  it("skips assigned, done, failed, blocked", () => {
    const b = makeBoard([
      makeTask("T1", { status: "done" }),
      makeTask("T2", { status: "assigned" }),
      makeTask("T3", { status: "failed" }),
      makeTask("T4", { status: "blocked" }),
      makeTask("T5", { status: "pending" }),
    ]);
    assert.equal(pickEligible(b)?.id, "T5");
  });
});

describe("inFlightCount", () => {
  function makeTask(id: string, status: Task["status"]): Task {
    return { id, title: id, deps: [], status, attemptCount: 0 };
  }
  function makeBoard(tasks: Task[]): Board {
    return {
      version: 1,
      projectId: "proj_if",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks,
      workers: {},
      concurrencyCap: 1,
    };
  }

  it("returns 0 for empty board", () => {
    assert.equal(inFlightCount(makeBoard([])), 0);
  });

  it("counts only assigned tasks", () => {
    const b = makeBoard([
      makeTask("T1", "done"),
      makeTask("T2", "assigned"),
      makeTask("T3", "pending"),
      makeTask("T4", "assigned"),
      makeTask("T5", "failed"),
      makeTask("T6", "blocked"),
    ]);
    assert.equal(inFlightCount(b), 2);
  });

  it("composes with pickEligible to model scheduler invariants", () => {
    // Scenario: 4 independent tasks, concurrencyCap=2. The scheduler
    // loop says: while inFlight < cap, pick + assign. After 2
    // iterations, inFlight should equal cap and pickEligible should
    // still return work (which the scheduler then declines to assign).
    const tasks = [
      makeTask("T1", "pending"),
      makeTask("T2", "pending"),
      makeTask("T3", "pending"),
      makeTask("T4", "pending"),
    ];
    const b = makeBoard(tasks);
    b.concurrencyCap = 2;

    // Simulate the scheduler loop deterministically.
    while (inFlightCount(b) < b.concurrencyCap) {
      const t = pickEligible(b);
      if (!t) break;
      t.status = "assigned";
    }
    assert.equal(inFlightCount(b), 2);
    // 2 still pending, eligible — scheduler declines to assign because cap is hit.
    assert.equal(b.tasks.filter((t) => t.status === "pending").length, 2);
  });

  it("scheduler invariant: completing a task frees a slot and pickEligible refills", () => {
    const tasks = [
      makeTask("T1", "assigned"),
      makeTask("T2", "assigned"),
      makeTask("T3", "pending"),
      makeTask("T4", "pending"),
    ];
    const b = makeBoard(tasks);
    b.concurrencyCap = 2;
    assert.equal(inFlightCount(b), 2);

    // T1 completes.
    tasks[0]!.status = "done";
    assert.equal(inFlightCount(b), 1);

    // Scheduler loop fills back to cap.
    while (inFlightCount(b) < b.concurrencyCap) {
      const t = pickEligible(b);
      if (!t) break;
      t.status = "assigned";
    }
    assert.equal(inFlightCount(b), 2);
    // T3 just got picked up (first pending), T4 still waiting.
    assert.equal(tasks[2]!.status, "assigned");
    assert.equal(tasks[3]!.status, "pending");
  });
});

describe("allTerminal", () => {
  function makeTask(id: string, status: Task["status"]): Task {
    return { id, title: id, deps: [], status, attemptCount: 0 };
  }
  function makeBoard(tasks: Task[]): Board {
    return {
      version: 1,
      projectId: "proj_at",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks,
      workers: {},
      concurrencyCap: 1,
    };
  }

  it("returns false for empty board", () => {
    assert.equal(allTerminal(makeBoard([])), false);
  });

  it("returns true when every task is done", () => {
    assert.equal(
      allTerminal(makeBoard([makeTask("T1", "done"), makeTask("T2", "done")])),
      true,
    );
  });

  it("returns true when mix of done and failed", () => {
    assert.equal(
      allTerminal(makeBoard([makeTask("T1", "done"), makeTask("T2", "failed")])),
      true,
    );
  });

  it("returns false when any task is pending/assigned/blocked", () => {
    assert.equal(
      allTerminal(makeBoard([makeTask("T1", "done"), makeTask("T2", "pending")])),
      false,
    );
    assert.equal(
      allTerminal(makeBoard([makeTask("T1", "done"), makeTask("T2", "assigned")])),
      false,
    );
    assert.equal(
      allTerminal(makeBoard([makeTask("T1", "done"), makeTask("T2", "blocked")])),
      false,
    );
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
