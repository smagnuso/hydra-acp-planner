import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMergeReply,
  classifyDiscardReply,
  classifyWorkspaceStatusReply,
} from "../src/bridge.ts";

// Unit tests for classifyMergeReply against the exact, hardcoded reply
// prefixes the daemon emits for `/hydra workspace merge`:
//   - success: `Merged ${branch} into ${source}...`
//     (cli/src/core/session-manager.ts's mergeWorkspaceIntoSource)
//   - failure: `Workspace merge failed: ${message}`
//     (cli/src/core/session.ts's runWorkspaceCommand catch block)
// These strings are written for a human, not a wire contract, so this
// test exists to catch drift if the daemon's literal prefixes ever
// change — a silent mismatch would make every merge attempt read as
// "unknown" (safe but noisy) or, worse, a coincidental prefix match
// could misclassify a failure as a success.

describe("classifyMergeReply", () => {
  it("classifies a successful merge as landed, keeping the full reply as detail", () => {
    const reply = "Merged hydra/T3 into ~/repo";
    const result = classifyMergeReply(reply);
    assert.equal(result.status, "landed");
    assert.equal(result.detail, reply);
    assert.ok(result.at);
  });

  it("does NOT classify as landed when a WARNING is appended after the Merged line", () => {
    // This asserted the opposite until it was understood what those
    // warnings mean. The daemon head-lines `Merged …` even when the
    // replay of the workspace's uncommitted work failed — and since an
    // agent that never commits has nothing BUT uncommitted work, that
    // reply can mean the entire payload was lost. Reporting `landed`
    // there is a false positive on total loss, which is strictly worse
    // than an unconfirmed result the user is told to go check.
    const reply =
      "Merged hydra/T3 into ~/repo\n  WARNING: the workspace's uncommitted changes could not be replayed; they remain reachable from hydra/T3.";
    const result = classifyMergeReply(reply);
    assert.equal(result.status, "unknown");
    assert.equal(result.detail, reply, "the warning text must survive into the finding");
  });

  it("does not classify as landed when the user's own work was displaced", () => {
    const reply =
      "Merged hydra/T3 into ~/repo\n  WARNING: this workspace started clean, so your uncommitted work was never copied in; it is preserved at refs/hydra/landing/abc.";
    assert.equal(classifyMergeReply(reply).status, "unknown");
  });

  it("still classifies a clean Merged reply as landed", () => {
    const reply = "Merged hydra/T3 into ~/repo; still working in ~/.hydra-acp/workspaces/ab/T3.";
    assert.equal(classifyMergeReply(reply).status, "landed");
  });

  it("classifies a failed merge as declined, stripping the daemon's fixed prefix from detail", () => {
    const reply = "Workspace merge failed: not a fast-forward; run /hydra workspace sync first";
    const result = classifyMergeReply(reply);
    assert.equal(result.status, "declined");
    assert.equal(result.detail, "not a fast-forward; run /hydra workspace sync first");
  });

  it("classifies an unrecognized reply as unknown, never as landed", () => {
    const result = classifyMergeReply("Workspaces are not available on this session (no workspace hook configured).");
    assert.equal(result.status, "unknown");
  });

  it("classifies garbled/empty text as unknown", () => {
    assert.equal(classifyMergeReply("").status, "unknown");
    assert.equal(classifyMergeReply("   ").status, "unknown");
    assert.equal(classifyMergeReply("some unrelated agent output").status, "unknown");
  });

  it("classifies no reply (timeout/send failure) as unknown with a distinct detail", () => {
    const result = classifyMergeReply(undefined);
    assert.equal(result.status, "unknown");
    assert.equal(result.detail, "no reply received");
  });

  it("never classifies a reply that merely mentions 'merged' mid-sentence as landed", () => {
    // Only an exact `Merged ` prefix counts — anything else is a false
    // positive risk this function deliberately refuses to take.
    const result = classifyMergeReply("The worker merged some files earlier in the turn.");
    assert.equal(result.status, "unknown");
  });
});

describe("classifyDiscardReply", () => {
  it("classifies a successful discard as ok, keeping the full reply as detail", () => {
    const reply = "Discarded ~/.hydra-acp/workspaces/abc/T2 and its branch hydra/T2";
    const result = classifyDiscardReply(reply);
    assert.equal(result.ok, true);
    assert.equal(result.detail, reply);
  });

  it("classifies a failed discard as not ok, stripping the daemon's fixed prefix from detail", () => {
    const result = classifyDiscardReply("Workspace discard failed: workspace is shared with another session");
    assert.equal(result.ok, false);
    assert.equal(result.detail, "workspace is shared with another session");
  });

  it("classifies an unrecognized reply or no reply as not ok", () => {
    assert.equal(classifyDiscardReply("some unrelated text").ok, false);
    assert.equal(classifyDiscardReply(undefined).ok, false);
    assert.equal(classifyDiscardReply(undefined).detail, "no reply received");
  });
});

describe("classifyWorkspaceStatusReply", () => {
  it("reads a clean workspace as committed", () => {
    const reply = [
      "In workspace feature-x (git) at ~/.hydra-acp/workspaces/ab/feature-x",
      "  no uncommitted changes",
      "Use `/hydra workspace stop` to merge and return.",
    ].join("\n");
    assert.equal(classifyWorkspaceStatusReply(reply), "committed");
  });

  it("reads staged/unstaged/untracked counts as uncommitted", () => {
    for (const line of ["  2 staged, 1 unstaged:", "  3 untracked:", "  1 unstaged:"]) {
      const reply = `In workspace T1 (git)\n${line}\n    M src/a.ts`;
      assert.equal(classifyWorkspaceStatusReply(reply), "uncommitted", line);
    }
  });

  it("reads a failed probe as unknown, NOT as committed", () => {
    // The provider prints neither line when its git query fails, on the
    // grounds that wrongly reporting a clean tree is what makes somebody
    // discard work. Absence must therefore never read as clean.
    const reply = "In workspace T1 (git) at ~/ws/T1\nUse `/hydra workspace stop` to merge and return.";
    assert.equal(classifyWorkspaceStatusReply(reply), "unknown");
  });

  it("reads no reply at all as unknown", () => {
    assert.equal(classifyWorkspaceStatusReply(undefined), "unknown");
  });
});
