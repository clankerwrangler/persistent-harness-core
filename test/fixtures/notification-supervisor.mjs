import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor, fileSessions } from "./isolated-supervisor.mjs";
import { createCoreSession } from "../../src/core-session.mjs";
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(10); }
  throw new Error("condition not reached");
}
class Actor extends EventEmitter {
  #closePromise;
  constructor(options) { super(); Object.assign(this, options); this.pid = process.pid; this.isRunning = false; this.streaming = false; this.sent = []; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming,
    model: this.session.launch?.model?.resolved ?? null, thinkingLevel: this.session.launch?.thinking?.resolved ?? "off" }; }
  async start() {
    this.connection = new HarnessClient({ requestTimeoutMs: 120_000, socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.connection.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    this.isRunning = true; return this.state();
  }
  busy() { this.streaming = true; this.emit("event", { type: "agent_start" }); }
  idle() { this.streaming = false; this.emit("event", { type: "agent_settled" }); }
  async request(type, params = {}) {
    if (type === "get_state") return this.state(); if (type === "get_entries") return { entries: [] };
    // A cron or background input: the core worker accepts it, then adds it for the model.
    if (type === "deliver_input") { await this.connection.request("accept_actor_input", { inputId: params.inputId }); return { accepted: true }; }
    if (type === "prompt") return {};
    throw new Error(`unexpected request ${type}`);
  }
  async submit() { return {}; }
  send(frame) { this.sent.push(frame); }
  async close() {
    // Like PiSessionActor, concurrent callers join shutdown through the exit event.
    if (this.#closePromise) return this.#closePromise;
    if (!this.isRunning) return;
    this.isRunning = false;
    this.#closePromise = (async () => { await this.connection.stop(); this.emit("exit", { code: 0, expected: true }); })();
    return this.#closePromise;
  }
}
/** `fileHistory: true` gives sessions `.jsonl` stand-ins for their history, which a test writes itself. */
export async function fixture(t, { fileHistory = false, ...options } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-supervisor-"));
  const skillsPath = path.join(dir, "skills"); await mkdir(skillsPath); await mkdir(path.join(dir, "sessions"));
  const actors = new Map(), errors = [];
  const supervisor = new HarnessSupervisor({ socketPath: path.join(dir, "run", "h.sock"), databasePath: path.join(dir, "state", "h.sqlite"),
    pidPath: path.join(dir, "run", "h.pid"), skillsPath, actorInactivityMs: 0, notificationIdleMs: 70, notificationTickMs: 10,
    backgroundJobsDirectory: path.join(dir, "jobs"), titleGenerator: null,
    // Projection-only notification readers do not implement the history-index contract.
    ...(options.transcriptReader && !Object.hasOwn(options, "sessionHistoryIndex") && !Object.hasOwn(options, "sessionHistoryIndexFactory")
      ? { sessionHistoryIndex: { close() {} } } : {}),
    runtimeProvisioner: async () => ({}), actorFactory: value => { const actor = new Actor(value); actors.set(value.session.sessionId, actor); return actor; },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }), logger: { error: message => errors.push(String(message)), log() {} }, ...options });
  await supervisor.start();
  const client = new HarnessClient({ requestTimeoutMs: 120_000, socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "notification-fixture" });
  t.after(async () => { await client.stop(); await supervisor.stop(); await rm(dir, { recursive: true, force: true }); });
  async function actor(parentId = null) {
    // A real (empty) core session folder, so the supervisor can read it through the core.
    const { sessionId, sessionFile } = fileHistory ? await fileSessions(path.join(dir, "sessions")).create()
      : await createCoreSession({ sessionsDirectory: path.join(dir, "sessions") });
    const actorToken = randomUUID();
    const launch = { model: null, thinking: { resolved: "off" }, capabilities: [], skillCatalog: [] };
    if (parentId) supervisor.store.createChild(parentId, { sessionId, sessionFile, actorToken,
      policy: { ...launch, prompt: "child work", name: "Child", cwd: dir, repositoryRoot: dir, depth: supervisor.store.getSession(parentId).depth + 1 } });
    else supervisor.store.createRoot({ sessionId, sessionFile, actorToken, launch, cwd: dir, repositoryRoot: dir, name: `Root ${sessionId.slice(0, 8)}` });
    await client.request("revive_session", { sessionId });
    return eventually(() => supervisor.store.getSession(sessionId)?.lifecycle === "resident" && actors.get(sessionId)?.isRunning && actors.get(sessionId));
  }
  return { dir, supervisor, client, actors, actor, errors };
}
