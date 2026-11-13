import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CoreWorker } from "../src/core-worker.mjs";
import { PythonRecovery, projectNamespaceRecovery, namespaceRecoveryText } from "../src/python-recovery.mjs";

const identity = (id, generation = 1) => ({ version: 1, sessionId: "s", toolCallId: id, actorGeneration: generation, executionId: `exec-${id}` });
const result = (id, details, extra = {}) => ({ type: "message", message: { role: "toolResult", toolName: "ipython", toolCallId: id,
  ...(details ? { details } : {}), ...extra } });

test("recovery compares canonical checkpoint identity and preserves unknown outcomes", () => {
  const old = identity("old"), expected = identity("new");
  const entries = [result("old", { namespaceCheckpoint: old }),
    result("new", { namespaceCheckpointAttempt: expected, namespaceCheckpointState: "pending", ok: true, executionId: expected.executionId }),
    result("unknown", null, { isError: true }),
    result("blocked", { nativeAsyncRecovery: "not-started" }, { isError: true })];
  const report = projectNamespaceRecovery(entries, { found: true, namespaceCheckpoint: old, skipped: [{ name: "x", reason: "live object" }] });
  assert.deepEqual(report.expectedCheckpoint, expected);
  assert.equal(report.identityMatches, false);
  assert.deepEqual(report.interruptedOrUncheckpointed, [
    { toolCallId: "new", state: "execution-ended-without-checkpoint", executionOk: true },
    { toolCallId: "unknown", state: "interrupted-or-unreported", executionOk: null },
  ]);
  assert.match(namespaceRecoveryText(report), /Do not repeat unknown external side effects/);
  const matched = projectNamespaceRecovery(entries.slice(0, 2), { found: true, namespaceCheckpoint: expected });
  assert.equal(matched.identityMatches, true);
  assert.deepEqual(matched.interruptedOrUncheckpointed, []);
  assert.equal(projectNamespaceRecovery(entries.slice(0, 2), { found: true, namespaceCheckpoint: identity("new", 2) }).identityMatches, false);
});

test("expired newer metadata makes the expected checkpoint unknown", () => {
  const entries = [result("old", { namespaceCheckpoint: identity("old") }),
    { ...result("expired", null), expired: true }];
  const report = projectNamespaceRecovery(entries, { found: true, namespaceCheckpoint: identity("old") });
  assert.equal(report.expectedCheckpoint, null);
  assert.equal(report.identityMatches, false);
  assert.equal(report.historyIncomplete, true);
  assert.deepEqual(report.interruptedOrUncheckpointed, [{ toolCallId: "expired", state: "history-expired", executionOk: null }]);
});

test("a planned cell stays blocked until the current kernel diagnostic is in the request", async () => {
  let kernel = { isRunning: true }, restore = { found: true, namespaceCheckpoint: identity("other") };
  let reads = 0;
  const recovery = new PythonRecovery({ history: async (options) => {
    reads++; assert.equal(options.from, 1);
    assert.deepEqual(options.select.where, { role: "toolResult", toolName: "ipython" });
    return [result("prior", { namespaceCheckpoint: identity("prior") })];
  }, ensureKernel: async () => kernel, currentKernel: () => kernel, restore: () => restore, nativeAsync: () => true });
  const diagnostic = await recovery.reconcile();
  assert.equal(recovery.blocksCall, true);
  recovery.reviewed({ instructions: diagnostic.slice(0, -1) });
  assert.equal(recovery.blocksCall, true, "partial diagnostics do not authorize execution");
  recovery.reviewed({ instructions: diagnostic });
  assert.equal(recovery.blocksCall, false);
  assert.equal(await recovery.reconcile(), diagnostic);
  assert.equal(reads, 1, "a live kernel does not rescan history on every request");
  kernel = { isRunning: true }; restore = { found: false, error: "restore failed" };
  assert.equal(recovery.blocksCall, true, "a replacement invalidates the old request's diagnostic");
  const replacement = await recovery.reconcile();
  assert.match(replacement, /restore failed/);
  recovery.reviewed({ instructions: diagnostic });
  assert.equal(recovery.blocksCall, true, "the old payload cannot authorize the new kernel");
  recovery.reviewed({ instructions: replacement });
  assert.equal(recovery.blocksCall, false);
});

