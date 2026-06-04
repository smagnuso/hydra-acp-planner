// M0 transformer: connect to the daemon, register intercepts covering
// the full surface we'll eventually use, but pass everything through
// untouched. The goal is to validate the wiring — log every prompt,
// response, and lifecycle event the daemon hands us, then return
// `{action: "continue"}` so behavior is unchanged.
//
// Subsequent milestones replace the pass-through handlers with real
// decomposition, scheduling, and result parsing.

import { TransformerClient } from "./acp/transformer.js";
import type { JsonRpcRequest, JsonRpcNotification } from "./acp/protocol.js";
import { logger } from "./util/log.js";

const log = logger("planner");

const INTERCEPTS = [
  "request:session/prompt",
  "response:session/prompt",
  "lifecycle:session.opened",
  "lifecycle:session.idle",
  "lifecycle:session.closed",
];

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
}

export class PlannerBridge {
  private client: TransformerClient;

  constructor(opts: BridgeOptions) {
    this.client = new TransformerClient({
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
      intercepts: INTERCEPTS,
      clientName: "hydra-acp-planner",
    });
    this.client.on("open", () => log.info("transformer registered, intercepts active"));
    this.client.on("close", ({ hadError }) =>
      log.info(`disconnected (hadError=${hadError})`),
    );
    this.client.on("error", (err) => log.error("client error:", err));
    this.client.on("request", (req) => this.handleRequest(req));
    this.client.on("notification", (note) => this.handleNotification(note));
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop?.();
  }

  // The daemon delivers intercepted messages via hydra-acp/transformer/message
  // requests. We must respond with { action: "continue" | "stop" | "processing" }.
  // For M0 we always continue — the transformer is purely observational.
  private handleRequest(req: JsonRpcRequest): void {
    if (req.method === "hydra-acp/transformer/message") {
      const params = (req.params ?? {}) as {
        phase?: string;
        method?: string;
        sessionId?: string;
      };
      log.debug(
        `intercept ${params.phase}:${params.method} session=${params.sessionId?.slice(-8) ?? "?"}`,
      );
      this.client.reply(req.id, { action: "continue" });
      return;
    }
    log.warn(`unexpected request method: ${req.method}`);
    this.client.replyError(req.id, -32601, "Method not found");
  }

  // Lifecycle events come as notifications (no response required).
  private handleNotification(note: JsonRpcNotification): void {
    if (note.method === "hydra-acp/transformer/session_event") {
      const params = (note.params ?? {}) as { event?: string; sessionId?: string };
      log.info(
        `lifecycle ${params.event} session=${params.sessionId?.slice(-8) ?? "?"}`,
      );
      return;
    }
    log.debug(`unhandled notification: ${note.method}`);
  }
}
