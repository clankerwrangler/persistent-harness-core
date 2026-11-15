// The live view of a session's replies, made where the session runs. The core's own events
// become the events the WebUI shows while a reply is being written, each sent to the
// supervisor as a `live_event` frame, in order. For a session the user talks to (a root at
// depth 0), its replies' presentation directives are taken out of the shown text, and each
// frame also carries what the reply feed shows (`feed`; root-output-projector.mjs numbers
// and keeps that feed). The supervisor numbers, keeps and passes these frames on; it does
// not shape them, so a change here reaches a session when it next starts. What it does read
// belongs to the channel between the halves: the frame's fields, the event kinds and
// fields it acts on (supervisor.mjs, #onActorEvent) and those live rows are kept by
// (live-conversation.mjs). A change to those raises SESSION_CHANNEL_VERSION.
import { assistantTextPart } from "./conversation-projection.mjs";
import { PresentationDirectiveFilter, presentationEquals, sanitizePresentationText } from "./presentation-directive.mjs";
import { assistantTurnFailureFromEvents, captureAssistantTurn, resetAssistantTurn } from "./child-task-failure.mjs";

const EVENT_MAX_BYTES = 32 * 1024;
const FEED_TEXT_MAX_BYTES = 32 * 1024;
const MAX_INDEX = 1_000_000_000;
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function boundedString(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function boundedUtf8(value, maxBytes = FEED_TEXT_MAX_BYTES) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}
function safeIndex(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_INDEX ? value : undefined; }
function safeStopReason(value) { return STOP_REASONS.has(value) ? value : "unknown"; }
function safeTimestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

/** A reply being streamed, as a message: one text part per text item the provider sent. */
function replyMessage(reply) {
  return { role: "assistant", provider: reply.provider, timestamp: reply.timestamp,
    content: reply.parts.map((part) => ({ type: "text", text: part.text, startedAt: part.startedAt, ...(part.signature ? { textSignature: part.signature } : {}) })) };
}

/** What the reply feed is told of one session's events: its text with the presentation
 * directive taken out (one per assistant message, at its start), and how each message ended. */
export class RootFeed {
  #message = null;

