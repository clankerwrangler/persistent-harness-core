import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export const DEFAULT_ROOT_OUTPUT_MAX_EVENTS = 1024;
export const DEFAULT_ROOT_OUTPUT_MAX_BYTES = 512 * 1024;
export const ROOT_OUTPUT_GENERATION_MAX = 128;
export const ROOT_OUTPUT_TEXT_MAX_BYTES = 32 * 1024;
const MAX_ID = 128;
const MAX_INDEX = 1_000_000_000;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXIT_REASONS = new Set(["actor_exit", "error", "passivated", "stopped", "deleted", "unexpected_exit"]);

function eventBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function boundedString(value, max = MAX_ID) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function boundedUtf8(value, maxBytes = ROOT_OUTPUT_TEXT_MAX_BYTES) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}
function safeIndex(value, { zero = false } = {}) {
  return Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= MAX_INDEX ? value : undefined;
}

/** Parse the standard SSE Last-Event-ID used by the root-output feed. */
export function parseRootOutputCursor(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > ROOT_OUTPUT_GENERATION_MAX + 18) return { invalid: true };
  const separator = value.lastIndexOf(":");
  if (separator < 1) return { invalid: true };
  const generation = value.slice(0, separator);
  const encodedSeq = value.slice(separator + 1);
  if (!GENERATION.test(generation) || !/^(?:0|[1-9][0-9]*)$/.test(encodedSeq)) return { invalid: true };
  const afterSeq = Number(encodedSeq);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return { invalid: true };
  return { generation, afterSeq };
}

/**
 * Privacy-safe, root-only live feed with bounded activation-gated replay. Each root session
 * says what the feed shows of its events (`feed` on its live frames, made by the session
 * half: live-view.mjs, RootFeed); this numbers it into turns and messages and keeps it.
 */
export class RootOutputProjector extends EventEmitter {
  #sequence = 0;
  #ring = [];
  #ringBytes = 0;
  #turns = new Map();
  #active = false;

  constructor({ generation = randomUUID(), maxEvents = DEFAULT_ROOT_OUTPUT_MAX_EVENTS,
    maxBytes = DEFAULT_ROOT_OUTPUT_MAX_BYTES } = {}) {
    super();
    if (typeof generation !== "string" || !GENERATION.test(generation)) throw new Error("root-output generation is invalid");
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("root-output maxEvents must be positive");
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error("root-output maxBytes must be at least 1024");
    Object.assign(this, { generation, maxEvents, maxBytes });
  }

