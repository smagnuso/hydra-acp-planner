// ACP wire protocol version this transformer speaks. Single source of
// truth for the initialize handshake; never a literal at the callsite.
export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

// Shape of params the daemon delivers via hydra-acp/transformer/message. Mirrors the
// envelope hydra-acp builds in Session.forwardRequest / runResponseChain.
export interface TransformerMessageParams {
  token: string;
  phase: "request" | "response";
  method: string;
  direction: string;
  sessionId: string;
  envelope: unknown;
}

// Action returned to the daemon from hydra-acp/transformer/message.
//   continue   — daemon proceeds with the envelope unchanged.
//   stop       — daemon halts the chain. For request side, the optional
//                payload becomes the response delivered to the originator.
//   processing — transformer parks the claim and will discharge later via
//                hydra-acp/message/emit with respondsTo, or re-emit via
//                route:"chain".
export interface TransformerAction {
  action: "continue" | "stop" | "processing";
  payload?: unknown;
}

// Lifecycle event the daemon fires for transformers that declare a
// matching "lifecycle:<event>" intercept. Notification-only — no reply.
export interface TransformerSessionEvent {
  event: "session.opened" | "session.idle" | "session.closed" | string;
  sessionId: string;
  [key: string]: unknown;
}
