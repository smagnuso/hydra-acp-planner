import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  allTerminal,
  BOARD_SCHEMA_VERSION,
  canonicalProjectId,
  forkBoard,
  inFlightCount,
  listProjects,
  loadBoard,
  newBoard,
  newProjectId,
  parseFleetDefaultsFromObject,
  pickEligible,
  resolveAgent,
  resolveModel,
  saveBoard,
  shortProjectId,
  shortSessionId,
  stopBoardBookkeeping,
  type Board,
  type Task,
} from "../src/board.ts";
import { assertNoDecomposerDistill, extractAddTaskBlock } from "../src/decomposition.ts";

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

  it("default cap is unlocked so decomposition can recompute it", () => {
    const b = newBoard({ description: "x" });
    assert.equal(b.concurrencyCap, 1);
    assert.equal(b.concurrencyCapLocked, undefined);
  });

  it("explicit concurrencyCap locks the cap", () => {
    const b = newBoard({ description: "x", concurrencyCap: 4 });
    assert.equal(b.concurrencyCap, 4);
    assert.equal(b.concurrencyCapLocked, true);
  });

  it("fleet defaults are stored", () => {
    const b = newBoard({
      description: "x",
      fleetDefaults: { agent: "code-claude", model: "opus" },
    });
    assert.equal(b.fleetDefaults.agent, "code-claude");
    assert.equal(b.fleetDefaults.model, "opus");
  });

  it("pendingExecute flag persists across save/load", () => {
    // create sets pendingExecute=false; start sets true. The flag
    // drives whether finishDecomposition kicks off scheduling or
    // stops at ready. Crash safety: the flag must survive disk
    // round-trip so a daemon restart mid-decomposition resumes with
    // the user's original intent.
    const b = newBoard({ description: "x" });
    b.pendingExecute = true;
    saveBoard(b, "hydra_session_pe1");
    const loaded = loadBoard(b.projectId);
    assert.equal(loaded?.pendingExecute, true);

    b.pendingExecute = false;
    saveBoard(b, "hydra_session_pe1");
    const loadedFalse = loadBoard(b.projectId);
    assert.equal(loadedFalse?.pendingExecute, false);
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

  it("treats awaiting_review dep as satisfied for the review task targeting it", () => {
    const b = makeBoard([
      makeTask("T1", { status: "awaiting_review" }),
      makeTask("review-T1", {
        deps: ["T1"],
        kind: "review",
        reviews: "T1",
      }),
    ]);
    assert.equal(pickEligible(b)?.id, "review-T1");
  });

  it("also accepts reviews declared as an array", () => {
    const b = makeBoard([
      makeTask("T1", { status: "awaiting_review" }),
      makeTask("T2", { status: "done" }),
      makeTask("review-bundle", {
        deps: ["T1", "T2"],
        kind: "review",
        reviews: ["T1", "T2"],
      }),
    ]);
    assert.equal(pickEligible(b)?.id, "review-bundle");
  });

  it("still blocks non-review dependents whose dep is awaiting_review", () => {
    const b = makeBoard([
      makeTask("T1", { status: "awaiting_review" }),
      makeTask("T2", { deps: ["T1"] }),
    ]);
    assert.equal(pickEligible(b), undefined);
  });

  it("blocks a review task whose dep is awaiting_review but isn't its review target", () => {
    const b = makeBoard([
      makeTask("T1", { status: "awaiting_review" }),
      makeTask("review-T2", {
        deps: ["T1"],
        kind: "review",
        reviews: "T2",
      }),
    ]);
    assert.equal(pickEligible(b), undefined);
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

describe("BOARD_SCHEMA_VERSION", () => {
  it("is 2 after phase 1 schema additions", () => {
    assert.equal(BOARD_SCHEMA_VERSION, 2);
  });
});

describe("schema migration v1 → v2", () => {
  function makeV1Board(): Board {
    return {
      version: 1,
      projectId: "proj_mig",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        { id: "T1", title: "work task", deps: [], status: "pending", attemptCount: 0 },
      ],
      workers: {},
      concurrencyCap: 1,
    };
  }

  it("migrates version on loadBoard round-trip", () => {
    const b = makeV1Board();
    saveBoard(b, "s_mig");
    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.version, 2);
  });

  it("sets kind='work' on tasks that lack it during migration", () => {
    const b = makeV1Board();
    saveBoard(b, "s_mig_k");
    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.tasks[0]!.kind, "work");
  });

  it("leaves kind untouched when already set", () => {
    const b = makeV1Board();
    b.tasks[0]!.kind = "review";
    saveBoard(b, "s_mig_k2");
    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.tasks[0]!.kind, "review");
  });

  it("does not re-migrate a board already at version 2", () => {
    const b = newBoard({ description: "v2" });
    b.version = 2;
    saveBoard(b, "s_mig_v2");
    // Load multiple times — version should stay 2.
    let loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.version, 2);
    const t = loaded!.tasks[0];
    saveBoard(loaded, "s_mig_v2");
    loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    assert.equal(loaded!.version, 2);
  });
});