test("ordinary sessions without native history need no kernel until Python is called", async () => {
  let scans = 0, launches = 0;
  const recovery = new PythonRecovery({ history: async () => { scans++; return []; }, ensureKernel: async () => { launches++; },
    currentKernel: () => null, restore: () => null, nativeAsync: () => false });
  assert.equal(await recovery.reconcile(), "");
  assert.equal(await recovery.reconcile(), "");
  assert.equal(scans, 1);
  assert.equal(launches, 0);
  recovery.invalidateHistory();
  await recovery.reconcile(); assert.equal(scans, 2);
});

test("ordinary mode still restores diagnostics for earlier native history", async () => {
  const kernel = { isRunning: true }; let launches = 0;
  const recovery = new PythonRecovery({ history: async () => [result("old", { namespaceCheckpointAttempt: identity("old"),
    namespaceCheckpointState: "pending", executionId: "exec-old", ok: true })],
    ensureKernel: async () => { launches++; return kernel; }, currentKernel: () => kernel,
    restore: () => ({ found: false }), nativeAsync: () => false });
  assert.match(await recovery.reconcile(), /execution-ended-without-checkpoint/);
  assert.equal(launches, 1);
  assert.equal(recovery.blocksCall, true);
});

test("worker blocks a call planned before replacement and admits a later informed call", async (t) => {
  const enabled = process.env.PI_HARNESS_NATIVE_ASYNC;
  process.env.PI_HARNESS_NATIVE_ASYNC = "1";
  t.after(() => { if (enabled === undefined) delete process.env.PI_HARNESS_NATIVE_ASYNC; else process.env.PI_HARNESS_NATIVE_ASYNC = enabled; });
  const entries = [result("prior", { namespaceCheckpoint: identity("prior") })];
  const core = Object.assign(new EventEmitter(), { history: async () => structuredClone(entries) });
  const worker = new CoreWorker({ core, options: { sessionDir: "/unused", sidecarBase: "/unused" },
    env: { PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_GENERATION: "1" }, cwd: "/tmp", agentDir: "/tmp",
    broker: { ui: {} }, publish() {} });
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", compat: { supportsAsyncTools: true } };
  worker.models = [model]; worker.selected = { model, reasoning: "high" }; worker.depth = 1;
  worker.manifest = { skills: [] }; worker.scratch = { directory: "/tmp", rootSessionId: "root" };
  worker.client = { request: async () => ({ fastMode: false }) };
  let executed = 0;
  const makeKernel = () => ({ isRunning: true, snapshotStats: {}, execute: async () => {
    executed++; return { ok: true, outputs: [{ text: "executed" }] };
  } });
  worker.kernel = makeKernel(); worker.lastRestore = { found: true, namespaceCheckpoint: identity("prior") };
  const first = await worker.prepare({ contextFiles: [] });
  assert.match(first.sections.harness, /Checkpoint identities match: true/);
  worker.review({ body: { instructions: first.sections.harness } });
  assert.equal((await worker.prepare({ contextFiles: [] })).reviewRequest, undefined, "a latched kernel does not resend the review body");
  worker.kernel = makeKernel(); worker.lastRestore = { found: false, error: "new restore missing" };
  const blocked = await worker.tool({ call: "a", name: "ipython", arguments: { code: "print('x')" } });
  assert.equal(blocked.isError, true); assert.equal(blocked.details.nativeAsyncRecovery, "not-started"); assert.equal(executed, 0);
  assert.match(blocked.content[0].text, /It did not run/);
  assert.match(blocked.content[0].text, /new restore missing/);
  const second = await worker.prepare({ contextFiles: [] });
  assert.equal(second.reviewRequest, "body");
  worker.review({ body: { instructions: second.sections.harness } });
  const allowed = await worker.tool({ call: "b", name: "ipython", arguments: { code: "print('x')" } });
  assert.equal(allowed.isError, false); assert.equal(executed, 1);
});
