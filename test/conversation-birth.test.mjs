import assert from "node:assert/strict";
import test from "node:test";
import { ConversationBirthClock, ConversationOrder, conversationBirth } from "../src/conversation-birth.mjs";
import { assistantTextPart, sortVisibleHistory } from "../src/conversation-projection.mjs";
import { projectProgressEntry, PROGRESS_ENTRY_TYPE } from "../src/progress-projection.mjs";
import { sanitizePresentationText } from "../src/presentation-directive.mjs";
import { LiveConversation } from "../src/live-conversation.mjs";
const at = "2026-01-01T23:59:10.000Z";
const stamp = sequence => ({ version: 1, createdAt: at, sequence });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test("birth schema is exact and bounded; canonical text/progress retain IDs and legacy fallback", () => {
  assert.deepEqual(conversationBirth(stamp(1)), stamp(1));
  for (const bad of [null, [], {}, { ...stamp(1), version: 2 }, { ...stamp(1), sequence: 0 }, { ...stamp(1), sequence: 1.5 },
    { ...stamp(1), sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...stamp(1), createdAt: "yesterday" }, { ...stamp(1), extra: true }]) assert.equal(conversationBirth(bad), undefined);
  const message = { role: "assistant", id: "segment", timestamp: 1, content: [{ type: "text", id: "core", text: "same" }] };
  const legacy = assistantTextPart(message, 0); message.content[0].harnessBirth = stamp(4);
  const born = assistantTextPart(message, 0); assert.equal(born.id, legacy.id); assert.equal(born.createdAt, at); assert.equal(born.timelineSequence, 4);
  message.content[0].harnessBirth = { ...stamp(1), version: 2 }; assert.deepEqual(assistantTextPart(message, 0), legacy);
  assert.deepEqual(projectProgressEntry({ type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p", timestamp: new Date(1).toISOString(), data: { summary: "Checking", harnessBirth: stamp(3) } }),
    { kind: "progress", id: "p", summary: "Checking", createdAt: at, timelineSequence: 3 });
});
test("restart/fork seed only active canonical ancestry, tolerate malformed metadata, and preserve compaction ancestry", () => {
  const text = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A", harnessBirth: stamp(4) }] } };
  const progress = { type: "custom", customType: PROGRESS_ENTRY_TYPE, data: { harnessBirth: stamp(8) } };
  const malformed = { ...progress, data: { harnessBirth: { ...stamp(800), version: 2 } } };
  const clock = new ConversationBirthClock([text, progress, malformed, { type: "compaction" }], { now: () => at });
  assert.deepEqual(clock.next(), stamp(9));
  clock.reset([text]); assert.deepEqual(clock.next(), stamp(5));
  const fork = new ConversationBirthClock(JSON.parse(JSON.stringify([text, progress])), { now: () => at }); assert.deepEqual(fork.next(), stamp(9));
});
test("equal-millisecond reverse arrival uses birth sequence; unstamped ties remain stable before stamped rows", () => {
  const row = (id, sequence) => ({ kind: "message", id, message: { id, createdAt: at, ...(sequence ? { timelineSequence: sequence } : {}) } });
  const a = row("a", 2), p = { kind: "progress", id: "p", createdAt: at, timelineSequence: 1 };
  assert.deepEqual(sortVisibleHistory([a, row("receipt"), row("legacy"), p]).map(r => r.id), ["receipt", "legacy", "p", "a"]);
});
test("live empty placeholders upgrade; conflicts reject only ordering, including after reconciliation", () => {
  const live = new LiveConversation(); const old = new Date(1).toISOString();
  const update = (type, fields = {}) => ({ type: "message_update", messageId: "a", createdAt: old, assistantMessageEvent: { type, delta: "Text" }, ...fields });
  live.accept(update("text_start")); live.accept(update("text_delta", { createdAt: at, timelineSequence: 2 }));
  live.accept({ type: "message_end", message: { role: "assistant", content: [{ type: "text", id: "a", createdAt: old, timelineSequence: 9, text: "Completed" }] } });
  assert.deepEqual(live.snapshot().map(r => [r.text, r.createdAt, r.timelineSequence]), [["Completed", at, 2]]);
  live.reconcile(new Set(["a"])); assert.equal(live.snapshot().length, 0);
  const normalized = live.accept(update("text_delta", { timelineSequence: 99 }));
  assert.equal(normalized.createdAt, at); assert.equal(normalized.timelineSequence, 2); assert.equal(live.snapshot()[0].text, "Text");
  const order = new ConversationOrder(); order.keep({ id: "p", createdAt: at, timelineSequence: 1 });
  assert.equal(order.keep({ id: "p", createdAt: old, timelineSequence: 90 }).createdAt, at);
});

test("a core reply's text is shown when its first words arrived, after reasoning shown meanwhile", () => {
  const began = Date.parse("2026-11-09T08:00:00.000Z"), started = began + 40_000;
  const reply = { role: "assistant", provider: "test", timestamp: began, content: [{ type: "text", text: "answer", startedAt: started }] };
  const part = assistantTextPart(reply, 0, { entryId: "7" });
  assert.equal(part.createdAt, new Date(started).toISOString());
  assert.equal(part.id, assistantTextPart({ ...reply, content: [{ type: "text", text: "answer" }] }, 0, { entryId: "7" }).id, "the id does not change");
  const heading = projectProgressEntry({ type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "6", timestamp: new Date(began + 10_000).toISOString(),
    data: { summary: "Checking the logs" } });
  const ordered = sortVisibleHistory([{ kind: "message", message: part }, heading]);
  assert.deepEqual(ordered.map((item) => item.kind), ["progress", "message"]);
});
