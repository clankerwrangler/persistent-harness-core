// Real core, worker and Python kernel: recovery is visible before a planned cell runs.
import assert from "node:assert/strict";
import { rm, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { coreLiveFixture, until } from "./fixtures/core-live.mjs";

const ready = Boolean(process.env.PI_HARNESS_CORE_BIN && process.env.PI_HARNESS_CORE_JS && process.env.PI_HARNESS_PYTHON);
const call = (name, id, args, async = false) => ({ type: "response.output_item.done", item: {
  type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args),
  ...(async ? { async: true } : {}), status: "completed" } });
const finish = (send, response, index) => {
  send(response, { type: "response.completed", response: { id: `response-${index}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } });
  response.end();
};

test("a restored namespace mismatch reaches the next provider request", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  let f, resumedBody;
  f = await coreLiveFixture(t, "namespace-reopen", ({ response, body, index, send, done }) => {
    if (index === 1) {
      assert.match(body.instructions, /Python namespace recovery diagnostic/);
      send(response, call("ipython", "seed", { code: "recovery_value = 7\nprint('SEED_DONE')" }, true));
      send(response, call("wait_for_ipython", "wait", {}));
    } else if (index === 2) done(response, 0, "SEED_ACCEPTED");
    else {
      resumedBody = body;
      assert.match(body.instructions, /Python namespace recovery diagnostic/);
      assert.match(body.instructions, /Checkpoint identities match: false/);
      assert.match(body.instructions, /execution-ended-without-checkpoint/);
      assert.match(body.instructions, /Do not repeat unknown external side effects/);
      done(response, 0, "MISMATCH_REPORTED");
    }
    finish(send, response, index);
  }, { nativeAsync: true, maxRequests: 3 });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "seed namespace", behavior: "auto" });
  await until(() => f.events.some((event) => event.type === "agent_settled"), "the seed turn settles");
  const session = f.supervisor.store.getSession(f.sessionId);
  assert(session?.sessionFile);
  await f.client.request("stop_session", { sessionId: f.sessionId });
  await rm(`${session.sessionFile}.kernel-state`, { recursive: true, force: true });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "resume namespace", behavior: "auto" });
  await until(async () => (await f.visible()).some((row) => row.text === "MISMATCH_REPORTED"), "the mismatch answer");
  t.diagnostic(`synthetic resumed provider body: ${Buffer.byteLength(JSON.stringify(resumedBody))} bytes; one body-only review before this kernel is latched`);
});

test("a cell planned before an in-flight kernel replacement does not run", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  let f;
  f = await coreLiveFixture(t, "namespace-inflight", async ({ response, body, index, send, done }) => {
    if (index === 1) {
      send(response, call("ipython", "lost", { code: "import os\nos._exit(7)" }, true));
      await until(() => f.toolEnded("lost"), "the interrupted call is handled");
      send(response, call("ipython", "planned", { code: "open('SHOULD_NOT_EXIST', 'w').write('bad')" }));
    } else {
      const outputs = body.input.filter((item) => item.type === "function_call_output");
      const lost = outputs.find((item) => item.call_id === "lost");
      const blocked = outputs.find((item) => item.call_id === "planned");
      assert.match(JSON.stringify(lost?.output), /Python namespace recovery diagnostic/);
      assert.match(JSON.stringify(blocked?.output), /It did not run/);
      assert.match(JSON.stringify(blocked?.output), /Python namespace recovery diagnostic/);
      done(response, 0, "PLANNED_CELL_BLOCKED");
    }
    finish(send, response, index);
  }, { nativeAsync: true, maxRequests: 2 });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "exercise recovery", behavior: "auto" });
  await until(async () => (await f.visible()).some((row) => row.text === "PLANNED_CELL_BLOCKED"), "the blocked-call answer");
  assert.equal(await access(path.join(f.cwd, "SHOULD_NOT_EXIST")).then(() => true, () => false), false);
});

test("expired historical recovery facts are reported as unknown across checkpoints", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  let f;
  f = await coreLiveFixture(t, "namespace-expired", ({ response, body, index, send, done }) => {
    if (index === 1) {
      send(response, call("ipython", "seed", { code: "recovery_value = 7\nprint('SEED_DONE')" }, true));
      send(response, call("wait_for_ipython", "wait", {}));
    } else if (index === 2) done(response, 0, "EXPIRED_SEED_ACCEPTED");
    else {
      assert.match(body.instructions, /Historical recovery facts expired: true/);
      assert.match(body.instructions, /history-expired/);
      assert.match(body.instructions, /Checkpoint identities match: false/);
      done(response, 0, "EXPIRED_HISTORY_REPORTED");
    }
    finish(send, response, index);
  }, { nativeAsync: true, maxRequests: 3 });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "seed namespace", behavior: "auto" });
  await until(() => f.events.some((event) => event.type === "agent_settled"), "the seed turn settles");
  const session = f.supervisor.store.getSession(f.sessionId);
  assert(session?.sessionFile);
  await f.client.request("stop_session", { sessionId: f.sessionId });
  const { Core } = await import(pathToFileURL(process.env.PI_HARNESS_CORE_JS).href);
  const core = Core.start({ bin: process.env.PI_HARNESS_CORE_BIN, dir: session.sessionFile });
  try { await core.checkpoint([{ role: "user", content: [{ type: "text", text: "edited context" }] }]); }
  finally { await core.close(); }
  await rm(path.join(session.sessionFile, "log/000001.payload.jsonl"));
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "resume after expiration", behavior: "auto" });
  await until(async () => (await f.visible()).some((row) => row.text === "EXPIRED_HISTORY_REPORTED"), "the expired-history answer");
});
