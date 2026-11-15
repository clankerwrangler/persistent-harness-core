import assert from "node:assert/strict";
import test from "node:test";
import { LiveView } from "../src/live-view.mjs";
import { PRESENTATION_SCHEMA } from "../src/presentation-directive.mjs";

const usage = { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 };
const run = (view, events) => events.flatMap((event) => view.core(event, "openai-codex"));
const shown = (frames) => frames.filter((frame) => frame.type === "live_event" && frame.event).map((frame) => frame.event);

test("streamed text is shown under the ids its saved message will have", () => {
  const frames = run(new LiveView(), [
    { ev: "turn_start" },
    { ev: "text_delta", attempt: 1, item: "item-a", delta: "First " },
    { ev: "text_delta", attempt: 1, item: "item-a", delta: "part." },
    { ev: "text_delta", attempt: 1, item: "item-b", delta: "Second part." },
    { ev: "message_end", attempt: 1, stopReason: "stop", usage, n: 3 },
    { ev: "settled" },
  ]);
  const events = shown(frames);
  assert.deepEqual(events.map((event) => event.assistantMessageEvent?.type ?? event.type), [
    "agent_start", "text_start", "text_delta", "text_delta", "text_end", "text_start", "text_delta", "text_end", "message_end", "agent_settled"]);
  const end = events.find((event) => event.type === "message_end");
  assert.deepEqual(end.message.content.map((part) => part.text), ["First part.", "Second part."]);
  const liveIds = [...new Set(events.filter((event) => event.type === "message_update").map((event) => event.messageId))];
  assert.deepEqual(liveIds, end.message.content.map((part) => part.id), "live rows meet their saved message");
  assert.equal(liveIds.length, 2);
  assert.equal(events.find((event) => event.assistantMessageEvent?.type === "text_end").assistantMessageEvent.text, "First part.");
  assert(!frames.some((frame) => frame.drop), "text the provider named needs no dropping");
  assert.equal(frames.at(-1).failure, null);
});

test("text the provider gave no id is dropped from the live rows once saved", () => {
  const frames = run(new LiveView(), [
    { ev: "turn_start" }, { ev: "text_delta", attempt: 1, delta: "Unnamed." }, { ev: "message_end", attempt: 1, stopReason: "stop", usage }, { ev: "settled" }]);
  const end = frames.find((frame) => frame.event?.type === "message_end");
  assert.deepEqual(end.drop, [shown(frames).find((event) => event.type === "message_update").messageId]);
});

test("a chained turn is activity, not a new working stretch; a failed reply is the settled turn's failure", () => {
  const view = new LiveView();
  assert.deepEqual(shown(view.core({ ev: "turn_start" })).map((event) => event.type), ["agent_start"]);
  assert.deepEqual(view.core({ ev: "turn_start" }), [{ type: "live_activity" }]);
  assert.deepEqual(view.core({ ev: "error", n: 4, error: "provider refused" }), []);
  const settled = view.core({ ev: "settled" });
  assert.equal(settled.length, 1); assert.equal(settled[0].event.type, "agent_settled");
  assert.equal(settled[0].failure, "provider refused");
  assert.deepEqual(view.core({ ev: "settled" }), [], "settling twice says nothing");
  view.core({ ev: "turn_start" });
  assert.equal(view.core({ ev: "settled" })[0].failure, "assistant turn settled without a message");
});

test("tool runs are shown by call and name only", () => {
  const frames = run(new LiveView(), [{ ev: "turn_start" },
    { ev: "tool_call", call: "c1", name: "ipython", arguments: { code: "secret()" } },
    { ev: "tool_result", call: "c1", result: { content: [{ type: "text", text: "secret output" }] } },
    { ev: "tool_call", call: "c2", name: "read" }, { ev: "cancel", calls: ["c2"] }]);
  assert.deepEqual(shown(frames).slice(1), [{ type: "tool_execution_start", toolCallId: "c1", toolName: "ipython" },
    { type: "tool_execution_end", toolCallId: "c1" }, { type: "tool_execution_start", toolCallId: "c2", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "c2" }]);
  assert.doesNotMatch(JSON.stringify(frames), /secret/);
});

test("a root's presentation directive is left out of what is shown and told to the reply feed", () => {
  const marker = `<!-- ${PRESENTATION_SCHEMA} body=happy face=smile -->\n`, directive = new RegExp(PRESENTATION_SCHEMA.replace(/\./g, "\\."));
  const events = [{ ev: "turn_start" }, { ev: "text_delta", attempt: 1, item: "i", delta: marker },
    { ev: "text_delta", attempt: 1, item: "i", delta: "Hello." }, { ev: "message_end", attempt: 1, stopReason: "stop", usage }, { ev: "settled" }];
  const root = run(new LiveView({ presentation: true }), events);
  assert.doesNotMatch(JSON.stringify(shown(root)), directive);
  assert.equal(shown(root).find((event) => event.type === "message_end").message.content[0].text, "Hello.");
  const quiet = root.find((frame) => frame.event === null);
  assert(quiet && !quiet.feed, "the directive alone shows nothing");
  const feed = root.map((frame) => frame.feed).filter(Boolean);
  assert.deepEqual(feed.map((item) => item.type), ["agent_start", "text_delta", "assistant_terminal", "agent_settled"]);
  assert.deepEqual(feed[1], { type: "text_delta", contentIndex: 0, delta: "Hello.", presentation: { schema: PRESENTATION_SCHEMA, body: "happy", face: "smile" } });
  assert.equal(feed[2].text, "Hello."); assert.equal(feed[2].stopReason, "stop");
  const child = run(new LiveView(), events);
  assert(child.every((frame) => !frame.feed), "only a root has a reply feed");
  assert.match(shown(child).find((event) => event.type === "message_end").message.content[0].text, directive);
});

test("an oversized reply is shown truncated and fails the reply feed's turn", () => {
  const frames = run(new LiveView({ presentation: true }), [{ ev: "turn_start" },
    { ev: "text_delta", attempt: 1, item: "i", delta: "d".repeat(40 * 1024) }, { ev: "message_end", attempt: 1, stopReason: "stop", usage }]);
  const events = shown(frames);
  assert(events.some((event) => event.type === "message_update" && event.truncated));
  const end = events.find((event) => event.type === "message_end");
  assert.equal(end.truncated, true); assert.equal(end.message.content[0].text, "");
  assert.deepEqual(frames.map((frame) => frame.feed?.type).filter(Boolean), ["agent_start", "failed", "failed", "assistant_terminal"]);
  assert.equal(frames.at(-1).feed.truncated, true);
});
