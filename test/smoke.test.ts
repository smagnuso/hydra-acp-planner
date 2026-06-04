import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const bin = resolve(here, "..", "dist", "index.js");

// Minimal smoke tests against the built binary. These verify CLI mode
// works end-to-end — argv parsing, version readback, describe line.
// Transformer-mode behavior is exercised against a live daemon and is
// out of scope for unit tests.

describe("hydra-acp-planner CLI", () => {
  it("--version prints a version line", () => {
    const r = spawnSync("node", [bin, "--version"], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^hydra-acp-planner \S+\n$/);
  });

  it("--describe prints a one-line summary", () => {
    const r = spawnSync("node", [bin, "--describe"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\S/);
    assert.equal(r.stdout.split("\n").filter((l) => l.length > 0).length, 1);
  });

  it("--help prints usage and includes the planner name", () => {
    const r = spawnSync("node", [bin, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hydra-acp-planner/);
    assert.match(r.stdout, /Usage:/);
  });

  it("no args defaults to list (exit 0)", () => {
    // Empty $HOME so we don't read the developer's real boards.
    const r = spawnSync("node", [bin], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/tmp/planner-test-empty-home-do-not-create" },
    });
    assert.equal(r.status, 0);
    // With no projects, list shows the hint message.
    assert.match(r.stdout, /No planner projects yet/);
  });

  it("unknown subcommand exits 2", () => {
    const r = spawnSync("node", [bin, "bogus"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown subcommand: bogus/);
  });

  it("placeholder subcommand exits 2 with a useful message", () => {
    const r = spawnSync("node", [bin, "archive"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not implemented yet/);
  });
});
