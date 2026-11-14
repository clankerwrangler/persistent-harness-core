import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { PythonStepLog } from "../src/python-steps.mjs";
import { PythonRecovery, projectNamespaceRecovery, namespaceRecoveryText } from "../src/python-recovery.mjs";

const identity = (id) => ({ version: 1, sessionId: "s", toolCallId: id, actorGeneration: 1, executionId: `exec-${id}` });
const pendingDetails = (id, ok = true) => ({ ok, executionId: `exec-${id}`, namespaceCheckpointAttempt: identity(id), namespaceCheckpointState: "pending" });
const result = (id, details, extra = {}) => ({ type: "message", message: { role: "toolResult", toolName: "ipython", toolCallId: id,
  ...(details ? { details } : {}), ...extra } });

async function folder(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-steps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "session.python-steps.json");
}

test("a cell that never returned is reported as interrupted after a stop", async (t) => {
  const file = await folder(t);
  const log = await PythonStepLog.create(file);
  await log.started("a"); await log.finished("a", pendingDetails("a"));
  await log.checkpointed("a", { ok: true, namespaceCheckpoint: identity("a") });
  await log.started("b");
  // The process stops here; the next start reads the record from disk.
  const report = (await PythonStepLog.load(file)).report({ found: true, namespaceCheckpoint: identity("a") });
  assert.deepEqual(report.expectedCheckpoint, identity("a"));
  assert.equal(report.identityMatches, true);
  assert.deepEqual(report.interruptedOrUncheckpointed, [{ toolCallId: "b", state: "interrupted-or-unreported", executionOk: null }]);
});

test("a save clears the steps it covers, so the record stays small", async (t) => {
  const file = await folder(t);
  const log = await PythonStepLog.create(file);
  for (const id of ["a", "b", "c"]) { await log.started(id); await log.finished(id, pendingDetails(id)); }
  await log.checkpointed("c", { ok: true, namespaceCheckpoint: identity("c") });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.steps, []);
  assert.deepEqual(saved.saved, identity("c"));
  assert.deepEqual(log.report({ found: true, namespaceCheckpoint: identity("c") }).interruptedOrUncheckpointed, []);
});

test("a save still in progress at a stop is reported only when the restored namespace is older", async (t) => {
  const file = await folder(t);
  const log = await PythonStepLog.create(file);
  await log.started("a"); await log.finished("a", pendingDetails("a"));
  await log.checkpointed("a", { ok: true, namespaceCheckpoint: identity("a") });
  await log.started("b"); await log.finished("b", pendingDetails("b"));
  const reread = await PythonStepLog.load(file);
  // The kernel wrote the namespace before the stop, but the record did not hear of it.
  const written = reread.report({ found: true, namespaceCheckpoint: identity("b") });
  assert.equal(written.identityMatches, true);
  assert.deepEqual(written.interruptedOrUncheckpointed, []);
  const lost = reread.report({ found: true, namespaceCheckpoint: identity("a") });
  assert.deepEqual(lost.expectedCheckpoint, identity("b"));
  assert.equal(lost.identityMatches, false);
  assert.deepEqual(lost.interruptedOrUncheckpointed, [{ toolCallId: "b", state: "execution-ended-without-checkpoint", executionOk: true }]);
});

test("a failed background save leaves the older namespace expected and names the unsaved cell", async (t) => {
  const file = await folder(t);
  const log = await PythonStepLog.create(file);
  await log.started("a"); await log.finished("a", pendingDetails("a"));
  await log.checkpointed("a", { ok: true, namespaceCheckpoint: identity("a") });
  await log.started("b"); await log.finished("b", pendingDetails("b", false));
  await log.checkpointed("b", { ok: false, error: "disk full" });
  const report = log.report({ found: true, namespaceCheckpoint: identity("a") });
  assert.deepEqual(report.expectedCheckpoint, identity("a"));
  assert.equal(report.identityMatches, true);
  assert.deepEqual(report.interruptedOrUncheckpointed, [{ toolCallId: "b", state: "execution-ended-without-checkpoint", executionOk: false }]);
});

test("the record gives the same report as reading history for the usual cases", async (t) => {
  const cases = {
    "saved, then a stop mid-cell": { steps: [["a", "saved"], ["b", "running"]], history: [result("a", { namespaceCheckpoint: identity("a") }), result("b", null, { isError: true })], restored: "a" },
    "a save in progress, written": { steps: [["a", "saved"], ["b", "pending"]], history: [result("a", { namespaceCheckpoint: identity("a") }), result("b", pendingDetails("b"))], restored: "b" },
    "a save in progress, lost": { steps: [["a", "saved"], ["b", "pending"]], history: [result("a", { namespaceCheckpoint: identity("a") }), result("b", pendingDetails("b"))], restored: "a" },
    "a finished save, then the saved namespace lost": { steps: [["a", "saved"]], history: [result("a", pendingDetails("a"))], restored: null },
  };
  for (const [name, { steps, history, restored }] of Object.entries(cases)) {
    const log = await PythonStepLog.create(await folder(t));
    for (const [id, state] of steps) {
      await log.started(id);
      if (state === "running") continue;
      await log.finished(id, pendingDetails(id));
      if (state === "saved") await log.checkpointed(id, { ok: true, namespaceCheckpoint: identity(id) });
    }
    const restore = restored ? { found: true, namespaceCheckpoint: identity(restored) } : { found: false };
    assert.deepEqual(log.report(restore), projectNamespaceRecovery(history, restore), name);
  }
});

test("history is read once to start the record; later starts read only the record", async (t) => {
  const file = await folder(t);
  const kernel = { isRunning: true }, restore = { found: true, namespaceCheckpoint: identity("old") };
  const history = [result("old", { namespaceCheckpoint: identity("old") }), result("lost", null, { isError: true }),
    result("new", pendingDetails("new"))];
  let reads = 0;
  const recovery = () => new PythonRecovery({ history: async () => { reads++; return structuredClone(history); },
    ensureKernel: async () => kernel, currentKernel: () => null, restore: () => restore, nativeAsync: () => true, stepsPath: file });
  const first = await recovery().reconcile();
  assert.equal(reads, 1);
  assert.equal(first, namespaceRecoveryText(projectNamespaceRecovery(history, restore)));
  const later = await recovery().reconcile();
  assert.equal(reads, 1, "a later start does not read history");
  assert.equal(later, first, "and says the same");
  // When the restored namespace is the expected one, the expected call is not listed.
  const matched = { found: true, namespaceCheckpoint: identity("new") };
  const again = new PythonRecovery({ history: async () => { throw new Error("history read"); }, ensureKernel: async () => kernel,
    currentKernel: () => null, restore: () => matched, nativeAsync: () => true, stepsPath: file });
  assert.equal(await again.reconcile(), namespaceRecoveryText(projectNamespaceRecovery(history, matched)));
});

test("a record that cannot be written leaves the history check in place", async (t) => {
  const missing = path.join(path.dirname(await folder(t)), "no-such-folder", "session.python-steps.json");
  let reads = 0;
  const recovery = new PythonRecovery({ history: async () => { reads++; return [result("a", { namespaceCheckpoint: identity("a") })]; },
    ensureKernel: async () => ({ isRunning: true }), currentKernel: () => null, restore: () => ({ found: true, namespaceCheckpoint: identity("a") }),
    nativeAsync: () => true, stepsPath: missing });
  assert.match(await recovery.reconcile(), /Checkpoint identities match: true/);
  await recovery.stepStarted("b");
  assert.equal(recovery.steps, null);
  await recovery.reconcile();
  assert.equal(reads, 2);
});
