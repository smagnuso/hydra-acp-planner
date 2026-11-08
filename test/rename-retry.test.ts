import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameWithRetry } from "../src/util/rename-retry.ts";
import { newBoard, saveBoard } from "../src/board.ts";
import { boardPath } from "../src/paths.ts";

function errWith(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(failures: string[]) {
  const calls = { rename: 0, sleeps: [] as number[], unlinked: [] as string[] };
  const queue = [...failures];
  return {
    calls,
    deps: {
      rename: () => {
        calls.rename += 1;
        const code = queue.shift();
        if (code !== undefined) {
          throw errWith(code);
        }
      },
      sleep: (ms: number) => {
        calls.sleeps.push(ms);
      },
      unlink: (p: string) => {
        calls.unlinked.push(p);
      },
    },
  };
}

describe("renameWithRetry", () => {
  it("succeeds first time without sleeping", () => {
    const h = harness([]);
    renameWithRetry("a.tmp", "a", h.deps);
    assert.equal(h.calls.rename, 1);
    assert.deepEqual(h.calls.sleeps, []);
    assert.deepEqual(h.calls.unlinked, []);
  });

  it("retries transient EPERM/EBUSY/EACCES with growing delays then succeeds", () => {
    const h = harness(["EPERM", "EBUSY", "EACCES"]);
    renameWithRetry("a.tmp", "a", h.deps);
    assert.equal(h.calls.rename, 4);
    assert.equal(h.calls.sleeps.length, 3);
    assert.ok(h.calls.sleeps[0]! < h.calls.sleeps[1]! && h.calls.sleeps[1]! < h.calls.sleeps[2]!);
    assert.deepEqual(h.calls.unlinked, []);
  });

  it("gives up after 5 attempts, removes tmp, rethrows the original", () => {
    const h = harness(["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
    assert.throws(
      () => renameWithRetry("a.tmp", "a", h.deps),
      (e: NodeJS.ErrnoException) => e.code === "EBUSY",
    );
    assert.equal(h.calls.rename, 5);
    assert.equal(h.calls.sleeps.length, 4);
    assert.deepEqual(h.calls.unlinked, ["a.tmp"]);
  });

  it("does not retry non-retryable codes", () => {
    const h = harness(["ENOENT"]);
    assert.throws(
      () => renameWithRetry("a.tmp", "a", h.deps),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT",
    );
    assert.equal(h.calls.rename, 1);
    assert.deepEqual(h.calls.sleeps, []);
    assert.deepEqual(h.calls.unlinked, ["a.tmp"]);
  });

  it("rethrows the rename error even if tmp cleanup fails", () => {
    const h = harness(["ENOENT"]);
    const deps = {
      ...h.deps,
      unlink: () => {
        throw errWith("ENOENT");
      },
    };
    assert.throws(
      () => renameWithRetry("a.tmp", "a", deps),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT" && e.message === "ENOENT",
    );
  });
});

describe("saveBoard rename retry", () => {
  let originalHome: string | undefined;
  let originalProfile: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    tmpHome = mkdtempSync(join(tmpdir(), "hydra-planner-rr-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalProfile;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("survives transient EPERM/EBUSY on the board rename", () => {
    const b = newBoard({ description: "x" });
    const h = harness(["EPERM", "EBUSY"]);
    const deps = {
      ...h.deps,
      rename: (from: string, to: string) => {
        h.deps.rename();
        renameSync(from, to);
      },
    };
    saveBoard(b, "hydra_session_rr1", deps);
    assert.equal(h.calls.rename, 3);
    const onDisk = JSON.parse(readFileSync(boardPath(b.projectId), "utf8"));
    assert.equal(onDisk.projectId, b.projectId);
  });

  it("rethrows a non-retryable rename error and removes the temp file", () => {
    const b = newBoard({ description: "x" });
    const h = harness(["ENOSPC"]);
    assert.throws(
      () => saveBoard(b, "hydra_session_rr2", h.deps),
      (e: NodeJS.ErrnoException) => e.code === "ENOSPC",
    );
    assert.equal(h.calls.unlinked.length, 1);
    assert.match(h.calls.unlinked[0]!, /board\.json\.tmp\./);
  });
});