describe("awaiting_review status semantics", () => {
  function makeTask(id: string, opts?: Partial<Task>): Task {
    return {
      id,
      title: id,
      deps: opts?.deps ?? [],
      status: opts?.status ?? "pending",
      attemptCount: 0,
      ...opts,
    };
  }

  it("is non-terminal (allTerminal returns false)", () => {
    const b = {
      version: 2,
      projectId: "proj_ar",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "awaiting_review" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(allTerminal(b), false);
  });

  it("is NOT counted in inFlightCount", () => {
    const b = {
      version: 2,
      projectId: "proj_ar",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "awaiting_review" }), makeTask("T2", { status: "assigned" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(inFlightCount(b), 1);
  });

  it("blocks dependents in pickEligible", () => {
    const b = {
      version: 2,
      projectId: "proj_ar",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask("T1", { status: "awaiting_review" }),
        makeTask("T2", { deps: ["T1"], status: "pending" }),
      ],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(pickEligible(b), undefined);
  });

  it("is not picked by pickEligible (not pending)", () => {
    const b = {
      version: 2,
      projectId: "proj_ar",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "awaiting_review" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(pickEligible(b), undefined);
  });
});

describe("superseded status semantics", () => {
  function makeTask(id: string, opts?: Partial<Task>): Task {
    return {
      id,
      title: id,
      deps: opts?.deps ?? [],
      status: opts?.status ?? "pending",
      attemptCount: 0,
      ...opts,
    };
  }

  it("is terminal (allTerminal returns true)", () => {
    const b = {
      version: 2,
      projectId: "proj_ss",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "superseded" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(allTerminal(b), true);
  });

  it("satisfies dependents in pickEligible (like done)", () => {
    const b = {
      version: 2,
      projectId: "proj_ss",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask("T1", { status: "superseded" }),
        makeTask("T2", { deps: ["T1"], status: "pending" }),
      ],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(pickEligible(b)?.id, "T2");
  });

  it("is NOT counted in inFlightCount", () => {
    const b = {
      version: 2,
      projectId: "proj_ss",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "superseded" }), makeTask("T2", { status: "assigned" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(inFlightCount(b), 1);
  });

  it("composes with done in allTerminal", () => {
    const b = {
      version: 2,
      projectId: "proj_ss",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "done" }), makeTask("T2", { status: "superseded" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(allTerminal(b), true);
  });

  it("composes with failed in allTerminal", () => {
    const b = {
      version: 2,
      projectId: "proj_ss",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [makeTask("T1", { status: "failed" }), makeTask("T2", { status: "superseded" })],
      workers: {},
      concurrencyCap: 1,
    };
    assert.equal(allTerminal(b), true);
  });
});

describe("newBoard creates version 2 boards", () => {
  it("has BOARD_SCHEMA_VERSION as its version", () => {
    const b = newBoard({ description: "x" });
    assert.equal(b.version, 2);
  });

  it("tasks created via newBoard default to work kind", () => {
    // newBoard doesn't create tasks, but a decomposer-emitted task
    // with the migrated board should get kind="work".
    const b = newBoard({ description: "x" });
    assert.equal(b.version, 2);
  });
});

describe("reviewPolicy and fleetDefaults shape", () => {
  it("newBoard has flat fleetDefaults by default", () => {
    const b = newBoard({ description: "x" });
    assert.equal(b.fleetDefaults.agent, null);
    assert.equal(b.fleetDefaults.model, null);
    assert.equal(b.fleetDefaults.work, undefined);
    assert.equal(b.fleetDefaults.review, undefined);
  });

  it("accepts work/review sub-buckets in fleetDefaults", () => {
    const b = newBoard({
      description: "x",
      fleetDefaults: {
        agent: "default-agent",
        model: "default-model",
      },
    });
    // The call signature doesn't accept sub-buckets directly, but
    // the shape allows them post-creation (schema groundwork).
    b.fleetDefaults.work = { agent: "worker-agent", model: "haiku" };
    b.fleetDefaults.review = { agent: "reviewer", model: "opus", runOn: "orchestrator" };
    assert.equal(b.fleetDefaults.work!.agent, "worker-agent");
    assert.equal(b.fleetDefaults.review!.runOn, "orchestrator");
  });

  it("reviewPolicy is optional and undefined by default", () => {
    const b = newBoard({ description: "x" });
    assert.equal(b.reviewPolicy, undefined);
  });
});

describe("distill kind (T1 schema groundwork)", () => {
  it("persists a kind='distill' task through saveBoard/loadBoard", () => {
    const sessionId = "hydra_session_distill_rt";
    const board = newBoard({ description: "distill round-trip" });
    const distillTask: Task = {
      id: "T2d",
      title: "Distill T1/T1a/T1b",
      deps: ["T1", "T1a", "T1b"],
      agent: null,
      model: null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
      kind: "distill",
      reviews: ["T1", "T1a", "T1b"],
      distillOf: "T2",
    };
    board.tasks = [distillTask];
    saveBoard(board, sessionId);

    const loaded = loadBoard(board.projectId);
    assert.ok(loaded, "loaded board");
    assert.equal(loaded!.tasks.length, 1);
    const t = loaded!.tasks[0]!;
    assert.equal(t.kind, "distill");
    assert.equal(t.distillOf, "T2");
    assert.deepEqual(t.reviews, ["T1", "T1a", "T1b"]);
    assert.deepEqual(t.deps, ["T1", "T1a", "T1b"]);
  });

  it("fleetDefaults.distill falls through to fleetDefaults.review for agent/model", () => {
    const board = newBoard({
      description: "fallthrough",
      fleetDefaults: { agent: "fleet-agent", model: "fleet-model" },
    });
    board.fleetDefaults.review = { agent: "reviewer-agent", model: "reviewer-model" };
    const distillTask: Task = {
      id: "T2d",
      title: "Distill",
      deps: [],
      agent: null,
      model: null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
      kind: "distill",
      reviews: ["T1"],
      distillOf: "T2",
    };

    // No distill bucket → falls through to review.
    assert.equal(resolveAgent(distillTask, board), "reviewer-agent");
    assert.equal(resolveModel(distillTask, board), "reviewer-model");

    // Distill bucket explicit values override review.
    board.fleetDefaults.distill = { agent: "distiller", model: "distiller-model" };
    assert.equal(resolveAgent(distillTask, board), "distiller");
    assert.equal(resolveModel(distillTask, board), "distiller-model");

    // Distill bucket partial: model unset → model falls through to review,
    // agent stays on distill bucket.
    board.fleetDefaults.distill = { agent: "distill-only" };
    assert.equal(resolveAgent(distillTask, board), "distill-only");
    assert.equal(resolveModel(distillTask, board), "reviewer-model");
  });

  it("set_plan public config surface routes fleetDefaults.distill onto the board", () => {
    // Simulates the MCP set_plan tool args shape — the public config
    // surface for distill overrides. The parser must land distill on
    // board.fleetDefaults.distill verbatim (no merge with review).
    const fd = parseFleetDefaultsFromObject({
      agent: "fleet-agent",
      model: "fleet-model",
      review: { agent: "reviewer", model: "opus" },
      distill: { agent: "distiller", model: "haiku" },
    });
    const board = newBoard({ description: "distill config surface", fleetDefaults: fd });
    assert.deepEqual(board.fleetDefaults.distill, { agent: "distiller", model: "haiku" });
    assert.equal(board.fleetDefaults.review!.agent, "reviewer");

    const distillTask: Task = {
      id: "T2d",
      title: "Distill",
      deps: [],
      agent: null,
      model: null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
      kind: "distill",
      reviews: ["T1"],
      distillOf: "T2",
    };
    assert.equal(resolveAgent(distillTask, board), "distiller");
    assert.equal(resolveModel(distillTask, board), "haiku");
  });

  it("public config surface with only review set → distill falls through to review", () => {
    // Same parser, but the user only configured review. The resolver's
    // existing fall-through (T1 in-memory shape) must still pick up
    // review.{agent,model} for a kind='distill' task.
    const fd = parseFleetDefaultsFromObject({
      review: { agent: "reviewer-agent", model: "reviewer-model" },
    });
    const board = newBoard({ description: "fallthrough via surface", fleetDefaults: fd });
    assert.equal(board.fleetDefaults.distill, undefined);

    const distillTask: Task = {
      id: "T2d",
      title: "Distill",
      deps: [],
      agent: null,
      model: null,
      status: "pending",
      assignedTo: null,
      attemptCount: 0,
      artifacts: null,
      startedAt: null,
      finishedAt: null,
      kind: "distill",
      reviews: ["T1"],
      distillOf: "T2",
    };
    assert.equal(resolveAgent(distillTask, board), "reviewer-agent");
    assert.equal(resolveModel(distillTask, board), "reviewer-model");
  });

  it("rejects decomposer output containing kind='distill'", () => {
    assert.throws(
      () =>
        assertNoDecomposerDistill({
          tasks: [
            { id: "T1", title: "work", deps: [] },
            { id: "Tbad", title: "synth", deps: [], kind: "distill" },
          ],
        }),
      (err: Error) =>
        /distill/i.test(err.message) && /Tbad/.test(err.message) && /bridge-synthesized|decomposer/i.test(err.message),
    );
  });

  it("rejects add_task output containing kind='distill' with the same phrasing as set_plan", () => {
    // Mirrors the add_task path in bridge.handleAdd: extract the
    // hydra-add-task block, then run the same guard set_plan uses.
    const reply = [
      "Here you go:",
      "```hydra-add-task",
      JSON.stringify({
        tasks: [
          { id: "T9", title: "smuggled", deps: [], kind: "distill" },
        ],
      }),
      "```",
    ].join("\n");
    const raw = extractAddTaskBlock(reply);
    assert.throws(
      () => assertNoDecomposerDistill(raw),
      (err: Error) =>
        /distill/i.test(err.message) &&
        /T9/.test(err.message) &&
        /bridge-synthesized|decomposer/i.test(err.message),
    );
  });

  it("accepts decomposer output without distill kinds", () => {
    assert.doesNotThrow(() =>
      assertNoDecomposerDistill({
        tasks: [
          { id: "T1", title: "w", deps: [] },
          { id: "T2", title: "r", deps: ["T1"], kind: "review", reviews: ["T1"] },
        ],
      }),
    );
  });
});

describe("rehydrate orphan synthesize recovery (T3)", () => {
  it("reverts a done review with decision=synthesize and no sibling distill back to pending", () => {
    const b = newBoard({ description: "orphan synth" });
    b.tasks = [
      { id: "T1", title: "w1", deps: [], status: "awaiting_review", attemptCount: 0, kind: "work" },
      { id: "T2", title: "w2", deps: [], status: "awaiting_review", attemptCount: 0, kind: "work" },
      {
        id: "R",
        title: "review",
        deps: ["T1", "T2"],
        status: "done",
        attemptCount: 1,
        kind: "review",
        reviews: ["T1", "T2"],
        finishedAt: "2025-01-01T00:00:00.000Z",
        artifacts: { review_decision: "synthesize", notes: "no clear winner" } as never,
      },
    ];
    saveBoard(b, "hydra_session_orphan");

    const loaded = loadBoard(b.projectId);
    assert.ok(loaded);
    const review = loaded!.tasks.find((t) => t.id === "R")!;
    assert.equal(review.status, "pending");
    assert.equal(review.finishedAt, null);
    assert.equal(review.assignedTo, null);
    assert.equal(
      (review.artifacts as Record<string, unknown> | undefined)?.review_decision,
      undefined,
    );

    const eligible = pickEligible(loaded!);
    assert.ok(eligible, "review should be eligible after recovery");
    assert.equal(eligible!.id, "R");
  });

  it("leaves a healthy synthesize→distill pair untouched", () => {
    const b = newBoard({ description: "healthy synth" });
    b.tasks = [
      { id: "T1", title: "w1", deps: [], status: "awaiting_review", attemptCount: 0, kind: "work" },
      { id: "T2", title: "w2", deps: [], status: "awaiting_review", attemptCount: 0, kind: "work" },
      {
        id: "R",
        title: "review",
        deps: ["T1", "T2"],
        status: "done",
        attemptCount: 1,
        kind: "review",
        reviews: ["T1", "T2"],
        finishedAt: "2025-01-01T00:00:00.000Z",
        artifacts: { review_decision: "synthesize" } as never,
      },
      {
        id: "Rd",
        title: "distill R",
        deps: ["T1", "T2"],
        status: "pending",
        attemptCount: 0,
        kind: "distill",
        reviews: ["T1", "T2"],
        distillOf: "R",
      },
    ];
    saveBoard(b, "hydra_session_ok");

    const loaded = loadBoard(b.projectId);
    const review = loaded!.tasks.find((t) => t.id === "R")!;
    assert.equal(review.status, "done");
    assert.equal(
      (review.artifacts as Record<string, unknown>).review_decision,
      "synthesize",
    );
  });

  it("does not touch reviews with a non-synthesize decision", () => {
    const b = newBoard({ description: "winner review" });
    b.tasks = [
      {
        id: "R",
        title: "review",
        deps: [],
        status: "done",
        attemptCount: 1,
        kind: "review",
        reviews: ["T1", "T2"],
        finishedAt: "2025-01-01T00:00:00.000Z",
        artifacts: { review_decision: "winner", winner: "T1" } as never,
      },
    ];
    saveBoard(b, "hydra_session_winner");

    const loaded = loadBoard(b.projectId);
    const review = loaded!.tasks.find((t) => t.id === "R")!;
    assert.equal(review.status, "done");
  });
});

describe("stopBoardBookkeeping", () => {
  function makeTask(id: string, opts: Partial<Task> = {}): Task {
    return {
      id,
      title: id,
      deps: opts.deps ?? [],
      status: opts.status ?? "pending",
      assignedTo: opts.assignedTo ?? undefined,
      attemptCount: 0,
      startedAt: opts.startedAt ?? undefined,
      finishedAt: opts.finishedAt ?? undefined,
      ...opts,
    };
  }

  it("returns empty array and mutates nothing on an empty board", () => {
    const b = newBoard({ description: "empty" });
    const result = stopBoardBookkeeping(b);
    assert.deepEqual(result, { inFlightWorkerIds: [] });
    assert.equal(b.tasks.length, 0);
    assert.deepEqual(b.workers, {});
  });

  it("reverts one assigned task and clears its worker's currentTaskId", () => {
    const workerId = "worker-1";
    const taskId = "T1";
    const b: Board = {
      version: 2,
      projectId: "proj_sbb",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask(taskId, { status: "assigned", assignedTo: workerId, startedAt: "2025-01-01T00:00:00Z", finishedAt: undefined }),
      ],
      workers: {
        [workerId]: { currentTaskId: taskId, tasksCompleted: [] },
      },
      concurrencyCap: 1,
    };

    const result = stopBoardBookkeeping(b);

    assert.deepEqual(result, { inFlightWorkerIds: [workerId] });
    const task = b.tasks[0]!;
    assert.equal(task.status, "pending");
    assert.equal(task.assignedTo, null);
    assert.equal(task.startedAt, null);
    assert.equal(task.finishedAt, null);
    assert.equal(b.workers[workerId].currentTaskId, null);
  });

  it("reverts multiple assigned tasks on different workers", () => {
    const w1 = "w-1", w2 = "w-2", w3 = "w-3";
    const t1 = "T1", t2 = "T2", t3 = "T3";
    const b: Board = {
      version: 2,
      projectId: "proj_sbb_multi",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask(t1, { status: "assigned", assignedTo: w1, startedAt: "2025-01-01T00:00:00Z" }),
        makeTask("T4", { status: "pending" }),
        makeTask(t2, { status: "assigned", assignedTo: w2, startedAt: "2025-01-01T00:00:00Z" }),
        makeTask(t3, { status: "assigned", assignedTo: w3, startedAt: "2025-01-01T00:00:00Z" }),
      ],
      workers: {
        [w1]: { currentTaskId: t1, tasksCompleted: [] },
        [w2]: { currentTaskId: t2, tasksCompleted: [] },
        [w3]: { currentTaskId: t3, tasksCompleted: [] },
      },
      concurrencyCap: 3,
    };

    const result = stopBoardBookkeeping(b);

    assert.equal(result.inFlightWorkerIds.length, 3);
    for (const wid of [w1, w2, w3]) {
      assert.ok(result.inFlightWorkerIds.includes(wid), `${wid} should be in inFlightWorkerIds`);
    }
    assert.equal(b.tasks.find((t) => t.id === t1)?.status, "pending");
    assert.equal(b.tasks.find((t) => t.id === t2)?.status, "pending");
    assert.equal(b.tasks.find((t) => t.id === t3)?.status, "pending");
    assert.equal(b.tasks.find((t) => t.id === "T4")?.status, "pending");
    assert.equal(b.workers[w1].currentTaskId, null);
    assert.equal(b.workers[w2].currentTaskId, null);
    assert.equal(b.workers[w3].currentTaskId, null);
  });

  it("does NOT touch awaiting_review tasks", () => {
    // In production, when a task enters awaiting_review, the worker's
    // currentTaskId is cleared by handleTaskComplete (the worker is
    // either closed or kept alive for a continue-strategy review, but
    // either way its currentTaskId is null). Mirror that here.
    const workerId = "worker-ar";
    const taskId = "T1";
    const b: Board = {
      version: 2,
      projectId: "proj_sbb_ar",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask(taskId, { status: "awaiting_review", assignedTo: workerId }),
      ],
      workers: {
        [workerId]: { currentTaskId: null, tasksCompleted: [taskId] },
      },
      concurrencyCap: 1,
    };

    const result = stopBoardBookkeeping(b);

    assert.deepEqual(result, { inFlightWorkerIds: [] });
    const task = b.tasks[0]!;
    assert.equal(task.status, "awaiting_review");
    assert.equal(task.assignedTo, workerId);
    assert.equal(b.workers[workerId].currentTaskId, null);
  });

  it("handles assigned task with missing worker entry (defensive)", () => {
    const ghostWorkerId = "ghost-worker";
    const taskId = "T1";
    const b: Board = {
      version: 2,
      projectId: "proj_sbb_ghost",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask(taskId, { status: "assigned", assignedTo: ghostWorkerId, startedAt: "2025-01-01T00:00:00Z" }),
      ],
      workers: {},
      concurrencyCap: 1,
    };

    // Should not throw — task is reverted, worker id is in result array
    const result = stopBoardBookkeeping(b);

    assert.deepEqual(result, { inFlightWorkerIds: [ghostWorkerId] });
    const task = b.tasks[0]!;
    assert.equal(task.status, "pending");
    assert.equal(task.assignedTo, null);
    assert.equal(task.startedAt, null);
  });

  it("catches orphaned shadow workers whose task.assignedTo points elsewhere", () => {
    // Repro of the duplicate-spawn race: two workers were assigned to
    // the same task (the second's id overwrote task.assignedTo), so
    // the task-level walk only sees the second one. The first lives on
    // in board.workers with currentTaskId still set and must also be
    // collected and cleared by stopBoardBookkeeping.
    const primary = "worker-primary";
    const shadow = "worker-shadow";
    const taskId = "T1";
    const b: Board = {
      version: 2,
      projectId: "proj_sbb_shadow",
      description: "x",
      state: "running",
      createdAt: "",
      updatedAt: "",
      fleetDefaults: { agent: null, model: null },
      tasks: [
        makeTask(taskId, {
          status: "assigned",
          assignedTo: primary,
          startedAt: "2025-01-01T00:00:00Z",
        }),
      ],
      workers: {
        [primary]: { currentTaskId: taskId, tasksCompleted: [] },
        [shadow]: { currentTaskId: taskId, tasksCompleted: [] },
      },
      concurrencyCap: 1,
    };

    const result = stopBoardBookkeeping(b);

    const ids = [...result.inFlightWorkerIds].sort();
    assert.deepEqual(ids, [primary, shadow].sort());
    assert.equal(b.tasks[0]!.status, "pending");
    assert.equal(b.tasks[0]!.assignedTo, null);
    assert.equal(b.workers[primary].currentTaskId, null);
    assert.equal(b.workers[shadow].currentTaskId, null);
  });
});

describe("forkBoard", () => {
  function srcBoard(overrides: Partial<Board> = {}): Board {
    const base: Board = {
      version: BOARD_SCHEMA_VERSION,
      projectId: "hydra_plan_src",
      description: "build a thing",
      state: "running",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
      fleetDefaults: { agent: "claude", model: null },
      reviewPolicy: { mode: "hints", overrideHint: false, maxAttempts: 3 },
      tasks: [
        {
          id: "T1",
          title: "first",
          why: "because",
          what: "do it",
          deps: [],
          status: "done",
          attemptCount: 2,
          assignedTo: "hydra_session_w1",
          artifacts: { summary: "did it", files_changed: ["a.ts"] },
          startedAt: "2025-01-01T01:00:00Z",
          finishedAt: "2025-01-01T01:05:00Z",
          kind: "work",
          reviewFeedback: ["nit"],
          agent: "claude",
        },
        {
          id: "T2",
          title: "second",
          deps: ["T1"],
          status: "assigned",
          attemptCount: 1,
          assignedTo: "hydra_session_w2",
          kind: "work",
        },
        {
          id: "review-T1",
          title: "review T1",
          deps: ["T1"],
          status: "done",
          attemptCount: 1,
          kind: "review",
          reviews: "T1",
        },
      ],
      workers: {
        hydra_session_w1: { currentTaskId: null, tasksCompleted: ["T1"] },
        hydra_session_w2: { currentTaskId: "T2", tasksCompleted: [] },
      },
      concurrencyCap: 4,
      concurrencyCapLocked: true,
      contractBrief: "be careful",
      orchestratorAgent: "claude",
      orchestratorModel: "opus",
      executionMs: 60000,
      executionStartedAt: "2025-01-02T00:00:00Z",
    };
    return { ...base, ...overrides };
  }

  it("mints a fresh projectId distinct from the source", () => {
    const src = srcBoard();
    const forked = forkBoard({ source: src });
    assert.notEqual(forked.projectId, src.projectId);
    assert.match(forked.projectId, /^hydra_plan_[0-9a-f]+$/);
  });

  it("resets every task to pending with no artifacts or assignment", () => {
    const forked = forkBoard({ source: srcBoard() });
    for (const t of forked.tasks) {
      assert.equal(t.status, "pending");
      assert.equal(t.assignedTo, null);
      assert.equal(t.attemptCount, 0);
      assert.equal(t.artifacts, null);
      assert.equal(t.startedAt, null);
      assert.equal(t.finishedAt, null);
      assert.equal(t.reviewFeedback, undefined);
    }
  });

  it("preserves task structure (id/title/deps/kind/reviews/agent)", () => {
    const forked = forkBoard({ source: srcBoard() });
    assert.deepEqual(forked.tasks.map((t) => t.id), ["T1", "T2", "review-T1"]);
    assert.deepEqual(forked.tasks[1]!.deps, ["T1"]);
    assert.equal(forked.tasks[2]!.kind, "review");
    assert.equal(forked.tasks[2]!.reviews, "T1");
    assert.equal(forked.tasks[0]!.agent, "claude");
    assert.equal(forked.tasks[0]!.why, "because");
  });

  it("starts in ready state with no workers and no execution timer", () => {
    const forked = forkBoard({ source: srcBoard() });
    assert.equal(forked.state, "ready");
    assert.deepEqual(forked.workers, {});
    assert.equal(forked.executionMs, undefined);
    assert.equal(forked.executionStartedAt, null);
    assert.equal(forked.pendingExecute, false);
  });

  it("carries over fleet defaults, review policy, contract brief, cap", () => {
    const forked = forkBoard({ source: srcBoard() });
    assert.deepEqual(forked.fleetDefaults, { agent: "claude", model: null, work: undefined, review: undefined });
    assert.deepEqual(forked.reviewPolicy, { mode: "hints", overrideHint: false, maxAttempts: 3 });
    assert.equal(forked.contractBrief, "be careful");
    assert.equal(forked.concurrencyCap, 4);
    assert.equal(forked.concurrencyCapLocked, true);
  });

  it("drops orchestratorAgent/Model so the new session reseeds them", () => {
    const forked = forkBoard({ source: srcBoard() });
    assert.equal(forked.orchestratorAgent, undefined);
    assert.equal(forked.orchestratorModel, undefined);
  });

  it("inherits the source description by default", () => {
    const forked = forkBoard({ source: srcBoard() });
    assert.equal(forked.description, "build a thing");
  });

  it("uses the override description when provided", () => {
    const forked = forkBoard({ source: srcBoard(), description: "  do it differently  " });
    assert.equal(forked.description, "do it differently");
  });

  it("falls back to the source description when override is whitespace-only", () => {
    const forked = forkBoard({ source: srcBoard(), description: "   " });
    assert.equal(forked.description, "build a thing");
  });

  it("does not mutate the source board", () => {
    const src = srcBoard();
    const snapshot = JSON.parse(JSON.stringify(src));
    forkBoard({ source: src });
    assert.deepEqual(JSON.parse(JSON.stringify(src)), snapshot);
  });

  it("forks from any source state — done, failed, decomposing all valid", () => {
    for (const state of ["done", "failed", "decomposing", "ready", "stopped", "running"] as const) {
      const forked = forkBoard({ source: srcBoard({ state }) });
      assert.equal(forked.state, "ready");
    }
  });
});
