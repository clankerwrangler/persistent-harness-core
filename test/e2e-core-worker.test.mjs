// Sessions on the conversation core, end to end: a test supervisor, the core worker,
// the real core binary and a fake provider. Needs PI_HARNESS_CORE_BIN and PI_HARNESS_CORE_JS;
// the Python test also needs an installed kernel runtime under PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";

const ready = Boolean(process.env.PI_HARNESS_CORE_BIN && process.env.PI_HARNESS_CORE_JS);
const runtimeReady = ready && (Boolean(process.env.PI_HARNESS_PYTHON) || (Boolean(process.env.PI_CODING_AGENT_DIR)
  && await access(path.join(process.env.PI_CODING_AGENT_DIR, "harness/kernel-runtime/environments")).then(() => true, () => false)));

const itemText = (item) => typeof item?.content === "string" ? item.content
  : (item?.content ?? []).map((part) => part.text ?? "").join("");
// The request's newest input: a message's text, or a tool call's output. The core's
// context usage line, always last, is not one.
function lastInput(body) {
  const item = body.input.findLast((entry) => !/^Context: about /.test(itemText(entry)));
  if (item?.type === "function_call_output") return { output: String(item.output) };
  return { text: itemText(item) };
}
const allText = (body) => JSON.stringify(body.input);

/** A fake Responses endpoint. `decide(body)` returns a reply: `{ text }` or `{ code }` (an ipython call). */
function fakeProvider(decide) {
  const bodies = [];
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    let reply;
    try { reply = decide(body, bodies.length); } catch (error) { reply = { text: `FAKE_PROVIDER_ERROR ${error.message}` }; }
    if (reply.status) { response.writeHead(reply.status); response.end("fake provider failure"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (reply.code !== undefined) {
      calls += 1;
      send({ type: "response.output_item.done", item: { type: "function_call", id: `fc_${calls}`, call_id: `call_${calls}`,
        name: "ipython", arguments: JSON.stringify({ code: reply.code }) } });
    } else {
      const item = `msg_${bodies.length}`;
      for (const piece of reply.text.match(/.{1,4}/gs)) send({ type: "response.output_text.delta", item_id: item, delta: piece });
      send({ type: "response.output_item.done", item: { type: "message", id: item, content: [{ type: "output_text", text: reply.text }] } });
    }
    send({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } });
    response.end();
  });
  return { server, bodies };
}

