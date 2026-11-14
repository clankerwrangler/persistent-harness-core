// A session's own record of its Python steps since the namespace was last saved, kept
// beside the session so a waking session compares two small notes instead of reading its
// whole history. `saved` is the identity of the newest saved namespace; `steps` are the
// cells run after it, each written before it runs, so a stop mid-cell leaves it "running".
import { open, readFile, rename, rm } from "node:fs/promises";

const VERSION = 1;
const MAX_STEPS = 64;
const STATES = new Set(["running", "pending", "unsaved", "done"]);

function identity(value) {
  if (!value || typeof value !== "object") return null;
  const keys = ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"];
  return keys.every((key) => value[key] !== undefined) ? Object.fromEntries(keys.map((key) => [key, value[key]])) : null;
}

function valid(data) {
  return data?.version === VERSION && Array.isArray(data.steps) && Array.isArray(data.legacy)
    && data.steps.every((step) => typeof step?.toolCallId === "string" && STATES.has(step.state));
}

export class PythonStepLog {
  #path; #data; #tail = Promise.resolve();

  constructor(filePath, data) { this.#path = filePath; this.#data = data; }

  /** The record at `filePath`, or null when there is none yet (or it cannot be read). */
  static async load(filePath) {
    let text;
    try { text = await readFile(filePath, "utf8"); } catch { return null; }
    try { const data = JSON.parse(text); return valid(data) ? new PythonStepLog(filePath, data) : null; } catch { return null; }
  }

  /**
   * A first record, carrying forward what the full history check found once: the expected
   * checkpoint, the calls it lists whatever was restored, and the expected call it lists
   * only when the restored namespace does not match (`pending`).
   */
  static async create(filePath, { expected = null, legacy = [], pending = null, incomplete = false } = {}) {
    const log = new PythonStepLog(filePath, { version: VERSION, saved: null, legacyExpected: identity(expected),
      legacy: structuredClone(legacy), savedCall: pending ? structuredClone(pending) : null,
      legacyIncomplete: incomplete === true, steps: [] });
    await log.#write();
    return log;
  }

  /** Before a cell runs. */
  started(toolCallId) {
    this.#data.steps.push({ toolCallId, state: "running", attempt: null, executionOk: null });
    return this.#write();
  }

  /** After a cell returned its result (`details` as saved with the tool result). */
  finished(toolCallId, details = {}) {
    const step = this.#step(toolCallId);
    if (!step) return this.#write();
    const attempt = identity(details.namespaceCheckpointAttempt);
    step.attempt = attempt;
    step.executionOk = details.executionOk ?? (typeof details.ok === "boolean" ? details.ok : null);
    if (details.namespaceCheckpoint) return this.#saved(toolCallId, identity(details.namespaceCheckpoint), false);
    if (details.namespaceCheckpointState === "pending") step.state = "pending";
    else if (attempt) step.state = "unsaved";
    else step.state = "done";
    return this.#write();
  }

  /** When a background save of a cell's namespace ended. */
  checkpointed(toolCallId, outcome) {
    if (outcome?.ok && outcome.namespaceCheckpoint) return this.#saved(toolCallId, identity(outcome.namespaceCheckpoint), true);
    const step = this.#step(toolCallId);
    if (step && step.state === "pending") step.state = "unsaved";
    return this.#write();
  }

  /** The recovery report, in the shape the full history check gives. */
  report(restore) {
    const data = this.#data;
    const pending = data.steps.findLast((step) => step.state === "pending" && step.attempt);
    const expectedCheckpoint = pending?.attempt ?? data.saved ?? data.legacyExpected ?? null;
    const restoredCheckpoint = restore?.namespaceCheckpoint ?? null;
    const keys = ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"];
    const identityMatches = Boolean(expectedCheckpoint && restoredCheckpoint
      && keys.every((key) => expectedCheckpoint[key] === restoredCheckpoint[key]));
    const items = data.steps.flatMap((step) => {
      if (step.state === "running") return [{ toolCallId: step.toolCallId, state: "interrupted-or-unreported", executionOk: null }];
      if (step.state === "unsaved" || step === pending && !identityMatches) {
        return [{ toolCallId: step.toolCallId, state: "execution-ended-without-checkpoint", executionOk: step.executionOk }];
      }
      return [];
    });
    // A namespace saved in the background whose save is not what was restored: its cell is named,
    // as the history check names a result whose save it cannot see.
    const carried = data.savedCall && !identityMatches && !pending ? [data.savedCall] : [];
    return { expectedCheckpoint, restoredCheckpoint, identityMatches,
      snapshotFound: restore?.found === true, restorationError: restore?.error ?? null, skippedValues: restore?.skipped ?? [],
      historyIncomplete: data.legacyIncomplete === true, interruptedOrUncheckpointed: [...data.legacy, ...carried, ...items] };
  }

  /** Whether there is anything a session without native checkpoints needs to hear. */
  get hasFindings() {
    const data = this.#data;
    return data.legacy.length > 0 || data.legacyIncomplete || data.legacyExpected != null || data.savedCall != null || data.saved != null
      || data.steps.some((step) => step.state !== "done");
  }

  #step(toolCallId) { return this.#data.steps.findLast((step) => step.toolCallId === toolCallId); }

  // A save covers its cell and everything before it; what the history check carried over goes too.
  #saved(toolCallId, checkpoint, inBackground) {
    const data = this.#data, index = data.steps.findLastIndex((step) => step.toolCallId === toolCallId);
    const step = data.steps[index];
    data.savedCall = inBackground ? { toolCallId, state: "execution-ended-without-checkpoint", executionOk: step?.executionOk ?? null } : null;
    data.saved = checkpoint; data.legacy = []; data.legacyExpected = null; data.legacyIncomplete = false;
    data.steps = data.steps.slice(index + 1);
    return this.#write();
  }

  #write() {
    const data = this.#data;
    // Finished steps without findings are dropped, then the oldest if too many, never a running one.
    data.steps = data.steps.filter((step) => step.state !== "done");
    while (data.steps.length > MAX_STEPS) {
      const index = data.steps.findIndex((step) => step.state !== "running");
      if (index < 0) break;
      data.steps.splice(index, 1);
    }
    const content = `${JSON.stringify(data)}\n`;
    this.#tail = this.#tail.catch(() => {}).then(async () => {
      const temporary = `${this.#path}.${process.pid}.tmp`;
      const file = await open(temporary, "w", 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, this.#path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
    return this.#tail;
  }
}
