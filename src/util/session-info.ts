// Per-session info fetcher. Hits the daemon's GET /v1/sessions/:id
// endpoint and returns the matching SessionListEntry. Used by the
// planner at board-create time to seed `board.orchestratorAgent` /
// `orchestratorModel` from authoritative daemon state, so the status
// view, plan panel, and board-context preamble can render the
// effective agent/model immediately — without waiting for a fresh
// `session_info_update` to fire reactively.

import { logger } from "./log.js";

const log = logger("session-info");

export interface SessionInfo {
  sessionId: string;
  agentId?: string;
  currentModel?: string;
}

export interface FetchSessionInfoOpts {
  daemonHttpBase: string;
  token: string;
}

// GET <daemonHttpBase>/v1/sessions/:id. Returns the parsed entry on
// success, undefined on any failure — 404, network error, malformed
// JSON. Failure is silent (logged at debug level) because the seed is
// best-effort; the reactive update path will still populate
// orchestratorAgent/Model once the next `session_info_update` arrives.
export async function fetchSessionInfo(
  sessionId: string,
  opts: FetchSessionInfoOpts,
): Promise<SessionInfo | undefined> {
  const url =
    `${opts.daemonHttpBase.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (!res.ok) {
      log.debug(`fetchSessionInfo ${sessionId}: HTTP ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body?.sessionId !== "string") {
      log.warn(`fetchSessionInfo ${sessionId}: malformed response`);
      return undefined;
    }
    const out: SessionInfo = { sessionId: body.sessionId };
    if (typeof body.agentId === "string") out.agentId = body.agentId;
    if (typeof body.currentModel === "string") {
      out.currentModel = body.currentModel;
    }
    return out;
  } catch (err) {
    log.debug(`fetchSessionInfo ${sessionId}: ${(err as Error).message}`);
    return undefined;
  }
}
