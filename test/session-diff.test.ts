import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchSessionDiff, httpBaseFromWsUrl } from "../src/util/session-diff.ts";

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


interface Seen {
  url?: string;
  auth?: string;
}

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (base: string, seen: Seen) => Promise<void>,
): Promise<void> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    seen.url = req.url;
    seen.auth = req.headers.authorization;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// The fetch tests run against a real HTTP server rather than a stubbed
// global fetch: the thing most likely to break here is the URL and header
// shape, and a stub that answers whatever it is asked cannot catch a
// wrong one.
test("fetchSessionDiff parses the documented shape and asks for a folded diff", async () => {
  await withServer(
    (_req, res) =>
      json(res, 200, [
        { path: "src/a.ts", created: true, hunks: [{ oldText: "", newText: "x\n" }] },
        {
          path: "src/b.ts",
          created: false,
          hunks: [
            { oldText: "one\n", newText: "two\n" },
            { oldText: "three\n", newText: "four\n" },
          ],
        },
      ]),
    async (base, seen) => {
      const diff = await fetchSessionDiff("hydra_session_abc", {
        daemonHttpBase: base,
        token: "tok",
      });
      assert.equal(diff?.length, 2);
      assert.equal(diff?.[0]?.path, "src/a.ts");
      assert.equal(diff?.[0]?.created, true);
      assert.deepEqual(diff?.[0]?.hunks, [{ oldText: "", newText: "x\n" }]);
      assert.equal(diff?.[1]?.hunks.length, 2);
      assert.equal(seen.url, "/v1/sessions/hydra_session_abc/diff?fold=true");
      assert.equal(seen.auth, "Bearer tok");
    },
  );
});

test("fetchSessionDiff returns [] for a session that provably edited nothing", async () => {
  // Distinct from undefined, and the audit's no-op warning depends on
  // the difference.
  await withServer(
    (_req, res) => json(res, 200, []),
    async (base) => {
      const diff = await fetchSessionDiff("s", { daemonHttpBase: base, token: "t" });
      assert.deepEqual(diff, []);
    },
  );
});

test("fetchSessionDiff returns undefined on a non-200", async () => {
  await withServer(
    (_req, res) => json(res, 404, { error: "no such session" }),
    async (base) => {
      const diff = await fetchSessionDiff("s", { daemonHttpBase: base, token: "t" });
      assert.equal(diff, undefined);
    },
  );
});

test("fetchSessionDiff returns undefined when the body is not an array", async () => {
  await withServer(
    (_req, res) => json(res, 200, { files: [] }),
    async (base) => {
      const diff = await fetchSessionDiff("s", { daemonHttpBase: base, token: "t" });
      assert.equal(diff, undefined);
    },
  );
});

test("fetchSessionDiff discards the whole response when one entry is malformed", async () => {
  // Not the one good entry: a partially-read diff understates what the
  // worker did, and understating it is what makes the audit accuse a
  // worker of changing nothing.
  await withServer(
    (_req, res) =>
      json(res, 200, [
        { path: "src/a.ts", hunks: [{ oldText: "", newText: "x\n" }] },
        { path: "src/b.ts", hunks: [{ oldText: 7, newText: "y\n" }] },
      ]),
    async (base) => {
      const diff = await fetchSessionDiff("s", { daemonHttpBase: base, token: "t" });
      assert.equal(diff, undefined);
    },
  );
});

test("fetchSessionDiff returns undefined when the daemon is unreachable", async () => {
  const diff = await fetchSessionDiff("s", {
    daemonHttpBase: "http://127.0.0.1:1",
    token: "t",
  });
  assert.equal(diff, undefined);
});

test("fetchSessionDiff tolerates a trailing slash on the base", async () => {
  await withServer(
    (_req, res) => json(res, 200, []),
    async (base, seen) => {
      await fetchSessionDiff("s", { daemonHttpBase: `${base}/`, token: "t" });
      assert.equal(seen.url, "/v1/sessions/s/diff?fold=true");
    },
  );
});
