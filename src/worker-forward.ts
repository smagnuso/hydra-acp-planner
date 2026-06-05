// Forwarders for worker session/update notifications into the
// orchestrator's held turn. The key challenge: ACP message_chunk and
// thought_chunk are *streaming* — agents emit many small fragments
// that the TUI concatenates into one rendered message. Per-chunk
// rewriting injects `[Tn] ` mid-sentence and produces output like
//
//   [T1]  I'm[T1]  building a module[T1]  for fetching URLs.
//
// Tool calls are atomic and don't suffer this problem — their full
// payload arrives in one tool_call envelope.
//
// So we use two strategies in parallel:
//
//   * Tool calls / tool_call_update → rewrite synchronously and
//     re-emit (`buildForwardedToolEnvelope`): rewrite the sessionId,
//     namespace the toolCallId with `<taskId>:` so concurrent workers
//     don't collide in the orchestrator's id space (the TUI pairs
//     call+updates by toolCallId), and prefix the title for
//     attribution.
//
//   * Message / thought chunks → buffer and flush via
//     `WorkerForwarder`: accumulate text per worker per kind, then
//     emit a single cohesive update on natural boundaries (a
//     debounce timeout when the stream goes idle, the arrival of a
//     different update kind that should logically follow, or the
//     worker's turn ending). One `[Tn] ` prefix per flush.
//
// Plan updates from workers are not forwarded — the orchestrator
// owns the project-level plan panel.

export interface ForwardedEnvelope {
  sessionId: string;
  update: Record<string, unknown>;
}

export type EmitFn = (env: ForwardedEnvelope) => void;

// Vendor-namespaced metadata stamped onto every envelope we forward
// from a worker into the orchestrator. Today nothing reads this — the
// TUI renders the envelope by its `sessionUpdate` kind and ignores
// _meta — but it's the right contract for future client features
// that want to group, color, filter, or pill-tag worker output
// without us having to inject ASCII markers into the visible text.
//
// Sub-namespace under the existing "hydra-acp" key so it cohabits
// cleanly with daemon-emitted markers like `synthetic: true`.
//
// Two concerns kept distinct:
//
//   * `sourceSessionId` is general-purpose: "this update was
//     produced by another session, not the one it's being
//     broadcast on." Any consumer that wants to color, group, or
//     filter by source can key off this without knowing about the
//     planner. Future hydra features (session fork visualization,
//     peer agent handoff, sub-agent spawning, etc.) can populate
//     the same field and benefit from the same TUI affordances.
//
//   * `sourceToolCallId` (tool envelopes only) is the ORIGINAL
//     toolCallId as the worker emitted it — before we namespaced
//     it with `<taskId>:`. Pair (sourceSessionId, sourceToolCallId)
//     lets a client lazy-fetch the freshest state of the resource
//     directly from the source session's history without having
//     to parse our namespacing convention.
//
//   * `planner.taskId` and `planner.sourceKind` are planner-
//     specific extension data: human-readable task label and the
//     worker's original sessionUpdate kind before we translated
//     it. Planner-aware consumers can use these for nicer labels;
//     general consumers can ignore them.
//
// Pattern for other extensions: claim your own sub-key under
// `_meta.hydra-acp.<your-extension-name>` for extension-specific
// fields, and populate the general-purpose top-level fields
// (`sourceSessionId`, `sourceToolCallId`, …) when you're forwarding
// resources from another session. General consumers can then
// participate without knowing about your extension.
interface WorkerTextMeta {
  "hydra-acp": {
    sourceSessionId: string;
    planner: {
      taskId: string;
      // Original sessionUpdate kind on the worker. For text streams
      // this distinguishes a translated agent_message_chunk (worker
      // said "X") from a true agent_thought_chunk (worker thought
      // "X"). Tool envelopes set it equal to the outer
      // sessionUpdate kind for consistency.
      sourceKind: string;
    };
  };
}

interface WorkerToolMeta {
  "hydra-acp": {
    sourceSessionId: string;
    sourceToolCallId: string;
    planner: {
      taskId: string;
      sourceKind: string;
    };
  };
}

function workerTextMeta(opts: {
  taskId: string;
  workerSessionId: string;
  sourceKind: string;
}): WorkerTextMeta {
  return {
    "hydra-acp": {
      sourceSessionId: opts.workerSessionId,
      planner: {
        taskId: opts.taskId,
        sourceKind: opts.sourceKind,
      },
    },
  };
}

function workerToolMeta(opts: {
  taskId: string;
  workerSessionId: string;
  sourceKind: string;
  sourceToolCallId: string;
}): WorkerToolMeta {
  return {
    "hydra-acp": {
      sourceSessionId: opts.workerSessionId,
      sourceToolCallId: opts.sourceToolCallId,
      planner: {
        taskId: opts.taskId,
        sourceKind: opts.sourceKind,
      },
    },
  };
}

// Idle-gap debounce: flush this long after the LAST chunk arrives,
// so a quick burst coalesces into one cohesive emit.
const DEFAULT_FLUSH_DELAY_MS = 400;