  accept(event) {
    switch (event?.type) {
      case "agent_start": this.#message = null; return { type: "agent_start" };
      case "agent_settled": this.#message = null; return { type: "agent_settled" };
      case "message_start":
        if (event.message?.role !== "assistant") return null;
        this.#message = this.#fresh(); return { type: "message_start" };
      case "message_update": {
        if (event.truncated === true) return { type: "failed" };
        const update = event.assistantMessageEvent;
        if (update?.type !== "text_delta") return null;
        const delta = boundedUtf8(update.delta), contentIndex = safeIndex(update.contentIndex);
        if (!delta || contentIndex === undefined) return { type: "failed" };
        const message = this.#message ??= this.#fresh(); message.sawText = true;
        const text = message.filter.push(delta);
        if (!text) return null;
        if (!boundedUtf8(text)) return { type: "failed" };
        const first = !message.shown; message.shown = true;
        return { type: "text_delta", contentIndex, delta: text, ...(first ? { presentation: message.filter.presentation } : {}) };
      }
      case "message_end": {
        if (event.truncated === true) { this.#message = null; return { type: "assistant_terminal", truncated: true }; }
        if (event.message?.role !== "assistant") return null;
        const message = this.#message ?? this.#fresh(); this.#message = null; message.filter.finish();
        const terminal = terminalOf(event.message);
        if (!terminal || message.sawText && !presentationEquals(message.filter.presentation, terminal.presentation)) return { type: "assistant_terminal", truncated: true };
        return { type: "assistant_terminal", ...terminal };
      }
      default: return null;
    }
  }

  #fresh() { return { filter: new PresentationDirectiveFilter(), sawText: false, shown: false }; }
}

function terminalOf(message) {
  const raw = (Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  if (Buffer.byteLength(raw, "utf8") > FEED_TEXT_MAX_BYTES) return undefined;
  const sanitized = sanitizePresentationText(raw);
  if (Buffer.byteLength(sanitized.text, "utf8") > FEED_TEXT_MAX_BYTES) return undefined;
  const result = { stopReason: safeStopReason(message.stopReason), text: sanitized.text, presentation: sanitized.presentation };
  const messageId = boundedString(message.id); if (messageId) result.messageId = messageId;
  const timestamp = safeTimestamp(message.timestamp); if (timestamp !== undefined) result.timestamp = timestamp;
  return result;
}

/** One session's live view. `core(event, provider)` takes the core's events; `accept(event)`
 * takes a session event (agent_start, message_update, message_end, tool_execution_*,
 * agent_settled) as the core's are turned into. Both return the frames to send. */
export class LiveView {
  #presentation; #feed; #reply = null; #working = false;
  #filters = new Map(); #identity = null; #textIds = new Map(); #turn = {};

  constructor({ presentation = false } = {}) {
    this.#presentation = presentation === true;
    this.#feed = this.#presentation ? new RootFeed() : null;
    resetAssistantTurn(this.#turn);
  }

  core(ev, provider) {
    const frames = [];
    const publish = (event) => { const frame = this.accept(event); if (frame) frames.push(frame); return frame; };
    switch (ev?.ev) {
      case "turn_start":
        // A chain of turns (messages that arrived meanwhile) is one working stretch.
        if (this.#working) return [{ type: "live_activity" }];
        this.#working = true;
        publish({ type: "agent_start" });
        break;
      case "text_delta": {
        if (typeof ev.delta !== "string") break;
        const item = typeof ev.item === "string" && ev.item ? ev.item : undefined;
        let reply = this.#reply;
        if (reply?.attempt !== ev.attempt) reply = this.#reply = { attempt: ev.attempt, parts: [], timestamp: Date.now(), provider };
        let index = reply.parts.length - 1;
        // A new text item from the provider is a new part, as it will be once saved.
        if (index < 0 || (item !== undefined && reply.parts[index].item !== item)) {
          if (index >= 0) publish({ type: "message_update", message: replyMessage(reply), assistantMessageEvent: { type: "text_end", contentIndex: index, text: reply.parts[index].text } });
          // The saved text keeps the provider's item id in its signature; naming the live
          // text the same way gives it the id its saved message will have.
          // Each part shows at the time its first words arrived, as the core saves it.
          reply.parts.push({ item, text: "", startedAt: Date.now(), signature: item ? JSON.stringify({ v: 1, id: item }) : undefined });
          index += 1;
          publish({ type: "message_update", message: replyMessage(reply), assistantMessageEvent: { type: "text_start", contentIndex: index } });
        }
        reply.parts[index].text += ev.delta;
        publish({ type: "message_update", message: replyMessage(reply), assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: ev.delta } });
        break;
      }
      case "message_end": {
        const reply = this.#reply?.attempt === ev.attempt ? this.#reply : null;
        this.#reply = null;
        const last = reply ? reply.parts.length - 1 : -1;
        if (last >= 0) publish({ type: "message_update", message: replyMessage(reply), assistantMessageEvent: { type: "text_end", contentIndex: last, text: reply.parts[last].text } });
        const message = { ...(reply ? replyMessage(reply) : { role: "assistant", content: [], timestamp: Date.now() }), stopReason: ev.stopReason, usage: ev.usage };
        const frame = publish({ type: "message_end", message });
        // A live row the provider gave no id cannot meet its saved message: drop it once saved.
        const drop = (reply?.parts ?? []).flatMap((part, index) => part.signature ? [] : [assistantTextPart(message, index)?.id]).filter(Boolean);
        if (frame && drop.length) frame.drop = drop;
        break;
      }
      case "error":
        // A failed reply is saved (n) and ends the turn's work with this error.
        if (ev.n != null) captureAssistantTurn(this.#turn, { role: "assistant", stopReason: "error", errorMessage: ev.error, content: [] });
        break;
      case "tool_call": publish({ type: "tool_execution_start", toolCallId: ev.call, toolName: ev.name }); break;
      case "tool_result": publish({ type: "tool_execution_end", toolCallId: ev.call }); break;
      case "cancel": for (const call of ev.calls ?? []) publish({ type: "tool_execution_end", toolCallId: call }); break;
      case "settled":
        if (!this.#working) break;
        this.#working = false;
        publish({ type: "agent_settled" });
        break;
      default: break;
    }
    return frames;
  }

  /** The frame for one session event, or null when nothing of it is kept. A frame's `event`
   * is what the WebUI is shown (null when this part of it shows nothing); `feed` is the reply
   * feed's part; `failure` (on agent_settled) is why the turn failed, or null. */
  accept(frame) {
    if (frame?.type === "agent_start") resetAssistantTurn(this.#turn);
    else if (frame?.type === "message_end" && frame.message?.role === "assistant") captureAssistantTurn(this.#turn, frame.message);
    const retained = this.#bounded(frame);
    if (!retained) return null;
    const feed = this.#feed?.accept(retained) ?? null;
    return { type: "live_event", event: this.#presentation ? this.#sanitize(retained) : retained, ...(feed ? { feed } : {}),
      ...(frame.type === "agent_settled" ? { failure: assistantTurnFailureFromEvents(this.#turn) } : {}) };
  }

  // A shown event is at most 32 KB: a longer reply is shown truncated (its text left out).
  #bounded(frame) {
    const projected = this.#project(frame);
    if (!projected) return null;
    try {
      if (Buffer.byteLength(JSON.stringify(projected)) <= EVENT_MAX_BYTES) return projected;
      if (projected.type === "message_end" && projected.message?.role === "assistant") {
        return { ...projected, message: { ...projected.message, content: projected.message.content.map((part) => ({ ...part, text: "" })) }, truncated: true };
      }
      if (projected.type === "message_update" && projected.assistantMessageEvent?.type === "text_end") {
        return { ...projected, assistantMessageEvent: { ...projected.assistantMessageEvent, text: "" }, truncated: true };
      }
      return { type: projected.type ?? "unknown", truncated: true };
    } catch { return { type: "unknown", truncated: true }; }
  }

  // Only what the WebUI shows: reply text under the id its saved message will have, which
  // tool runs, and when the turn starts and settles. Reasoning and tool bodies stay here.
  #project(frame) {
    const type = typeof frame?.type === "string" ? frame.type : "unknown";
    if (type === "agent_start" || type === "agent_settled") { this.#identity = null; this.#textIds.clear(); }
    if (type === "message_update") {
      const update = frame.assistantMessageEvent;
      if (!["text_start", "text_delta", "text_end"].includes(update?.type)
        || update.type === "text_delta" && typeof update.delta !== "string") return null;
      const contentIndex = safeIndex(update.contentIndex) ?? 0;
      if (update.type === "text_start" && boundedString(update.id)) this.#textIds.set(contentIndex, update.id);
      const message = frame.message ?? { ...this.#identity,
        content: { [contentIndex]: { type: "text", id: this.#textIds.get(contentIndex),
          text: update.content ?? update.text ?? update.delta ?? "", harnessBirth: update.harnessBirth } } };
      const part = assistantTextPart(message, contentIndex);
      if (!part) return null;
      return { type, messageId: part.id, createdAt: part.createdAt, ...(part.timelineSequence ? { timelineSequence: part.timelineSequence } : {}), assistantMessageEvent: { type: update.type, contentIndex,
        ...(update.type === "text_delta" ? { delta: update.delta } : {}), ...(update.type === "text_end" ? { text: part.text } : {}) } };
    }
    if (type === "message_start") {
      const role = frame.message?.role;
      if (role !== "assistant") return { type };
      const timestamp = Number.isSafeInteger(frame.message.timestamp) && frame.message.timestamp >= 0 ? frame.message.timestamp : Date.now();
      const identity = { role, timestamp, ...(typeof frame.message.id === "string" && frame.message.id ? { id: frame.message.id } : {}) };
      this.#identity = identity; this.#textIds.clear();
      for (const [index, part] of (Array.isArray(frame.message.content) ? frame.message.content : []).entries()) {
        if (part?.type === "text" && boundedString(part.id)) this.#textIds.set(index, part.id);
      }
      return { type, message: identity };
    }
    if (type === "message_end") {
      const message = frame.message;
      // Saved history owns image rows and bytes: say only that a result with images
      // arrived, never its payload.
      if (message?.role === "toolResult" && this.#presentation && message.content?.some((part) => part?.type === "image")) {
        return { type, message: { role: "toolResult" } };
      }
      if (message?.role !== "assistant") return { type };
      const content = Array.isArray(message.content)
        ? message.content.map((part, contentIndex) => {
          if (part?.type !== "text" || typeof part.text !== "string") return null;
          const projected = assistantTextPart(message, contentIndex, { timestamp: this.#identity?.timestamp });
          return { type: "text", text: part.text, ...(projected ? { id: projected.id, createdAt: projected.createdAt, ...(projected.timelineSequence ? { timelineSequence: projected.timelineSequence } : {}), contentIndex } : {}) };
        }).filter(Boolean) : [];
      const messageId = boundedString(message.id);
      const timestamp = safeTimestamp(message.timestamp);
      return { type, message: { role: "assistant", content, stopReason: safeStopReason(message.stopReason),
        ...(messageId ? { id: messageId } : {}), ...(timestamp !== undefined ? { timestamp } : {}) } };
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) {
      return { type,
        ...(typeof frame.toolCallId === "string" ? { toolCallId: frame.toolCallId } : {}),
        ...(typeof frame.toolName === "string" ? { toolName: frame.toolName } : {}),
        ...(typeof frame.isError === "boolean" ? { isError: frame.isError } : {}) };
    }
    return { type };
  }

  // A root's replies may open with a presentation directive; the WebUI never shows one.
  #sanitize(event) {
    if (event.type === "agent_start" || event.type === "agent_settled") { this.#filters.clear(); return event; }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_start") this.#filters.set(event.messageId, new PresentationDirectiveFilter());
      if (update?.type === "text_delta") {
        let filter = this.#filters.get(event.messageId);
        if (!filter) { filter = new PresentationDirectiveFilter(); this.#filters.set(event.messageId, filter); }
        const delta = filter.push(update.delta); if (!delta) return null;
        return { ...event, assistantMessageEvent: { ...update, delta } };
      }
      if (update?.type === "text_end") {
        this.#filters.delete(event.messageId);
        return { ...event, assistantMessageEvent: { ...update, text: sanitizePresentationText(update.text ?? "").text } };
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content.map((part) => ({ ...part, text: sanitizePresentationText(part.text).text }));
      for (const part of content) this.#filters.delete(part.id);
      return { ...event, message: { ...event.message, content } };
    }
    return event;
  }
}
