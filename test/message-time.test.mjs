import assert from "node:assert/strict";
import test from "node:test";
import { MessageClock, formatMessageTime, messageTimeBlock } from "../src/message-time.mjs";

const timeZone = "Europe/Berlin";
const at = Date.UTC(2026, 9, 28, 21, 16);
const minutes = n => n * 60 * 1000;

test("formats local wall-clock time with the zone name", () => {
  assert.equal(formatMessageTime(at, timeZone), "[Wed, 28 Oct 2026, 22:16 CET]");
  assert.equal(formatMessageTime(Date.UTC(2026, 6, 1, 6, 5), timeZone), "[Wed, 1 Jul 2026, 08:05 CEST]");
});

test("a time is a marked text block", () => {
  assert.deepEqual(messageTimeBlock(at, { timeZone }), { type: "text", text: "[Wed, 28 Oct 2026, 22:16 CET]", harness: "time" });
});

test("every incoming message gets a time; a tool result only after a long quiet stretch", () => {
  let now = at;
  const clock = new MessageClock({ now: () => now, timeZone });
  assert.equal(clock.incoming().text, "[Wed, 28 Oct 2026, 22:16 CET]");
  const results = [5, 16, 20, 31].map((offset) => { now = at + minutes(offset); return clock.toolResult()?.text; });
  assert.deepEqual(results, [undefined, "[Wed, 28 Oct 2026, 22:32 CET]", undefined, "[Wed, 28 Oct 2026, 22:47 CET]"]);
});

test("the first tool result with no earlier time only starts the quiet stretch", () => {
  let now = at;
  const clock = new MessageClock({ now: () => now, timeZone });
  assert.equal(clock.toolResult(), undefined);
  now = at + minutes(15);
  assert.equal(clock.toolResult()?.text, "[Wed, 28 Oct 2026, 22:31 CET]");
});