// Max-hold ceiling: flush this long after the FIRST chunk of a fresh
// stream regardless of subsequent activity. Without this cap, a worker
// that streams continuously (no idle gap) would never flush until a
// tool call forced it — and the user would see no thinking for the
// whole duration of the agent's prose, then a wall of text just as
// the first tool fires. With it, fresh emits land at least every
// ~1.5s during continuous streams.
const DEFAULT_MAX_HOLD_MS = 1500;

// Rewrite a worker tool_call / tool_call_update for re-emission on
// the orchestrator. Two things change on the wire envelope; the
// rest of the attribution rides in `_meta`:
//
//   * sessionId  → the orchestrator's, so the daemon routes the
//     update to the orchestrator's attached clients.
//   * toolCallId → namespaced with `<taskId>:` so call+update pairs
//     from different workers don't collide in the orchestrator's id
//     space. The TUI pairs tool_call_update to tool_call by id;
//     unrewritten collisions would render one worker's update on
//     another worker's panel.
//
// We deliberately do NOT modify the title. Earlier revisions
// prefixed descriptive (multi-word) titles with "[Tn] " for visible
// attribution, but with `_meta.hydra-acp.planner.taskId` now carrying
// the same information cleanly, the ASCII prefix is doubly redundant
// — and asymmetric (kind-name titles like "bash" stayed unprefixed,
// descriptive ones got the prefix). Clients should render attribution
// from `_meta` instead. Until they do, worker tool titles in the
// orchestrator transcript appear without attribution; the
// orchestrator's plan panel still shows which task is running.
//
// Idempotent on `toolCallId` so re-running on an already-rewritten
// envelope is a no-op (defensive against double-forwarding).
export function buildForwardedToolEnvelope(opts: {
  orchestratorSessionId: string;
  taskId: string;
  workerSessionId: string;
  kind: string;
  envelope: unknown;
}): ForwardedEnvelope | undefined {
  const env = opts.envelope as { update?: Record<string, unknown> } | undefined;
  const update = env?.update;
  if (!update) return undefined;
  if (opts.kind !== "tool_call" && opts.kind !== "tool_call_update") {
    return undefined;
  }
  const cloned: Record<string, unknown> = { ...update };
  const ns = `${opts.taskId}:`;
  // Capture the worker's original toolCallId BEFORE we rewrite it,
  // so we can stamp the un-namespaced form into _meta for lazy
  // back-references from the orchestrator's TUI.
  const original = cloned.toolCallId;
  let sourceToolCallId: string | undefined;
  if (typeof original === "string") {
    sourceToolCallId = original.startsWith(ns)
      ? original.slice(ns.length)
      : original;
    if (!original.startsWith(ns)) {
      cloned.toolCallId = `${ns}${original}`;
    }
  }
  // Stamp worker provenance into _meta. Merge with any existing
  // _meta on the source envelope so daemon-side or agent-side markers
  // pass through unmolested.
  const existingMeta =
    cloned._meta && typeof cloned._meta === "object" && !Array.isArray(cloned._meta)
      ? (cloned._meta as Record<string, unknown>)
      : {};
  cloned._meta = {
    ...existingMeta,
    ...workerToolMeta({
      taskId: opts.taskId,
      workerSessionId: opts.workerSessionId,
      sourceKind: opts.kind,
      sourceToolCallId: sourceToolCallId ?? "",
    }),
  };
  return {
    sessionId: opts.orchestratorSessionId,
    update: cloned,
  };
}

// Build a flush-time message/thought envelope from accumulated text.
// Exported so tests can verify the wire shape without spinning up a
// full WorkerForwarder.
//
// We deliberately do NOT prefix the text here. The TUI concatenates
// successive agent_thought_chunk arrivals into one rendered thought
// block (closeThought only fires on a non-thought event), so a per-
// emission `[Tn] ` prefix ends up mid-message in the welded result.
// Attribution lives on tool call titles instead (one panel per tool,
// prefix lands cleanly) and via the plan panel showing which task is
// in_progress.
export function buildFlushedTextEnvelope(opts: {
  orchestratorSessionId: string;
  taskId: string;
  workerSessionId: string;
  // The kind we emit on the orchestrator's wire (always
  // agent_thought_chunk today — see file-header rationale).
  kind: "agent_message_chunk" | "agent_thought_chunk";
  // The kind the worker originally emitted before our translation.
  // Stamped into _meta so future TUI features can distinguish a
  // translated message from a true thought.
  sourceKind: "agent_message_chunk" | "agent_thought_chunk";
  text: string;
}): ForwardedEnvelope {
  return {
    sessionId: opts.orchestratorSessionId,
    update: {
      sessionUpdate: opts.kind,
      content: { type: "text", text: opts.text },
      _meta: workerTextMeta({
        taskId: opts.taskId,
        workerSessionId: opts.workerSessionId,
        sourceKind: opts.sourceKind,
      }),
    },
  };
}

