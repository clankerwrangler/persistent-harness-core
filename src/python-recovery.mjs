// Reconcile the restored Python namespace with the session's Python steps. The session's own
// step record (python-steps.mjs) answers this; canonical tool-result history is read only
// once, to start that record for a session that has none yet.
import { rm } from "node:fs/promises";
import { PythonStepLog } from "./python-steps.mjs";

const SELECT = Object.freeze({
  where: { role: "toolResult", toolName: "ipython" },
  fields: ["role", "toolCallId", "toolName", "isError"],
  details: [...["namespaceCheckpoint", "namespaceCheckpointAttempt"].flatMap((field) =>
    ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"].map((key) => `${field}.${key}`)),
    "namespaceCheckpointState", "nativeAsyncRecovery", "executionId", "executionOk", "ok"],
});

/** The top-level tool-result detail fields recovery reads: the daily cleanup keeps these
 * when it deletes old tool output, so recovery sees old calls as before, not expired. */
export const RECOVERY_DETAIL_FIELDS = Object.freeze([...new Set(SELECT.details.map((field) => field.split(".")[0]))]);

export function projectNamespaceRecovery(entries, restore) {
  const results = entries.filter((entry) => entry.type === "message"
    && entry.message?.role === "toolResult" && entry.message.toolName === "ipython");
  const expectedIndex = results.findLastIndex(({ message }) => message.details?.namespaceCheckpoint
    || message.details?.namespaceCheckpointState === "pending");
  const newestExpired = results.findLastIndex((entry) => entry.expired === true);
  const expectedResult = newestExpired > expectedIndex ? undefined : results[expectedIndex]?.message;
  const expectedCheckpoint = expectedResult?.details?.namespaceCheckpoint ?? expectedResult?.details?.namespaceCheckpointAttempt ?? null;
  const restoredCheckpoint = restore?.namespaceCheckpoint ?? null;
  const keys = ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"];
  const identityMatches = Boolean(expectedCheckpoint && restoredCheckpoint
    && keys.every((key) => expectedCheckpoint[key] === restoredCheckpoint[key]));
  return {
    expectedCheckpoint, restoredCheckpoint, identityMatches,
    snapshotFound: restore?.found === true,
    restorationError: restore?.error ?? null,
    skippedValues: restore?.skipped ?? [],
    historyIncomplete: newestExpired >= 0,
    interruptedOrUncheckpointed: results.flatMap((entry) => {
      const result = entry.message, details = result.details ?? {};
      if (entry.expired === true) return [{ toolCallId: result.toolCallId, state: "history-expired", executionOk: null }];
      if (details.nativeAsyncRecovery === "interrupted-unknown" || (result.isError === true && !details.executionId
        && !details.namespaceCheckpoint && !details.namespaceCheckpointAttempt && !details.nativeAsyncRecovery)) {
        return [{ toolCallId: result.toolCallId, state: "interrupted-or-unreported", executionOk: null }];
      }
      if ((details.executionId && details.ok === false && !details.namespaceCheckpoint && details.namespaceCheckpointState !== "pending")
        || (result === expectedResult && details.namespaceCheckpointState === "pending" && !identityMatches)) {
        return [{ toolCallId: result.toolCallId, state: "execution-ended-without-checkpoint",
          executionOk: details.executionOk ?? (details.namespaceCheckpointState === "pending" ? details.ok : null) }];
      }
      return [];
    }),
  };
}

export function namespaceRecoveryText(report) {
  if (!report) return "";
  return [
    "# Python namespace recovery diagnostic",
    `Expected canonical checkpoint: ${JSON.stringify(report.expectedCheckpoint)}`,
    `Restored checkpoint: ${JSON.stringify(report.restoredCheckpoint)}`,
    `Checkpoint identities match: ${report.identityMatches}. Snapshot found: ${report.snapshotFound}.`,
    `Restoration error: ${JSON.stringify(report.restorationError)}`,
    `Skipped values: ${JSON.stringify(report.skippedValues)}`,
    `Historical recovery facts expired: ${report.historyIncomplete}.`,
    `Interrupted/unknown or uncheckpointed original calls: ${JSON.stringify(report.interruptedOrUncheckpointed)}`,
    "This describes this kernel's initial restoration, not exact current namespace state or a replacement tool result.",
    "Matching identities do not prove exact restoration. Later verified mutations may supersede this report.",
    "Verify or reconstruct needed Python state before dependent work. Do not repeat unknown external side effects or replay interrupted cells automatically.",
  ].join("\n");
}

function hasNamespaceHistory(entries) {
  return entries.some((entry) => entry.expired === true || entry.message?.details?.namespaceCheckpoint
    || entry.message?.details?.namespaceCheckpointAttempt || entry.message?.details?.nativeAsyncRecovery
    || (entry.message?.isError === true && !entry.message?.details?.executionId));
}

export class PythonRecovery {
  constructor({ history, ensureKernel, currentKernel, restore, nativeAsync, stepsPath }) {
    Object.assign(this, { history, ensureKernel, currentKernel, restore, nativeAsync, stepsPath });
    this.state = null;
    this.noNamespaceHistory = false;
    // undefined: not read yet; null: none (history is read instead).
    this.steps = stepsPath ? undefined : null;
  }

  /** Before a cell runs, after it returned, and when its background save ended. */
  stepStarted(toolCallId) { return this.#step((log) => log.started(toolCallId)); }
  stepFinished(toolCallId, details) { return this.#step((log) => log.finished(toolCallId, details)); }
  stepCheckpointed(toolCallId, outcome) { return this.#step((log) => log.checkpointed(toolCallId, outcome)); }

  // A record that cannot be written is removed, so the next start reads history again.
  async #step(change) {
    const log = this.steps;
    if (!log) return;
    try { await change(log); }
    catch { this.steps = null; await rm(this.stepsPath, { force: true }).catch(() => {}); }
  }

  async #stepLog() {
    if (this.steps === undefined) this.steps = await PythonStepLog.load(this.stepsPath);
    return this.steps;
  }

  // The record starts from what history shows now. The expected call that history lists
  // only when the restored namespace does not match it is kept apart.
  async #startStepLog(entries) {
    if (!this.stepsPath || this.steps) return;
    const unmatched = projectNamespaceRecovery(entries, null);
    const matched = projectNamespaceRecovery(entries, { namespaceCheckpoint: unmatched.expectedCheckpoint });
    const key = (item) => `${item.toolCallId}\u0000${item.state}`, listed = new Set(matched.interruptedOrUncheckpointed.map(key));
    const pending = unmatched.interruptedOrUncheckpointed.find((item) => !listed.has(key(item))) ?? null;
    try {
      this.steps = await PythonStepLog.create(this.stepsPath, { expected: unmatched.expectedCheckpoint,
        legacy: matched.interruptedOrUncheckpointed, pending, incomplete: unmatched.historyIncomplete });
    } catch { this.steps = null; await rm(this.stepsPath, { force: true }).catch(() => {}); }
  }

  invalidateHistory() { this.noNamespaceHistory = false; }

  async reconcile(extra) {
    const current = this.currentKernel();
    if (!extra && !this.nativeAsync() && this.noNamespaceHistory) return "";
    if (!extra && current?.isRunning && this.state?.kernel === current) return namespaceRecoveryText(this.state.report);
    const log = await this.#stepLog();
    if (log) return this.#reconcileFromSteps(log, extra);
    const entries = await this.history({ from: 1, select: SELECT });
    if (extra) entries.push({ type: "message", message: extra });
    if (!this.nativeAsync() && !hasNamespaceHistory(entries)) {
      await this.#startStepLog(entries);
      this.state = null; this.noNamespaceHistory = true; return "";
    }
    this.noNamespaceHistory = false;
    await this.#startStepLog(entries);
    let kernel;
    try { kernel = await this.ensureKernel(); }
    catch (error) {
      this.state = { kernel: null, visible: false, report: projectNamespaceRecovery(entries,
        { error: error instanceof Error ? error.message : String(error) }) };
      return namespaceRecoveryText(this.state.report);
    }
    if (!this.state || this.state.kernel !== kernel || extra) {
      this.state = { kernel, visible: false, report: projectNamespaceRecovery(entries, this.restore()) };
    }
    return namespaceRecoveryText(this.state.report);
  }

  // `extra`, a result just returned, is already in the step record.
  async #reconcileFromSteps(log, extra) {
    if (!this.nativeAsync() && !log.hasFindings) { this.state = null; return ""; }
    let kernel;
    try { kernel = await this.ensureKernel(); }
    catch (error) {
      this.state = { kernel: null, visible: false, report: log.report({ error: error instanceof Error ? error.message : String(error) }) };
      return namespaceRecoveryText(this.state.report);
    }
    if (!this.state || this.state.kernel !== kernel || extra) {
      this.state = { kernel, visible: false, report: log.report(this.restore()) };
    }
    return namespaceRecoveryText(this.state.report);
  }

  reviewed(body) {
    const state = this.state;
    if (!state || state.visible || !state.kernel || state.kernel !== this.currentKernel() || !state.kernel.isRunning) return;
    const encoded = JSON.stringify(namespaceRecoveryText(state.report)).slice(1, -1);
    if (JSON.stringify(body).includes(encoded)) state.visible = true;
  }

  get needsReview() { return Boolean(this.state && !this.state.visible); }
  get blocksCall() {
    const state = this.state;
    return Boolean(state && (!state.visible || !state.kernel || state.kernel !== this.currentKernel() || !state.kernel.isRunning));
  }
}
