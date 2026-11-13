import assert from "node:assert/strict";
import test from "node:test";
import { CoreTranscriptReader } from "../src/core-transcript-reader.mjs";
import { PROGRESS_ENTRY_TYPE } from "../src/progress-projection.mjs";
import { AGENT_MESSAGE_ENTRY_TYPE } from "../src/agent-message-projection.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const at = (n) => new Date(Date.UTC(2026, 10, 9, 8, 0, n)).toISOString();
const user = (n, content) => ({ type: "message", id: String(n), timestamp: at(n), message: { role: "user", content, timestamp: Date.parse(at(n)) } });
const reply = (n, content) => ({ type: "message", id: String(n), timestamp: at(n),
  message: { role: "assistant", provider: "test", content, stopReason: "stop", timestamp: Date.parse(at(n)) } });
const text = (value) => ({ type: "text", text: value });

/** The core as the reader sees it: the current chunk starts at `chunkStart`; a range reads any entries. */
function core(entries, chunkStart = 0) {
  const asked = [];
  return { asked, history: async (_sessionFile, range) => {
    asked.push(range ?? null);
    if (!range) return entries.filter((entry) => Number(entry.id) >= chunkStart);
    return entries.filter((entry) => Number(entry.id) >= range.from && Number(entry.id) <= range.to);
  } };
}

test("a page shows what the user sees: no reasoning, times or shared locations", async () => {
  const fake = core([
    user(1, [{ type: "text", text: "[Mon, 9 Nov 2026, 09:00 CET]", harness: "time" }, text("Where is it?"),
      { type: "text", text: "User-shared device location (not independently verified): latitude 1", harness: "location" }]),
    reply(2, [{ type: "thinking", thinking: "PRIVATE reasoning" }, text("Here.")]),
  ]);
  const page = await new CoreTranscriptReader({ history: fake.history }).read({ sessionFile: "s", sessionId: "s", publicView: true });
  assert.deepEqual(page.messages.map((m) => [m.role, m.text]), [["user", "Where is it?"], ["assistant", "Here."]]);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|latitude|09:00/);
});

test("progress headings and family messages are rows of the same history", async () => {
  const fake = core([
    user(1, [text("Start")]),
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "2", timestamp: at(2), data: { summary: "Reading the logs" } },
    { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "3", timestamp: at(3),
      data: { messageId: "m1", direction: "to", peerId: "child", peerName: "helper", relationship: "child", body: "Please check" } },
    reply(4, [text("Done.")]),
  ]);
  const page = await new CoreTranscriptReader({ history: fake.history }).read({ sessionFile: "s", sessionId: "s", publicView: true });
  assert.deepEqual(page.history.map((item) => item.kind), ["message", "progress", "agent_message", "message"]);
});

test("a user's image is shown by reference and read on demand; tool images only where allowed", async () => {
  const toolResult = { type: "message", id: "3", timestamp: at(3),
    message: { role: "toolResult", toolCallId: "c", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: Date.parse(at(3)) } };
  const fake = core([user(1, [text("Look"), { type: "image", data: PNG, mimeType: "image/png" }]), reply(2, [text("Seen.")]), toolResult]);
  const reader = new CoreTranscriptReader({ history: fake.history });
  const page = await reader.read({ sessionFile: "s", sessionId: "s", publicView: true });
  const shown = page.messages.find((m) => m.role === "user").images[0];
  assert.deepEqual(shown.ref, { entryId: "1", index: 0 }); assert.equal(shown.data, undefined);
  assert.equal((await reader.readImage({ sessionFile: "s", entryId: "1", index: 0 })).data, PNG);
  await assert.rejects(reader.readImage({ sessionFile: "s", entryId: "3", index: 0 }), /does not exist/);
  assert.equal((await reader.readImage({ sessionFile: "s", entryId: "3", index: 0, allowToolImages: true })).data, PNG);
});

test("the title turn is the first completed exchange", async () => {
  const ask = "Plan a three-day hiking trip through the Dolomites in early October";
  const fake = core([user(1, [text(ask)]), reply(2, [text("Here is a day-by-day plan with huts, trail lengths and a weather fallback.")]), user(3, [text("Thanks")])]);
  const page = await new CoreTranscriptReader({ history: fake.history }).read({ sessionFile: "s", sessionId: "s", includeTitleTurn: true });
  assert.equal(page.titleUser, ask);
  assert(page.titleTurn);
});

test("scroll-back pages reach the start of the history, through older chunks, without repeats", async () => {
  const entries = [];
  for (let n = 1; n <= 300; n += 2) entries.push(user(n, [text(`question ${n}`)]), reply(n + 1, [text(`answer ${n + 1}`)]));
  const fake = core(entries, 251);
  const reader = new CoreTranscriptReader({ history: fake.history });
  let page = await reader.read({ sessionFile: "s", sessionId: "s", publicView: true, maxMessages: 40 });
  assert.equal(page.messages[0].text, "question 261", "the first page is the newest of the current chunk");
  const seen = page.messages.map((m) => m.text);
  while (page.historyPage.hasMore) {
    page = await reader.read({ sessionFile: "s", sessionId: "s", publicView: true, maxMessages: 40, before: page.historyPage.nextCursor });
    seen.unshift(...page.messages.map((m) => m.text));
  }
  assert.equal(seen.length, 300);
  assert.equal(new Set(seen).size, 300);
  assert.equal(seen[0], "question 1");
  assert(fake.asked.every((range) => range === null || range.to < 261), "older pages ask only for entries before the first page");
});

test("a scroll-back cursor must name an entry", async () => {
  const reader = new CoreTranscriptReader({ history: core([user(1, [text("a")])]).history });
  for (const before of ["x", "-1", "1.5", "01"]) {
    await assert.rejects(reader.read({ sessionFile: "s", sessionId: "s", publicView: true, before }), /cursor is invalid/);
  }
});