// Per-worker buffer-and-flush for streaming text. One instance per
// worker session; bridge.ts owns the lifecycle (create on spawn,
// dispose on close).
// Single-buffer stream state. The idle timer resets on every chunk
// (coalesces bursts); the max-hold timer is set on the FIRST chunk
// of a fresh stream and is NEVER reset (ensures forward progress
// for continuous streams).
//
// `sourceKind` records the worker's original kind for the first
// chunk of the buffer; subsequent ingests in the same burst inherit
// it. We pass it through to buildFlushedTextEnvelope so the _meta
// stamp distinguishes a translated message from a true thought.
//
// We use one buffer for all worker text — both agent_message_chunk
// and agent_thought_chunk are funneled through ingestText() and
// flushed as agent_thought_chunk on the orchestrator side. In a
// worker context, all the agent's prose is internal narration (no
// human user to "speak to"), so rendering it as the orchestrator's
// "thinking" is semantically accurate and gives a consistent
// muted/italic affordance in the TUI regardless of whether the
// worker agent classifies its own output as message vs thought.
interface StreamBuffer {
  text: string;
  sourceKind: "agent_message_chunk" | "agent_thought_chunk";
  idleTimer: NodeJS.Timeout | undefined;
  maxHoldTimer: NodeJS.Timeout | undefined;
}

function emptyBuffer(): StreamBuffer {
  return {
    text: "",
    sourceKind: "agent_thought_chunk",
    idleTimer: undefined,
    maxHoldTimer: undefined,
  };
}

export class WorkerForwarder {
  private buf: StreamBuffer = emptyBuffer();

  constructor(
    private readonly opts: {
      orchestratorSessionId: string;
      workerSessionId: string;
      taskId: string;
      emit: EmitFn;
      // Override only in tests. Production defaults give a snappy
      // ~400ms idle debounce and a 1.5s max-hold so continuous
      // streams flush at least every 1.5s.
      flushDelayMs?: number;
      maxHoldMs?: number;
    },
  ) {}

  // Append streaming text from the worker. `sourceKind` lets us
  // record the worker's original update kind for _meta tagging;
  // first chunk of a fresh burst wins, mixed-kind bursts (which
  // would be unusual) end up tagged with whichever kind started
  // the burst. Both timers are managed: idle resets on every call
  // (so a burst coalesces), max-hold is set once at stream-start
  // and never reset (so a never-idle stream still flushes regularly).
  ingestText(
    text: string,
    sourceKind: "agent_message_chunk" | "agent_thought_chunk",
  ): void {
    if (text.length === 0) return;
    const idleDelay = this.opts.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    const maxHold = this.opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    const wasEmpty = this.buf.text.length === 0;
    if (wasEmpty) {
      this.buf.sourceKind = sourceKind;
    }
    this.buf.text += text;
    if (this.buf.idleTimer) clearTimeout(this.buf.idleTimer);
    this.buf.idleTimer = setTimeout(() => this.flush(), idleDelay);
    if (typeof this.buf.idleTimer.unref === "function") this.buf.idleTimer.unref();
    if (wasEmpty && !this.buf.maxHoldTimer) {
      this.buf.maxHoldTimer = setTimeout(() => this.flush(), maxHold);
      if (typeof this.buf.maxHoldTimer.unref === "function") this.buf.maxHoldTimer.unref();
    }
  }

  // Tool call arrived. Flush any pending text first so the tool
  // render comes after the narration that logically preceded it
  // (within this worker — order across workers is best-effort).
  // Then emit the rewritten tool envelope.
  ingestToolUpdate(kind: string, envelope: unknown): void {
    this.flush();
    const out = buildForwardedToolEnvelope({
      orchestratorSessionId: this.opts.orchestratorSessionId,
      taskId: this.opts.taskId,
      workerSessionId: this.opts.workerSessionId,
      kind,
      envelope,
    });
    if (out) this.opts.emit(out);
  }

  // Force-flush the buffer. Call before disposing or on turn-end.
  flushAll(): void {
    this.flush();
  }

  // Clear pending timers without flushing. Used on cancellation
  // paths where in-flight text is being abandoned.
  dispose(): void {
    this.clearTimers();
    this.buf = emptyBuffer();
  }

  private clearTimers(): void {
    if (this.buf.idleTimer) {
      clearTimeout(this.buf.idleTimer);
      this.buf.idleTimer = undefined;
    }
    if (this.buf.maxHoldTimer) {
      clearTimeout(this.buf.maxHoldTimer);
      this.buf.maxHoldTimer = undefined;
    }
  }

  private flush(): void {
    const text = this.buf.text;
    const sourceKind = this.buf.sourceKind;
    this.clearTimers();
    this.buf.text = "";
    if (text.length === 0) return;
    this.opts.emit(
      buildFlushedTextEnvelope({
        orchestratorSessionId: this.opts.orchestratorSessionId,
        taskId: this.opts.taskId,
        workerSessionId: this.opts.workerSessionId,
        // All worker text renders as the orchestrator's thinking.
        // See file-header comment for rationale.
        kind: "agent_thought_chunk",
        sourceKind,
        text,
      }),
    );
  }
}
