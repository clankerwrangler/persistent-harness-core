import assert from "node:assert/strict";
import test from "node:test";
import { CoreTranscriptReader } from "../src/core-transcript-reader.mjs";
import { fixture } from "./fixtures/notification-supervisor.mjs";

const image = { type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };

test("image RPC admits root tool images without exposing child results or changing input delivery", async t => {
  // Each session's history as the core hands it out (complete entries, pi's shapes).
  const histories = new Map();
  const transcriptReader = new CoreTranscriptReader({ history: async sessionFile => histories.get(sessionFile) ?? [] });
  const f = await fixture(t, { transcriptReader }), root = await f.actor(), child = await f.actor(root.session.sessionId);
  for (const actor of [root, child]) histories.set(actor.session.sessionFile, [
    { type: "message", id: "input", timestamp: new Date(1).toISOString(), message: { role: "user", content: [image], timestamp: 1 } },
    { type: "message", id: "output", timestamp: new Date(2).toISOString(), message: { role: "toolResult", content: [image], timestamp: 2 } },
  ]);
  for (const actor of [root, child]) {
    const visible = await f.client.request("get_visible_messages", { sessionId: actor.session.sessionId });
    const output = visible.messages.find(row => row.id === "output");
    if (actor === root) {
      assert.equal(output.role, "tool_output"); assert.equal(output.text, "");
      assert.deepEqual(output.images[0].ref, { entryId: "output", index: 0 });
      assert.equal("data" in output.images[0], false);
    } else assert.equal(output, undefined);
  }
  const get = (sessionId, entryId) => f.client.request("get_visible_image", { sessionId, entryId, index: 0 });
  assert.deepEqual((await get(root.session.sessionId, "output")).image, image);
  await assert.rejects(get(child.session.sessionId, "output"), /does not exist/);
  for (const actor of [root, child]) assert.deepEqual((await get(actor.session.sessionId, "input")).image, image);
  const pending = f.supervisor.store.createActorInput(root.session.sessionId,
    { inputId: "pending-image", message: "", images: [image] });
  assert.deepEqual((await get(root.session.sessionId, pending.inputId)).image, image);
  await assert.rejects(get("missing-session", "output"), /canonical history/);
  await assert.rejects(root.connection.request("get_visible_image", { sessionId: root.session.sessionId, entryId: "output", index: 0 }), /not available/);
  f.supervisor.store.deleteSession(child.session.sessionId);
  await assert.rejects(get(child.session.sessionId, "input"), /canonical history/);
});