  get active() { return this.#active; }
  get cursor() { return this.#sequence; }
  get oldestSeq() { return this.#ring[0]?.seq ?? null; }

  /** One feed item (`event`): agent_start, message_start, text_delta, failed,
   * assistant_terminal or agent_settled. */
  accept({ session, actorGeneration, actorEventSeq, event } = {}) {
    if (session?.kind !== "root" || session?.depth !== 0) return [];
    if (!safeIndex(actorGeneration) || !safeIndex(actorEventSeq)) return [];
    const sessionId = boundedString(session.sessionId); if (!sessionId) return [];
    const emitted = [];
    const publish = (payload) => { if (this.#active) emitted.push(this.#publish(payload)); };
    let turn = this.#turns.get(sessionId);

    if (event?.type === "agent_start") {
      if (turn && actorGeneration < turn.actorGeneration) return emitted;
      if (turn) publish(this.#terminal(turn, "superseded", "new_agent_start"));
      turn = { sessionId, actorGeneration, turnStartSeq: actorEventSeq,
        turnId: `${sessionId}:g${actorGeneration}:t${actorEventSeq}`,
        messageIndex: 0, message: null, failed: false };
      this.#turns.set(sessionId, turn);
      publish(this.#base(turn, { type: "turn_start", turnStartSeq: actorEventSeq })); return emitted;
    }
    if (!turn || turn.actorGeneration !== actorGeneration) return emitted;

    if (event?.type === "message_start") { this.#startMessage(turn); return emitted; }
    if (event?.type === "failed") { turn.failed = true; return emitted; }
    if (event?.type === "text_delta") {
      const delta = boundedUtf8(event.delta); const contentIndex = safeIndex(event.contentIndex, { zero: true });
      if (!delta || contentIndex === undefined) { turn.failed = true; return emitted; }
      const message = turn.message ?? this.#startMessage(turn);
      message.deltaSeq += 1;
      publish(this.#base(turn, { type: "text_delta", messageIndex: message.index,
        deltaSeq: message.deltaSeq, contentIndex, delta,
        ...(event.presentation && typeof event.presentation === "object" ? { presentation: event.presentation } : {}) }));
      return emitted;
    }
    if (event?.type === "assistant_terminal") {
      if (event.truncated === true || typeof event.text !== "string") { this.#publishTruncated(turn, publish); return emitted; }
      const message = turn.message ?? this.#startMessage(turn);
      const stopReason = typeof event.stopReason === "string" ? event.stopReason : "unknown";
      if (["error", "aborted", "unknown"].includes(stopReason)) turn.failed = true;
      publish(this.#base(turn, { type: "assistant_terminal", messageIndex: message.index, status: "complete",
        stopReason, text: event.text, presentation: event.presentation,
        ...(boundedString(event.messageId) ? { messageId: event.messageId } : {}),
        ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) }));
      turn.message = null; return emitted;
    }
    if (event?.type === "agent_settled") {
      publish(this.#terminal(turn, turn.failed ? "failed" : "settled", turn.failed ? "assistant_terminal_failed" : undefined));
      this.#turns.delete(sessionId);
    }
    return emitted;
  }

  failSession(sessionId, actorGeneration, reason = "actor_exit") {
    if (!boundedString(sessionId) || !safeIndex(actorGeneration)) return undefined;
    const turn = this.#turns.get(sessionId); if (!turn || turn.actorGeneration !== actorGeneration) return undefined;
    this.#turns.delete(sessionId);
    return this.#active ? this.#publish(this.#terminal(turn, "actor_exit", EXIT_REASONS.has(reason) ? reason : "actor_exit")) : undefined;
  }

  subscribe(cursor = null) {
    this.#active = true;
    const latest = this.#sequence; const base = { generation: this.generation, cursor: latest, oldestSeq: this.oldestSeq };
    if (cursor == null || (cursor && Object.keys(cursor).length === 0)) return { ...base, gap: false, events: [] };
    if (cursor.invalid || cursor.invalidCursor || typeof cursor.generation !== "string" || !GENERATION.test(cursor.generation)
      || !Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < 0) return { ...base, gap: true, gapReason: "invalid_cursor", events: [] };
    if (cursor.generation !== this.generation) return { ...base, gap: true, gapReason: "generation_mismatch", events: [] };
    if (cursor.afterSeq > latest) return { ...base, gap: true, gapReason: "invalid_cursor", events: [] };
    const oldest = this.oldestSeq;
    if (cursor.afterSeq < latest && oldest === null) return { ...base, gap: true, gapReason: "replay_overrun", events: [] };
    if (oldest !== null && cursor.afterSeq < oldest - 1) return { ...base, gap: true, gapReason: "replay_overrun", events: [] };
    return { ...base, gap: false, events: this.#ring.filter((item) => item.seq > cursor.afterSeq).map((item) => item.frame) };
  }

  #publishTruncated(turn, publish, message = turn.message ?? this.#startMessage(turn)) {
    turn.failed = true; publish(this.#base(turn, { type: "assistant_terminal", messageIndex: message.index,
      status: "truncated", truncated: true })); turn.message = null;
  }
  #startMessage(turn) {
    turn.messageIndex += 1;
    turn.message = { index: turn.messageIndex, deltaSeq: 0 };
    return turn.message;
  }
  #base(turn, payload) { return { ...payload, sessionId: turn.sessionId, turnId: turn.turnId, actorGeneration: turn.actorGeneration }; }
  #terminal(turn, status, reason) { return this.#base(turn, { type: "turn_terminal", status, ...(reason ? { reason } : {}) }); }
  #publish(event) {
    const frame = { type: "root_output", generation: this.generation, seq: ++this.#sequence, event };
    const bytes = eventBytes(frame); this.#ring.push({ seq: frame.seq, bytes, frame }); this.#ringBytes += bytes;
    while (this.#ring.length > this.maxEvents || this.#ringBytes > this.maxBytes) {
      const removed = this.#ring.shift(); this.#ringBytes -= removed.bytes;
    }
    this.emit("event", frame); return frame;
  }
}
