// A session's worker when it runs on the conversation core instead of pi.
//
// It runs one `core run` process through the core's JavaScript library and does the
// harness's per-session jobs around it: the Python kernel (the `ipython` tool), the
// harness's prompt parts, registration with the supervisor, messages from other
// sessions, progress headings, and usage reports. The supervisor talks to it in the
// same JSON-lines transport as the pi worker, with a smaller command set, and gets the
// core's own events (`core_event` frames), not pi's.
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentDirectory, coreArgs, coreBinary, coreLibraryPath } from "./core-session.mjs";
import { HarnessClient } from "./client.mjs";
import { PythonKernel } from "./kernel.mjs";
import { PythonRuntimeManager } from "./python-runtime.mjs";
import { PythonRecovery } from "./python-recovery.mjs";
import { createHostHandlers } from "./host-handlers.mjs";
import { discoverSkills, manifestForSkills, writeManifestAtomic } from "./skills.mjs";
import { assembleActorSystemPrompt, loadDepthPrompt } from "./depth-prompt.mjs";
import { formatPrefixPrompt, loadPromptPrefix } from "./prompt-prefix.mjs";
import { PROGRESS_ENTRY_TYPE, ProgressHeadingTracker } from "./progress-projection.mjs";
import { AGENT_MESSAGE_ENTRY_TYPE, CHILD_CREATION_ENTRY_TYPE } from "./agent-message-projection.mjs";
import { nodeMemoryDiagnostics } from "./memory-diagnostics.mjs";
import { actorInputCustomPayload } from "./protocol.mjs";
import { TURN_FAILURE_ACCEPTED_TYPE, TURN_FAILURE_ENTRY_TYPE, TurnFailureReporter } from "./child-turn-failure.mjs";
import { inputIdForEntry } from "./conversation-projection.mjs";
import { fastModeOptions, supportsFastMode } from "./fast-mode.mjs";
import { MessageClock } from "./message-time.mjs";
import { locationBlock } from "./input-location.mjs";
import {
  INCOMING_MESSAGE_TYPE, KERNEL_SCRIPT, PYTHON_RUNTIME_SUPPORT, USAGE_ENTRY_TYPE, actorSkillGrant, applyActorSkillGrant,
  incomingCustomPayload, nativeAsyncEnabled, pythonToolResult, skillPrompt,
} from "./python-tool.mjs";
const exec = promisify(execFile);
const choice = (value, values, name) => {
  if (!values.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
};

// Events the supervisor gets; the rest are the library's own business (answers, replies).
const FORWARDED = new Set(["turn_start", "text_delta", "tool_call", "tool_result", "cancel", "message_end", "turn_end",
  // tool_result: the core's own, for built-in calls (the worker reports its tools' results itself).
  "settled", "error", "retry", "cut_off", "context_too_large", "window_unknown", "sign_in_needed", "context_file"]);

export function parseCoreWorkerArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    const take = (key) => { if (value === undefined) throw new Error(`${flag} needs a value`); options[key] = value; i++; };
    switch (flag) {
      case "--session-dir": take("sessionDir"); break;
      case "--sidecar-base": take("sidecarBase"); break;
      case "--provider": take("provider"); break;
      case "--model": take("model"); break;
      case "--thinking": take("thinking"); break;
      case "--name": take("name"); break;
      default: throw new Error(`Unknown core worker flag: ${flag}`);
    }
  }
  if (!options.sessionDir || !options.sidecarBase) throw new Error("--session-dir and --sidecar-base are required");
  if ((options.provider === undefined) !== (options.model === undefined)) throw new Error("--provider and --model go together");
  return options;
}

