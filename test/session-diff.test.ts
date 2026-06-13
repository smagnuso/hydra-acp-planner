import { test } from "node:test";
import assert from "node:assert/strict";
import { httpBaseFromWsUrl } from "../src/util/session-diff.ts";

test("httpBaseFromWsUrl strips /acp path (the actual broken case)", () => {
  assert.equal(httpBaseFromWsUrl("ws://127.0.0.1:55514/acp"), "http://127.0.0.1:55514");
});

test("httpBaseFromWsUrl handles ws:// with no path", () => {
  assert.equal(httpBaseFromWsUrl("ws://host:55514"), "http://host:55514");
});

test("httpBaseFromWsUrl maps wss:// to https://", () => {
  assert.equal(httpBaseFromWsUrl("wss://host:55514/acp"), "https://host:55514");
});

test("httpBaseFromWsUrl strips multi-segment path", () => {
  assert.equal(
    httpBaseFromWsUrl("ws://host:55514/some/longer/path"),
    "http://host:55514",
  );
});

test("httpBaseFromWsUrl strips query string", () => {
  assert.equal(
    httpBaseFromWsUrl("ws://host:55514/acp?token=foo"),
    "http://host:55514",
  );
});

test("httpBaseFromWsUrl falls back to input on invalid URL", () => {
  assert.equal(httpBaseFromWsUrl("not-a-url"), "not-a-url");
});
