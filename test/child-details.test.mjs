// A parent reads one direct child's full record by name or ID; it cannot read other sessions.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures/notification-supervisor.mjs";

test("get_child returns one direct child's record and refuses anything else", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const parent = await f.actor(), child = await f.actor(parent.session.sessionId), other = await f.actor();
  const ask = selector => parent.connection.request("get_child", { selector });
  const byId = (await ask(child.session.sessionId)).child;
  assert.equal(byId.sessionId, child.session.sessionId); assert.equal(byId.parentSessionId, parent.session.sessionId);
  assert.equal((await ask(byId.shortId)).child.sessionId, child.session.sessionId);
  assert.equal((await ask(byId.name)).child.sessionId, child.session.sessionId);
  await assert.rejects(ask(other.session.sessionId), /no direct child/);
  await assert.rejects(ask(parent.session.sessionId), /no direct child/);
});