const IPYTHON_TOOL = {
  type: "function",
  name: "ipython",
  description: "Execute Python in this session's persistent IPython namespace. Use skill? for full skill instructions.",
  promptSnippet: "Execute Python in the persistent namespace; use skill? to inspect any skill's SKILL.md.",
  promptGuidelines: [
    "Use Python for all execution; ordinary Pi tools are unavailable.",
    "Inspect a skill with skill? before first use when its workflow is relevant.",
  ],
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "Python/IPython code to execute" } },
    required: ["code"],
    additionalProperties: false,
  },
};
const WAIT_TOOL = {
  type: "function",
  name: "wait_for_ipython",
  description: "Wait for prior Python calls to settle. Make this the last tool call of the current response. When it returns, read the original Python results and continue.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

export class CoreWorker {
  #closed;
  constructor({ core, options, env, cwd, broker, publish, agentDir }) {
    Object.assign(this, { core, options, env, cwd, broker, publish, agentDir });
    this.sessionId = env.PI_HARNESS_ACTOR_ID;
    this.actorToken = env.PI_HARNESS_ACTOR_TOKEN;
    this.actorGeneration = Number(env.PI_HARNESS_ACTOR_GENERATION);
    this.selected = { model: null, reasoning: null };
    this.models = [];
    this.followUps = [];
    this.progress = new ProgressHeadingTracker();
    this.progressTurnId = null;
    this.progressTail = Promise.resolve();
    this.historyTail = Promise.resolve();
    this.deliveredIds = new Set();
    this.deliveringInputs = new Set();
    this.reportedInputs = new Set();
    // Times added to what the model is sent: every incoming message, and a tool result
    // after a long quiet stretch (since the last time given, which start() restores).
    this.clock = new MessageClock();
    this.kernel = undefined;
    this.kernelPromise = undefined;
    this.kernelRestart = undefined;
    this.lastRestore = null;
    this.pythonRecovery = new PythonRecovery({
      history: (options) => this.core.history(options),
      ensureKernel: () => this.#ensureKernel(), currentKernel: () => this.kernel,
      restore: () => this.lastRestore, nativeAsync: () => nativeAsyncEnabled(this.model),
    });
    this.manifest = undefined;
    this.runtime = new PythonRuntimeManager({ runtimeDir: path.join(agentDir, "harness", "kernel-runtime") });
    // The supervisor's shutdown drain waits for this.
    this.coordinator = { waitForIdle: () => core.idle() };
    // Failed turns are saved, then reported (the parent or Home hears of them), then the
    // receipt is saved; one not yet reported is reported again after a restart.
    this.turnFailures = new TurnFailureReporter({ client: () => this.client,
      onRecorded: async (_report, journal) => { await this.core.record(TURN_FAILURE_ACCEPTED_TYPE, { version: 1, entryId: journal.entryId }); } });
    this.turnToolCalls = false;
    core.on("event", (event) => this.#onCoreEvent(event));
    // The request could not be prepared (the harness's prompt parts, its inputs): nothing was sent.
    core.on("handler_error", ({ op }) => { if (op === "prepared") void this.#turnFailed("request_preparation", "before_provider_dispatch"); });
  }

  get model() {
    const named = this.selected.model;
    if (!named) return undefined;
    return this.models.find((m) => m.provider === named.provider && m.id === named.id) ?? { provider: named.provider, id: named.id };
  }

  // ---- start ----

  async start() {
    const { options } = this;
    if (options.provider) await this.core.setModel({ provider: options.provider, model: options.model });
    if (options.thinking) await this.core.setModel({ reasoning: options.thinking });
    // The core keeps the current choice; asking with no change reads it.
    const current = await this.core.setModel({});
    this.selected = { model: current.model ?? null, reasoning: current.reasoning ?? null };
    await this.#refreshModels();
    // In this chunk: messages already delivered are not delivered again, and replies
    // whose usage was not reported yet (a stop before reporting) are reported now.
    const entries = await this.core.history();
    const reported = new Set();
    const failuresAccepted = new Set(entries.filter((e) => e.type === "custom" && e.customType === TURN_FAILURE_ACCEPTED_TYPE).map((e) => e.data?.entryId));
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === TURN_FAILURE_ENTRY_TYPE && !failuresAccepted.has(entry.id)) {
        try { this.turnFailures.remember(entry.data, { entryId: entry.id, position: Number(entry.id) }); } catch { /* a malformed record is skipped */ }
      }
    }
    for (const entry of entries) {
      if (entry.type === "custom_message" && entry.customType === INCOMING_MESSAGE_TYPE && typeof entry.details?.messageId === "string") {
        this.deliveredIds.add(entry.details.messageId);
      }
      if (entry.type === "custom" && entry.customType === USAGE_ENTRY_TYPE && typeof entry.data?.entryId === "string") reported.add(entry.data.entryId);
    }
    // Inputs already in history are the supervisor's to reconcile (it does so when this
    // worker starts); this worker reports only those it adds from now on.
    for (const entry of entries) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId === "string" && inputId) this.reportedInputs.add(inputId);
    }
    // The tool-result quiet stretch counts from the last time given, saved or not yet.
    const stamped = entries.findLast((entry) => (entry.message?.content ?? entry.content ?? []).some?.((part) => part?.harness === "time"));
    const last = Date.parse(stamped?.timestamp);
    if (Number.isFinite(last)) this.clock.last = last;
    await this.#register();
    await this.turnFailures.flush();
    for (const entry of entries) {
      const message = entry.type === "message" ? entry.message : null;
      if (message?.role !== "assistant" || !message.usage || reported.has(entry.id)) continue;
      await this.#reportUsage({ n: entry.id, usage: message.usage, provider: message.provider, model: message.model });
    }
  }

  // The core's model list (read locally; it never goes to the network for this). On a
  // failure or after the deadline the last list stays, and the result says so.
  async #refreshModels({ signal } = {}) {
    try {
      if (signal?.aborted) return { aborted: true, errors: new Map() };
      const stopped = signal && new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
      const models = await (stopped ? Promise.race([this.core.models(), stopped]) : this.core.models());
      if (models === null) return { aborted: true, errors: new Map() };
      this.models = models;
      return { aborted: false, errors: new Map() };
    } catch (error) { return { aborted: false, errors: new Map([["core", error]]) }; }
  }

  async #register() {
    const { env } = this;
    this.client = new HarnessClient({ socketPath: env.PI_HARNESS_SOCKET || path.join(this.agentDir, "harness", "supervisor.sock"),
      reconnectBaseMs: 100, reconnectMaxMs: 2000, requestTimeoutMs: 30_000 });
    this.client.on("status", ({ state }) => { if (state === "connected") this.#restoreProgress(); });
    this.client.on("event", (frame) => {
      if (frame.event === "message_available") this.historyTail = this.historyTail.then(() => this.#receiveMessage(frame.data?.message))
        .catch((error) => this.broker.ui.notify(error instanceof Error ? error.message : String(error), "error"));
    });
    let cwd = this.cwd, repositoryRoot = null;
    try { cwd = await realpath(this.cwd); } catch {}
    try {
      const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 1500 });
      if (stdout.trim()) repositoryRoot = await realpath(stdout.trim());
    } catch {}
    const registered = await this.client.start({ registrationType: "register_actor", sessionId: this.sessionId,
      sessionFile: this.options.sessionDir, cwd, repositoryRoot, actorToken: this.actorToken, actorGeneration: this.actorGeneration });
    if (!Number.isInteger(registered.session?.depth) || registered.session.depth < 0) throw new Error("supervisor registration did not provide a valid depth");
    if (typeof registered.scratch?.directory !== "string") throw new Error("supervisor did not provide root scratch context");
    this.depth = registered.session.depth;
    this.scratch = registered.scratch;
  }

  // ---- supervisor commands ----

  async handle(command) {
    if (this.#closed) throw new Error("Actor worker is closing");
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new TypeError("RPC command must be an object");
    switch (command.type) {
      case "get_state": return this.#state();
      case "prompt": return this.#submit(command);
      case "abort": this.followUps = []; this.broker.cancelAll(); this.core.abort(); return undefined;
      case "get_entries": {
        const from = command.since == null ? undefined : Number(command.since) + 1;
        if (from !== undefined && !Number.isSafeInteger(from)) throw new TypeError("since must be an entry id");
        const entries = await this.core.history(from === undefined ? {} : { from });
        return { entries, leafId: entries.at(-1)?.id ?? (command.since ?? null) };
      }
      case "get_available_models": {
        if (command.refresh !== false) await this.#refreshModels();
        return { models: this.models };
      }
      case "select_inference": {
        const model = this.models.find((m) => m.provider === command.provider && m.id === command.model);
        if (!model) throw new Error("Model is unavailable");
        // A change never lands mid-turn: it waits for the session to settle. The latest wins.
        this.pendingSelection = { requestId: command.requestId, model, thinkingLevel: command.thinkingLevel };
        if (!this.core.busy) await this.#applySelection();
        return { accepted: true };
      }
      case "deliver_input": return this.#deliverInput(command.inputId);
      // One request outside the conversation (titles), never saved.
      case "complete": return this.core.complete({ model: command.model, instructions: command.instructions,
        messages: command.messages, reasoning: command.reasoning });
      case "restart_kernel": {
        await this.core.idle();
        await this.#scheduleKernelRestart();
        await this.#ensureKernel();
        return { restarted: true };
      }
      case "get_memory_diagnostics": return { version: 1, node: nodeMemoryDiagnostics(),
        python: await (this.kernel?.memoryDiagnostics() ?? Promise.resolve({ state: "unavailable-not-running" })) };
      default: throw new Error(`Unknown core worker command: ${String(command.type)}`);
    }
  }

  #state() {
    const model = this.model;
    return { sessionId: this.sessionId, sessionFile: this.options.sessionDir, sessionName: this.options.name ?? null,
      model: model ? { ...model } : null, thinkingLevel: this.selected.reasoning ?? "off",
      isStreaming: this.core.busy, pendingMessageCount: this.followUps.length };
  }

  // A message from the person: steer joins the running turn, follow_up waits for it to end.
  #submit(command) {
    if (typeof command.message !== "string") throw new TypeError("message must be a string");
    const behavior = choice(command.behavior ?? "auto", ["auto", "steer", "follow_up"], "behavior");
    const images = command.images ?? [];
    if (!Array.isArray(images) || images.some((i) => i?.type !== "image" || typeof i.data !== "string" || typeof i.mimeType !== "string")) {
      throw new TypeError("images must contain ImageContent objects");
    }
    if (command.messageId != null && typeof command.messageId !== "string") throw new TypeError("messageId must be a string");
    // The supervisor's input id is kept on the saved user message (it proves delivery).
    // The message leads with its time; a shared location follows it.
    const location = command.location === undefined ? [] : [locationBlock(command.location)];
    const input = { content: [this.clock.incoming(), { type: "text", text: command.message }, ...images, ...location],
      ...(command.messageId ? { id: command.messageId } : {}) };
    if (behavior === "follow_up" && this.core.busy) {
      this.followUps.push(input);
      return { queued: true };
    }
    if (behavior === "steer" && !this.core.busy) throw new Error("cannot steer an idle session");
    if (this.core.busy) this.core.steer(input); else this.core.send(input);
    return { accepted: true };
  }

  // Applies a held model change and tells the supervisor it is in use (or that it failed).
  async #applySelection() {
    const pending = this.pendingSelection;
    if (!pending) return;
    this.pendingSelection = null;
    const { model, thinkingLevel, requestId } = pending;
    try {
      await this.core.setModel({ provider: model.provider, model: model.id, ...(thinkingLevel ? { reasoning: thinkingLevel } : {}) });
      this.selected.model = { provider: model.provider, id: model.id };
      if (thinkingLevel) this.selected.reasoning = thinkingLevel;
      this.publish({ type: "inference_selection_applied", requestId, selection: { provider: model.provider, model: model.id,
        thinkingLevel: this.selected.reasoning ?? "off", fastModeSupported: supportsFastMode(model),
        ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}) } });
    } catch { this.publish({ type: "inference_selection_failed", requestId }); }
  }

  // A cron or background input: added for the model to see, as pi's custom message was.
  async #deliverInput(inputId) {
    if (typeof inputId !== "string" || !inputId || inputId.length > 128) throw new TypeError("invalid inputId");
    if (!this.client?.isConnected) throw new Error("harness is offline");
    const { input } = await this.client.request("get_actor_input", { inputId });
    if (!input || input.inputId !== inputId || input.sessionId !== this.sessionId) throw new Error("input is not reserved for this actor");
    if (!["cron", "background"].includes(input.source)) throw new Error("custom input requires a verified internal source");
    if (input.state === "completed") return { delivered: true };
    const saved = (await this.core.history()).some((entry) => inputIdForEntry(entry) === inputId);
    if (!saved && !this.deliveringInputs.has(inputId)) {
      this.deliveringInputs.add(inputId);
      const behavior = input.source === "background" ? "auto" : input.behavior;
      // Added now when idle, or at the next safe point of a running turn; reported once saved.
      void this.core.addContext(this.#stamped(actorInputCustomPayload(input)), behavior === "follow_up" ? { deliver: "follow_up" } : {})
        .then(() => this.#reportInputs())
        .catch((error) => this.broker.ui.notify(`input ${inputId} was not added: ${error.message}`, "error"))
        .finally(() => this.deliveringInputs.delete(inputId));
    }
    await this.client.request("accept_actor_input", { inputId });
    return { accepted: true };
  }

  // A message added for the model, led by the time it arrived.
  #stamped(payload) {
    const content = typeof payload.content === "string" ? [{ type: "text", text: payload.content }] : payload.content;
    return { ...payload, content: [this.clock.incoming(), ...content] };
  }

  // Inputs the core has saved (a person's message carries its id; a cron or background
  // input carries it in its details) are reported once, with the entry that holds them.
  // One pass runs at a time, so an input never has two reports in flight; a request
  // during a pass runs one more pass after it.
  #reportInputs() {
    this.inputReportsDirty = true;
    return this.inputReporting ??= (async () => {
      try {
        while (this.inputReportsDirty) {
          this.inputReportsDirty = false;
          try { await this.#reportInputsOnce(); } catch { /* tried again at the next report */ }
        }
      } finally { this.inputReporting = null; }
    })();
  }

  async #reportInputsOnce() {
    if (!this.client?.isConnected) return;
    for (const entry of await this.core.history()) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId !== "string" || !inputId || this.reportedInputs.has(inputId)) continue;
      try {
        await this.client.request("record_input_delivery", { inputId, entryId: entry.id, deliveredAt: entry.timestamp });
        this.reportedInputs.add(inputId);
      } catch { /* tried again at the next report */ }
    }
  }

  // ---- the core's questions ----

  async prepare({ contextFiles }) {
    const model = this.model;
    if (!model) throw new Error("no model chosen for this session");
    if (!Number.isInteger(this.depth)) throw new Error("actor depth is unavailable");
    const nativeAsync = nativeAsyncEnabled(model);
    this.manifest ??= await this.#resolveManifest();
    const depthPrompt = await loadDepthPrompt(contextFiles ?? [], this.depth);
    const prefixPrompt = this.depth === 0 ? formatPrefixPrompt(await loadPromptPrefix()) : "";
    const recoveryDiagnostic = await this.pythonRecovery.reconcile();
    const harness = assembleActorSystemPrompt({ depth: this.depth, depthPrompt: depthPrompt.prompt,
      skillPrompt: skillPrompt(this.manifest.skills, nativeAsync), prefixPrompt })
      + `\n\n# Session scratch\nUse ${this.scratch.directory}/ for temporary work. This directory belongs to root session ${this.scratch.rootSessionId} and is shared by its descendants. Explicit root deletion reclaims it after owned work finishes. Python exposes this path as scratch_dir.`;
    const checkpointError = this.kernel?.snapshotStats?.checkpointError;
    const diagnostic = checkpointError ? `\n\nPython namespace save diagnostic: ${JSON.stringify(checkpointError)}. Do not replay external side effects to repair a save failure.` : "";
    // The accepted-input cutoff for this request, and the session's Fast mode (only for
    // models that offer it; a model the list does not describe fully gets none).
    const preferences = await this.client.request("flush_actor_inputs", {});
    if (typeof preferences.fastMode !== "boolean") throw new Error("session inference preferences are unavailable");
    const tools = [{ ...IPYTHON_TOOL, ...(nativeAsync ? { async: true } : {}) }, ...(nativeAsync ? [WAIT_TOOL] : [])];
    return { model: { provider: model.provider, id: model.id }, reasoning: this.selected.reasoning ?? undefined,
      instructions: "", sections: { harness: harness + (recoveryDiagnostic ? `\n\n${recoveryDiagnostic}` : "") + diagnostic }, tools,
      ...(this.pythonRecovery.needsReview ? { reviewRequest: "body" } : {}),
      ...fastModeOptions(model, preferences.fastMode) };
  }

  review(request) { this.pythonRecovery.reviewed(request?.body); return {}; }

  async tool(event, signal) {
    try {
      const result = await this.#runTool(event, signal);
      // After a long quiet stretch the output is followed by the time.
      const time = Array.isArray(result?.content) ? this.clock.toolResult() : undefined;
      return time ? { ...result, content: [...result.content, time] } : result;
    }
    // The core reports only its built-in tools' results; the supervisor hears of these here.
    finally { this.publish({ type: "core_event", event: { ev: "tool_result", call: event.call } }); }
  }

  async #runTool({ call, name, arguments: args }, signal) {
    if (name === "wait_for_ipython") {
      await this.core.waitForToolHandlers("ipython");
      return { content: [{ type: "text", text: "Prior Python calls have settled. Read their original results and continue." }] };
    }
    if (name !== "ipython") throw new Error(`Unknown tool: ${name}`);
    let diagnostic = await this.pythonRecovery.reconcile();
    if (this.pythonRecovery.blocksCall) return this.#blockedPython(diagnostic);
    const previousKernel = await this.#ensureKernel();
    if (this.pythonRecovery.blocksCall) {
      diagnostic = await this.pythonRecovery.reconcile();
      return this.#blockedPython(diagnostic);
    }
    const result = await this.#executePython(args?.code, signal, call, previousKernel);
    this.pythonRecovery.invalidateHistory();
    const { content, details } = pythonToolResult(result);
    if (previousKernel && previousKernel !== this.kernel) {
      diagnostic = await this.pythonRecovery.reconcile({ role: "toolResult", toolName: "ipython", toolCallId: call,
        isError: details?.ok === false, details });
      if (diagnostic) {
        content.push({ type: "text", text: diagnostic });
        details.namespaceRecovery = this.pythonRecovery.state.report;
      }
    }
    return { content, details, isError: details?.ok === false };
  }

  #blockedPython(diagnostic) {
    return { isError: true, details: { nativeAsyncRecovery: "not-started" }, content: [{ type: "text", text: "This cell was planned before the replacement namespace diagnostic reached the model. "
      + "It did not run. Review the diagnostic and verify needed state before issuing another cell.\n\n" + diagnostic }] };
  }

  // ---- Python ----

  async #resolveManifest() {
    const grant = await actorSkillGrant();
    if (!grant) throw new Error("core sessions need the supervisor's skill grant");
    const catalog = await discoverSkills(grant.skills.map((skill) => ({ source: "skill", path: skill.skillPath })));
    if (catalog.diagnostics.length) throw new Error(`Invalid skill package:\n${catalog.diagnostics.map((item) => item.error).join("\n")}`);
    const manifest = manifestForSkills(applyActorSkillGrant(catalog.skills, grant));
    const base = this.options.sidecarBase;
    const capabilities = manifest.skills.filter((skill) => skill.python).map((skill) => ({
      id: skill.id, version: skill.version, contentHash: skill.contentHash, hostRequests: skill.python.hostRequests }));
    await Promise.all([writeManifestAtomic(`${base}.skill-manifest.json`, manifest),
      writeManifestAtomic(`${base}.capabilities.json`, { version: 1, capabilities })]);
    return manifest;
  }

  #scheduleKernelRestart() {
    if (this.kernelRestart) return this.kernelRestart;
    const restarting = this.kernel;
    this.kernelRestart = new Promise((resolve) => setImmediate(resolve))
      .then(async () => { if (this.kernel === restarting) this.kernel = undefined; await restarting?.close(); })
      .finally(() => { this.kernelRestart = undefined; });
    return this.kernelRestart;
  }

  async #ensureKernel() {
    if (this.kernelRestart) await this.kernelRestart;
    if (this.kernel && !this.kernel.isRunning) {
      const exited = this.kernel; this.kernel = undefined;
      await exited.close({ snapshot: false }).catch(() => {});
    }
    if (this.kernel) return this.kernel;
    this.kernelPromise ??= (async () => {
      this.manifest ??= await this.#resolveManifest();
      const manifest = this.manifest;
      const context = this.hostContext();
      const { kernel, ready } = await this.runtime.launch({
        skills: manifest.skills,
        consent: ({ pythonVersion, packages }) => this.broker.ui.confirm("Install managed Python runtime?",
          `Persistent Harness needs CPython ${pythonVersion} and:\n${packages.join("\n")}`, { timeout: 60_000 }),
        onProgress: () => {},
        createKernel: (runtime) => new PythonKernel({
          pythonPath: runtime.pythonPath, expectedVersions: runtime.expectedVersions,
          kernelScript: KERNEL_SCRIPT, runtimeSupportDir: PYTHON_RUNTIME_SUPPORT,
          cwd: this.cwd, stateDir: `${this.options.sidecarBase}.kernel-state`, manifest, scratch: this.scratch,
          shutdownTimeoutMs: Number(this.env.PI_HARNESS_KERNEL_SHUTDOWN_TIMEOUT_MS ?? 1500),
          killTimeoutMs: Number(this.env.PI_HARNESS_KERNEL_KILL_TIMEOUT_MS ?? 1000),
          interruptTimeoutMs: Number(this.env.PI_HARNESS_KERNEL_INTERRUPT_TIMEOUT_MS ?? 2000),
          hostHandlers: createHostHandlers({ cwd: this.cwd, scratch: this.scratch, getClient: () => this.client,
            getContext: () => context, getManifest: () => this.manifest, getKernel: () => this.kernel,
            getKernelRestore: () => this.lastRestore,
            recordAgentMessage: (message) => this.#recordAgentMessage(message, "to"),
            recordChildCreation: (child) => this.#recordChildCreation(child),
            restartKernel: () => this.#scheduleKernelRestart() }),
        }),
      });
      this.lastRestore = ready.restore ?? null;
      this.kernel = kernel;
      return kernel;
    })().finally(() => { this.kernelPromise = undefined; });
    return this.kernelPromise;
  }

  // What the kernel's host requests read about the session (models, the current model).
  hostContext() {
    const worker = this;
    return {
      get model() { return worker.model; },
      get thinkingLevel() { return worker.selected.reasoning ?? "off"; },
      ui: this.broker.ui,
      modelRegistry: {
        refresh: (options) => worker.#refreshModels(options),
        getError: () => null,
        getAvailable: () => worker.models,
      },

    };
  }

  async #executePython(code, signal, call, kernel) {
    if (typeof code !== "string" || !code.trim()) throw new Error("Python code is required");
    const nativeAsync = nativeAsyncEnabled(this.model);
    const namespaceCheckpoint = nativeAsync
      ? { version: 1, sessionId: this.sessionId, toolCallId: call, actorGeneration: this.actorGeneration } : undefined;
    const result = await kernel.execute(code, { signal, onUpdate: () => {}, toolContext: this.hostContext(),
      namespaceCheckpoint, checkpointInBackground: Boolean(namespaceCheckpoint),
      onCheckpoint: (outcome) => {
        if (outcome.ok) return;
        void this.core.addContext({ customType: "persistent-harness-checkpoint-failure",
          content: `Python namespace save failed after execution for call ${call}: ${outcome.error}. `
            + "The original execution result is unchanged. Side effects may already have occurred. "
            + "Verify or reconstruct Python state; do not replay the cell automatically.",
          display: true, details: outcome }, { deliver: "follow_up", wake: Boolean(this.client?.isConnected && this.kernel === kernel) })
          .catch(() => {});
      } });
    if (!kernel.isRunning || (!result.ok && /Python kernel exited|control channel is closed|EPIPE|ECONNRESET/.test(result.error ?? ""))) {
      if (this.kernel === kernel) this.kernel = undefined;
      await kernel.close({ snapshot: false }).catch(() => {});
    }
    return result;
  }

  // ---- messages between sessions ----

  async #receiveMessage(message) {
    if (!message?.messageId) return;
    if (!this.deliveredIds.has(message.messageId)) {
      await this.#recordAgentMessage({ messageId: message.messageId, targetId: message.senderId,
        targetName: message.senderName ?? message.senderShortId, relationship: message.relationship, body: message.body }, "from");
      // Saved by the core before it is acknowledged: a lost ack redelivers, and the
      // delivered ids keep a redelivery out.
      // Every message wakes the session: idle, it starts a turn; mid-turn, it joins at the next safe point.
      await this.core.addContext(this.#stamped(incomingCustomPayload(message)));
      this.deliveredIds.add(message.messageId);
    }
    if (this.client?.isConnected) await this.client.request("ack_message", { messageId: message.messageId });
  }

  // An agent message (to or from another session) or a child's creation, kept in history
  // once and reported to the supervisor with its entry id.
  async #recordOnce(customType, key, value, data, report) {
    const existing = (await this.core.history()).find((entry) => entry.type === "custom" && entry.customType === customType
      && entry.data?.[key] === value && (!data.direction || entry.data.direction === data.direction));
    let entryId, createdAt;
    if (existing) { entryId = existing.id; createdAt = existing.timestamp; }
    else { entryId = String(await this.core.record(customType, data)); createdAt = new Date().toISOString(); }
    if (this.client?.isConnected) await this.client.request(report, { entryId, ...data, createdAt });
  }

  #recordAgentMessage(message, direction) {
    const data = { messageId: message.messageId, direction, peerId: message.targetId,
      peerName: message.targetName ?? message.targetShortId, relationship: message.relationship, body: message.body };
    return this.#recordOnce(AGENT_MESSAGE_ENTRY_TYPE, "messageId", message.messageId, data, "record_agent_message_entry");
  }

  #recordChildCreation(child) {
    if (!child) return Promise.resolve();
    const data = { taskId: child.taskId, childId: child.childId, childName: child.childName, relationship: "child", body: child.body };
    return this.#recordOnce(CHILD_CREATION_ENTRY_TYPE, "childId", child.childId, data, "record_child_creation_entry");
  }

  // ---- failed turns ----

  async #turnFailed(failureClass, dispatchBoundary) {
    const report = { version: 1, turnId: randomUUID(), failureClass, dispatchBoundary };
    try {
      const n = await this.core.record(TURN_FAILURE_ENTRY_TYPE, report);
      this.turnFailures.remember(report, { entryId: String(n), position: n });
      await this.turnFailures.flush();
    } catch (error) { this.broker.ui.notify(`a failed turn was not reported: ${error.message}`, "error"); }
  }

  // ---- events: progress, usage, forwarding ----

  #queue(type, params) {
    this.progressTail = this.progressTail.then(async () => { if (this.client?.isConnected) await this.client.request(type, params); }).catch(() => {});
    return this.progressTail;
  }

  #restoreProgress() {
    if (!this.progressTurnId) return;
    this.#queue("update_progress_heading", { phase: "start", turnId: this.progressTurnId });
    if (this.progressSummary) this.#queue("update_progress_heading", { phase: "heading", turnId: this.progressTurnId, summary: this.progressSummary });
  }

  #onCoreEvent(event) {
    const model = this.model;
    // Tool bodies stay here: the supervisor needs only which call started or ended.
    if (FORWARDED.has(event.ev)) this.publish({ type: "core_event", event: event.ev === "tool_call" ? { ev: event.ev, call: event.call, name: event.name }
      : event.ev === "tool_result" ? { ev: event.ev, call: event.call } : event, provider: model?.provider });
    switch (event.ev) {
      case "tool_call": this.turnToolCalls = true; break;
      case "turn_end":
        // The provider failed the turn; its calls (if any) may already have had effects.
        if (event.stopReason === "error") void this.#turnFailed("turn_failed", this.turnToolCalls ? "tool_effects_possible" : "provider_dispatch_unknown");
        break;
      case "turn_start":
        this.turnToolCalls = false;
        // The message that started this turn is saved by now.
        void this.#reportInputs();
        if (!this.progressTurnId) {
          this.progress.reset(); this.progressSummary = undefined; this.progressTurnId = randomUUID();
          this.#queue("update_progress_heading", { phase: "start", turnId: this.progressTurnId });
        }
        this.progress.update({ role: "assistant", api: model?.api, provider: model?.provider }, { type: "thinking_start", contentIndex: 0 });
        break;
      case "reasoning_delta": {
        const summary = this.progress.update({ role: "assistant", api: model?.api, provider: model?.provider },
          { type: "thinking_delta", contentIndex: 0, delta: event.delta });
        if (summary && summary !== this.progressSummary && this.progressTurnId) {
          this.progressSummary = summary;
          const turnId = this.progressTurnId;
          void this.core.record(PROGRESS_ENTRY_TYPE, { summary }).then((n) =>
            this.#queue("record_progress_entry", { entryId: String(n), summary, createdAt: new Date().toISOString() })).catch(() => {});
          this.#queue("update_progress_heading", { phase: "heading", turnId, summary });
        }
        break;
      }
      case "message_end": void this.#reportUsage(event); break;
      case "settled": {
        // Messages that joined the turn at a safe point are saved by now.
        void this.#reportInputs();
        const turnId = this.progressTurnId;
        this.progressTurnId = null; this.progressSummary = undefined; this.progress.reset();
        if (turnId) this.#queue("update_progress_heading", { phase: "settled", turnId });
        // A model change held during the turn lands before the next one starts.
        const next = this.followUps.shift();
        void this.#applySelection().finally(() => { if (next !== undefined) this.core.send(next); });
        break;
      }
    }
  }

  async #reportUsage(event) {
    const usage = event.usage;
    const provider = event.provider ?? this.model?.provider, model = event.model ?? this.model?.id;
    if (!this.client?.isConnected || !usage || !provider || !model || event.n == null) return;
    try {
      await this.client.request("record_usage", { entryId: String(event.n), provider, model,
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning ?? 0, totalTokens: usage.totalTokens, costTotal: usage.cost?.total ?? 0 });
      await this.core.record(USAGE_ENTRY_TYPE, { entryId: String(event.n) });
      const context = event.contextUsage;
      if (context?.contextWindow) await this.client.request("record_context_usage",
        { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent });
    } catch { /* reported again on the next start from history */ }
  }

  close() {
    if (!this.#closed) {
      this.#closed = (async () => {
        this.broker.close();
        this.turnFailures.close();
        await this.progressTail; await this.historyTail.catch(() => {});
        await this.kernelRestart; await this.kernel?.close().catch(() => {});
        await this.core.close();
        await this.client?.stop();
      })();
    }
    return this.#closed;
  }
}

/** The worker for `runSDKWorkerRpc` (same transport as the pi worker). */
export async function bootstrapCoreWorker({ argv = [], cwd = process.cwd(), env = process.env, publish, broker } = {}) {
  const options = parseCoreWorkerArgs(argv);
  const agentDir = agentDirectory(env);
  const { Core } = await import(pathToFileURL(coreLibraryPath(env)).href);
  let worker;
  const core = Core.start({ bin: coreBinary(env), dir: options.sessionDir, cwd, env,
    // The harness's sessions use Python only: the core's seven built-in tools are off.
    args: [...["read", "bash", "edit", "write", "grep", "find", "ls"].flatMap((name) => ["--no-tool", name]), ...coreArgs(env)],
    prepare: (request) => worker.prepare(request),
    review: (request) => worker.review(request),
    credentials: (provider) => { throw new Error(`not signed in to ${provider}`); },
    tool: (call, signal) => worker.tool(call, signal) });
  worker = new CoreWorker({ core, options, env, cwd, broker, publish, agentDir });
  try { await worker.start(); }
  catch (error) { await worker.close().catch(() => {}); throw error; }
  return worker;
}
