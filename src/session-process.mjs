// The supervisor's handle on one session process (bin/core-actor.mjs): starts it, sends it
// commands over the session channel (session-channel.mjs) and passes its events on.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_CHANNEL_VERSION, sessionLineDecoder } from "./session-channel.mjs";

const MAX_STDERR_BYTES = 64 * 1024;
// How long an input may wait before the session process accepts it.
export const DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS = 330_000;

export class SessionProcess extends EventEmitter {
  #child;
  #pending = new Map();
  #stdoutDecoder = sessionLineDecoder();
  #stderr = "";
  #started = false;
  #closing = false;
  #exitPromise;
  #terminal = false;
  #inputTail = Promise.resolve();

  constructor({ command, args, cwd, env, requestTimeoutMs = 30_000, startupTimeoutMs = requestTimeoutMs,
    promptPreflightTimeoutMs = DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS, shutdownTimeoutMs = 3000 }) {
    super();
    if (typeof command !== "string" || !command) throw new TypeError("session process command is required");
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.promptPreflightTimeoutMs = promptPreflightTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
  }

  get pid() {
    return this.#child?.pid;
  }

  get stderr() {
    return this.#stderr;
  }

  get isRunning() {
    return Boolean(this.#child && !this.#terminal && this.#child.exitCode === null && !this.#child.killed);
  }

  async start() {
    if (this.#started) throw new Error("session process is already started");
    this.#started = true;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      if (this.#stderr.length >= MAX_STDERR_BYTES) return;
      const available = Math.max(0, MAX_STDERR_BYTES - Buffer.byteLength(this.#stderr));
      if (available > 0) this.#stderr += Buffer.from(chunk).subarray(0, available).toString("utf8");
    });
    this.#exitPromise = new Promise((resolve) => {
      const finish = (code, signal, spawnError = null) => {
        if (this.#terminal) return;
        this.#terminal = true;
        const details = (spawnError?.message ?? this.#stderr) || null;
        const error = new Error(`session process exited code=${code} signal=${signal}${details ? `\n${details}` : ""}`);
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.#pending.clear();
        this.emit("exit", { code, signal, expected: this.#closing, error: details });
        resolve({ code, signal });
      };
      child.once("exit", (code, signal) => finish(code, signal));
      child.once("error", (error) => finish(null, null, error));
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const deadline = performance.now() + this.startupTimeoutMs;
    const remaining = () => {
      if (this.#closing || this.#terminal) throw new Error("session process startup was stopped");
      const timeoutMs = deadline - performance.now();
      if (timeoutMs <= 0) throw new Error("session request get_state timed out");
      return timeoutMs;
    };
    const state = await this.request("get_state", {}, remaining());
    remaining(); // A late response is not readiness if timer delivery was delayed.
    // A session process built for another channel version is stopped, not half used.
    if (state?.channelVersion !== SESSION_CHANNEL_VERSION) {
      this.#terminate("SIGKILL");
      throw new Error(`session process speaks channel version ${String(state?.channelVersion)}, not ${SESSION_CHANNEL_VERSION}`);
    }
    return state;
  }

  #onStdout(chunk) {
    let frames;
    try {
      frames = this.#stdoutDecoder.push(chunk);
    } catch (error) {
      this.emit("protocolError", new Error(`invalid session process output: ${error.message}`));
      this.#terminate("SIGKILL");
      return;
    }
    for (const frame of frames) {
      if (frame.type === "response" && frame.id && this.#pending.has(frame.id)) {
        const pending = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success) pending.resolve(frame.data);
        else pending.reject(new Error(frame.error ?? `${pending.type} failed`));
      } else {
        this.emit("event", frame);
      }
    }
  }

  send(frame) {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error("session process is not running");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(type, fields = {}, timeoutMs = this.requestTimeoutMs) {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) return Promise.reject(new Error("session process is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`session request ${type} timed out`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { type, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  /** Serialize input acceptance. The response acknowledges acceptance, not run completion. */
  submit(message, behavior = "auto", images = [], messageId, location) {
    const operation = this.#inputTail.then(() => this.request("prompt", {
      message, behavior,
      ...(location === undefined ? {} : { location }), ...(images.length ? { images } : {}), ...(messageId === undefined ? {} : { messageId }),
    }, this.promptPreflightTimeoutMs));
    this.#inputTail = operation.catch(() => {});
    return operation;
  }

  #terminate(signal) {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  }

  async close() {
    if (!this.#child || this.#terminal || this.#child.exitCode !== null) return;
    this.#closing = true;
    // SIGTERM lets the session process stop on its own; after the grace period a forced
    // shutdown ends its whole process group, Python kernel included.
    try { this.#child.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => this.#terminate("SIGKILL"), this.shutdownTimeoutMs);
    timer.unref();
    await this.#exitPromise;
    clearTimeout(timer);
  }
}

const operatorConfigured = () => process.env.NODE_DISABLE_COMPILE_CACHE === "1"
  || process.env.NODE_COMPILE_CACHE !== undefined;
const privateDirectory = (info) => info.isDirectory() && typeof process.geteuid === "function"
  && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700;

/** One disposable code cache for the session processes of one supervisor; never canonical or session state. */
export async function createSessionCompileCache() {
  if (operatorConfigured() || typeof process.geteuid !== "function") return;
  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-compile-"));
    const identity = await lstat(directory);
    if (!privateDirectory(identity)) return;
    return { directory, async dispose() {
      try {
        const current = await lstat(directory);
        if (privateDirectory(current) && current.dev === identity.dev && current.ino === identity.ino) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch { /* Disposable cache cleanup must not fail supervisor shutdown. */ }
    } };
  } catch { /* Unavailable cache storage leaves ordinary startup intact. */ }
}
