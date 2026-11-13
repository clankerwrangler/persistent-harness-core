import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { CoreWorker } from "../src/core-worker.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";

// The core as the worker sees it through the library, with a history it can grow.
function fakeCore(history) {
  return Object.assign(new EventEmitter(), {
    busy: false,
    setModel: async () => ({ model: null, reasoning: null }),
    models: async () => [],
    history: async () => structuredClone(history),
    record: async () => history.length + 1,
    idle: async () => {}, close: async () => {},
  });
}

function supervisorConnection(t) {
  const requests = [];
  t.mock.method(HarnessClient.prototype, "start", async () => ({ session: { depth: 0 }, scratch: { directory: os.tmpdir(), rootSessionId: "root" } }));
  t.mock.method(HarnessClient.prototype, "stop", async () => {});
  t.mock.getter(HarnessClient.prototype, "isConnected", () => true);
  t.mock.method(HarnessClient.prototype, "request", async (type, params) => { requests.push({ type, params }); return { recorded: true }; });
  return requests;
}

const userEntry = (id, inputId) => ({ type: "message", id, timestamp: new Date(1).toISOString(),
  message: { role: "user", id: inputId, content: [{ type: "text", text: "hello" }], timestamp: 1 } });

test("inputs already in history at startup are the supervisor's to reconcile; new ones are reported once", async (t) => {
  const requests = supervisorConnection(t);
  const input = { inputId: "cron-input", sessionId: "s", source: "cron", origin: { jobId: "job", runId: "run" }, message: "Run", acceptedAt: 1 };
  const history = [userEntry("1", "old-user-input"), { type: "custom_message", id: "2", timestamp: new Date(2).toISOString(), ...actorInputCustomPayload(input) }];
  const core = fakeCore(history);
  const worker = new CoreWorker({ core, options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish() {}, agentDir: os.tmpdir() });
  await worker.start();
  assert.deepEqual(requests.filter((r) => r.type === "record_input_delivery"), [], "startup does not sweep history");

  // A message the person sent now is saved by the core, then the turn starts.
  history.push(userEntry("3", "new-input"));
  core.emit("event", { ev: "turn_start" });
  for (let i = 0; i < 20 && !requests.some((r) => r.type === "record_input_delivery"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  core.emit("event", { ev: "settled", through: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requests.filter((r) => r.type === "record_input_delivery").map((r) => r.params),
    [{ inputId: "new-input", entryId: "3", deliveredAt: new Date(1).toISOString() }]);
  await worker.close();
});

test("an input has one report in flight at a time; one saved during a report is reported after it", async (t) => {
  const reports = [], gate = Promise.withResolvers();
  let inFlight = 0, most = 0;
  t.mock.method(HarnessClient.prototype, "start", async () => ({ session: { depth: 0 }, scratch: { directory: os.tmpdir(), rootSessionId: "root" } }));
  t.mock.method(HarnessClient.prototype, "stop", async () => {});
  t.mock.getter(HarnessClient.prototype, "isConnected", () => true);
  t.mock.method(HarnessClient.prototype, "request", async (type, params) => {
    if (type !== "record_input_delivery") return {};
    inFlight++; most = Math.max(most, inFlight); reports.push(params.inputId);
    await gate.promise; inFlight--;
    return { accepted: true };
  });
  const history = [];
  const core = fakeCore(history);
  const worker = new CoreWorker({ core, options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish() {}, agentDir: os.tmpdir() });
  await worker.start();
  history.push(userEntry("1", "first"));
  // Turn start, then settle, while the first report is still held: three report requests.
  core.emit("event", { ev: "turn_start" });
  for (let i = 0; i < 100 && reports.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  core.emit("event", { ev: "settled", through: null });
  history.push(userEntry("2", "second"));
  core.emit("event", { ev: "turn_start" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reports, ["first"], "no second report while the first is in flight");
  gate.resolve();
  for (let i = 0; i < 100 && reports.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reports, ["first", "second"]);
  assert.equal(most, 1);
  await worker.close();
});

test("a model list reload that fails or runs out of time says so and keeps the last list", async () => {
  const listed = [{ provider: "p", id: "kept" }];
  let models = async () => listed;
  const core = Object.assign(fakeCore([]), { models: () => models() });
  const worker = new CoreWorker({ core, options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish() {}, agentDir: os.tmpdir() });
  const registry = worker.hostContext().modelRegistry;
  assert.deepEqual(await registry.refresh(), { aborted: false, errors: new Map() });
  assert.deepEqual(registry.getAvailable(), listed);
  models = async () => { throw new Error("catalog unreadable"); };
  const failed = await registry.refresh();
  assert.equal(failed.errors.size, 1); assert.deepEqual(registry.getAvailable(), listed);
  models = () => new Promise(() => {});
  const timedOut = await registry.refresh({ signal: AbortSignal.timeout(20) });
  assert.equal(timedOut.aborted, true); assert.deepEqual(registry.getAvailable(), listed);
});

test("tool events reach the supervisor without their arguments or results", async (t) => {
  supervisorConnection(t);
  const core = fakeCore([]), published = [];
  const worker = new CoreWorker({ core, options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish: (frame) => published.push(frame), agentDir: os.tmpdir() });
  await worker.start();
  core.emit("event", { ev: "tool_call", call: "c1", name: "read", arguments: { path: "x".repeat(100_000) }, async: false, builtin: true });
  core.emit("event", { ev: "tool_result", call: "c1", result: { content: [{ type: "text", text: "y".repeat(100_000) }] } });
  const events = published.filter((frame) => frame.type === "core_event").map((frame) => frame.event);
  assert.deepEqual(events, [{ ev: "tool_call", call: "c1", name: "read" }, { ev: "tool_result", call: "c1" }]);
  await worker.close();
});

test("after a restart the tool-result quiet stretch counts from the last time given", async (t) => {
  supervisorConnection(t);
  const when = new Date(Date.UTC(2026, 10, 9, 8, 0)).toISOString();
  const history = [userEntry("1", "old"), { type: "message", id: "2", timestamp: when,
    message: { role: "user", content: [{ type: "text", text: "[time]", harness: "time" }, { type: "text", text: "later" }], timestamp: 2 } },
    { type: "message", id: "3", timestamp: new Date(Date.UTC(2026, 10, 9, 9, 0)).toISOString(), message: { role: "assistant", content: [], timestamp: 3 } }];
  const worker = new CoreWorker({ core: fakeCore(history), options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish() {}, agentDir: os.tmpdir() });
  await worker.start();
  assert.equal(worker.clock.last, Date.parse(when));
  await worker.close();
});

test("a model change during a turn waits for the session to settle, then is reported applied", async (t) => {
  supervisorConnection(t);
  const set = [], published = [];
  const core = Object.assign(fakeCore([]), {
    models: async () => [{ provider: "p", id: "a", api: "openai-responses", contextWindow: 1000 }, { provider: "p", id: "b", api: "openai-responses", contextWindow: 2000 }],
    setModel: async (change) => { set.push(change); return { model: null, reasoning: null }; },
  });
  const worker = new CoreWorker({ core, options: { sessionDir: "/nonexistent", sidecarBase: "/nonexistent" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "token", PI_HARNESS_ACTOR_GENERATION: "1" },
    cwd: os.tmpdir(), broker: { ui: { notify() {} }, close() {}, cancelAll() {} }, publish: (frame) => published.push(frame), agentDir: os.tmpdir() });
  await worker.start();
  set.length = 0;
  core.busy = true;
  assert.deepEqual(await worker.handle({ type: "select_inference", requestId: "r1", provider: "p", model: "a", thinkingLevel: "off" }), { accepted: true });
  assert.deepEqual(await worker.handle({ type: "select_inference", requestId: "r2", provider: "p", model: "b", thinkingLevel: "off" }), { accepted: true });
  assert.deepEqual(set, [], "nothing changes mid-turn");
  core.busy = false;
  core.emit("event", { ev: "settled", through: null });
  for (let i = 0; i < 50 && !published.some((f) => f.type === "inference_selection_applied"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(set, [{ provider: "p", model: "b", reasoning: "off" }], "the latest change lands once");
  const applied = published.filter((f) => f.type === "inference_selection_applied");
  assert.deepEqual(applied.map((f) => [f.requestId, f.selection.model, f.selection.contextWindow]), [["r2", "b", 2000]]);
  await worker.close();
});
