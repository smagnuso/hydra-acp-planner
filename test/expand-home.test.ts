import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandHome } from "../src/bridge.ts";

describe("expandHome", () => {
  it("expands ~/ (POSIX regression)", () => {
    assert.equal(expandHome("~/notes/spec.md", "/home/u"), "/home/u/notes/spec.md");
  });

  it("expands ~\\ (Windows)", () => {
    assert.equal(expandHome("~\\notes\\spec.md", "C:\\Users\\u"), "C:\\Users\\u\\notes\\spec.md");
  });

  it("expands a bare ~", () => {
    assert.equal(expandHome("~", "/home/u"), "/home/u");
  });

  it("leaves ~name and non-tilde paths alone", () => {
    assert.equal(expandHome("~foo/x", "/home/u"), "~foo/x");
    assert.equal(expandHome("a/~/b", "/home/u"), "a/~/b");
    assert.equal(expandHome("rel/x.md", "/home/u"), "rel/x.md");
  });
});