// `models`: [provider, id] pairs the fake provider serves; roots start on the first.
// `signedIn: false` leaves the core without any sign-in; `settings` gives the agent folder
// (then its own) a settings.json.
async function harness(t, decide, { models: served = [["test", "m"]], signedIn = true, settings = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-e2e-"));
  const cwd = path.join(root, "project");
  const agentDir = settings ? path.join(root, "agent") : process.env.PI_CODING_AGENT_DIR ?? path.join(root, "agent");
  if (settings) { await mkdir(agentDir, { recursive: true }); await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings)); }
  await mkdir(cwd); await mkdir(agentDir, { recursive: true });
  const provider = fakeProvider(decide);
  await new Promise((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${provider.server.address().port}`;
  const models = path.join(root, "models.json"), auth = path.join(root, "auth.json");
  await writeFile(models, JSON.stringify({ models: Object.fromEntries(served.map(([provider, id]) => [id,
    { provider, id, name: id, api: "openai-responses", baseUrl: base, contextWindow: 100_000, reasoning: false }])) }));
  await writeFile(auth, JSON.stringify(signedIn ? Object.fromEntries(served.map(([provider]) => [provider, { type: "api_key", key: "t" }])) : {}), { mode: 0o600 });
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HARNESS_CORE_ARGS: process.env.PI_HARNESS_CORE_ARGS };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HARNESS_CORE_ARGS = JSON.stringify(["--models", models, "--auth", auth, "--catalog", path.join(root, "catalog"), "--agent-dir", agentDir]);
  const h = { root, cwd, bodies: provider.bodies };
  t.after(async () => {
    await h.client?.stop(); await h.supervisor?.stop();
    provider.server.closeAllConnections(); await new Promise((resolve) => provider.server.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  h.supervisor = new HarnessSupervisor({ socketPath: path.join(root, "s.sock"), databasePath: path.join(root, "harness.sqlite"),
    pidPath: path.join(root, "s.pid"), skillsPath: path.resolve("skills"), actorInactivityMs: 0, maxDepth: 1,
    coreSessionsPath: path.join(root, "sessions"), runtimeDir: path.join(agentDir, "harness/kernel-runtime") });
  await h.supervisor.start();
  h.client = new HarnessClient({ socketPath: path.join(root, "s.sock"), heartbeatMs: 0, requestTimeoutMs: 120_000 });
  await h.client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  h.root = async (name, { unnamedModel = false } = {}) => {
    const model = unnamedModel ? {} : { provider: served[0][0], model: served[0][1] };
    const { admission } = await h.client.request("create_root", { cwd, repositoryRoot: null, name, ...model, thinkingLevel: null });
    await h.client.request("subscribe_session", { selector: admission.sessionId });
    return admission.sessionId;
  };
  return h;
}

function settledOnce(client, id, label = "settled", timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off("event", listener); reject(new Error(`timed out waiting for ${label}`)); }, timeoutMs);
    const listener = (frame) => {
      if (frame.event === "actor_event" && frame.data?.sessionId === id && frame.data.event?.type === "agent_settled") {
        clearTimeout(timer); client.off("event", listener); resolve();
      }
    };
    client.on("event", listener);
  });
}

async function send(h, id, message) {
  const settled = settledOnce(h.client, id, message);
  await h.client.request("submit_input", { sessionId: id, message, behavior: "auto" });
  await settled;
}

async function until(probe, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const replyTexts = async (h, id) => (await h.client.request("get_visible_messages", { sessionId: id })).messages
  .filter((m) => m.role === "assistant").map((m) => m.text);

test("a root session runs on the core: streamed live, saved, shown under one id", { skip: !ready && "core binary not configured" }, async (t) => {
  const replies = ["CORE_WORKER_DONE", "SECOND_REPLY"];
  const h = await harness(t, (body) => lastInput(body).text?.includes("FAIL_ME") ? { status: 500 } : { text: replies.shift() ?? "(no more replies)" });
  const id = await h.root("core-smoke");
  const live = [];
  h.client.on("event", (frame) => {
    const e = frame.data?.event;
    if (frame.event === "actor_event" && frame.data.sessionId === id && e?.type === "message_update") live.push(e);
  });
  await send(h, id, "hello core");

  // Saved through the core, in pi's entry shapes.
  const { entries } = await h.client.request("get_actor_entries", { sessionId: id, since: null });
  assert.deepEqual(entries.filter((e) => e.type === "message").map((e) => e.message.role), ["user", "assistant"]);
  const userContent = entries.find((e) => e.message?.role === "user").message.content;
  assert.equal(userContent[0].harness, "time"); assert.equal(userContent[1].text, "hello core");
  // The reply's text keeps when its first words arrived, and is shown at that time.
  const replyText = entries.find((e) => e.message?.role === "assistant").message.content.find((part) => part.type === "text");
  assert(Number.isSafeInteger(replyText.startedAt));
  const shownReply = (await h.client.request("get_visible_messages", { sessionId: id })).messages.find((m) => m.role === "assistant");
  assert.equal(shownReply.createdAt, new Date(replyText.startedAt).toISOString());

  // Shown once, under the same id it streamed with.
  const visible = await h.client.request("get_visible_messages", { sessionId: id });
  const replyRows = visible.messages.filter((m) => m.role === "assistant");
  assert.deepEqual(replyRows.map((m) => m.text), ["CORE_WORKER_DONE"]);
  assert.ok(live.length > 0, "the reply streamed live");
  assert.ok(live.every((e) => e.messageId === replyRows[0].id), "live text and saved message share one id");
  assert.equal(visible.messages.filter((m) => m.role === "user").length, 1);

  // The request carried the harness's prompt parts and only the Python tools.
  assert.match(JSON.stringify(h.bodies[0].instructions ?? h.bodies[0].input?.[0]), /Session scratch/);
  assert.deepEqual(h.bodies[0].tools.map((tool) => tool.name), ["ipython"]);

  // After its worker stops, the next message continues the same session.
  await h.client.request("stop_session", { sessionId: id });
  await send(h, id, "again");
  assert.deepEqual(await replyTexts(h, id), ["CORE_WORKER_DONE", "SECOND_REPLY"]);
  assert.equal(h.bodies.length, 2);

  // A failed turn is saved, reported to the supervisor, and its receipt saved.
  const failures = [], store = h.supervisor.store, record = store.recordActorTurnFailure.bind(store);
  store.recordActorTurnFailure = (...args) => { failures.push(args[2]); return record(...args); };
  await send(h, id, "FAIL_ME please");
  await until(() => failures.length === 1, "the failure report");
  assert.equal(failures[0].failureClass, "turn_failed");
  assert.equal(failures[0].dispatchBoundary, "provider_dispatch_unknown");
  const saved = await until(async () => {
    const { entries: all } = await h.client.request("get_actor_entries", { sessionId: id, since: null });
    const failure = all.find((e) => e.type === "custom" && e.customType === "persistent-harness.turn-failure-v1");
    const receipt = all.find((e) => e.type === "custom" && e.customType === "persistent-harness.turn-failure-accepted-v1");
    return failure && receipt && { failure, receipt };
  }, "the failure record and its receipt");
  assert.equal(saved.failure.data.turnId, failures[0].turnId);
  assert.equal(saved.receipt.data.entryId, saved.failure.id);
});

test("a turn the core cannot sign in for is reported as failed, never dropped silently", { skip: !ready && "core binary not configured" }, async (t) => {
  const h = await harness(t, () => ({ text: "never sent" }), { signedIn: false });
  const id = await h.root("signed-out");
  const failures = [], store = h.supervisor.store, record = store.recordActorTurnFailure.bind(store);
  store.recordActorTurnFailure = (...args) => { failures.push(args[2]); return record(...args); };
  await send(h, id, "hello");
  await until(() => failures.length === 1, "the failure report");
  assert.equal(failures[0].failureClass, "request_preparation");
  assert.equal(failures[0].dispatchBoundary, "before_provider_dispatch");
  assert.equal(h.bodies.length, 0, "nothing reached the provider");
});

test("a session that names no model starts on the settings' default model and thinking level", { skip: !ready && "core binary not configured" }, async (t) => {
  const h = await harness(t, () => ({ text: "DEFAULT_REPLY" }), { models: [["test", "m"], ["test", "other"]],
    settings: { defaultProvider: "test", defaultModel: "other", defaultThinkingLevel: "high" } });
  const id = await h.root("no-model", { unnamedModel: true });
  await send(h, id, "hello");
  assert.deepEqual(await replyTexts(h, id), ["DEFAULT_REPLY"]);
  assert.equal(h.bodies[0].model, "other");
  // The choice is kept: after the worker stops, the session continues on the same model.
  await h.client.request("stop_session", { sessionId: id });
  await send(h, id, "again");
  assert.equal(h.bodies[1].model, "other");
});

test("Python, a forked child, a family message and a cron run, on the core", { skip: !runtimeReady && "kernel runtime not available", timeout: 300_000 }, async (t) => {
  const h = await harness(t, (body) => {
    const input = lastInput(body), all = allText(body);
    if (input.output !== undefined) return { text: `DONE ${input.output.trim().slice(0, 80)}` };
    const text = input.text;
    if (text.includes("RUN_PY")) return { code: "x = 41\nprint('PY', x + 1)" };
    if (text.includes("SPAWN_CHILD")) return { code: "await rlm('CHILD_TASK do it', name='kid', fork_context=True)" };
    if (text.includes("CHILD_TASK")) return { code: `await agent_message.send('core-family', 'FROM_CHILD ${all.includes("PY 42") ? "saw-parent" : "no-parent"}')` };
    if (text.includes("FROM_CHILD")) return { text: `GOT ${text.match(/FROM_CHILD (\S+)/)?.[1]}` };
    if (text.includes("MAKE_CRON")) return { code: 'job = await cron(action="create", name="Check", prompt="SCHEDULED_CHECK", schedule={"kind":"every","intervalSeconds":3600}, execution_mode="origin", notification_intent="conditional")\nawait cron(action="run", selector=job["job"]["jobId"])\nprint("CRON_STARTED")' };
    if (text.includes("SCHEDULED_CHECK")) {
      const run = text.match(/run ([A-Za-z0-9_-]+)\)/)?.[1];
      return { code: `await cron(action="report", run_id=${JSON.stringify(run)}, disposition="deliver", body="CRON_FINDING")\nprint("REPORTED")` };
    }
    return { text: `UNEXPECTED ${text.slice(0, 60)}` };
  });
  const parent = await h.root("core-family");

  // Python: the call reaches the kernel and its output comes back to the model.
  await send(h, parent, "RUN_PY please");
  assert.deepEqual(await replyTexts(h, parent), ["DONE PY 42"]);

  // A forked child starts from the parent's context and messages the parent back.
  const gotMessage = until(async () => (await replyTexts(h, parent)).some((text) => text.startsWith("GOT")), "the child's message");
  await send(h, parent, "SPAWN_CHILD now");
  await gotMessage;
  assert.ok((await replyTexts(h, parent)).includes("GOT saw-parent"), "the child saw the parent's Python output");
  const childFirst = h.bodies.find((body) => lastInput(body).text?.includes("CHILD_TASK"));
  assert.ok(allText(childFirst).includes("RUN_PY please"), "the fork carries the parent's conversation");
  const childCall = JSON.stringify(childFirst.input.filter((item) => item.type === "function_call"));
  assert.ok(!childCall.includes("rlm("), "the parent's call still running at the fork is left out");

  // Cron: a run of the session's own job arrives as a harness input and reports a finding.
  await send(h, parent, "MAKE_CRON now");
  const notice = await until(async () => (await h.client.request("list_notifications")).notifications.find((n) => n.kind === "cron"), "the cron finding");
  assert.equal(notice.body, "CRON_FINDING");
  const entries = (await h.client.request("get_actor_entries", { sessionId: parent, since: null })).entries;
  assert.ok(entries.some((e) => e.type === "custom_message" && e.details?.source === "cron"), "the cron input is saved as a harness input");
});

test("Fast mode reaches the provider only on a model that offers it", { skip: !ready && "core binary not configured" }, async (t) => {
  const h = await harness(t, () => ({ text: "OK" }), { models: [["openai", "gpt-6.1-sol"], ["test", "m"]] });
  const id = await h.root("fast");
  await send(h, id, "first");
  const initial = await h.client.request("get_session_inference", { sessionId: id });
  assert.equal(initial.fastModeSupported, true);
  await h.client.request("set_session_fast_mode", { sessionId: id, fastMode: true, expected: initial.selection });
  await send(h, id, "fast on");
  assert.equal(h.bodies.at(-1).service_tier, "priority");
  // The preference stays on; a model without Fast mode is asked without it.
  const on = await h.client.request("get_session_inference", { sessionId: id });
  await h.client.request("set_session_inference", { sessionId: id, provider: "test", model: "m", thinkingLevel: on.selection.thinkingLevel, expected: on.selection });
  // The change is recorded as applied: nothing pending, and the session keeps the new model.
  const moved = await h.client.request("get_session_inference", { sessionId: id });
  assert.equal(moved.pending, null); assert.equal(moved.selection.model, "m");
  assert.deepEqual(h.supervisor.store.getSession(id).launch.model.resolved, { provider: "test", id: "m" });
  await send(h, id, "other model");
  assert.equal(h.bodies.at(-1).model, "m");
  assert.equal(h.bodies.at(-1).service_tier, undefined);
});

test("a message's time and shared location reach the model, not the display", { skip: !ready && "core binary not configured" }, async (t) => {
  const h = await harness(t, () => ({ text: "OK" }));
  const id = await h.root("located");
  const location = { latitude: 12.5, longitude: -7.25, accuracy: 30, timestamp: Date.UTC(2026, 10, 9, 8, 0) };
  const settled = settledOnce(h.client, id, "located");
  await h.client.request("submit_input", { sessionId: id, message: "where am I", behavior: "auto", location });
  await settled;
  const sent = allText(h.bodies.at(-1));
  assert.match(sent, /\[\w{3}, \d{1,2} \w{3} \d{4}, \d{2}:\d{2} [^\]]+\]/, "the message leads with its time");
  assert.match(sent, /not independently verified\): latitude 12\.5; longitude -7\.25; accuracy 30 m/);
  const { messages } = await h.client.request("get_visible_messages", { sessionId: id });
  const mine = messages.find((m) => m.role === "user");
  assert.equal(mine.text, "where am I");
  assert.doesNotMatch(JSON.stringify(messages), /latitude|12\.5|not independently/);
});
