// The daily cleanup of stored tool output and reasoning. Each session folder's old,
// unreferenced side files are deleted by `core reap`, which holds the session's
// references lock while it checks and deletes (the core's ReaperReferences model);
// messages and images meant for the user always stay.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { coreBinary } from "./core-session.mjs";

export const REAP_AGE_SECONDS = 14 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const REAP_TIMEOUT_MS = 10 * 60 * 1000;

/** `core reap <dir> <age>`: resolves to `{ deleted: [files], bytes }`; rejects on failure. */
export function coreReap(dir, ageSeconds, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(coreBinary(env), ["reap", dir, String(ageSeconds)], { env, timeout: REAP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const value = JSON.parse(stdout);
          if (!Array.isArray(value?.deleted) || !Number.isFinite(value?.bytes)) throw new Error("unexpected reap output");
          resolve(value);
        } catch (parseError) { reject(parseError); }
      });
  });
}

export class CoreReaper {
  #timer = null; #running = null; #stopped = false;

  constructor({ sessionsDirectory, reap = coreReap, ageSeconds = REAP_AGE_SECONDS, intervalMs = DAY_MS,
    firstDelayMs = FIRST_RUN_DELAY_MS, onRun = () => {}, logger = console } = {}) {
    Object.assign(this, { sessionsDirectory, reap, ageSeconds, intervalMs, firstDelayMs, onRun, logger });
  }

  start() {
    this.#stopped = false;
    this.#schedule(this.firstDelayMs);
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer); this.#timer = null;
    await this.#running;
  }

  #schedule(delay) {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => { this.#running = this.runOnce().finally(() => { this.#running = null; this.#schedule(this.intervalMs); }); }, delay);
    this.#timer.unref?.();
  }

  /** One pass over every session folder, one at a time. A failed folder is counted and skipped. */
  async runOnce() {
    const summary = { sessions: 0, files: 0, bytes: 0, failed: 0 };
    let names = [];
    try { names = await readdir(this.sessionsDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") this.logger.error?.(`core cleanup could not list sessions: ${error.message}`); }
    for (const entry of names) {
      if (this.#stopped) break;
      // Session folders are named by session id; the harness's own sidecars beside them
      // (`<id>.kernel-state`, ...) and hidden files are not sessions.
      if (!entry.isDirectory() || entry.name.includes(".")) continue;
      summary.sessions += 1;
      try {
        const result = await this.reap(path.join(this.sessionsDirectory, entry.name), this.ageSeconds);
        summary.files += result.deleted.length; summary.bytes += result.bytes;
      } catch (error) {
        summary.failed += 1;
        this.logger.error?.(`core cleanup of ${entry.name} failed: ${error.message}`);
      }
    }
    await this.onRun(summary);
    return summary;
  }
}
