// How the supervisor reads a session's conversation records: it asks the session half.
// Each read starts the session half's one-off reader (bin/session-records.mjs), which loads
// the session code as it is now, so the supervisor itself never knows the records' shapes
// and a session-only update changes what it is shown without a restart. The reader asks
// back for the input receipts it needs; those are the supervisor's, from its store.
import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_COMPILE_CACHE_ENV, SESSION_RECORDS_VERSION, sessionLineDecoder } from "./session-channel.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RECORDS_READER = path.join(PACKAGE_ROOT, "bin", "session-records.mjs");
const READ_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_STDERR_CHARS = 4096;

export class SessionRecords {
  #compileCache;
  // Each running reader, with when it can no longer write: it exited, or it never started.
  #readers = new Map();
  #closed = false;

  /** `inputReceiptReader(inputId, sessionId)`: the store's receipt of an input, or null.
   * `compileCache()`: the session processes' code cache ({ directory }), if any. */
  constructor({ inputReceiptReader = () => null, compileCache = async () => undefined, env = process.env,
    command = process.execPath, script = RECORDS_READER, timeoutMs = READ_TIMEOUT_MS, spawn = spawnProcess } = {}) {
    Object.assign(this, { inputReceiptReader, env, command, script, timeoutMs, spawn });
    this.#compileCache = compileCache;
  }

  // Each read asks the session half; nothing is cached, so there is nothing to clear.
  clear() {}

  /** Ends the reads still running and waits until their readers have exited; later reads fail.
   * Their code cache can be removed after this. */
  async close() {
    this.#closed = true;
    for (const child of this.#readers.keys()) child.kill("SIGKILL");
    await Promise.all(this.#readers.values());
  }

  /** A page of a session's visible history and what it proves about inputs and messages. */
  read(options) { return this.#ask({ op: "read", options }); }
  /** One image shown in a session's history. */
  readImage(options) { return this.#ask({ op: "image", options }); }
  /** What search sees of entries `from`..`to`: `{ last, messages }`. */
  searchable(sessionFile, range, sanitizePresentation) { return this.#ask({ op: "searchable", sessionFile, range, sanitizePresentation }); }
  /** The tool-result detail fields Python recovery reads, which cleanup must keep. */
  recoveryFields() { return this.#ask({ op: "recovery_fields" }); }

  async #ask(request) {
    const env = { ...this.env };
    delete env[SESSION_COMPILE_CACHE_ENV];
    const cache = await this.#compileCache().catch(() => undefined);
    if (cache?.directory) env[SESSION_COMPILE_CACHE_ENV] = cache.directory;
    if (this.#closed) throw new Error("the supervisor is stopping");
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, [this.script], { env, stdio: ["pipe", "pipe", "pipe"] });
      // A reader that could not be started reports an error and never exits.
      const ended = new Promise((done) => {
        child.once("exit", done);
        child.once("error", () => { if (child.pid === undefined) done(); });
      }).then(() => { this.#readers.delete(child); });
      this.#readers.set(child, ended);
      const decoder = sessionLineDecoder();
      let stderr = "", settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error("the session's records reader did not answer in time")), this.timeoutMs);
      timer.unref?.();
      const write = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => { stderr = (stderr + text).slice(-MAX_STDERR_CHARS); });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => finish(new Error(`the session's records reader stopped without answering (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
      child.stdout.on("data", (chunk) => {
        let lines;
        try { lines = decoder.push(chunk); } catch (error) { finish(error); return; }
        for (const line of lines) {
          if (line?.type === "receipts" && Array.isArray(line.ids)) {
            try {
              const receipts = Object.fromEntries(line.ids.filter((id) => typeof id === "string")
                .map((id) => [id, this.inputReceiptReader(id, line.sessionId) ?? null]));
              write({ type: "receipts", receipts });
            } catch (error) { finish(error); }
          } else if (line?.type === "result") finish(null, line.value);
          else if (line?.type === "error") finish(new Error(String(line.message)));
          else finish(new Error("the session's records reader sent an unexpected line"));
        }
      });
      write({ version: SESSION_RECORDS_VERSION, ...request });
    });
  }
}
