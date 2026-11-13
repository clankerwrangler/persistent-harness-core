// The JSON-lines transport between the supervisor and a session's worker: commands in,
// responses and events out, and dialogs (questions for the person) on the same connection.
import { randomUUID } from "node:crypto";
import { PiRpcLineDecoder } from "./session-actor.mjs";

export const MAX_WORKER_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** Dialogs stay on the RPC connection; the supervisor shows them and sends the answer back. */
export class RpcDialogBroker {
  #pending = new Map();
  #closed = false;
  constructor(publish, { maxPending = 128, onChange = () => {} } = {}) {
    this.publish = publish;
    this.maxPending = maxPending;
    this.onChange = onChange;
    const send = (method, fields) => {
      if (!this.#closed) this.publish({ type: "extension_ui_request", id: randomUUID(), method, ...fields });
    };
    this.ui = {
      select: (title, options, opts) => this.dialog("select", { title, options }, opts),
      confirm: (title, message, opts) => this.dialog("confirm", { title, message }, opts),
      input: (title, placeholder, opts) => this.dialog("input", { title, placeholder }, opts),
      editor: (title, prefill, opts) => this.dialog("editor", { title, prefill }, opts),
      notify: (message, notifyType = "info") => send("notify", { message, notifyType }),
      setStatus: (statusKey, statusText) => send("setStatus", { statusKey, statusText }),
    };
  }
  get pendingCount() { return this.#pending.size; }
  dialog(method, fields, opts = {}) {
    const defaultValue = method === "confirm" ? false : undefined;
    if (this.#closed || opts.signal?.aborted) return Promise.resolve(defaultValue);
    if (this.#pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending dialogs"));
    if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout < 0 || opts.timeout > 2_147_483_647)) {
      return Promise.reject(new TypeError("Invalid dialog timeout"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (!this.#pending.delete(id)) return false;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancel);
        this.onChange();
        return true;
      };
      const finish = (value) => { if (cleanup()) resolve(value); };
      const cancel = () => finish(defaultValue);
      this.#pending.set(id, { method, finish, cancel });
      opts.signal?.addEventListener("abort", cancel, { once: true });
      if (opts.timeout > 0) timer = setTimeout(cancel, opts.timeout);
      try { this.publish({ type: "extension_ui_request", id, method, ...fields, timeout: opts.timeout }); }
      catch (error) { if (cleanup()) reject(error); }
    });
  }
  respond(frame) {
    const pending = this.#pending.get(frame.id);
    if (!pending) return false;
    if (frame.cancelled === true) pending.cancel();
    else if (pending.method === "confirm") {
      if (typeof frame.confirmed !== "boolean") return false;
      pending.finish(frame.confirmed);
    } else {
      if (typeof frame.value !== "string") return false;
      pending.finish(frame.value);
    }
    return true;
  }
  cancelAll() { for (const pending of this.#pending.values()) pending.cancel(); }
  close() { this.#closed = true; this.cancelAll(); }
}

/**
 * Serve one worker over stdin/stdout. `bootstrap({ argv, cwd, env, publish, broker, lifecycle })`
 * returns the worker: `handle(command)`, `close()` and `coordinator.waitForIdle()`.
 * Output is bounded; dialog answers bypass pending commands, including startup dialogs.
 */
export async function runWorkerRpc({ input = process.stdin, output = process.stdout, argv = process.argv.slice(2),
  cwd = process.cwd(), env = process.env, bootstrap, installSignalHandlers = true } = {}) {
  if (typeof bootstrap !== "function") throw new TypeError("bootstrap is required");
  const decoder = new PiRpcLineDecoder();
  const pending = new Set();
  const activeIds = new Set();
  let closing = false, shutdownRequested = false, drainingShutdown = false, fatalError, worker, finish, boot;
  const done = new Promise((resolve) => { finish = resolve; });
  const publish = (frame) => {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_WORKER_FRAME_BYTES + 1 || output.writableLength + Buffer.byteLength(line) > MAX_WORKER_FRAME_BYTES + 256 * 1024) {
      const error = new Error("Actor RPC output buffer limit exceeded");
      void close(error);
      throw error;
    }
    output.write(line);
  };
  const broker = new RpcDialogBroker(publish, { onChange: () => { void drainShutdown(); } });
  const lifecycle = { requestShutdown: () => { shutdownRequested = true; queueMicrotask(() => { void drainShutdown(); }); } };
  async function drainShutdown() {
    if (!shutdownRequested || closing || drainingShutdown || pending.size || broker.pendingCount) return;
    drainingShutdown = true;
    try {
      const owner = await boot;
      await owner.coordinator.waitForIdle();
      if (!pending.size && !broker.pendingCount) await close();
    } catch (error) { await close(error); }
    finally { drainingShutdown = false; }
  }
  const signals = installSignalHandlers ? ["SIGTERM", "SIGINT", ...(process.platform !== "win32" ? ["SIGHUP"] : [])] : [];
  const onSignal = () => { void close(); };
  async function close(error) {
    if (error) fatalError ??= error;
    if (closing) return done;
    closing = true;
    input.off("data", receive); input.off("end", onEnd);
    input.pause();
    broker.close();
    try { worker ??= await boot; await worker?.close(); }
    catch (failure) { fatalError ??= failure; }
    finally {
      for (const signal of signals) process.off(signal, onSignal);
      input.off("error", onError); output.off("error", onError);
      finish();
    }
    return done;
  }
  const onEnd = () => { void close(); };
  const onError = (error) => { void close(error); };
  const respondError = (command, error) => publish({ type: "response", id: command?.id, command: command?.type ?? "parse", success: false, error: errorText(error) });
  function receive(chunk) {
    if (closing) return;
    let commands;
    try { commands = decoder.push(chunk); }
    catch (error) { respondError(null, error); void close(error); return; }
    for (const command of commands) {
      if (command?.type === "extension_ui_response") { broker.respond(command); continue; }
      if (shutdownRequested) { respondError(command, new Error("Actor shutdown requested")); continue; }
      if (pending.size >= MAX_PENDING_REQUESTS) { respondError(command, new Error("Too many pending actor RPC requests")); continue; }
      if (command?.id != null && (typeof command.id !== "string" || activeIds.has(command.id))) {
        void close(new Error("Invalid or duplicate active actor RPC request id")); return;
      }
      if (command?.id != null) activeIds.add(command.id);
      const task = (async () => {
        try {
          const owner = await boot;
          if (closing) return;
          const data = await owner.handle(command);
          if (closing) return;
          publish({ type: "response", id: command?.id, command: command?.type, success: true, ...(data === undefined ? {} : { data }) });
        } catch (error) { if (!closing) respondError(command, error); }
      })();
      pending.add(task);
      task.finally(() => { pending.delete(task); activeIds.delete(command?.id); void drainShutdown(); }).catch(onError);
    }
  }
  input.on("data", receive); input.on("end", onEnd); input.on("error", onError); output.on("error", onError);
  for (const signal of signals) process.on(signal, onSignal);
  boot = bootstrap({ argv, cwd, env, publish, broker, lifecycle });
  try { worker = await boot; void drainShutdown(); }
  catch (error) { await close(error); }
  await done;
  if (fatalError) throw fatalError;
}
