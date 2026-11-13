import assert from "node:assert/strict";
import test from "node:test";
import { boundVisibleHistory } from "../src/visible-page.mjs";

test("a page keeps the newest rows and shortens a single oversized one", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ kind: "message", message: { id: String(index), role: "assistant",
    text: index === 19 ? "x".repeat(100_000) : `m${index}`, createdAt: "2026-01-01T00:00:00Z", status: "complete" } }));
  const result = boundVisibleHistory(history, { maxMessages: 5, maxBytes: 4096 });
  assert.equal(result.truncated, true);
  assert(result.messages.length <= 5);
  assert(Buffer.byteLength(JSON.stringify(result.messages)) <= 4096);
  assert.match(result.messages.at(-1).text, /…$/);
});

test("a page counts progress rows in the same newest bounded suffix", () => {
  const history = [
    { kind: "message", message: { id: "m1", role: "user", text: "old", createdAt: "2026-01-01T00:00:00Z", status: "complete" } },
    ...Array.from({ length: 20 }, (_, index) => ({ kind: "progress", id: `p${index}`, summary: `Progress ${index}`, createdAt: "2026-01-01T00:00:00Z" })),
  ];
  const result = boundVisibleHistory(history, { maxMessages: 5, maxBytes: 2048 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.history.map((item) => item.id), ["p15", "p16", "p17", "p18", "p19"]);
  assert(Buffer.byteLength(JSON.stringify({ messages: result.messages, history: result.history })) <= 2048);
});
