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
  // Set iff this session was locally forked (via /btw or
  // POST /v1/sessions/:id/fork). Lets the planner answer get_plan
  // / get_status on a forked session by walking up to the owning
  // session's board. See SessionListEntry in cli/PROTOCOL.md.
  forkedFromSessionId?: string;
  // Set iff this session was spawned as a transformer child.
  parentSessionId?: string;
  // Effective interactive tristate from the daemon's GET
  // /v1/sessions/:id (computed via effectiveInteractive). undefined
  // means the session has not been promoted (no non-ancillary prompt
  // yet) or the value is unknown. Consumers MUST fail-closed on
  // undefined when using this to gate mutations.
  interactive?: boolean;
  // Where the session's agent actually runs. For an ISOLATED session
  // this is the workspace path, not the project — use
  // `integrationTreeOf` rather than reading it directly.
  cwd?: string;
  // Present iff the session runs in an isolated workspace. `sourceCwd`
  // is the load-bearing field: a workspace lives outside its source tree
  // and shares no path prefix with it, so this recorded edge is the only
  // way back.
  workspace?: {
    path: string;
    sourceCwd: string;
    label: string;
    provider: string;
  };
}

// The tree a session's work ultimately belongs to: its own cwd normally,
// or the tree its workspace derives from when it is isolated. This is the
// daemon's own documented rule for reading an isolated session's location
// (`workspace.sourceCwd ?? cwd`), and it is what makes a plan run under an
// isolated orchestrator land back into that orchestrator's workspace
// rather than into the user's checkout.
export function integrationTreeOf(info: SessionInfo): string | undefined {
  return info.workspace?.sourceCwd ?? info.cwd;
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
    if (typeof body.forkedFromSessionId === "string") {
      out.forkedFromSessionId = body.forkedFromSessionId;
    }
    if (typeof body.parentSessionId === "string") {
      out.parentSessionId = body.parentSessionId;
    }
    if (typeof body.interactive === "boolean") {
      out.interactive = body.interactive;
    }
    if (typeof body.cwd === "string") {
      out.cwd = body.cwd;
    }
    // Field-by-field, like the daemon parses its own meta: a malformed
    // block must read as "not isolated" rather than reaching the planner
    // as junk that later resolves to a bogus integration tree.
    const ws = body.workspace;
    if (ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
      const w = ws as Record<string, unknown>;
      if (
        typeof w.path === "string" &&
        typeof w.sourceCwd === "string" &&
        typeof w.label === "string" &&
        typeof w.provider === "string"
      ) {
        out.workspace = {
          path: w.path,
          sourceCwd: w.sourceCwd,
          label: w.label,
          provider: w.provider,
        };
      }
    }
    return out;
  } catch (err) {
    log.debug(`fetchSessionInfo ${sessionId}: ${(err as Error).message}`);
    return undefined;
  }
}
