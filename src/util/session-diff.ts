// Per-session diff fetcher, behind the `verified_diff` audit.
//
// A worker reports `files_changed` itself, which is a CLAIM. This is the
// evidence: the daemon reconstructs the diff from the session's own
// recorded tool_call edit payloads, so it says what the worker actually
// did rather than what it says it did. Same split as the commits[] a
// worker reports versus its workspace's ahead-count.
//
// Drawn from recorded edits rather than from git, so it reads the same
// for an isolated worker as for one in the shared tree. Deletes are not
// representable in that payload and will not appear (daemon-side limit,
// see cli/PROTOCOL.md under GET /v1/sessions/:id/diff).

import { logger } from "./log.js";

const log = logger("session-diff");

export interface DiffHunk {
  oldText: string;
  newText: string;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  created?: boolean;
}

export function httpBaseFromWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const proto =
      u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return wsUrl;
  }
}

// Parse one entry, or undefined when it does not have the documented
// shape.
function parseFile(raw: unknown): DiffFile | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== "string" || !Array.isArray(f.hunks)) {
    return undefined;
  }
  const hunks: DiffHunk[] = [];
  for (const h of f.hunks) {
    if (h === null || typeof h !== "object" || Array.isArray(h)) {
      return undefined;
    }
    const hh = h as Record<string, unknown>;
    if (typeof hh.oldText !== "string" || typeof hh.newText !== "string") {
      return undefined;
    }
    hunks.push({ oldText: hh.oldText, newText: hh.newText });
  }
  return {
    path: f.path,
    hunks,
    ...(typeof f.created === "boolean" ? { created: f.created } : {}),
  };
}

// GET <daemonHttpBase>/v1/sessions/:id/diff. Returns the per-file diff on
// success, undefined on any failure: 404, network error, older daemon
// without the route, malformed body.
//
// The empty array and undefined are NOT interchangeable and callers rely
// on the difference: `[]` means the session provably edited nothing,
// which is what makes the "claimed files_changed but the diff is empty"
// warning trustworthy, while undefined means we could not tell and no
// conclusion may be drawn. So a body we cannot fully parse returns
// undefined rather than the entries that happened to survive: a
// partially-read diff understates the evidence, and understating it here
// accuses a worker of doing nothing.
//
// `fold=true` collapses sequential rewrites of the same region into their
// net effect, so hunkCount measures what changed rather than how many
// passes it took to get there.
export async function fetchSessionDiff(
  sessionId: string,
  opts: { daemonHttpBase: string; token: string },
): Promise<DiffFile[] | undefined> {
  const url =
    `${opts.daemonHttpBase.replace(/\/+$/, "")}/v1/sessions/` +
    `${encodeURIComponent(sessionId)}/diff?fold=true`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (!res.ok) {
      log.debug(`fetchSessionDiff ${sessionId}: HTTP ${res.status}`);
      return undefined;
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      log.warn(`fetchSessionDiff ${sessionId}: expected an array`);
      return undefined;
    }
    const out: DiffFile[] = [];
    for (const raw of body) {
      const parsed = parseFile(raw);
      if (parsed === undefined) {
        log.warn(`fetchSessionDiff ${sessionId}: malformed entry, discarding the response`);
        return undefined;
      }
      out.push(parsed);
    }
    return out;
  } catch (err) {
    log.debug(`fetchSessionDiff ${sessionId}: ${(err as Error).message}`);
    return undefined;
  }
}

export function summarizeDiff(diff: DiffFile[]): string {
  if (diff.length === 0) {
    return "";
  }
  const first = diff[0]!;
  const head = `${first.path}: ${first.hunks.length} hunk(s)`;
  return diff.length === 1 ? head : `${head} (+${diff.length - 1} more)`;
}
