import assert from "node:assert/strict";
import test from "node:test";
import { conversationOrderFixture } from "./fixtures/conversation-order.mjs";

// A reply can stream several text items with progress between them. Each item shows as its
// own row while it streams, under the id its saved part will have, in the order they arrived.
test("a streamed reply shows each text item as its own row, in order, under its saved id", { timeout: 120_000 }, async (t) => {
  const f = await conversationOrderFixture(t, "reply-text-items");
  await f.start();
  await f.reply();
  const live = await f.interleave();
  // History rows give the order; message rows carry their text in `messages`.
  const text = (page, row) => page.messages.find((message) => message.id === row.id);
  const kinds = (page) => page.history.map((row) => row.kind === "message" ? `${text(page, row)?.role}:${text(page, row)?.text}` : `progress:${row.summary}`);
  const textIds = (page) => page.history.filter((row) => f.text.includes(text(page, row)?.text)).map((row) => row.id);
  assert.deepEqual(kinds(live).slice(1), [`progress:${f.headings[0]}`, `assistant:${f.text[0]}`, `progress:${f.headings[1]}`, `assistant:${f.text[1]}`]);
  const liveIds = textIds(live);
  assert.equal(new Set(liveIds).size, 2, "two items are two rows, not one row with both texts");
  const saved = await f.finish();
  assert.deepEqual(kinds(saved).slice(1), kinds(live).slice(1), "saving keeps the order");
  assert.deepEqual(textIds(saved), liveIds, "saved parts keep the live ids");
});
