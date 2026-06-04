import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { logger } from "../util/log.js";
import {
  ACP_PROTOCOL_VERSION,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isNotification,
  isRequest,
  isResponse,
} from "./protocol.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const log = logger("acp");

export interface TransformerClientOptions {
  daemonWsUrl: string;
  token: string;
  // Set of `<phase>:<method>` intercepts and `lifecycle:<event>` events
  // the transformer wants. Sent in hydra-acp/transformer/initialize.
  intercepts: string[];
  // Identifies this process to the daemon during `initialize`. Used for
  // log messages and (if the daemon ever surfaces it) attribution.
  clientName: string;
}

export interface TransformerClientEvents {
  open: [];
  close: [{ hadError: boolean }];
  error: [Error];
  request: [JsonRpcRequest];
  notification: [JsonRpcNotification];
  response: [JsonRpcResponse];
}

interface PendingRequest {
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
}

// One WebSocket to the daemon for the entire transformer process. Unlike
// the notifier's AcpAttach (one WS per session), the daemon multiplexes
// every session's hydra-acp/transformer/message + hydra-acp/transformer/session_event over
// this single connection, keyed by sessionId in the params.
export class TransformerClient extends EventEmitter<TransformerClientEvents> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;

  constructor(private readonly opts: TransformerClientOptions) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    log.debug(`connecting ${this.opts.daemonWsUrl}`);
    const subprotocols = ["acp.v1", `hydra-acp-token.${this.opts.token}`];
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.daemonWsUrl, subprotocols);
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      log.info(`ws open`);
      void this.handshake()
        .then(() => {
          this.emit("open");
        })
        .catch((err: unknown) => {
          this.emit("error", err as Error);
          try {
            this.ws?.close();
          } catch {
            void 0;
          }
        });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = data.toString("utf8");
      try {
        const parsed = JSON.parse(text) as JsonRpcMessage;
        this.onMessage(parsed);
      } catch (err) {
        log.warn(
          `parse error: ${(err as Error).message}; raw=${text.slice(0, 200)}`,
        );
      }
    });

    ws.on("error", (err) => {
      log.warn(`ws error: ${err.message}`);
      this.emit("error", err);
    });

    ws.on("close", (code, reason) => {
      const hadError = code >= 4000 || code === 1006 || code === 1011;
      const reasonText = reason.toString("utf8");
      this.connected = false;
      log.info(
        `ws closed code=${code}${reasonText ? ` reason=${reasonText}` : ""}`,
      );
      for (const [, p] of this.pending) {
        p.reject(new Error("ws closed"));
      }
      this.pending.clear();
      this.emit("close", { hadError });
    });
  }

  stop(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        void 0;
      }
    }
  }

  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`${resp.error.code}: ${resp.error.message}`));
          } else {
            resolve(resp.result as R);
          }
        },
        reject,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
  }

  reply(id: JsonRpcId, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.write(msg);
  }

  replyError(id: JsonRpcId, code: number, message: string): void {
    const msg: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    this.write(msg);
  }

  private async handshake(): Promise<void> {
    try {
      await this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: this.opts.clientName, version: pkg.version },
      });
    } catch (err) {
      log.warn(`initialize failed: ${(err as Error).message}`);
    }
    try {
      await this.request("hydra-acp/transformer/initialize", {
        intercepts: this.opts.intercepts,
      });
      log.info(
        `hydra-acp/transformer/initialize ok intercepts=${this.opts.intercepts.join(",")}`,
      );
    } catch (err) {
      log.warn(`hydra-acp/transformer/initialize failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn(`drop write to closed ws: ${JSON.stringify(msg)}`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p.resolve(m);
      } else {
        log.debug(`unmatched response id=${String(m.id)}`);
      }
      this.emit("response", m);
    } else if (isRequest(m)) {
      this.emit("request", m);
    } else if (isNotification(m)) {
      this.emit("notification", m);
    }
  }
}
