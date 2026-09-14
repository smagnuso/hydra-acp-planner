import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyMergeReply } from "../src/bridge.ts";

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

  it("still classifies as landed when warnings are appended after the Merged line", () => {
    const reply = "Merged hydra/T3 into ~/repo\n  WARNING: nested tree sub was NOT reconciled: conflict.";
    const result = classifyMergeReply(reply);
    assert.equal(result.status, "landed");
    assert.equal(result.detail, reply);
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
