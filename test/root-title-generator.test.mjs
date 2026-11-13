import assert from "node:assert/strict";
import test from "node:test";
import { createRootTitleGenerator } from "../src/root-title-generator.mjs";

// The session's worker makes the request through its core (`complete`); this records it.
function fakeComplete(calls, result = {}) {
  return async (request) => {
    calls.push(request);
    return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: 'Title: "Semantic Session Titles"' }], ...result };
  };
}

test("titles use the session's own model through its core, as one request outside the conversation", async () => {
  const generate = createRootTitleGenerator();
  for (const selection of [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openrouter", id: "z-ai/glm-5.3" },
    { provider: "grok-cli", id: "grok-4.6" },
  ]) {
    const calls = [];
    assert.equal(await generate({ userText: "It's broken again.", assistantText: "The provider used for session titles is wrong." },
      selection, fakeComplete(calls)), "Semantic Session Titles");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].model, selection);
    assert.match(calls[0].instructions, /metadata/i);
    assert.match(JSON.stringify(calls[0].messages), /broken again/);
    assert.match(JSON.stringify(calls[0].messages), /provider used for session titles/);
    assert.equal(calls[0].tools, undefined);
  }
});

test("unknown selection, no running session and provider failures never fall back", async () => {
  const calls = [];
  const generate = createRootTitleGenerator();
  const turn = { userText: "Why did session titles break?", assistantText: "The title provider is unavailable." };
  await assert.rejects(generate(turn, undefined, fakeComplete(calls)), /session model/);
  await assert.rejects(generate(turn, { provider: "openai-codex", id: "m" }, undefined), /cannot make requests/);
  assert.equal(calls.length, 0);
  await assert.rejects(generate(turn, { provider: "openai-codex", id: "m" }, fakeComplete(calls, { stopReason: "error", errorMessage: "private" })), /title model.*error/);
  assert.equal(calls.length, 1);
});

test("title failures and output truncation cannot become a partial generated title", async () => {
  for (const stopReason of ["length", "aborted", "error", "toolUse"]) {
    const generate = createRootTitleGenerator();
    await assert.rejects(generate({ userText: "Synthetic fixture", assistantText: "Session title generation" },
      { provider: "openai-codex", id: "m" }, fakeComplete([], { stopReason })), /title model/);
  }
});

test("a request that never answers times out instead of holding the title", async () => {
  const generate = createRootTitleGenerator({ timeoutMs: 50 });
  await assert.rejects(generate({ userText: "Synthetic fixture", assistantText: "Session title generation" },
    { provider: "openai-codex", id: "m" }, () => new Promise(() => {})), /timed out/);
});
