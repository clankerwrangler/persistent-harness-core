import { closestThinkingLevel, readDefaultInference, readDefaultModel, resolveDefaultTarget, writeDefaultModel } from "./default-inference.mjs";
import { quiescentScratchProcessRoots } from "./process-ownership.mjs";
import { DEFAULT_SCRATCH_DIRECTORY, ensureSessionScratch, reclaimSessionScratch } from "./session-scratch.mjs";
import { nodeMemoryDiagnostics, workerMemoryDiagnostics } from "./memory-diagnostics.mjs";
import { birthOrder, sortVisibleHistory } from "./conversation-birth.mjs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChildLaunchPolicy } from "./child-policy.mjs";
import { LiveConversation } from "./live-conversation.mjs";
import { pendingFamilyMessage, pendingInputMessage } from "./pending-rows.mjs";
import { BackgroundCompletionMonitor, defaultBackgroundJobsDirectory } from "./background-notifier.mjs";
import { CoreReaper } from "./core-reaper.mjs";
import { normalizeCronLaunch } from "./cron-launch.mjs";
import { DEFAULT_CRON_TIMEZONE } from "./cron-schedule.mjs";
import { rootReminders } from "./run-reminders.mjs";
import { CronScheduler, cronOriginPrompt } from "./cron-scheduler.mjs";
import { CronStore } from "./cron-store.mjs";
import { InboxStore, createInboxServer } from "./inbox.mjs";
import { inboxOriginJobId, normalizeProgressHeading } from "./protocol.mjs";
import { NotificationStore, NOTIFICATION_IDLE_MS } from "./notification-store.mjs";
import { JsonLineDecoder, encodeFrame } from "./framing.mjs";
import { projectAvailableModels, resolveModelSelection, validateInferenceEffort } from "./inference-options.mjs";
import { actorInputDigest, actorInputPrompt,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  errorResponse,
  event,
  protocolErrorFrame,
  response,
  validateRequest,
} from "./protocol.mjs";
import { captureOwnedProcessIdentity, terminateOwnedProcess } from "./process-ownership.mjs";
import { RootOutputProjector } from "./root-output-projector.mjs";
import { coreSessionContext, createCoreSession, forkableContext, removeCoreSession } from "./core-session.mjs";
import { agentDirectory, coreSessionsDirectory } from "./core-layout.mjs";
import { sessionSidecarPaths, publishActorGenerationSkillGrant } from "./session-paths.mjs";
import { SessionHistoryIndex } from "./session-history-index.mjs";
import { retryIntentForRequest, SESSION_ACTION_TIMEOUT_MS } from "./session-actions.mjs";
import { DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS, SessionProcess, createSessionCompileCache } from "./session-process.mjs";
import { SESSION_COMPILE_CACHE_ENV } from "./session-channel.mjs";
import { SessionRecords } from "./session-records.mjs";
import { HarnessStore } from "./store.mjs";
import { HomeFailureNudge } from "./home-failure-nudge.mjs";
import { PythonRuntimeManager } from "./python-runtime.mjs";
import { RUNTIME_DIRECTORY_ENV, runtimeDirectory } from "./python-runtime-layout.mjs";
import { grantedManifestSkills } from "./skills.mjs";
import { defaultRootName, resolveRootTitle, firstCompletedTitleTurn, rootTitleExcerpt } from "./root-title.mjs";
import { createRootTitleGenerator } from "./root-title-generator.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE_ACTOR_WORKER = path.join(PACKAGE_ROOT, "bin", "core-actor.mjs");
// A busy actor otherwise grows its young generation to 64 MB, mostly empty; 4 MB semispaces measured smaller and no slower.
const ACTOR_NODE_FLAGS = ["--expose-gc", "--max-semi-space-size=4"];
const DEFAULT_SKILLS_PATH = path.resolve(path.join(PACKAGE_ROOT, "skills"));
import {
  acquireInstanceLock,
  ownedSocketPath,
  preparePidPath,
  prepareSocketPath,
  publishSocketLink,
  releaseInstanceLock,
  supervisorInternals,
  unlinkIfOwned,
  unlinkSocketLinkIfOwned,
  writeJsonAtomic,
  writeOwnedPidFile,
} from "./supervisor-instance.mjs";
import {
  boundedActorEvent,
  boundedEntries,
  boundedReplay,
  broadcastFrame,
  encodeSupervisorFrame,
  flushSocketWrites,
  receiverRelationship,
  requestFailure,
  socketOutputBufferLimit,
  writeSocketFrame,
} from "./supervisor-transport.mjs";
import { SessionHistoryCoordinator } from "./supervisor-history.mjs";
import { SkillRuntimeCoordinator, sameSkillCatalog } from "./supervisor-skills.mjs";
export { socketOutputBufferLimit, supervisorInternals };

const MAX_IN_FLIGHT_REQUESTS = 8192;
const COMPLETED_REQUEST_ID_CACHE_SIZE = 4096;
const ACTOR_CONNECTION_GRACE_MS = 250;
const ACTOR_CONNECTION_RESTART_WAIT_MS = 2000;
const ACTOR_CONNECTION_STATE_TIMEOUT_MS = 1000;


export class HarnessSupervisor {
  #server;
  #store;
  #sockets = new Set();
  #actorConnections = new Map();
  #clientConnections = new Set();
  #actors = new Map();
  #startQueue = [];
  #startingActors = new Set();
  #activeStarts = 0;
  #actorCompileCache;
  #drainingStarts = false;
  #launchPromises = new Map();
  #passivationTimers = new Map();
  #messageBuckets = new Map();
  #ownedSocketPath;
  #socketLinkTarget;
  #pidIdentity;
  #instanceLockIdentity;
  #ownerToken = randomUUID();
  #startedAt;
  #stoppingPromise;
  #stoppedPromise;
  #resolveStopped;
  #logTail = Promise.resolve();
  #actorReadyPromises = new Map();
  #actorActivationOwners = new Map();
  #actorRetirements = new Map();
  #actorInputWakes = new Map();
  #skills;
  #history;
  #sessionMutationTails = new Map();
  #dialogRequests = new Map();
  #actorConnectionWaiters = new Map();

  #rootOutput;
  #cronStore;
  #cronScheduler;
  #cronCompletionTails = new Map();
  #inboxStore;
  #inboxServer;
  #backgroundCompletionMonitor;
  #coreReaper;
  get backgroundScans() { return this.#backgroundCompletionMonitor?.completedScans ?? 0; }
  #autoTitleInflight = new Map();
  #notifications;
  #notificationTimer;

  constructor({
    socketPath, databasePath, pidPath,
    maxFrameBytes = MAX_FRAME_BYTES,
    messageRateCapacity = 20,
    messageRateRefillPerSecond = 1,
    pendingMessageLimit = 100,
    maxMessageDeliveryAttempts = Number(process.env.PI_HARNESS_MAX_MESSAGE_ATTEMPTS ?? 5),
    maxDepth = Number(process.env.PI_HARNESS_MAX_DEPTH ?? 1),
    maxResidentActors = Number(process.env.PI_HARNESS_MAX_RESIDENT_ACTORS ?? 8),
    maxConcurrentStarts = Number(process.env.PI_HARNESS_MAX_CONCURRENT_STARTS ?? 2),
    actorInactivityMs = Number(process.env.PI_HARNESS_ACTOR_INACTIVITY_MS ?? 10 * 60 * 1000),
    configuredChildModel = process.env.PI_HARNESS_CHILD_MODEL || null,
    configuredChildThinkingLevel = process.env.PI_HARNESS_CHILD_THINKING || null,
    skillsPath = process.env.PI_HARNESS_SKILLS_PATH || DEFAULT_SKILLS_PATH,
    runtimeDir = runtimeDirectory(agentDirectory()),
    runtimeProvisioner = null,
    actorFactory = (options) => new SessionProcess(options),
    transcriptReader = null,
    processIdentityFactory = captureOwnedProcessIdentity,
    processTerminator = terminateOwnedProcess,
    actorStartupTimeoutMs = Number(process.env.PI_HARNESS_ACTOR_STARTUP_TIMEOUT_MS ?? 120_000),
    actorPromptPreflightTimeoutMs = Number(process.env.PI_HARNESS_ACTOR_PROMPT_PREFLIGHT_TIMEOUT_MS ?? DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS),
    actorShutdownTimeoutMs = Number(process.env.PI_HARNESS_ACTOR_SHUTDOWN_TIMEOUT_MS ?? 3000),
    logger = console,
    logPath = path.join(path.dirname(databasePath), "events.jsonl"),
    maxLogBytes = Number(process.env.PI_HARNESS_MAX_LOG_BYTES ?? 1024 * 1024),
    rootOutputProjector = new RootOutputProjector(),
    sessionHistoryIndex = null,
    sessionHistoryTimeoutMs = 25_000,
    sessionHistoryIndexFactory = (options) => new SessionHistoryIndex(options),
    cronTickIntervalMs = Number(process.env.PI_HARNESS_CRON_TICK_MS ?? 60_000),
    cronMaxParallel = Number(process.env.PI_HARNESS_CRON_MAX_PARALLEL ?? 2),
    cronDefaultTimezone = process.env.PI_HARNESS_CRON_TIMEZONE || DEFAULT_CRON_TIMEZONE,
    cronStoreFactory = (value, options) => new CronStore(value, options),
    cronSchedulerFactory = (options) => new CronScheduler(options),
    inboxPort = process.env.PI_HARNESS_INBOX_PORT ? Number(process.env.PI_HARNESS_INBOX_PORT) : null,
    homeSessionPath = null,
    inboxHost = process.env.PI_HARNESS_INBOX_HOST || "0.0.0.0",
    backgroundJobsDirectory = defaultBackgroundJobsDirectory(),
    scratchDirectory = process.env.PI_HARNESS_SCRATCH_ROOT || DEFAULT_SCRATCH_DIRECTORY,
    backgroundCompletionIntervalMs = Number(process.env.PI_HARNESS_BACKGROUND_COMPLETION_TICK_MS ?? 5_000),
    titleGenerator = createRootTitleGenerator(),
    notificationIdleMs = NOTIFICATION_IDLE_MS,
    notificationTickMs = 1_000,
    homeNudge = new HomeFailureNudge(),
    coreSessionsPath = coreSessionsDirectory(),
    // Creating, reading and removing core sessions (replaceable in tests).
    coreSessions = { create: createCoreSession, context: coreSessionContext, remove: removeCoreSession },
    // The daily cleanup of old stored tool output and reasoning; null turns it off.
    coreReaperFactory = (options) => new CoreReaper(options),
  }) {
    this.coreReaperFactory = coreReaperFactory;
    this.coreSessionsDirectory = path.resolve(coreSessionsPath);
    this.coreSessions = coreSessions;
    Object.assign(this, { socketPath, databasePath, pidPath, maxFrameBytes, messageRateCapacity, messageRateRefillPerSecond,
      pendingMessageLimit, maxMessageDeliveryAttempts, maxDepth, maxResidentActors, maxConcurrentStarts, actorInactivityMs,
      configuredChildModel, configuredChildThinkingLevel, actorFactory, transcriptReader, processIdentityFactory, processTerminator,
      actorStartupTimeoutMs, actorPromptPreflightTimeoutMs, actorShutdownTimeoutMs, logger, maxLogBytes,
      cronTickIntervalMs, cronMaxParallel, cronDefaultTimezone, cronStoreFactory, cronSchedulerFactory, inboxPort, inboxHost, homeSessionPath,
      backgroundJobsDirectory, scratchDirectory,
      backgroundCompletionIntervalMs, titleGenerator, notificationIdleMs, notificationTickMs });
    this.#homeNudge = homeNudge;
    this.skillsPath = path.resolve(skillsPath);
    this.skillArtifactRoot = path.join(path.dirname(path.resolve(databasePath)), "skill-artifacts");
    this.runtimeDir = path.resolve(runtimeDir);
    this.runtimeProvisioner = runtimeProvisioner ?? ((skills, { approved = false, onProgress = () => {} } = {}) => new PythonRuntimeManager({ runtimeDir: this.runtimeDir }).ensure({
      skills,
      consent: async () => approved,
      onProgress,
    }));
    this.logPath = path.resolve(logPath);
    if (!Number.isInteger(sessionHistoryTimeoutMs) || sessionHistoryTimeoutMs < 1 || sessionHistoryTimeoutMs > 25_000) {
      throw new Error("sessionHistoryTimeoutMs must be from 1 through 25000");
    }
    this.sessionHistoryTimeoutMs = sessionHistoryTimeoutMs;
    this.sessionHistoryIndex = sessionHistoryIndex;
    this.sessionHistoryIndexFactory = sessionHistoryIndexFactory;
    this.#rootOutput = rootOutputProjector;
    this.#rootOutput.on("event", (frame) => this.#broadcastRootOutput(frame));
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) throw new Error("maxDepth must be from 0 through 4");
    if (!Number.isInteger(maxResidentActors) || maxResidentActors < 1 || maxResidentActors > 128) throw new Error("maxResidentActors must be from 1 through 128");
    if (!Number.isInteger(maxConcurrentStarts) || maxConcurrentStarts < 1 || maxConcurrentStarts > 32) throw new Error("maxConcurrentStarts must be from 1 through 32");
    if (!Number.isFinite(actorInactivityMs) || actorInactivityMs < 0) throw new Error("actorInactivityMs must be non-negative");
    if (!Number.isFinite(actorStartupTimeoutMs) || actorStartupTimeoutMs < 100 || actorStartupTimeoutMs > 300_000) throw new Error("actorStartupTimeoutMs must be from 100 through 300000");
    if (!Number.isFinite(actorPromptPreflightTimeoutMs) || actorPromptPreflightTimeoutMs < 100 || actorPromptPreflightTimeoutMs > 900_000) throw new Error("actorPromptPreflightTimeoutMs must be from 100 through 900000");
    if (!Number.isFinite(actorShutdownTimeoutMs) || actorShutdownTimeoutMs < 100 || actorShutdownTimeoutMs > 60_000) throw new Error("actorShutdownTimeoutMs must be from 100 through 60000");
    if (!Number.isInteger(maxLogBytes) || maxLogBytes < 4096 || maxLogBytes > 64 * 1024 * 1024) throw new Error("maxLogBytes must be from 4096 through 67108864");
    if (!Number.isInteger(cronTickIntervalMs) || cronTickIntervalMs < 100 || cronTickIntervalMs > 60 * 60 * 1000) throw new Error("cronTickIntervalMs must be from 100 through 3600000");
    if (!Number.isInteger(cronMaxParallel) || cronMaxParallel < 1 || cronMaxParallel > 32) throw new Error("cronMaxParallel must be from 1 through 32");
    // A session's records are read by the session half; the supervisor answers with its receipts.
    this.transcriptReader ??= new SessionRecords({ inputReceiptReader: (inputId, sessionId) =>
      this.store.getActorInput(inputId, sessionId, { includeDigest: true }),
      compileCache: () => (this.#actorCompileCache ??= createSessionCompileCache()) });
    if (!Number.isInteger(backgroundCompletionIntervalMs) || backgroundCompletionIntervalMs < 100 || backgroundCompletionIntervalMs > 60 * 60 * 1000) throw new Error("backgroundCompletionIntervalMs must be from 100 through 3600000");
    this.#history = new SessionHistoryCoordinator({
      getStore: () => this.store,
      getIndex: () => this.sessionHistoryIndex,
      isBusy: (sessionId, session) => this.#historyMaintenanceBusy(sessionId, session),
      isStopping: () => Boolean(this.#stoppingPromise),
      timeoutMs: this.sessionHistoryTimeoutMs,
      logger: this.logger,
    });
    this.#skills = new SkillRuntimeCoordinator({
      skillsPath: this.skillsPath,
      skillArtifactRoot: this.skillArtifactRoot,
      runtimeProvisioner: (...args) => this.runtimeProvisioner(...args),
      getStore: () => this.store,
      withActorActivation: (sessionId, operation, check) => this.#withActorActivation(sessionId, operation, check),
      log: (eventName, fields) => this.#log(eventName, fields),
    });
    this.#stoppedPromise = new Promise((resolve) => { this.#resolveStopped = resolve; });
  }
  get whenStopped() { return this.#stoppedPromise; }
  get store() { if (!this.#store) throw new Error("supervisor is not started"); return this.#store; }
  get inboxAddress() { return this.#inboxServer?.address() ?? null; }
  get cronStore() { if (!this.#cronStore) throw new Error("cron scheduler is not started"); return this.#cronStore; }

  async start() {
    if (this.#server) throw new Error("supervisor is already started");
    for (const directory of new Set([path.dirname(this.socketPath), path.dirname(this.databasePath), path.dirname(this.pidPath), path.dirname(this.logPath)])) await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.socketPath), 0o700);
    this.#instanceLockIdentity = await acquireInstanceLock(this.#instanceLockPath, this.#ownerToken);
    try { await preparePidPath(this.pidPath); await prepareSocketPath(this.socketPath); }
    catch (error) { await this.#releaseInstanceLock(); throw error; }
    this.#ownedSocketPath = ownedSocketPath(this.socketPath, this.#ownerToken); this.#store = new HarnessStore(this.databasePath);
    // Home (named in home.json beside the database) hears when another root exits or a turn fails.
    this.#homeSessionPath = this.homeSessionPath ?? path.join(path.dirname(this.databasePath), "home.json");
    this.#store.rootFailureObserver = () => this.#homeSessionId();
    this.#store.coveredWork = () => this.#coveredWork();
    try {
      this.#cronStore = this.cronStoreFactory(this.databasePath, { db: this.#store.database });
      this.#notifications = new NotificationStore(this.databasePath, { idleMs: this.notificationIdleMs, db: this.#store.database });
      this.#notifications.notifiesRoot = rootId => { const home = this.#homeSessionId(); return !home || rootId === home; };
      this.#notifications.cancelDialogs();
      if (!this.sessionHistoryIndex) {
        try {
          this.sessionHistoryIndex = this.sessionHistoryIndexFactory({
            // What search sees of a session is the session half's to say, as for its pages.
            databasePath: path.join(path.dirname(this.databasePath), "transcript-search.sqlite"),
            searchable: (sessionFile, range, sanitizePresentation) => this.transcriptReader.searchable(sessionFile, range, sanitizePresentation),
          });
          this.#history.clearDiagnostic();
        } catch (error) {
          this.sessionHistoryIndex = null;
          this.#history.setUnavailableDiagnostic({ code: "session_history_unavailable",
            message: "derived session-history search index is unavailable; core harness operation is unaffected" });
          this.logger.error?.(`session history index unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.#startedAt = Date.now();
      const previousOwners = this.store.reconcileAfterDaemonStart(this.#startedAt);
      for (const owner of previousOwners) if (owner.actorIdentity) await this.processTerminator(owner.actorIdentity, { graceMs: this.actorShutdownTimeoutMs });
      this.#server = net.createServer((socket) => this.#accept(socket));
      await new Promise((resolve, reject) => { const failed = (error) => reject(error); this.#server.once("error", failed); this.#server.listen(this.#ownedSocketPath, () => { this.#server.off("error", failed); resolve(); }); });
      await chmod(this.#ownedSocketPath, 0o600); this.#socketLinkTarget = await publishSocketLink(this.socketPath, this.#ownedSocketPath, this.#ownerToken);
      this.#pidIdentity = await writeOwnedPidFile(this.pidPath, { pid: process.pid, ownerToken: this.#ownerToken, socketPath: this.socketPath, startedAt: this.#startedAt });
      for (const actorId of this.store.listQueuedActorIds()) this.#requestActorStart(actorId, false);
      this.#retryChildExitMessages();
      this.#cronScheduler = this.cronSchedulerFactory({ cronStore: this.#cronStore, sessionStore: this.#store,
        dispatchRun: (value) => this.#dispatchCronRun(value), tickIntervalMs: this.cronTickIntervalMs,
        maxParallel: this.cronMaxParallel, defaultTimezone: this.cronDefaultTimezone, logger: this.logger });
      this.#cronScheduler.start();
      if (this.inboxPort != null) {
        if (!Number.isInteger(this.inboxPort) || this.inboxPort < 0 || this.inboxPort > 65535) throw new Error("PI_HARNESS_INBOX_PORT must be a TCP port");
        this.#inboxStore = new InboxStore(this.databasePath, { db: this.#store.database });
        this.#inboxServer = createInboxServer({ store: this.#inboxStore, deliver: (message) => this.#deliverInboxMessage(message), logger: this.logger });
        await new Promise((resolve, reject) => { this.#inboxServer.once("error", reject);
          this.#inboxServer.listen(this.inboxPort, this.inboxHost, () => { this.#inboxServer.off("error", reject); resolve(); }); });
      }
      this.#backgroundCompletionMonitor = new BackgroundCompletionMonitor({
        directory: this.backgroundJobsDirectory,
        onScanComplete: () => this.#retryPendingScratchCleanup(),
        intervalMs: this.backgroundCompletionIntervalMs,
        dispatch: (job) => this.#dispatchBackgroundCompletion(job),
        onActiveJobsChanged: (sessionId, jobs) => {
          for (const job of jobs) {
            this.#notifications.bindOrigin(sessionId, `background:${job.id}`, job.startedAt);
            const startedAt = Date.parse(job.startedAt);
            if (Number.isSafeInteger(startedAt) && startedAt >= 0) this.store.recordSessionActivity(sessionId, startedAt);
          }
          this.#broadcastNavigator("background_work_changed");
        },
        logger: this.logger,
      });
      this.#backgroundCompletionMonitor.start();
      this.#coreReaper = this.coreReaperFactory?.({ sessionsDirectory: this.coreSessionsDirectory, logger: this.logger,
        recoveryFields: () => this.transcriptReader.recoveryFields(),
        onRun: (summary) => this.#log("core_cleanup", summary) });
      this.#coreReaper?.start();
      this.#notificationTimer = setInterval(() => {
        try {
          this.#nudgeHomeIfDue();
          this.#retryChildExitMessages();
          this.#notifications.expire(); this.#recordCronNotifications();
          for (const id of this.#notifications.openFamilies()) this.#observeNotifications(id);
          for (const id of this.#cronStore.activeRunSessionIds()) if (!this.#cronCompletionTails.has(id)) void this.#completeCronRunsForSession(id);
        }
        catch (error) { this.logger.error?.(`notification reconciliation failed: ${error.message}`); }
      }, this.notificationTickMs);
      this.#notificationTimer.unref();
    } catch (error) {
      this.#server?.close(); this.#server = undefined;
      if (this.#ownedSocketPath) try { await unlink(this.#ownedSocketPath); } catch {}
      this.#closeSessionHistoryIndex();
      await this.#backgroundCompletionMonitor?.stop().catch(() => {}); this.#backgroundCompletionMonitor = undefined;
      await this.#coreReaper?.stop().catch(() => {}); this.#coreReaper = undefined;
      await this.#cronScheduler?.stop().catch(() => {}); this.#cronScheduler = undefined;
      this.#inboxServer?.close(); this.#inboxServer = undefined; this.#inboxStore?.close(); this.#inboxStore = undefined;
      clearInterval(this.#notificationTimer); this.#notifications?.close(); this.#notifications = undefined;
      this.#cronStore?.close(); this.#cronStore = undefined;
      this.#store?.close(); this.#store = undefined;
      await this.#releaseInstanceLock(); throw error;
    }
    await this.#log("daemon_started", { pid: process.pid, protocolVersion: PROTOCOL_VERSION, schemaVersion: this.store.schemaVersion });
    return this.status();
  }

  get #instanceLockPath() { return `${this.pidPath}.lock`; }

  async #releaseInstanceLock() {
    const identity = this.#instanceLockIdentity;
    this.#instanceLockIdentity = undefined;
    if (identity) await releaseInstanceLock(this.#instanceLockPath, this.#ownerToken, identity);
  }

  #log(eventName, fields = {}) {
    const operation = this.#logTail.then(async () => {
      try {
        let size = 0; try { size = (await lstat(this.logPath)).size; } catch {}
        if (size >= this.maxLogBytes) { await rm(`${this.logPath}.1`, { force: true }); await rename(this.logPath, `${this.logPath}.1`); }
        await writeFile(this.logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event: eventName, ...fields })}\n`, { mode: 0o600, flag: "a" });
        await chmod(this.logPath, 0o600);
      } catch (error) { if (error?.code !== "ENOENT") this.logger.error?.(`harness event log failed: ${error instanceof Error ? error.message : String(error)}`); }
    });
    this.#logTail = operation.catch(() => {}); return operation;
  }

  #accept(socket) {
    socket.setNoDelay(true);
    const state = { socket, decoder: new JsonLineDecoder({ maxFrameBytes: this.maxFrameBytes }), inFlightRequestIds: new Set(), recentCompletedRequestIds: new Set(), inFlightWorkCount: 0, inFlightRequestBytes: 0, continuationOwners: new Set(), outputQueue: [], outputQueueHead: 0, outputBytes: 0, outputBlocked: false, role: null, sessionId: null, generation: null, subscriptions: new Set(), rootOutputSubscribed: false, deliveryInFlight: new Set(), closing: false, cleaned: false };
    this.#sockets.add(state);
    socket.on("data", (chunk) => {
      if (state.closing || state.cleaned) return;
      let frames; try { frames = state.decoder.push(chunk); } catch (error) { this.#closeForProtocolError(state, error); return; }
      for (const frame of frames) {
        // Admission and registration run synchronously in wire order; dispatch may await independently.
        void this.#handleFrame(state, frame).catch((error) => { this.logger.error?.(error); socket.destroy(); });
      }
    });
    socket.on("drain", () => { state.outputBlocked = false; this.#flushWrites(state); });
    socket.on("error", () => {}); socket.on("close", () => this.#cleanupConnection(state));
  }

  async #handleFrame(state, rawFrame) {
    if (state.closing || state.cleaned || state.socket.destroyed) return;
    let request;
    try {
      request = validateRequest(rawFrame);
      if (state.inFlightRequestIds.has(request.id) || state.recentCompletedRequestIds.has(request.id)) {
        throw new ProtocolError("duplicate_request_id", `request id ${request.id} was already used recently on this connection`);
      }
      state.inFlightRequestIds.add(request.id);
    } catch (error) { this.#closeForProtocolError(state, error); return; }
    let admittedWork = false; let requestBytes = 0; let continuationOwner;
    try {
      const operation = this.#requestOperation(state, request);
      if (operation.continuationOwner !== undefined) {
        if (state.continuationOwners.has(operation.continuationOwner)) {
          throw requestFailure("continuation_in_progress", "this pending work already has an unfinished continuation");
        }
        continuationOwner = operation.continuationOwner;
        state.continuationOwners.add(continuationOwner);
      } else {
        requestBytes = Buffer.byteLength(JSON.stringify(rawFrame));
        if (state.inFlightWorkCount >= MAX_IN_FLIGHT_REQUESTS || state.inFlightRequestBytes + requestBytes > 2 * this.maxFrameBytes) {
          throw requestFailure("request_backpressure", "connection has too much unfinished request work");
        }
        admittedWork = true; state.inFlightWorkCount += 1; state.inFlightRequestBytes += requestBytes;
      }
      const result = operation.run();
      // Immediate continuations finish in this frame; only asynchronous work retains admission.
      const data = result && typeof result.then === "function" ? await result : result;
      if (!state.closing) this.#write(state, response(request.id, request.type, data));
    } catch (error) {
      if (!state.closing) this.#write(state, errorResponse(request.id, request.type, error, error?.code ?? "request_failed"));
    } finally {
      if (state.inFlightRequestIds.delete(request.id)) {
        if (admittedWork) { state.inFlightWorkCount -= 1; state.inFlightRequestBytes -= requestBytes; }
        if (continuationOwner !== undefined) state.continuationOwners.delete(continuationOwner);
      }
      if (!state.closing && !state.cleaned) {
        state.recentCompletedRequestIds.add(request.id);
        while (state.recentCompletedRequestIds.size > COMPLETED_REQUEST_ID_CACHE_SIZE) {
          state.recentCompletedRequestIds.delete(state.recentCompletedRequestIds.values().next().value);
        }
      }
    }
  }

  #closeForProtocolError(state, error) {
    if (state.closing || state.cleaned) return;
    // Flush the rejection before closing; destroy() can discard a completed write.
    // A peer that does not finish the close cannot retain the connection indefinitely.
    const timer = setTimeout(() => state.socket.destroy(), 1_000);
    timer.unref();
    state.socket.once("close", () => clearTimeout(timer));
    if (!this.#write(state, protocolErrorFrame(error), () => state.socket.end())) state.socket.destroy();
    state.closing = true;
    state.socket.pause();
  }

  #requestOperation(state, request) {
    const { type, params } = request;
    // A continuation uses its existing pending owner, not a new-work admission slot.
    if (state.role === "client" && type === "respond_dialog") {
      if (!state.subscriptions.has(params.sessionId)) throw requestFailure("stale_ui_request", "client is not subscribed to the pending action request");
      const key = `${params.sessionId}\0${params.uiRequestId}`; const pending = this.#dialogRequests.get(key);
      const actor = this.#actors.get(params.sessionId);
      if (!pending || pending.expiresAt <= Date.now() || !actor || !actor.worker.isRunning || actor.generation !== pending.generation) {
        throw requestFailure("stale_ui_request", "the action request is no longer pending on this actor generation");
      }
      return { continuationOwner: pending, run: () => {
        this.#dialogRequests.delete(key); clearTimeout(pending.timer);
        if (pending.notificationId) this.#notifications.transition(pending.notificationId, params.cancelled ? "cancelled" : "resolved");
        actor.worker.send({ type: "dialog_response", id: params.uiRequestId,
          ...(params.value !== undefined ? { value: params.value } : {}),
          ...(params.confirmed !== undefined ? { confirmed: params.confirmed } : {}),
          ...(params.cancelled !== undefined ? { cancelled: params.cancelled } : {}) });
        return { delivered: true };
      } };
    }
    if (state.role === "actor" && type === "flush_actor_inputs") {
      this.#requireActor(state);
      const actor = this.#actors.get(state.sessionId);
      if (!actor || actor.generation !== state.generation) throw new Error("actor generation is stale");
      return { continuationOwner: `input-queue\0${state.sessionId}\0${state.generation}`, run: async () => {
        await this.#deliverActorInputs(state.sessionId, actor);
        // Read after delivery at the existing authenticated request cutoff.
        return { flushed: true, fastMode: this.store.getSessionFastMode(state.sessionId) };
      } };
    }
    if (state.role === "actor" && ["get_actor_input", "accept_actor_input", "record_input_delivery"].includes(type)) {
      this.#requireActor(state);
      if (type !== "record_input_delivery") this.store.assertSessionAvailable(state.sessionId);
      const actor = this.#actors.get(state.sessionId);
      if (!actor || actor.generation !== state.generation) throw new Error("actor generation is stale");
      const input = this.store.getActorInput(params.inputId, state.sessionId);
      if (type !== "get_actor_input" && !input) throw new Error("input is not reserved for this actor");
      if (type === "accept_actor_input" && !["cron", "background"].includes(input.source)) throw new Error("custom input requires a verified internal source");
      const continuationOwner = input && input.state !== "completed"
        ? `${state.sessionId}\0${state.generation}\0${input.inputId}\0${type}` : undefined;
      return { continuationOwner, run: () => {
        if (type === "get_actor_input") return { input: input ?? null };
        if (type === "accept_actor_input") return { input: this.store.markActorInputAccepted(params.inputId, state.sessionId, state.generation) };
        return this.#recordInputDelivery(state, params, input);
      } };
    }
    if (state.role === "actor" && type === "ack_message") {
      this.#requireActor(state);
      const pending = this.store.getMessage(params.messageId);
      const continuationOwner = pending?.targetId === state.sessionId && pending.state === "delivered"
        ? `message\0${pending.messageId}` : undefined;
      return { continuationOwner, run: async () => {
        await this.#afterFrames(state.sessionId, state.generation, params.afterFrame);
        this.#requireFence(state.sessionId, state.generation, params.afterFrame);
        const message = this.store.acknowledgeMessage(params.messageId, state.sessionId);
        this.#receiptApplied(state.sessionId, state.generation, "messages", message.messageId);
        state.deliveryInFlight.delete(message.messageId);
        await this.#publishFamilyAdmission(state.sessionId, message.messageId).catch(error => this.logger.error?.(error));
        this.#syncPassivationTimer(state.sessionId);
        return { message };
      } };
    }
    return { run: () => this.#dispatch(state, request) };
  }

  async #recordInputDelivery(state, params, input) {
    await this.#afterFrames(state.sessionId, state.generation, params.afterFrame);
    const session = this.store.getSession(state.sessionId);
    const transcript = await this.transcriptReader.read({ sessionFile: session.sessionFile, sessionId: state.sessionId,
      inputProofIds: [params.inputId], familyDeliveryOnly: true });
    const proof = transcript.inputDeliveries?.[params.inputId];
    if (!proof || proof.entryId !== params.entryId || Date.parse(proof.deliveredAt) !== Date.parse(params.deliveredAt)) {
      throw new Error("input delivery is not present in the canonical transcript");
    }
    // The transcript read was asynchronous: the session may have exited or been replaced.
    this.#requireFence(state.sessionId, state.generation, params.afterFrame);
    const newlyDelivered = this.#completeInputDelivery(state.sessionId, input, proof, transcript);
    this.#receiptApplied(state.sessionId, state.generation, "inputs", params.inputId);
    return { accepted: true, newlyDelivered, input: this.store.getActorInput(params.inputId, state.sessionId) };
  }

  async #dispatch(state, request) {
    const { type, params } = request;
    if (type === "get_liveness") return { alive: true };
    if (type === "get_status") return this.status();
    if (type === "get_usage") return this.store.getUsageWindow(params.windowMinutes);
    if (type === "shutdown_daemon") { setImmediate(() => this.stop()); return { stopping: true }; }
    if (type === "register_actor") {
      if (state.role) throw new Error("connection is already registered");
      const registered = this.store.registerActor(params); state.role = "actor"; state.sessionId = params.sessionId; state.generation = params.actorGeneration;
      const old = this.#actorConnections.get(state.sessionId); this.#actorConnections.set(state.sessionId, state); if (old && old !== state) old.socket.end();
      const record = this.#actors.get(state.sessionId);
      if (record?.generation === state.generation) {
        record.messageTransportRepairAttempted = false;
        this.#queueHistoryMaintenance(state.sessionId, { invalidate: true });
      }
      this.#resolveActorConnectionWaiters(state);
      setImmediate(() => {
        this.#deliverPendingOutgoingHistory(state);
        this.#deliverPendingChildCreationHistory(state);
        const actor = this.#actors.get(state.sessionId);
        if (actor?.generation === state.generation && actor.worker.isRunning && !actor.expectedLifecycle
          && this.store.getSession(state.sessionId)?.lifecycle === "resident") this.#kickActorInputDelivery(state.sessionId, actor);
        void this.#withSessionMutation(state.sessionId, () => this.#deliverPending(state));
      });
      const scratch = ensureSessionScratch(this.store, state.sessionId, this.scratchDirectory);
      return { ...registered, scratch, limits: this.#limits() };
    }
    if (type === "register_client") {
      if (state.role) throw new Error("connection is already registered"); state.role = "client"; state.clientInstanceId = params.clientInstanceId; this.#clientConnections.add(state);
      return { limits: this.#limits(), ...this.#navigator() };
    }
    if (type === "heartbeat") { if (!state.role) throw new Error("connection is not registered"); if (state.role === "actor") this.store.heartbeatActor?.(state.sessionId, state.generation); return { alive: true }; }
    if (state.role === "actor") return this.#dispatchActor(state, type, params);
    if (state.role === "client") return this.#dispatchClient(state, type, params);
    throw new Error("connection must register as actor or client first");
  }

  #requireActor(state) { if (state.role !== "actor" || !state.sessionId || !state.generation) throw new Error("actor connection is not registered"); }
  #acceptActorSkillManifest(state, skills) {
    const record = this.#actors.get(state.sessionId);
    const expected = record?.generation === state.generation
      ? record.skillGrantSkills
      : this.store.getSessionSkillGrant(state.sessionId)?.skills;
    if (!expected || !sameSkillCatalog(expected, skills)) {
      throw new Error("actor skill manifest differs from its supervisor-owned grant");
    }
    return this.store.getSessionSkillGrant(state.sessionId);
  }

  async #dispatchActor(state, type, params) {
    this.#requireActor(state);
    // Home is the one session that may open a new room; others suggest one to the user.
    if (type === "create_root") {
      if (state.sessionId !== this.#homeSessionId()) throw requestFailure("create_root_forbidden", "only Home can start a new root session");
      return this.#createRoot(params);
    }
    if (type === "set_default_inference") {
      if (state.sessionId !== this.#homeSessionId()) throw requestFailure("default_inference_forbidden", "only Home can change the default model");
      return this.#setDefaultInference(state, params);
    }
    if (["spawn_child", "send_message", "revive_child"].includes(type)) this.store.assertSessionAvailable(state.sessionId);
    if (type === "set_session_name") { const session = this.store.setSessionName(state.sessionId, params.name); this.#broadcastNavigator("name_changed"); return { session }; }
    if (type === "record_actor_turn_failure") {
      this.store.recordActorTurnFailure(state.sessionId, state.generation, params);
      if (state.sessionId === this.#homeSessionId()) this.#homeNudge.failed(state.sessionId, params, Date.now());
      this.#retryChildExitMessages();
      return { recorded: true };
    }
    if (type === "update_activity") {
      const session = this.store.setActorActivity(state.sessionId, state.generation, params.streaming);
      if (params.streaming) this.#cancelHistoryMaintenance(state.sessionId);
      else this.#queueHistoryMaintenance(state.sessionId, { invalidate: true });
      this.#observeNotifications(state.sessionId); this.#syncPassivationTimers(); this.#broadcastNavigator("activity_changed"); return { session };
    }
    if (type === "update_progress_heading") return this.#updateProgressHeading(state, params);
    if (type === "record_progress_entry") {
      const record = this.#actors.get(state.sessionId);
      if (!record || record.generation !== state.generation) return { accepted: false };
      const summary = normalizeProgressHeading(params.summary);
      if (!summary || summary !== params.summary) throw new Error("progress entry is not a normalized safe heading");
      this.#onActorEvent(state.sessionId, record, { type: "progress_entry", entryId: params.entryId, summary, createdAt: params.createdAt, harnessBirth: params.harnessBirth });
      return { accepted: true };
    }
    if (type === "record_agent_message_entry") {
      const record = this.#actors.get(state.sessionId);
      if (!record || record.generation !== state.generation) return { accepted: false };
      if (params.direction === "from") {
        const message = this.store.getMessage(params.messageId);
        if (!message || message.targetId !== state.sessionId) throw new Error("incoming agent message entry does not match a message for this actor");
        if (message.senderId !== params.peerId || message.body !== params.body
          || receiverRelationship(message.relationship) !== params.relationship) {
          throw new Error("incoming agent message transcript entry does not match its durable message");
        }
        await this.#publishFamilyAdmission(state.sessionId, message.messageId).catch(error => this.logger.error?.(error));
        return { accepted: true, newlyQueued: false };
      }
      if (params.direction !== "to") throw new Error("only outgoing or incoming agent message entries can be recorded explicitly");
      const recorded = this.store.recordMessageSenderEntry(state.sessionId, params);
      if (recorded.newlyQueued) {
        this.#onActorEvent(state.sessionId, record, { type: "agent_message_entry", ...params });
        setImmediate(() => this.#deliverMessageWhenReady(recorded.message)
          .catch((error) => this.logger.error?.(`message target preparation failed for ${recorded.message.targetId}: ${error.message}`)));
      }
      return { accepted: true, newlyQueued: recorded.newlyQueued };
    }
    if (type === "record_child_creation_entry") {
      const record = this.#actors.get(state.sessionId);
      if (!record || record.generation !== state.generation) return { accepted: false };
      const recorded = this.store.recordChildCreationEntry(state.sessionId, params);
      if (recorded.newlyRecorded) {
        this.#onActorEvent(state.sessionId, record, { type: "child_creation_entry", ...params });
        setImmediate(() => this.#deliverPendingChildCreationHistory(state));
      }
      return { accepted: true, newlyRecorded: recorded.newlyRecorded };
    }
    if (type === "set_skill_manifest") return { grant: this.#acceptActorSkillManifest(state, params.skills) };
    if (type === "record_usage") return this.store.recordUsage(state.sessionId, params);
    if (type === "record_context_usage") return this.store.recordContextUsage(state.sessionId, params);
    if (["request_attention", "resolve_attention"].includes(type)) {
      this.store.assertSessionAvailable(state.sessionId);
      const session = this.store.getSession(state.sessionId);
      const actor = this.#actors.get(state.sessionId);
      if (session.kind !== "root" || session.depth !== 0 || !actor || actor.generation !== state.generation || !actor.worker.isRunning) {
        throw requestFailure("attention_forbidden", "human attention requests require the current root actor; children must route through their parent");
      }
      if (type === "request_attention" && !this.#notifications.notifiesRoot(state.sessionId)) {
        throw requestFailure("attention_forbidden", "only Home notifies the user; message Home if the user is needed");
      }
      return { notification: type === "request_attention" ? this.#notifications.request(state.sessionId, params, Date.now(), state.generation)
        : this.#notifications.resolveKey(state.sessionId, params.key) };
    }
    if (type === "get_roster") return { agents: this.store.getRoster(state.sessionId) };
    if (type === "run_reminders") return this.#runReminders(state.sessionId).then(notes => ({ notes }));
    if (type === "session_history") return this.#sessionHistory(state, params);
    if (type === "cron_job") {
      if (params.action === "report") {
        const actor = this.#actors.get(state.sessionId);
        if (!actor || actor.generation !== state.generation || !actor.worker.isRunning) throw requestFailure("cron_forbidden", "cron disposition requires the current actor");
      }
      return this.#cronOperation(state.sessionId, params);
    }
    if (type === "send_message") {
      this.#consumeMessageToken(state.sessionId); const message = this.store.createMessage(state.sessionId, params, { pendingLimit: this.pendingMessageLimit });
      this.#notifications.bindOrigin(state.sessionId, `message:${message.messageId}`, message.createdAt);
      const target = this.store.getSession(message.targetId);
      const waiting = this.#pendingFamilyPresentation(message);
      if (waiting) this.#publishInputState(message.targetId, waiting);
      setImmediate(() => this.#deliverPendingOutgoingHistory(state));
      return { message: { ...message, targetName: target?.name, targetShortId: target?.shortId, targetDepth: target?.depth } };
    }
    if (type === "spawn_child") return this.#spawnChild(state.sessionId, params);
    if (type === "list_children") return { children: this.store.listChildren(state.sessionId) };
    if (type === "get_child") return { child: this.store.resolveDirectChild(state.sessionId, params.selector) };
    if (type === "stop_child") { const child = this.store.resolveDirectChild(state.sessionId, params.selector); return this.#withSessionMutation(child.sessionId, async () => { await this.#stopActorAndDrainInputs(child.sessionId); return { child: this.store.getSession(child.sessionId) }; }); }
    if (type === "revive_child") { const child = this.store.resolveDirectChild(state.sessionId, params.selector); return this.#withSessionMutation(child.sessionId, async () => { this.#requestActorStart(child.sessionId, true); return { child: this.store.getSession(child.sessionId) }; }); }
    if (type === "delete_child") { const child = this.store.resolveDirectChild(state.sessionId, params.selector); const result = await this.#deleteSessionTree(child.sessionId); return { child: result.session, deletedSessionIds: result.deletedSessionIds }; }
    if (type === "get_status") return this.status();
    throw new Error(`request ${type} is not available to actors`);
  }

  async #dispatchClient(state, type, params) {
    if (type === "list_notifications") return this.#notifications.list(params);
    if (type === "get_notification") return { notification: this.#notifications.get(params.id), deliveries: this.#notifications.deliveries(params.id) };
    if (type === "read_notification") return { notification: this.#notifications.read(params.id) };
    if (type === "dismiss_notification") return { notification: this.#notifications.transition(params.id, "resolved", Date.now(), "user") };
    if (type === "claim_notification_delivery") return { claims: this.#notifications.claim(params.endpointIds), closures: this.#notifications.claimClosures(params.endpointIds) };
    if (type === "record_notification_delivery") return this.#notifications.receipt(params);
    if (type === "create_root") return this.#createRoot(params);
    if (type === "list_sessions") return this.#navigator();
    if (type === "get_skill_runtime_plan") return this.#skillRuntimePlan();
    if (type === "provision_skill_runtime") return this.#provisionSkillRuntime(params.fingerprint);
    if (type === "subscribe_root_output") { state.rootOutputSubscribed = true; return this.#rootOutput.subscribe(params); }
    if (type === "unsubscribe_root_output") { state.rootOutputSubscribed = false; return { unsubscribed: true }; }
    if (type === "rename_session") { const session = this.store.setSessionName(params.sessionId, params.name); this.#broadcastNavigator("name_changed"); return { session: this.#sessionView(session) }; }
    if (type === "subscribe_session") {
      const selected = this.#resolveSession(params.selector);
      const wasSubscribed = state.subscriptions.has(selected.sessionId);
      state.subscriptions.add(selected.sessionId);
      if (params.passive) {
        const actor = this.#actors.get(selected.sessionId);
        return { session: this.#sessionView(this.store.getSession(selected.sessionId)),
          state: { sessionId: selected.sessionId, sessionFile: selected.sessionFile, isStreaming: Boolean(actor && this.store.getSession(selected.sessionId)?.activity === "working") },
          eventSeq: actor?.eventSeq ?? 0, events: [], pendingUiRequests: this.#pendingUiRequests(selected.sessionId), passive: true };
      }
      try {
        const actor = await this.#ensureActorReady(selected.sessionId);
        const current = await actor.worker.request("get_state");
        return { session: this.#sessionView(this.store.getSession(selected.sessionId)), state: current,
          eventSeq: actor.eventSeq, events: current?.isStreaming ? this.#boundedReplay(actor.eventRing) : [], pendingUiRequests: this.#pendingUiRequests(selected.sessionId), passive: false };
      } catch (error) {
        if (!wasSubscribed) state.subscriptions.delete(selected.sessionId);
        throw error;
      }
    }
    if (type === "unsubscribe_session") { state.subscriptions.delete(params.sessionId); return { detached: true }; }
    if (type === "get_session_inference") return this.#withSessionMutation(params.sessionId, () => this.#getSessionInference(params.sessionId));
    if (type === "set_session_inference") return this.#withSessionMutation(params.sessionId, () => this.#setSessionInference(params));
    if (type === "set_session_fast_mode") return this.#withSessionMutation(params.sessionId, () => this.#setSessionFastMode(params));
    if (type === "submit_input") return this.#withSessionMutation(params.sessionId, async () => {
      if (this.#stoppingPromise) throw requestFailure("unavailable", "supervisor is stopping");
      const inputId = params.clientRequestId ? `client-${createHash("sha256").update(params.sessionId).update("\0").update(params.clientRequestId).digest("hex")}` : undefined;
      const clientMessageId = params.clientMessageId ?? params.clientRequestId;
      const retryIntent = retryIntentForRequest(params);
      const acceptedResponse = (input, includeMessage = true) => ({
        accepted: true, inputId: input.inputId, sessionId: params.sessionId, behavior: params.behavior,
        createdAt: input.delivery.acceptedAt, delivery: input.delivery, clientMessageId: input.clientMessageId,
        source: input.source, origin: input.origin, ...(input.outcome ? { outcome: input.outcome, handledAt: input.handledAt } : {}),
        ...(includeMessage && input.outcome !== "handled" && typeof input.message === "string" ? { message: pendingInputMessage(input) } : {}),
      });
      const prior = this.store.matchActorInputRequest(params.sessionId, { inputId, retryIntent, behavior: params.behavior, clientMessageId,
        ...(retryIntent?.mode === "original" ? {} : { message: params.message, images: params.images, location: params.location }) });
      if (prior && retryIntent) {
        if (prior.state !== "completed") this.#queueActorInputWake(params.sessionId);
        return acceptedResponse(prior, prior.state !== "completed");
      }
      // The core has no branches: retrying a response is not offered.
      if (retryIntent) throw requestFailure("invalid_request", "retrying a response is not supported");
      const payload = { message: params.message, images: params.images, location: params.location, source: "user", origin: null };
      const input = this.store.createActorInput(params.sessionId, { inputId, ...payload, behavior: params.behavior,
        retryIntent, clientMessageId, pendingLimit: this.pendingMessageLimit });
      if (!prior) this.#notifications.noteUserInput(params.sessionId);
      if (input.state !== "completed") this.#queueActorInputWake(params.sessionId);
      const current = this.store.getActorInput(input.inputId, params.sessionId);
      const trusted = { ...payload, ...input, ...current };
      if (current.outcome !== "handled" && (!prior || prior.state !== "completed")) this.#publishInputState(params.sessionId, pendingInputMessage(trusted));
      if (!prior) this.#broadcastNavigator("input_accepted");
      return acceptedResponse(trusted, !prior || prior.state !== "completed");
    });
    if (type === "get_memory_diagnostics") {
      const numeric = nodeMemoryDiagnostics();
      const unavailable = state => ({ version: 1, supervisor: numeric, worker: { state } });
      const session = this.store.getSession(params.sessionId);
      if (!session || session.lifecycle === "deleted") throw requestFailure("not_found", "session does not exist");
      const actor = this.#actors.get(params.sessionId);
      if (this.#stoppingPromise || actor?.expectedLifecycle || this.store.isSessionDeleting(params.sessionId)) return unavailable("unavailable-busy");
      if (!actor?.worker.isRunning || session.lifecycle !== "resident" || actor.generation !== session.actorGeneration) return unavailable("unavailable-not-running");
      try {
        const data = await actor.worker.request("get_memory_diagnostics", {}, 1000);
        if (this.#actors.get(params.sessionId) !== actor || actor.expectedLifecycle) return unavailable("unavailable-busy");
        return { version: 1, supervisor: numeric, worker: workerMemoryDiagnostics(data) };
      } catch { return unavailable("unavailable-error"); }
    }
    if (type === "get_actor_state") { const actor = await this.#ensureActorReady(params.sessionId); return { state: await actor.worker.request("get_state") }; }
    if (type === "get_actor_entries") { const actor = await this.#ensureActorReady(params.sessionId); return this.#boundedEntries(await actor.worker.request("get_entries", params.since ? { since: params.since } : {})); }
    if (type === "get_visible_messages") {
      const session = this.store.getSession(params.sessionId);
      if (!session || session.lifecycle === "deleted" || !session.sessionFile) throw new Error("session does not have a canonical history");
      // A scroll-back cursor is the number of the oldest entry already shown.
      if (params.before !== undefined && params.before !== null && !/^(0|[1-9][0-9]{0,15})$/.test(String(params.before))) {
        throw requestFailure("invalid_request", "history cursor is invalid");
      }
      const { inputIds: _inputIds, inputEntries: _inputEntries, inputDeliveries: _inputDeliveries, inputAssociationStates: _inputAssociationStates, familyMessages = {}, ...visible } = await this.transcriptReader.read({ sessionFile: session.sessionFile,
        sessionId: session.sessionId, sanitizePresentation: session.kind === "root" && session.depth === 0,
        maxMessages: params.limit ?? 100, before: params.before ?? null, publicView: true, inputProofIds: "page", familyDeliveryOnly: true,
        allowToolImages: session.kind === "root" && session.depth === 0 });
      // The cursor belongs to this canonical page, not to pending or live rows
      // that can precede it in the augmented timeline.
      visible.historyPage = { ...visible.historyPage, canonicalIds: visible.history.map(item => item.id) };
      if (params.before) return visible;
      const actor = this.#actors.get(session.sessionId);
      const messages = new Map(visible.messages.map((message) => [message.id, message]));
      for (const input of this.store.listPendingActorInputs(session.sessionId)) if (!messages.has(input.inputId)) messages.set(input.inputId, pendingInputMessage(input));
      for (const route of this.store.listWaitingIncomingMessages(session.sessionId, Math.min(this.pendingMessageLimit, 1000))) {
        // Admission can precede acknowledgement, or lie outside this bounded page.
        if (familyMessages[route.messageId]?.delivery?.state === "delivered") continue;
        const waiting = this.#pendingFamilyPresentation(route);
        if (waiting) messages.set(waiting.id, waiting);
      }
      for (const message of actor?.liveConversation.snapshot() ?? []) {
        if (message.familyMessageId) {
          if (familyMessages[message.familyMessageId]?.delivery?.state === "delivered") continue;
          const route = this.store.getMessage(message.familyMessageId);
          const current = route && this.#pendingFamilyPresentation(route);
          if (current && !messages.has(message.id)) messages.set(message.id, current);
          continue;
        }
        if (!messages.has(message.id)) messages.set(message.id, message);
      }
      const history = visible.history.map((item) => item.kind === "message" ? { kind: "message", message: messages.get(item.id) } : item);
      const seen = new Set(visible.history.map((item) => item.id));
      for (const message of messages.values()) if (!seen.has(message.id)) history.push({ kind: "message", message });
      sortVisibleHistory(history);
      actor?.liveConversation.reconcile(new Set(visible.messages.map((message) => message.id)));
      return { ...visible, truncated: visible.truncated || Boolean(actor?.liveConversation.truncated), messages: [...messages.values()], history: history.map((item) => item.kind === "message" ? { kind: "message", id: item.message.id } : item),
        actorEventSeq: actor?.eventSeq ?? 0, actorGeneration: actor?.generation ?? session.actorGeneration };
    }
    if (type === "get_visible_image") {
      const session = this.store.getSession(params.sessionId);
      if (!session || session.lifecycle === "deleted" || !session.sessionFile) throw new Error("session does not have a canonical history");
      const input = this.store.getActorInput(params.entryId, session.sessionId);
      if (input?.images?.[params.index]) return { image: input.images[params.index] };
      return { image: await this.transcriptReader.readImage({ sessionFile: session.sessionFile, sessionId: session.sessionId,
        entryId: input?.entryId ?? params.entryId, index: params.index,
        allowToolImages: session.kind === "root" && session.depth === 0,
        sanitizePresentation: session.kind === "root" && session.depth === 0 }) };
    }
    // No compaction: the model manages its own context.
    if (type === "compact_session") throw requestFailure("invalid_request", "context compaction is not supported");
    if (type === "restart_kernel") return this.#withSessionMutation(params.sessionId, async () => {
      const actor = await this.#idleActorForAction(params.sessionId, "reload the Python kernel");
      return actor.worker.request("restart_kernel", {}, SESSION_ACTION_TIMEOUT_MS);
    });
    if (type === "abort_session") return this.#withSessionMutation(params.sessionId, async () => { const actor = await this.#ensureActorReady(params.sessionId); await actor.worker.request("abort"); return { aborted: true }; });
    if (type === "stop_session") return this.#withSessionMutation(params.sessionId, async () => {
      await this.#stopActorAndDrainInputs(params.sessionId);
      return { session: this.store.getSession(params.sessionId) };
    });
    if (type === "revive_session") return this.#withSessionMutation(params.sessionId, async () => { this.#requestActorStart(params.sessionId, true); return { session: this.store.getSession(params.sessionId) }; });
    if (type === "delete_session") return this.#deleteSessionTree(params.sessionId);
    throw new Error(`request ${type} is not available to clients`);
  }

  async #deleteSessionTree(sessionId) {
    // Fence before the first await, including legacy tombstoned intermediates.
    const sessions = this.store.beginSessionDeletion(sessionId);
    const ids = sessions.map((session) => session.sessionId);
    const retirement = this.#beginActorRetirement(ids);
    const failures = [];
    try {
      const outgoing = ids.flatMap(id => this.store.listMessagesAwaitingSenderEntry(id, Math.min(this.pendingMessageLimit, 1000)));
      const pending = [retirement.done, ...ids.map(id => this.#sessionMutationTails.get(id)).filter(Boolean)];
      for (const id of ids) {
        try { await this.#stopActor(id, "stopped"); } catch (error) { failures.push(error); }
      }
      // Old requests can finish shutdown, but cannot admit work across the fence.
      await Promise.allSettled(pending);
      for (const id of ids) {
        const record = this.#actors.get(id);
        if (record?.worker.isRunning) {
          try { await this.#stopActor(id, "stopped"); } catch (error) { failures.push(error); }
        }
        if (this.#actors.get(id)?.worker.isRunning) failures.push(new Error("session actor is still running"));
      }
      if (failures.length) throw new AggregateError(failures, "session subtree could not be stopped; deletion was not committed");
      const session = this.store.deleteSession(sessionId);
      for (const original of outgoing) {
        const route = this.store.getMessage(original.messageId);
        const retired = route?.state === "rejected" && this.#pendingFamilyPresentation(route);
        if (retired) this.#publishInputState(route.targetId, retired);
      }
      for (const item of sessions) {
        if (item.sessionFile) this.transcriptReader.clear(item.sessionFile);
        this.#clearSessionRouting(item.sessionId);
        this.#notifications.cancelSession(item.sessionId);
      }
      for (const client of this.#clientConnections) this.#write(client, event("sessions_deleted", { sessionIds: ids }));
      this.#broadcastNavigator("sessions_deleted");
      if (session.kind === "root" && this.store.rootScratchCleanupState(sessionId) === "deleting") {
        this.#backgroundCompletionMonitor?.resetRetirementProof();
      }
      return { session, deletedSessionIds: ids,
        ...(session.kind === "root" ? { scratchCleanup: this.store.rootScratchCleanupState(sessionId) } : {}) };
    } finally { retirement.release(); this.store.endSessionDeletion(sessions); }
  }

  async #tryScratchCleanup(rootId, processRoots) {
    try {
      const record = this.store.getRootScratch(rootId);
      if (record?.state !== "deleting") return;
      const family = this.store.getSessionSubtree(rootId);
      if (family.some(session => session.lifecycle !== "deleted" || this.#actors.get(session.sessionId)?.worker.isRunning)) return;
      // Runs even without a process proof: it also pins job identities, which must not wait for a clean /proc sample.
      if (!await this.#backgroundCompletionMonitor?.areSessionsQuiescent(family.map(session => session.sessionId))) return;
      if (!processRoots.has(rootId)) return;
      reclaimSessionScratch(this.store, rootId, this.scratchDirectory);
    } catch {
      // The tombstone and durable intent survive path changes, I/O errors, and restarts.
      // Retrying never revives actors, kills detached jobs, or replays their input.
    }
  }

  async #retryPendingScratchCleanup() {
    if (this.#stoppingPromise) return;
    const roots = this.store.listPendingScratchRoots().filter(rootId => !this.store.isSessionDeleting(rootId));
    const owners = roots.flatMap(rootId => this.store.getSessionSubtree(rootId).map(session => session.sessionId));
    if (!roots.length) { this.#backgroundCompletionMonitor?.resetRetirementProof(); return; }
    const processRoots = await quiescentScratchProcessRoots(roots);
    await this.#backgroundCompletionMonitor?.prepareRetirementProof(owners);
    for (const rootId of roots) {
      if (this.store.isSessionDeleting(rootId) || this.#sessionMutationTails.has(rootId)) continue;
      await this.#withSessionMutation(rootId, () => this.#tryScratchCleanup(rootId, processRoots));
    }
  }

  #clearSessionRouting(sessionId) {
    this.#messageBuckets.delete(sessionId);
    const state = this.#actorConnections.get(sessionId);
    if (state) state.socket.end();
    for (const client of this.#clientConnections) client.subscriptions.delete(sessionId);
  }

  #withSessionMutation(sessionId, operation) {
    const previous = this.#sessionMutationTails.get(sessionId) ?? Promise.resolve();
    const current = previous.then(() => {
      if (this.store.isSessionDeleting(sessionId)) this.store.assertSessionAvailable(sessionId);
      return operation();
    });
    const tail = current.catch(() => {});
    this.#sessionMutationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.#sessionMutationTails.get(sessionId) !== tail) return;
      this.#sessionMutationTails.delete(sessionId);
      this.#syncPassivationTimer(sessionId);
    });
    return current;
  }

  async #idleActorForAction(sessionId, action) {
    const actor = await this.#ensureActorReady(sessionId);
    const state = await actor.worker.request("get_state");
    if (state?.isStreaming || state?.isCompacting || Number(state?.pendingMessageCount ?? 0) > 0) {
      throw requestFailure("session_busy", `conversation must be idle to ${action}`);
    }
    return actor;
  }


  async #inferenceSnapshot(sessionId, actor = null, refresh = true) {
    const active = actor ?? await this.#ensureActorReady(sessionId);
    const [available, state] = await Promise.all([
      active.worker.request("get_available_models", { refresh }), active.worker.request("get_state"),
    ]);
    const models = projectAvailableModels(available?.models);
    const session = this.store.getSession(sessionId);
    if (!session || session.lifecycle === "deleted") throw requestFailure("not_found", "session does not exist");
    // The acknowledged launch policy owns the public active selection. The worker can
    // change its model before awaited observers publish the applied receipt.
    const pending = session.launch?.pendingInference;
    const current = resolveModelSelection(available?.models, pending ? session.launch?.model?.resolved
      : { provider: state?.model?.provider, id: state?.model?.id });
    const thinkingLevel = pending ? session.launch?.thinking?.resolved : state?.thinkingLevel;
    validateInferenceEffort(thinkingLevel, current);
    const busy = Boolean(state?.isStreaming || state?.isCompacting || Number(state?.pendingMessageCount) > 0
      || session.activity === "working" || this.store.hasPendingSessionWork(sessionId));
    return { selection: { provider: current.provider, model: current.id, thinkingLevel, fastMode: session.launch?.fastMode ?? null },
      pending: session.launch?.pendingInference ?? null,
      fastModeRootSessionId: session.launch?.fastModeRootSessionId ?? null,
      fastModeSupported: current.fastModeSupported, models, busy, telemetry: this.store.getSessionTelemetry(sessionId) };
  }

  async #getSessionInference(sessionId) {
    const actor = await this.#ensureActorReady(sessionId);
    if (this.store.getSession(sessionId)?.launch?.pendingInference?.error) await this.#sendPendingInference(sessionId, actor);
    return this.#inferenceSnapshot(sessionId, actor);
  }

  async #setSessionFastMode(params) {
    const preference = this.store.getSessionFastModePreference(params.sessionId);
    if (preference.fastModeRootSessionId !== params.sessionId) {
      throw requestFailure("invalid_request", "only the root session can change family Fast mode");
    }
    const actor = await this.#ensureActorReady(params.sessionId);
    // Read only the target actor, not the provider catalog or unrelated sessions.
    const state = await actor.worker.request("get_state");
    const session = this.store.getSession(params.sessionId);
    if (!session || session.lifecycle === "deleted") throw requestFailure("not_found", "session does not exist");
    if (session.launch?.fastModeRootSessionId !== params.sessionId) {
      throw requestFailure("invalid_request", "only the root session can change family Fast mode");
    }
    const pending = session.launch?.pendingInference;
    const selection = { provider: pending ? session.launch?.model?.resolved?.provider : state?.model?.provider,
      model: pending ? session.launch?.model?.resolved?.id : state?.model?.id,
      thinkingLevel: pending ? session.launch?.thinking?.resolved : state?.thinkingLevel, fastMode: session.launch?.fastMode ?? null };
    if (Object.keys(selection).some(key => selection[key] !== params.expected[key])) {
      throw requestFailure("stale_inference", "session inference selection changed; refresh and try again");
    }
    const fastModeSupported = pending ? session.launch?.fastModeSupported : state?.model?.fastModeSupported === true;
    const changed = selection.fastMode !== params.fastMode;
    if (changed) this.store.updateSessionFastMode(params.sessionId, params.fastMode, selection.fastMode);
    // The durable receipt is authoritative. No post-commit actor RPC can turn success into failure.
    this.#broadcastNavigator("inference_changed");
    return { selection: { ...selection, fastMode: params.fastMode }, pending: session.launch?.pendingInference ?? null,
      fastModeRootSessionId: params.sessionId, fastModeSupported, changed };
  }

  async #setSessionInference(params) {
    const actor = await this.#ensureActorReady(params.sessionId);
    const current = await this.#inferenceSnapshot(params.sessionId, actor, false);
    if (current.selection.provider !== params.expected.provider || current.selection.model !== params.expected.model
      || current.selection.thinkingLevel !== params.expected.thinkingLevel) {
      throw requestFailure("stale_inference", "session inference selection changed; refresh and confirm again");
    }
    let target;
    try {
      target = current.models.find((model) => model.provider === params.provider && model.id === params.model);
      if (!target) throw new Error(`model did not resolve exactly: ${params.provider}/${params.model}`);
      validateInferenceEffort(params.thinkingLevel, target);
    } catch (error) {
      throw requestFailure("unsupported_inference", error instanceof Error ? error.message : String(error));
    }
    const same = target.provider === current.selection.provider && target.id === current.selection.model
      && params.thinkingLevel === current.selection.thinkingLevel;
    if (same && !current.pending) return { ...current, changed: false };
    const pending = this.store.queueSessionInference(params.sessionId,
      { provider: target.provider, model: target.id, thinkingLevel: params.thinkingLevel },
      { ...current.selection, fastModeSupported: current.fastModeSupported });
    this.#broadcastNavigator("inference_pending");
    await this.#sendPendingInference(params.sessionId, actor, pending);
    return { ...await this.#inferenceSnapshot(params.sessionId, actor, false), changed: true };
  }

  // The store commits first, so an interrupted change can be repeated and still
  // finds any session that has not moved; settings name the new default last.
  async #setDefaultInference(state, params) {
    const settingsPath = this.settingsPath ?? path.join(path.dirname(this.databasePath), "..", "settings.json");
    const from = readDefaultModel(settingsPath);
    const available = await this.#actors.get(state.sessionId).worker.request("get_available_models", { refresh: false });
    let target;
    try { target = resolveDefaultTarget(params.target, available?.models ?? [], from.provider); }
    catch (error) { throw requestFailure("unsupported_inference", error.message); }
    const to = { provider: target.provider, id: target.id, fastModeSupported: projectAvailableModels([target])[0]?.fastModeSupported === true };
    const liveSessionIds = new Set(this.#actors.keys());
    const outcome = this.store.retargetDefaultInference({ from, to, liveSessionIds, apply: params.apply,
      thinkingFor: (level) => (level ? closestThinkingLevel(level, target) : level) });
    if (params.apply) {
      writeDefaultModel(settingsPath, target.provider, target.id);
      for (const { sessionId, live } of outcome.moved) {
        if (live && this.#actors.has(sessionId)) await this.#sendPendingInference(sessionId, this.#actors.get(sessionId));
      }
      this.#broadcastNavigator("inference_pending");
    }
    return { applied: params.apply, from, to: { provider: target.provider, model: target.id }, ...outcome };
  }

  async #sendPendingInference(sessionId, actor, pending = this.store.getSession(sessionId)?.launch?.pendingInference) {
    if (!pending) return;
    // The worker applies it once the session settles and reports it with an event.
    try { await actor.worker.request("select_inference", pending); }
    catch (error) {
      // The durable intent remains accepted even when its worker receipt is lost.
      // Reconnect and startup retry it without replaying conversation input.
      this.store.recordSessionInferenceResult(sessionId, actor.generation, { requestId: pending.requestId, error: true });
      this.#broadcastNavigator("inference_pending");
      this.logger.error?.(`inference delivery failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #limits() { return { maxFrameBytes: this.maxFrameBytes, maxDepth: this.maxDepth, maxResidentActors: this.maxResidentActors, maxConcurrentStarts: this.maxConcurrentStarts, rootOutputSseVersion: 1, rootOutputPresentationVersion: 1, notificationVersion: 1 }; }
  #resolveSession(selector) { return this.store.resolveSession(selector); }
  #sessionView(session) {
    const actor = this.#actors.get(session.sessionId);
    const summary = actor?.generation === session.actorGeneration && ["working", "delegating"].includes(session.activity)
      ? actor.progressSummary : undefined;
    const { actorIdentity: _actorIdentity, actorToken: _actorToken, ...publicSession } = session;
    return { ...publicSession, ...(summary ? { agentStatus: { summary } } : {}),
      activeBackgroundJobs: this.#backgroundCompletionMonitor?.getActiveBackgroundJobs(session.sessionId) ?? [],
      attachmentCount: [...this.#clientConnections].filter((state) => state.subscriptions.has(session.sessionId)).length,
      actorConnected: this.#actorConnections.has(session.sessionId) };
  }
  #historyMaintenanceBusy(sessionId, session = this.store.getSession(sessionId)) {
    const actor = this.#actors.get(sessionId);
    return this.#startQueue.includes(sessionId) || this.#startingActors.has(sessionId) || session?.activity === "working"
      || Boolean(actor && (actor.expectedLifecycle || actor.notificationWork.size || this.store.hasPendingSessionWork(sessionId)));
  }
  #cancelHistoryMaintenance(sessionId) { this.#history.cancelMaintenance(sessionId); }
  #queueHistoryMaintenance(sessionId, options) { this.#history.queueMaintenance(sessionId, options); }
  #sessionHistory(state, params) { return this.#history.handleRequest(state, params); }
  #navigator() {
    const preferredSessionIds = new Set([...this.#actors.keys(), ...this.#startingActors, ...this.#actorConnections.keys()]);
    for (const state of this.#clientConnections) for (const sessionId of state.subscriptions) preferredSessionIds.add(sessionId);
    const selected = this.store.listNavigatorSessions({ preferredSessionIds: [...preferredSessionIds] });
    return { sessions: selected.sessions.map((item) => this.#sessionView(item)),
      navigatorTotal: selected.total, navigatorTruncated: selected.truncated };
  }
  #broadcastRootOutput(frame) {
    const subscribers = [...this.#clientConnections]
      .filter((state) => state.rootOutputSubscribed && !state.closing && !state.cleaned && !state.socket.destroyed);
    if (subscribers.length === 0) return;
    let encoded;
    try { encoded = encodeFrame(event("root_output_event", frame), { maxFrameBytes: this.maxFrameBytes }); }
    catch {
      for (const state of subscribers) { state.rootOutputSubscribed = false; state.socket.destroy(); }
      return;
    }
    for (const state of subscribers) this.#write(state, encoded);
  }
  #recordCronNotifications() {
    for (const run of this.#cronStore.pendingNotifications()) {
      if (run.notificationIntent === "silent" || run.status === "completed" && run.notificationIntent === "conditional" && run.notificationDisposition === "no_finding") {
        this.#cronStore.notificationRecorded(run.runId); continue;
      }
      const job = this.#cronStore.getJob(run.jobId);
      const sessionId = run.sessionId ?? job.originSessionId;
      const family = this.#notifications.family(sessionId);
      if (!family) { this.#cronStore.notificationRecorded(run.runId); continue; }
      const missing = run.notificationIntent === "conditional" && !run.notificationDisposition;
      const output = run.notificationBody ?? run.output;
      const failed = run.status !== "completed" || missing || !output?.trim();
      this.#notifications.create({ key: `cron:${run.runId}`, rootId: family.rootId, sessionId,
        kind: "cron", title: failed ? `Scheduled result unavailable: ${job.name}` : job.name,
        body: failed ? missing ? "This scheduled check ended without the required deliver/no-finding disposition. Its condition was not established."
          : `This scheduled run did not produce its promised result (${run.status}). Open the conversation or cron history to inspect the outcome.` : output,
        expiresAt: (run.completedAt ?? Date.now()) + 86400_000,
        source: { type: "cron", runId: run.runId, jobId: run.jobId, intent: run.notificationIntent, failed } });
      this.#cronStore.notificationRecorded(run.runId);
    }
  }
  #observeNotifications(sessionId) {
    if (!this.#notifications || this.#stoppingPromise) return;
    const family = this.#notifications.family(sessionId);
    if (!family) { this.#notifications.cancelSession(sessionId); return; }
    const cron = family.members.some(s => this.#cronStore?.hasActiveRunForSession(s.id));
    const backgroundCount = family.members.reduce((n, s) => n + (this.#backgroundCompletionMonitor?.getActiveBackgroundJobs(s.id)?.length ?? 0), 0);
    const liveActors = family.members.filter(s => this.#actors.get(s.id)?.notificationWork?.size).map(s => s.id);
    this.#notifications.observe(sessionId, { owner: cron ? "cron" : null, backgroundCount, liveActors }, family);
  }
  #broadcastNavigator(reason) {
    if (this.#clientConnections.size === 0) return;
    const frame = event("navigator_changed", { reason, ...this.#navigator() });
    this.#broadcast(this.#clientConnections, frame);
  }


  async #createRoot(params) {
    const initialized = await this.coreSessions.create({ sessionsDirectory: this.coreSessionsDirectory });
    const launch = { model: params.model ? { requested: `${params.provider}/${params.model}`, resolved: { provider: params.provider, id: params.model }, source: "explicit" } : null,
      thinking: { requested: params.thinkingLevel, resolved: params.thinkingLevel, source: params.thinkingLevel ? "explicit" : "settings" }, capabilities: [], skillCatalog: [] };
    try {
      const admitted = this.store.createRoot({ ...initialized, cwd: params.cwd, repositoryRoot: params.repositoryRoot, name: params.name, launch, actorToken: randomUUID() });
      this.#requestActorStart(admitted.session.sessionId, false); this.#broadcastNavigator("root_admitted");
      return { admission: admitted.session };
    } catch (error) { await this.#removeUnadmittedSession(initialized.sessionFile); throw error; }
  }

  #sessionIsIsolatedScheduledRun(sessionId) {
    return this.#cronStore.listActiveRunsForSession(sessionId).some((run) => (
      run.executionModeUsed === "fresh"
      || (run.executionModeUsed == null && run.executionModeRequested === "fresh")
    ));
  }

  #cronOperation(sessionId, params) {
    const session = this.store.getSession(sessionId);
    if (!session || session.lifecycle === "deleted" || session.kind !== "root" || session.depth !== 0) {
      throw requestFailure("cron_forbidden", "cron management is available only to live root sessions");
    }
    if (params.action === "report") {
      const run = this.#cronStore.reportNotification(params.runId, sessionId, params);
      // Exact-run readiness is explicit. It does not wait for unrelated family work.
      if (run.status === "running") {
        this.#cronStore.finishRun(run.runId, "completed", { output: run.notificationBody });
        void this.#log("cron_run_finished", { runId: run.runId, jobId: run.jobId, sessionId, status: "completed" });
      }
      return { run: this.#cronStore.getRun(run.runId) };
    }
    if (this.#sessionIsIsolatedScheduledRun(sessionId)) {
      throw requestFailure("cron_recursive_scheduling", "scheduled runs cannot manage the scheduler");
    }
    if (params.action === "create") return { job: this.#cronScheduler.create(sessionId, params) };
    if (params.action === "list") return this.#cronScheduler.list(params);
    if (params.action === "update") {
      const { action: _action, selector, ...patch } = params;
      return { job: this.#cronScheduler.update(selector, patch) };
    }
    if (params.action === "pause") return { job: this.#cronScheduler.pause(params.selector) };
    if (params.action === "resume") return { job: this.#cronScheduler.resume(params.selector) };
    if (params.action === "run") return { run: this.#cronScheduler.runNow(params.selector) };
    if (params.action === "remove") return { job: this.#cronScheduler.remove(params.selector) };
    if (params.action === "history") return this.#cronScheduler.history(params.selector, params.limit);
    throw new Error(`unsupported cron action: ${params.action}`);
  }

  async #createCronRoot(job, run) {
    const name = `Cron ${job.name} ${run.runId.slice(-6)}`.slice(0, 256);
    const initialized = await this.coreSessions.create({ sessionsDirectory: this.coreSessionsDirectory });
    const policy = normalizeCronLaunch(job.launch);
    const launch = {
      model: policy.model,
      thinking: policy.thinking,
      capabilities: [], skillCatalog: [],
    };
    try {
      const admitted = this.store.createRoot({ ...initialized, cwd: job.cwd, repositoryRoot: job.repositoryRoot,
        name, launch, actorToken: randomUUID() });
      this.#requestActorStart(admitted.session.sessionId, false);
      this.#broadcastNavigator("cron_root_admitted");
      return admitted.session;
    } catch (error) { await this.#removeUnadmittedSession(initialized.sessionFile); throw error; }
  }

  async #dispatchCronRun({ run, job, prompt }) {
    const dispatch = async (target, executionModeUsed, fallbackReason = null) => {
      const isolated = executionModeUsed === "fresh";
      const inputId = isolated ? `cron-input-${run.runId}` : `cron-origin-${run.runId}`;
      const original = isolated ? prompt : cronOriginPrompt(job, run);
      const intent = run.notificationIntent;
      const deliveryContext = intent === "conditional"
        ? `Evaluate this run's notification condition explicitly. Before settling, use cron(action="report", run_id="${run.runId}", disposition="deliver", body="the meaningful finding") when it holds, or disposition="no_finding" with no body when it does not. An absent disposition is an evaluation failure, not a negative finding.`
        : intent === "result" ? `This run promises a meaningful result or reminder. Its exact-run final response is delivered; you may instead bind concise notification text with cron(action="report", run_id="${run.runId}", disposition="deliver", body="the result").`
        : intent === "silent" ? "This run is silent: no routine completion notification is intended." : null;
      const message = deliveryContext ? `${original}\n\n[Scheduled delivery context: run ${run.runId}; intent ${intent}]\n${deliveryContext}\nThis delivery context does not grant any additional authority.` : original;
      this.#cancelIdlePreparation(target.sessionId);
      this.#cronStore.markRunRunning(run.runId, { executionModeUsed, sessionId: target.sessionId, fallbackReason, inputId });
      this.store.createActorInput(target.sessionId, { inputId, message, behavior: "auto", source: "cron",
        origin: { jobId: job.jobId, runId: run.runId }, pendingLimit: this.pendingMessageLimit });
      const actor = await this.#ensureActorReady(target.sessionId);
      await this.#deliverActorInputs(target.sessionId, actor);
      await this.#log("cron_run_dispatched", { runId: run.runId, jobId: job.jobId, sessionId: target.sessionId,
        executionModeUsed, ...(fallbackReason ? { fallbackReason } : {}) });
    };
    if (job.executionMode === "origin") {
      const dispatched = await this.#withSessionMutation(job.originSessionId, async () => {
        const origin = this.store.getSession(job.originSessionId);
        if (!origin || origin.lifecycle === "deleted" || origin.kind !== "root") return false;
        await dispatch(origin, "origin"); return true;
      });
      if (dispatched) return;
    }
    const target = await this.#createCronRoot(job, run);
    await this.#withSessionMutation(target.sessionId, () => dispatch(target, "fresh",
      job.executionMode === "origin" ? "origin session no longer exists" : null));
  }

  async #dispatchBackgroundCompletion(job) {
    const input = await this.#withSessionMutation(job.sessionId, async () => {
      const session = this.store.getSession(job.sessionId);
      if (!session || session.lifecycle === "deleted") return null;
      this.#cancelIdlePreparation(job.sessionId);
      const inputId = `background-completion-${job.id}`;
      const previous = this.store.getActorInput(inputId, job.sessionId, { includeDigest: true });
      const input = this.store.createActorInput(job.sessionId, {
        inputId,
        message: job.message,
        source: "background", origin: { jobId: job.id },
        behavior: previous?.behavior ?? (previous?.digest === actorInputDigest(job.message, "[]", "follow_up") ? "follow_up" : "auto"),
        pendingLimit: this.pendingMessageLimit,
      });
      if (input.state !== "completed") {
        this.#publishInputState(job.sessionId, pendingInputMessage(input));
        this.#notifications.noteContinuation(job.sessionId, `background:${job.id}`, job.startedAt);
      }
      return input;
    });
    if (!input) return "skipped";
    if (input.state !== "completed") {
      const actor = await this.#ensureActorReady(job.sessionId);
      this.#kickActorInputDelivery(job.sessionId, actor);
    }
    await this.#log("background_completion_queued", { jobId: job.id, sessionId: job.sessionId });
    return "sent";
  }

  // Inbox messages use the background-input path; the origin job ID records who sent them.
  async #deliverInboxMessage({ sender, kind, target, messageId, text }) {
    const live = (session) => session && session.lifecycle !== "deleted";
    const sessions = target.workingRoots
      ? this.store.listSessions().filter((s) => live(s) && s.kind === "root" && s.depth === 0 && ["working", "delegating"].includes(s.activity))
      : [this.store.getSession(target.sessionId)].filter(live);
    if (!target.workingRoots && !sessions.length) throw Object.assign(new Error("the route's session no longer exists"), { status: 409 });
    const jobId = inboxOriginJobId(kind, sender, messageId);
    const delivered = [];
    for (const { sessionId } of sessions) {
      const inputId = `inbox-${createHash("sha256").update(jobId).update("\0").update(sessionId).digest("hex").slice(0, 32)}`;
      const input = await this.#withSessionMutation(sessionId, async () => {
        this.#cancelIdlePreparation(sessionId);
        const created = this.store.createActorInput(sessionId, { inputId, message: text, source: "background", origin: { jobId },
          behavior: "auto", pendingLimit: this.pendingMessageLimit });
        if (created.state !== "completed") this.#publishInputState(sessionId, pendingInputMessage(created));
        return created;
      });
      if (input.state !== "completed") this.#kickActorInputDelivery(sessionId, await this.#ensureActorReady(sessionId));
      delivered.push(sessionId);
    }
    await this.#log("inbox_message_delivered", { sender, kind, messageId, sessions: delivered });
    return delivered;
  }

  async #maybeAutoTitleRoot(sessionId) {
    const existing = this.#autoTitleInflight.get(sessionId);
    if (existing) return existing;
    const operation = this.#autoTitleRoot(sessionId).finally(() => {
      if (this.#autoTitleInflight.get(sessionId) === operation) this.#autoTitleInflight.delete(sessionId);
    });
    this.#autoTitleInflight.set(sessionId, operation);
    return operation;
  }

  async #autoTitleRoot(sessionId) {
    try {
      const session = this.store.getSession(sessionId);
      if (!session || session.kind !== "root" || !session.sessionFile) return;
      if (session.name !== defaultRootName(session.cwd, session.sessionId)) return;
      const transcript = await this.transcriptReader.read({
        sessionFile: session.sessionFile, sessionId, maxMessages: 32, maxBytes: 24 * 1024, sanitizePresentation: true, includeTitleTurn: true, familyDeliveryOnly: true,
      });
      const firstReply = this.#actors.get(sessionId)?.liveConversation.snapshot().find((message) => message.status === "complete" && message.text.trim());
      const titled = firstCompletedTitleTurn(transcript.titleMessages ?? []);
      const turn = titled ? rootTitleExcerpt(titled) : (transcript.titleUser && firstReply ? firstCompletedTitleTurn([
        { role: "user", text: transcript.titleUser }, firstReply,
      ]) : null);
      if (!turn) return;
      let generated = null;
      const actor = this.#actors.get(sessionId);
      const complete = actor?.worker.isRunning ? (request) => actor.worker.request("complete", request, 15_000) : undefined;
      try { generated = await this.titleGenerator?.(turn, session.launch?.model?.resolved, complete); }
      catch (error) {
        this.logger.error?.(`auto-title model failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const title = resolveRootTitle(turn, generated);
      if (!title) return;
      const autoNamed = this.store.autoNameDefaultRoot(sessionId, title);
      if (autoNamed.renamed) this.#broadcastNavigator("name_changed");
    } catch (error) {
      this.logger.error?.(`auto-title failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #completeCronRunsForSession(sessionId) {
    const previous = this.#cronCompletionTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const runs = this.#cronStore?.listActiveRunsForSession(sessionId) ?? [];
      if (runs.length === 0) return;
      const settled = () => this.#notifications.settled(sessionId, {
        liveActors: [...this.#actors].filter(([, actor]) => actor.notificationWork?.size).map(([id]) => id),
      });
      if (!settled()) return;
      const session = this.store.getSession(sessionId);
      if (!session?.sessionFile) return;
      const transcript = await this.transcriptReader.read({ sessionFile: session.sessionFile,
        sessionId, maxMessages: 512, maxBytes: 64 * 1024, inputProofIds: runs.map(run => run.inputId), familyDeliveryOnly: true,
        sanitizePresentation: session.kind === "root" && session.depth === 0 });
      if (!settled()) return;
      for (const run of runs) {
        if (!["claimed", "running"].includes(this.#cronStore.getRun(run.runId)?.status)) continue;
        const inputEntryId = transcript.inputEntries?.[run.inputId];
        // Origin dispatch marks the run running before actor readiness or input
        // incorporation. Old family quiet time cannot finalize that pending work.
        // A durable delivery receipt also covers inputs outside the bounded view.
        if (!inputEntryId && this.store.getActorInput(run.inputId, sessionId)?.deliveredAt == null) continue;
        const inputIndex = inputEntryId ? transcript.messages.findIndex((message) => message.id === inputEntryId) : -1;
        const after = inputIndex < 0 ? [] : transcript.messages.slice(inputIndex + 1);
        const nextInput = after.findIndex(message => ["user", "scheduled_job", "background_notification"].includes(message.role));
        const output = (nextInput < 0 ? after : after.slice(0, nextInput)).filter(message => message.role === "assistant").at(-1)?.text?.trim();
        if (output || run.notificationDisposition) this.#cronStore.finishRun(run.runId, "completed", { output: output ?? null });
        else this.#cronStore.finishRun(run.runId, "failed", { error: "scheduled agent returned no visible response" });
        const finished = this.#cronStore.getRun(run.runId);
        await this.#log("cron_run_finished", { runId: run.runId, jobId: run.jobId,
          sessionId, status: finished.status, ...(finished.error ? { error: finished.error } : {}) });
      }
    }).catch((error) => this.logger.error?.(`cron completion failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`));
    this.#cronCompletionTails.set(sessionId, operation);
    void operation.finally(() => { if (this.#cronCompletionTails.get(sessionId) === operation) this.#cronCompletionTails.delete(sessionId); });
    return operation;
  }

  #failCronRunsForSession(sessionId, error) {
    if (!this.#cronStore) return;
    for (const run of this.#cronStore.listActiveRunsForSession(sessionId)) {
      this.#cronStore.finishRun(run.runId, "failed", { error });
      void this.#log("cron_run_finished", { runId: run.runId, jobId: run.jobId, sessionId, status: "failed", error });
    }
  }

  async #spawnChild(parentId, params) {
    this.store.assertSessionAvailable(parentId);
    const parent = this.store.getSession(parentId); if (!parent) throw new Error("parent session does not exist");
    const parentGrant = this.store.getSessionSkillGrant(parentId); if (!parentGrant) throw new Error("parent skill manifest has not been registered");
    const policy = resolveChildLaunchPolicy({ request: { ...params, skillCatalog: parentGrant.skills }, parent, configuredModel: this.configuredChildModel, configuredThinkingLevel: this.configuredChildThinkingLevel, maxDepth: this.maxDepth });
    // A fork copies the parent's current context (what its next request would send).
    let context = null;
    if (policy.forkContext) {
      if (!parent.sessionFile) throw new Error("parent has no canonical context to fork");
      context = forkableContext(await this.coreSessions.context(parent.sessionFile));
      policy.contextFork = { version: 2, sourceSessionId: parentId, messageCount: context.length };
    }
    // Freeze context before admission, including when actor capacity delays start.
    const initialized = await this.coreSessions.create({ sessionsDirectory: this.coreSessionsDirectory, context }); const sidecars = sessionSidecarPaths(initialized.sessionFile);
    try {
      await writeJsonAtomic(sidecars.skillGrantPath, { version: 1, skills: policy.skillCatalog, capabilities: policy.capabilities });
      await writeJsonAtomic(sidecars.capabilitiesPath, { version: 1, capabilities: policy.capabilities });
      const admitted = this.store.createChild(parentId, { sessionId: initialized.sessionId, sessionFile: initialized.sessionFile, policy, actorToken: randomUUID() });
      this.#requestActorStart(admitted.session.sessionId, false); this.#broadcastNavigator("child_admitted");
      const parentState = this.#actorConnections.get(parentId);
      if (parentState) setImmediate(() => this.#deliverPendingChildCreationHistory(parentState));
      return {
        admission: { sessionId: admitted.session.sessionId, shortId: admitted.session.shortId, name: admitted.session.name, depth: admitted.session.depth, activity: admitted.session.activity, lifecycle: admitted.session.lifecycle, acceptedAt: admitted.session.createdAt, initialTaskId: admitted.task.taskId, ...(policy.contextFork ? { contextFork: policy.contextFork } : {}), model: admitted.session.launch?.model, thinking: admitted.session.launch?.thinking, capabilityIds: admitted.session.launch?.capabilityIds ?? [] },
        childCreation: { taskId: admitted.task.taskId, childId: admitted.session.sessionId,
          childName: admitted.task.historyPeerName, relationship: "child", body: admitted.task.prompt },
      };
    } catch (error) { await this.#removeUnadmittedSession(initialized.sessionFile); throw error; }
  }
  async #removeUnadmittedSession(sessionFile) { const paths = sessionSidecarPaths(sessionFile); await Promise.all([this.coreSessions.remove(sessionFile), rm(paths.skillManifestPath, { force: true }), rm(paths.capabilitiesPath, { force: true }), rm(paths.skillGrantPath, { force: true }), rm(paths.kernelStatePath, { recursive: true, force: true }), rm(paths.pythonStepsPath, { force: true })]); }

  #skillRuntimePlan() { return this.#skills.skillRuntimePlan(); }
  #provisionSkillRuntime(expectedFingerprint) { return this.#skills.provisionSkillRuntime(expectedFingerprint); }

  #withActorActivation(sessionId, operation, check = () => {}) {
    const owner = { cancelled: false, done: null };
    const validate = () => {
      if (this.#stoppingPromise || owner.cancelled) throw requestFailure("unavailable", "actor activation was stopped");
      if (this.#actorRetirements.has(sessionId)) throw requestFailure("unavailable", "session actor is retiring");
      check();
    };
    try { validate(); } catch (error) { return Promise.reject(error); }
    const owners = this.#actorActivationOwners.get(sessionId) ?? new Set();
    this.#actorActivationOwners.set(sessionId, owners); owners.add(owner);
    owner.done = Promise.resolve().then(() => { validate(); return operation(validate); })
      .then(result => { validate(); return result; })
      .finally(() => {
        owners.delete(owner);
        if (!owners.size) this.#actorActivationOwners.delete(sessionId);
        this.#syncPassivationTimer(sessionId);
      });
    return owner.done;
  }

  #beginActorRetirement(ids) {
    const pending = [];
    for (const id of ids) {
      this.#actorRetirements.set(id, (this.#actorRetirements.get(id) ?? 0) + 1);
      const launch = this.#launchPromises.get(id);
      if (launch) pending.push(launch);
      const wake = this.#actorInputWakes.get(id);
      if (wake) { wake.cancelled = true; pending.push(wake.done); }
      // Include every invocation, not just the current serialization-map head.
      for (const owner of this.#actorActivationOwners.get(id) ?? []) {
        owner.cancelled = true; pending.push(owner.done);
      }
    }
    return { done: Promise.allSettled(pending), release: () => {
      for (const id of ids) {
        const count = this.#actorRetirements.get(id);
        if (count === 1) this.#actorRetirements.delete(id);
        else this.#actorRetirements.set(id, count - 1);
      }
    } };
  }

  #reconcileSkillGrant(sessionId, ancestry = new Set(), check = () => {}) { return this.#skills.reconcileSkillGrant(sessionId, ancestry, check); }

  #requestActorStart(sessionId, revive) {
    if (this.#actorRetirements.has(sessionId)) throw requestFailure("unavailable", "session actor is retiring");
    if (this.#stoppingPromise) throw requestFailure("unavailable", "supervisor is stopping");
    this.store.assertSessionAvailable(sessionId);
    let session = this.store.getSession(sessionId); if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    if (this.#actors.has(sessionId) || this.#startingActors.has(sessionId) || this.#startQueue.includes(sessionId)) return session;
    if (revive && session.lifecycle !== "starting") session = this.store.prepareActorRevival(sessionId, randomUUID());
    this.#cancelHistoryMaintenance(sessionId);
    if (session.lifecycle !== "starting") return session;
    this.#startQueue.push(sessionId); setImmediate(() => this.#drainActorStarts()); return session;
  }
  #ensureActorReady(sessionId, check = () => {}) {
    return this.#withActorActivation(sessionId, validate => {
      // Retries retain the original owner and cannot acquire later authority.
      const run = () => {
        validate();
        const current = this.#actorReadyPromises.get(sessionId);
        if (current) return current.then(run, run);
        const operation = this.#ensureActorReadyOnce(sessionId, validate)
          .finally(() => { if (this.#actorReadyPromises.get(sessionId) === operation) this.#actorReadyPromises.delete(sessionId); });
        this.#actorReadyPromises.set(sessionId, operation);
        return operation;
      };
      return run();
    }, check);
  }

  async #ensureActorReadyOnce(sessionId, check) {
    const validate = () => {
      if (this.#stoppingPromise) throw requestFailure("unavailable", "supervisor is stopping");
      check(); this.store.assertSessionAvailable(sessionId);
    };
    validate();
    const desired = await this.#reconcileSkillGrant(sessionId, new Set(), check);
    validate();
    let session = this.store.getSessionActorState(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    const resident = this.#actors.get(sessionId);
    if (resident?.worker.isRunning && session.lifecycle === "resident") {
      if (resident.skillGrantFingerprint === desired.fingerprint) return resident;
      if (session.activity !== "idle") {
        resident.skillRefreshPending = true;
        return resident;
      }
      await this.#stopActor(sessionId, "passivated");
      validate();
      session = this.store.getSessionActorState(sessionId);
    }
    this.#requestActorStart(sessionId, session.lifecycle !== "starting");
    const deadline = Date.now() + this.actorStartupTimeoutMs;
    while (Date.now() < deadline) {
      validate();
      const record = this.#actors.get(sessionId);
      if (record?.worker.isRunning && this.store.getSessionActorState(sessionId)?.lifecycle === "resident") return record;
      const currentSession = this.store.getSessionActorState(sessionId);
      if (currentSession?.lifecycle === "error") throw new Error(currentSession.lastError || "session actor failed to start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for session actor ${sessionId}`);
  }
  async #drainActorStarts() {
    if (this.#drainingStarts || !this.#store || this.#stoppingPromise) return; this.#drainingStarts = true;
    try {
      while (this.#startQueue.length && this.#activeStarts < this.maxConcurrentStarts && !this.#stoppingPromise) {
        const nextId = this.#startQueue[0];
        if (this.store.isSessionDeleting(nextId) || this.#actorRetirements.has(nextId)) { this.#startQueue.shift(); continue; }
        if (new Set([...this.#actors.keys(), ...this.#startingActors]).size >= this.maxResidentActors) {
          const excludeIds = [];
          let victim;
          // SQL first excludes active and durably pending workers. Check only
          // remaining candidates against their live ownership, in own-idle order.
          while ((victim = this.store.findIdleResidentActor(nextId, { excludeIds }))) {
            if (this.#isActorOwnIdle(victim.sessionId, this.#actors.get(victim.sessionId), false, victim)) break;
            excludeIds.push(victim.sessionId);
          }
          if (!victim) break;
          const record = this.#actors.get(victim.sessionId);
          await this.#withSessionMutation(victim.sessionId, async () => {
            if (this.#isActorOwnIdle(victim.sessionId, record, true)) await this.#stopActor(victim.sessionId, "passivated");
          });
          continue;
        }
        this.#startQueue.shift(); const session = this.store.getSession(nextId); if (!session || session.lifecycle !== "starting") continue;
        this.#startingActors.add(nextId); this.#activeStarts += 1;
        const launchPromise = this.#withActorActivation(nextId, check => this.#launchActor(nextId, check)).catch((error) => {
          if (this.#actorRetirements.has(nextId) || this.store.isSessionDeleting(nextId) || this.#stoppingPromise) return;
          const failed = this.store.getSession(nextId);
          const message = error instanceof Error ? error.message : String(error);
          // Factory/setup failures can precede the worker's own startup catch.
          if (!this.#stoppingPromise && !this.store.isSessionDeleting(nextId) && failed?.lifecycle === "starting") {
            this.store.markActorLifecycle(nextId, failed.actorGeneration, "error", message);
            this.#broadcastNavigator("actor_error");
          }
          this.logger.error?.(`actor ${nextId} launch failed: ${message}`);
        }).finally(() => { this.#launchPromises.delete(nextId); this.#startingActors.delete(nextId); this.#activeStarts -= 1; this.#queueHistoryMaintenance(nextId); this.#syncPassivationTimer(nextId); setImmediate(() => this.#drainActorStarts()); });
        this.#launchPromises.set(nextId, launchPromise);
      }
    } finally { this.#drainingStarts = false; }
  }

  #actorArgs(session) {
    if (!session.sessionFile) throw new Error(`session ${session.sessionId} has no session folder`);
    const args = ["--session-dir", session.sessionFile, "--sidecar-base", sessionSidecarPaths(session.sessionFile).basePath];
    if (session.launch?.model?.resolved) args.push("--provider", session.launch.model.resolved.provider, "--model", session.launch.model.resolved.id);
    if (session.launch?.thinking?.resolved) args.push("--thinking", session.launch.thinking.resolved);
    // The settings' default, for a session whose core has no model yet; the supervisor decides it.
    if (!session.launch?.model?.resolved) {
      const fallback = readDefaultInference(path.join(agentDirectory(process.env), "settings.json"));
      if (fallback) args.push("--default-provider", fallback.provider, "--default-model", fallback.model,
        ...(fallback.thinkingLevel ? ["--default-thinking", fallback.thinkingLevel] : []));
    }
    args.push("--name", session.name);
    if (session.kind === "root" && session.depth === 0) args.push("--presentation");
    return args;
  }
  #actorEnv(session, compileCache, generationSkillGrantPath, scratch) {
    const env = { ...process.env, PI_HARNESS_SOCKET: this.socketPath, PI_HARNESS_AUTO_START: "0", PI_HARNESS_ACTOR_ID: session.sessionId, PI_HARNESS_ACTOR_TOKEN: session.actorToken, PI_HARNESS_ACTOR_GENERATION: String(session.actorGeneration) };
    env.PI_HARNESS_ROOT_SESSION_ID = scratch.rootSessionId;
    env.PI_HARNESS_SCRATCH_DIRECTORY = scratch.directory;
    env[RUNTIME_DIRECTORY_ENV] = this.runtimeDir;
    delete env.PI_SESSION_ID; delete env.PI_SESSION_FILE;
    delete env[SESSION_COMPILE_CACHE_ENV];
    if (compileCache) env[SESSION_COMPILE_CACHE_ENV] = compileCache.directory;
    env.PI_HARNESS_ACTOR_SKILL_GRANT = generationSkillGrantPath;
    return env;
  }
  async #launchActor(sessionId, check) {
    let skillGrant;
    try {
      skillGrant = await this.#reconcileSkillGrant(sessionId, new Set(), check);
      skillGrant = { ...skillGrant, manifestSkills: await grantedManifestSkills(skillGrant) };
    } catch (error) {
      check();
      const failed = this.store.getActorLaunch(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      if (failed?.lifecycle === "starting") this.store.markActorLifecycle(sessionId, failed.actorGeneration, "error", message);
      this.#broadcastNavigator("actor_error");
      throw error;
    }
    const compileCache = await (this.#actorCompileCache ??= createSessionCompileCache());
    check();
    const session = this.store.getActorLaunch(sessionId); if (!session || session.lifecycle !== "starting" || this.store.isSessionDeleting(sessionId)) return;
    const generationSkillGrantPath = await publishActorGenerationSkillGrant(session, skillGrant);
    check();
    const scratch = ensureSessionScratch(this.store, sessionId, this.scratchDirectory);
    const worker = this.actorFactory({ command: process.execPath, args: [...ACTOR_NODE_FLAGS, CORE_ACTOR_WORKER, ...this.#actorArgs(session)], cwd: session.cwd, env: this.#actorEnv(session, compileCache, generationSkillGrantPath, scratch), startupTimeoutMs: this.actorStartupTimeoutMs, promptPreflightTimeoutMs: this.actorPromptPreflightTimeoutMs,
      shutdownTimeoutMs: this.actorShutdownTimeoutMs, session });
    const record = { worker, generation: session.actorGeneration, rootOutputSession: Object.freeze({ sessionId: session.sessionId, kind: session.kind, depth: session.depth }), expectedLifecycle: null, exitError: null, eventSeq: 0, eventRing: [], eventRingBytes: 0, progressSummary: undefined, progressTurnId: null,
      framesSeen: 0, frameWaiters: [], taken: { messages: new Set(), inputs: new Set() }, covered: { messages: new Set(), inputs: new Set() },
      skillGrantFingerprint: skillGrant.fingerprint, skillGrantSkills: skillGrant.skills, skillRefreshPending: false,
      notificationWork: new Set(), messageTransportRepairAttempted: false, liveConversation: new LiveConversation() }; this.#actors.set(sessionId, record);
    worker.on("event", (frame) => this.#onActorEvent(sessionId, record, frame)); worker.on("protocolError", (error) => this.logger.error?.(`actor ${sessionId} RPC protocol error: ${error.message}`)); worker.on("exit", (details) => this.#onActorExit(sessionId, record, details));
    try {
      const state = await worker.start();
      check();
      if (this.#stoppingPromise || record.expectedLifecycle) throw requestFailure("unavailable", "actor startup was stopped");
      if (state?.sessionId !== session.sessionId) throw new Error(`actor session mismatch: expected ${session.sessionId}, received ${String(state?.sessionId)}`);
      if (session.launch?.model?.resolved && (state?.model?.provider !== session.launch.model.resolved.provider || state?.model?.id !== session.launch.model.resolved.id)) {
        throw new Error(`actor model mismatch: expected ${session.launch.model.resolved.provider}/${session.launch.model.resolved.id}`);
      }
      if (session.launch?.thinking?.resolved && state?.thinkingLevel !== session.launch.thinking.resolved) {
        throw new Error(`actor thinking level mismatch: expected ${session.launch.thinking.resolved}, received ${String(state?.thinkingLevel)}`);
      }
      if (typeof state?.model?.provider === "string" && typeof state?.model?.id === "string"
        && typeof state?.thinkingLevel === "string") {
        this.store.recordResolvedSessionInference(sessionId, session.actorGeneration,
          { provider: state.model.provider, model: state.model.id, thinkingLevel: state.thinkingLevel, fastModeSupported: state.model.fastModeSupported === true });
      }
      this.store.assertSessionAvailable(sessionId);
      const processIdentity = await this.processIdentityFactory(worker.pid, session.actorToken);
      check();
      if (record.expectedLifecycle) throw requestFailure("unavailable", "actor startup was stopped");
      this.store.markActorStarted(sessionId, session.actorGeneration, { pid: worker.pid, sessionFile: state.sessionFile, processIdentity });
      await this.#sendPendingInference(sessionId, record);
      check();
      await this.#deliverActorInputs(sessionId, record);
      setImmediate(() => this.#retryQueuedMessages(sessionId));
      await this.#log("actor_started", { sessionId, generation: session.actorGeneration, kind: session.kind }); this.#broadcastNavigator("actor_resident"); this.#syncPassivationTimers();
      if (this.#stoppingPromise) { await this.#stopActor(sessionId, "passivated"); return; }
      check();
      await this.#submitInitialTask(sessionId, record);
    } catch (error) {
      const expected = record.expectedLifecycle; const message = error instanceof Error ? error.message : String(error); record.expectedLifecycle ??= "error"; record.exitError = message;
      await worker.close().catch(() => {}); if (!worker.isRunning && this.#actors.get(sessionId) === record) this.#actors.delete(sessionId);
      if (!expected || expected === "error") { const current = this.store.getSession(sessionId); if (current?.lifecycle !== "error") this.store.markActorLifecycle(sessionId, session.actorGeneration, "error", message, Date.now(), { reportChildExit: true }); this.store.completeSubmittedChildTask?.(sessionId, message); this.#broadcastNavigator("actor_error"); }
      throw error;
    }
  }
  #completeInputDelivery(sessionId, input, proof, transcript) {
    const timestamp = Date.parse(proof.deliveredAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("canonical input delivery timestamp is invalid");
    const changed = this.store.completeActorInput(input.inputId, sessionId, timestamp, proof.entryId);
    if (changed) this.#queueHistoryMaintenance(sessionId, { invalidate: true });
    this.#actors.get(sessionId)?.liveConversation.remove(input.inputId);
    // Historical incorporation is not active-branch visibility. Publish only the
    // canonical row from this read, never a reconstruction of submitted text.
    const message = transcript.messages?.find((row) => row.id === proof.entryId && row.inputId === input.inputId);
    if (changed && message) this.#publishInputState(sessionId, { ...message, id: input.inputId, entryId: proof.entryId });
    this.#syncPassivationTimer(sessionId);
    return changed;
  }

  #pendingFamilyPresentation(message) {
    const target = this.store.getSession(message.targetId);
    if (!target || target.lifecycle === "deleted" || this.store.isSessionDeleting(message.targetId)) return undefined;
    const sender = message.childExitGeneration != null ? { name: "Harness lifecycle" } : this.store.getSession(message.senderId);
    const row = pendingFamilyMessage(message, sender);
    return row && !["accepted", "queued", "delivered"].includes(message.state)
      ? { ...row, text: "", delivery: { ...row.delivery, state: message.state === "rejected" ? "rejected" : "retired" } } : row;
  }

  async #publishFamilyAdmission(sessionId, messageId) {
    const session = this.store.getSession(sessionId);
    if (!session?.sessionFile || session.lifecycle === "deleted" || this.store.isSessionDeleting(sessionId)) return;
    const transcript = await this.transcriptReader.read({ sessionFile: session.sessionFile, sessionId,
      inputProofIds: [], familyMessageId: messageId });
    const canonical = transcript.familyMessages?.[messageId];
    const route = this.store.getMessage(messageId);
    const message = canonical?.delivery?.state === "delivered" ? canonical
      : route && ["accepted", "queued", "delivered"].includes(route.state) ? this.#pendingFamilyPresentation(route) : undefined;
    if (message) this.#publishInputState(sessionId, message);
  }

  #publishInputOutcome(sessionId, input) {
    this.#actors.get(sessionId)?.liveConversation.remove(input.inputId);
    const outcome = { inputId: input.inputId, clientMessageId: input.clientMessageId, outcome: input.outcome, handledAt: input.handledAt };
    const recipients = [...this.#clientConnections].filter(client => client.subscriptions.has(sessionId));
    this.#broadcast(recipients, event("input_outcome", { sessionId, ...outcome }));
  }

  #publishInputState(sessionId, message) {
    const actor = this.#actors.get(sessionId);
    const publicEvent = { type: "input_state", message };
    if (actor) {
      actor.liveConversation.upsert(message);
      actor.eventSeq += 1;
      const retainedBytes = Buffer.byteLength(JSON.stringify(publicEvent));
      actor.eventRing.push({ seq: actor.eventSeq, event: publicEvent, retainedBytes });
      actor.eventRingBytes += retainedBytes;
      while (actor.eventRing.length > 128 || actor.eventRingBytes > 256 * 1024) actor.eventRingBytes -= actor.eventRing.shift().retainedBytes;
    }
    const recipients = [...this.#clientConnections].filter(client => client.subscriptions.has(sessionId));
    this.#broadcast(recipients, actor ? event("actor_event", { sessionId, actorGeneration: actor.generation, seq: actor.eventSeq, event: publicEvent })
      : event("input_state", { sessionId, message }));
  }

  #queueActorInputWake(sessionId, automaticRecord = null) {
    this.#cancelIdlePreparation(sessionId);
    // Persist startup intent before acknowledging; startup and skill reconciliation
    // remain owned by the existing actor scheduler, not the HTTP/RPC connection.
    this.#requestActorStart(sessionId, true);
    for (const input of this.store.setActorInputWakeError(sessionId)) this.#publishInputState(sessionId, pendingInputMessage(input));
    const current = this.#actorInputWakes.get(sessionId);
    if (current) {
      current.requested = true;
      if (!automaticRecord) current.automaticRecord = null;
      return;
    }
    const wake = { requested: true, cancelled: false, automaticRecord, done: null };
    this.#actorInputWakes.set(sessionId, wake);
    wake.done = Promise.resolve().then(async () => {
      const check = () => {
        if (wake.automaticRecord && this.#actors.get(sessionId) !== wake.automaticRecord
          && !wake.automaticRecord.expectedLifecycle) {
          // Settled readiness belongs to its resident actor, not a later revival.
          // Recheck before startup after skill reconciliation; a fresh durable
          // input/task (or a coalesced explicit wake) supplies its own authority.
          if (this.store.hasPendingActorInputs(sessionId) || this.store.nextQueuedChildTask(sessionId)
            || this.store.submittedChildTask(sessionId)) wake.automaticRecord = null;
          else wake.cancelled = true;
        }
        if (wake.cancelled) throw requestFailure("unavailable", "input wake was stopped");
      };
      try { do {
        wake.requested = false;
        try {
          const actor = await this.#ensureActorReady(sessionId, check);
          check();
          await this.#deliverActorInputs(sessionId, actor);
        } catch (error) {
          if (this.#stoppingPromise || wake.cancelled || this.store.isSessionDeleting(sessionId)) return;
          const message = error instanceof Error ? error.message : String(error);
          // Keep the durable outbox retryable and make post-acceptance failure
          // visible through the existing session error/revival path.
          const stopped = this.#stopActor(sessionId, "error", message);
          for (const input of this.store.setActorInputWakeError(sessionId, this.store.getSession(sessionId).actorGeneration))
            this.#publishInputState(sessionId, pendingInputMessage(input));
          await stopped;
          this.logger.error?.(`actor input wake failed for ${sessionId}: ${message}`);
        }
      } while (wake.requested && !wake.cancelled && !this.#stoppingPromise && !this.store.isSessionDeleting(sessionId));
      } finally {
        // Retire synchronously with the final dirty check: no coalesced send can
        // land between the loop ending and removal of its owner.
        if (this.#actorInputWakes.get(sessionId) === wake) {
          this.#actorInputWakes.delete(sessionId);
          this.#syncPassivationTimer(sessionId);
        }
      }
    }).catch((error) => this.logger.error?.(`actor input wake cleanup failed for ${sessionId}: ${error.message}`));
  }

  #kickActorInputDelivery(sessionId, record) {
    void this.#deliverActorInputs(sessionId, record).catch((error) => {
      if (!this.#stoppingPromise) this.logger.error?.(`actor input delivery failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  #publishActorInputFailure(sessionId, record) {
    if (this.#stoppingPromise || this.#actors.get(sessionId) !== record
      || (record.expectedLifecycle && record.expectedLifecycle !== "error") || this.store.isSessionDeleting(sessionId)) return;
    const current = this.store.getSessionActorState(sessionId);
    if (current?.actorGeneration !== record.generation || !["starting", "resident", "error"].includes(current.lifecycle)) return;
    for (const input of this.store.setActorInputWakeError(sessionId, record.generation)) {
      this.#publishInputState(sessionId, pendingInputMessage(input));
    }
  }
  async #deliverActorInputs(sessionId, record) {
    if (this.#actors.get(sessionId) !== record) return;
    record.inputDeliveryTail ??= Promise.resolve();
    const operation = record.inputDeliveryTail.then(async () => {
      if (this.#actors.get(sessionId) !== record) return;
      if (!this.store.hasPendingActorInputs(sessionId)) return;
      this.#cancelIdlePreparation(sessionId, record);
      const session = this.store.getSession(sessionId);
      if (!session?.sessionFile) throw new Error("session does not have a canonical history");
      let transcript, recordedInputIds, associations, reconciledIds;
      const reconcile = async ids => {
        const scope = new Set(ids);
        const snapshot = await this.transcriptReader.read({ sessionFile: session.sessionFile, sessionId, inputProofIds: [...scope], familyDeliveryOnly: true });
        transcript = snapshot; reconciledIds = scope;
        recordedInputIds = new Set(snapshot.inputIds ?? []);
        associations = snapshot.inputAssociationStates ?? {};
      };
      await reconcile(this.store.listPendingActorInputs(sessionId).map(input => input.inputId));
      for (const input of this.store.listPendingActorInputs(sessionId)) {
        if (associations[input.inputId] === "unresolved") {
          await this.#log("actor_input_unresolved", { sessionId, inputId: input.inputId });
        }
      }
      while (this.#actors.get(sessionId) === record && !record.expectedLifecycle && !this.store.isSessionDeleting(sessionId)) {
        const pendingInputs = this.store.listPendingActorInputs(sessionId);
        if (pendingInputs.length === 0) return;
        if (pendingInputs.some(input => !reconciledIds.has(input.inputId))) {
          await reconcile(pendingInputs.map(input => input.inputId));
          continue; // Resample after the awaited read; admission may have expanded its scope again.
        }
        let progressed = false;
        for (const input of pendingInputs) {
          if (record.expectedLifecycle || this.store.isSessionDeleting(sessionId)) return;
          // A late command reconciliation can replace the local scope. Resample
          // rather than treating an ID outside it as proven canonical absence.
          if (!reconciledIds.has(input.inputId)) { progressed = true; break; }
          // Ambiguous historical incorporation is not permission to submit again.
          if (associations[input.inputId] === "unresolved") continue;
          if (recordedInputIds.has(input.inputId)) {
            const proof = transcript.inputDeliveries?.[input.inputId];
            if (!proof) throw new Error("canonical input receipt is missing its entry timestamp");
            this.#completeInputDelivery(sessionId, input, proof, transcript);
            progressed = true;
            continue;
          }
          if (input.state === "accepted" && input.acceptedGeneration === record.generation) continue;
          if (["cron", "background"].includes(input.source)) {
            if (record.expectedLifecycle || this.store.isSessionDeleting(sessionId)) return;
            await record.worker.request("deliver_input", { inputId: input.inputId }, this.actorPromptPreflightTimeoutMs);
            const admitted = this.store.getActorInput(input.inputId, sessionId);
            if (admitted?.state !== "completed" && !(admitted?.state === "accepted" && admitted.acceptedGeneration === record.generation)) {
              // Command preflight can observe new canonical evidence without accepting input.
              await reconcile([...this.store.listPendingActorInputs(sessionId).map(pending => pending.inputId), input.inputId]);
              if (associations[input.inputId] === "unresolved") {
                await this.#log("actor_input_unresolved", { sessionId, inputId: input.inputId });
                continue;
              }
              if (recordedInputIds.has(input.inputId)) {
                const proof = transcript.inputDeliveries?.[input.inputId];
                if (!proof) throw new Error("canonical input receipt is missing its entry timestamp");
                this.#completeInputDelivery(sessionId, input, proof, transcript);
                progressed = true;
                continue;
              }
              throw new Error("internal input was not accepted by the actor worker");
            }
          } else {
            const result = await record.worker.submit(input.message, input.behavior, input.images, input.inputId, input.location);
            if (result?.outcome === "handled") {
              const handled = this.store.markActorInputHandled(input.inputId, sessionId);
              this.#publishInputOutcome(sessionId, handled);
            } else this.store.markActorInputAccepted(input.inputId, sessionId, record.generation);
          }
          progressed = true;
        }
        if (!progressed) return;
      }
    });
    const delivery = operation.catch(error => {
      // A launch can fail while another wake is queued behind this tail. That
      // waiter may observe retirement and return normally; publish at failure
      // ownership, before swallowing the rejection for sequential delivery.
      this.#publishActorInputFailure(sessionId, record);
      throw error;
    });
    record.inputDeliveryTail = delivery.catch(() => {});
    return delivery;
  }

  async #submitInitialTask(sessionId, record) {
    if (this.store.isSessionDeleting(sessionId) || record.expectedLifecycle) return;
    const task = this.store.nextQueuedChildTask(sessionId); if (!task) return; const child = this.store.getSession(sessionId); const parent = this.store.getSession(child.parentSessionId);
    const prompt = [`You are the retained child agent ${child.name}. Complete only the delegated task below.`, task.prompt, "When useful results are ready, send them explicitly to your parent with agent_message.send(); spawning never returns your answer automatically.", `Your parent is ${parent?.name ?? child.parentSessionId} (${parent?.shortId ?? child.parentSessionId}).`].join("\n\n");
    this.store.markChildTaskSubmitted(task.taskId); try { await record.worker.submit(prompt, "auto"); } catch (error) { this.store.completeSubmittedChildTask(sessionId, error instanceof Error ? error.message : String(error)); throw error; }
  }

  #updateProgressHeading(state, params) {
    const record = this.#actors.get(state.sessionId);
    if (!record || record.generation !== state.generation) return { accepted: false };
    let changed = false;
    if (params.phase === "start") {
      if (record.progressTurnId === params.turnId) return { accepted: true };
      changed = record.progressSummary !== undefined;
      record.progressTurnId = params.turnId;
      record.progressSummary = undefined;
    } else if (params.phase === "heading") {
      if (record.progressTurnId !== params.turnId) return { accepted: false };
      const normalized = normalizeProgressHeading(params.summary);
      if (!normalized || normalized !== params.summary) throw new Error("progress heading is not a normalized safe heading");
      if (normalized !== record.progressSummary) { record.progressSummary = normalized; changed = true; }
    } else if (params.phase === "settled") {
      if (record.progressTurnId !== params.turnId) return { accepted: false };
      changed = record.progressSummary !== undefined;
      record.progressTurnId = null;
      record.progressSummary = undefined;
    }
    if (changed) this.#broadcastNavigator("assistant_progress");
    return { accepted: true };
  }

  // A session's frames. Its live view (`live_event`, made by the session half: live-view.mjs)
  // is numbered, kept for replay and passed on as it is, with its reply-feed part (`feed`)
  // to the root output; its kind drives the session's activity, notifications and failure
  // capture. The supervisor's own events about the session (progress, agent messages,
  // children) and the session's dialogs and model changes are shaped here.
  #onActorEvent(sessionId, record, frame) {
    try { this.#handleActorEvent(sessionId, record, frame); } finally { this.#frameSeen(record, frame); }
  }

  // Receipts (ack_message, record_input_delivery) say how many session events came before
  // them and are applied only after those, so a receipt never overtakes the work it is for.
  #frameSeen(record, frame) {
    if (!Number.isSafeInteger(frame?.seq) || frame.seq <= record.framesSeen) return;
    record.framesSeen = frame.seq;
    const ready = record.frameWaiters.filter((waiter) => waiter.afterFrame <= record.framesSeen);
    record.frameWaiters = record.frameWaiters.filter((waiter) => waiter.afterFrame > record.framesSeen);
    for (const waiter of ready) waiter.resolve();
  }
  // Waits until the session's events before a receipt have been seen. A receipt whose events
  // can no longer arrive (the session exited or was replaced) is refused, and #requireFence
  // checks again right before the receipt changes anything, so it never lands unfenced.
  async #afterFrames(sessionId, generation, afterFrame) {
    if (afterFrame === undefined) return;
    const record = this.#fenceRecord(sessionId, generation);
    if (record.framesSeen >= afterFrame) return;
    await new Promise((resolve, reject) => record.frameWaiters.push({ afterFrame, resolve, reject }));
  }
  #requireFence(sessionId, generation, afterFrame) {
    if (afterFrame === undefined) return;
    if (this.#fenceRecord(sessionId, generation).framesSeen < afterFrame) throw new Error("receipt arrived before the session events it follows");
  }
  #fenceRecord(sessionId, generation) {
    const record = this.#actors.get(sessionId);
    if (!record || record.generation !== generation) throw new Error("receipt refused: its session is no longer running");
    return record;
  }

  // Work the session's core has taken (a message, a cron or background input, or a
  // person's input): the session counts as busy from here until its next agent_settled,
  // which covers it. Covered work is not pending, even before its receipt arrives.
  #workTaken(sessionId, record, frame) {
    for (const [key, kind] of [["messageId", "messages"], ["inputId", "inputs"]]) {
      if (typeof frame[key] === "string" && frame[key] && frame[key].length <= 128) record.taken[kind].add(frame[key]);
    }
    if (this.store.getSession(sessionId)?.activity !== "working") this.store.setActorActivity(sessionId, record.generation, true);
  }
  #coverTaken(record) {
    for (const kind of ["messages", "inputs"]) {
      for (const id of record.taken[kind]) record.covered[kind].add(id);
      record.taken[kind].clear();
    }
  }
  // Covered work whose receipt is still on its way, across live sessions (store.coveredWork).
  #coveredWork() {
    const work = { messages: new Set(), inputs: new Set() };
    for (const record of this.#actors.values()) {
      for (const kind of ["messages", "inputs"]) for (const id of record.covered?.[kind] ?? []) work[kind].add(id);
    }
    return work;
  }
  #receiptApplied(sessionId, generation, kind, id) {
    const record = this.#actors.get(sessionId);
    if (record?.generation === generation) { record.covered[kind].delete(id); record.taken[kind].delete(id); }
  }

  #handleActorEvent(sessionId, record, frame) {
    if (this.#actors.get(sessionId) !== record) return;
    if (frame?.type === "work_taken") { this.#workTaken(sessionId, record, frame); return; }
    // A turn chained onto a working stretch.
    if (frame?.type === "live_activity") { this.store.recordSessionActivity(sessionId); return; }
    const live = frame?.type === "live_event";
    const shown = live ? (frame.event && typeof frame.event === "object" ? frame.event : null) : this.#boundedActorEvent(frame);
    const type = live ? shown?.type : undefined;
    if (type === "agent_start") {
      this.#cancelHistoryMaintenance(sessionId);
      this.#cancelIdlePreparation(sessionId, record);
      record.eventRing = []; record.eventRingBytes = 0;
      record.progressSummary = undefined;
    } else if (type === "agent_settled") {
      record.progressSummary = undefined;
      record.progressTurnId = null;
      if (sessionId === this.#homeSessionId()) this.#homeNudge.settled();
    }
    let visible = null;
    if (live || shown) {
      record.eventSeq += 1;
      if (live && frame.feed) this.#rootOutput.accept({ session: record.rootOutputSession, actorGeneration: record.generation, actorEventSeq: record.eventSeq, event: frame.feed });
      if (shown) {
        visible = record.liveConversation.accept(shown);
        if (visible.type === "message_update" && visible.assistantMessageEvent?.type === "text_end") {
          setImmediate(() => void this.#maybeAutoTitleRoot(sessionId));
        }
        const retainedBytes = Buffer.byteLength(JSON.stringify(visible));
        record.eventRing.push({ seq: record.eventSeq, event: visible, retainedBytes });
        record.eventRingBytes += retainedBytes;
        while (record.eventRing.length > 128 || record.eventRingBytes > 256 * 1024) {
          record.eventRingBytes -= record.eventRing.shift().retainedBytes;
        }
      }
    }
    try {
      if (["inference_selection_applied", "inference_selection_failed"].includes(frame?.type)) {
        if (this.store.recordSessionInferenceResult(sessionId, record.generation, { requestId: frame.requestId,
          selection: frame.selection, ...(frame.type === "inference_selection_failed" ? { error: true } : {}) })) this.#broadcastNavigator("inference_changed");
      }
      const reply = type === "message_end" && shown.message?.role === "assistant";
      if (["agent_start", "tool_execution_start", "tool_execution_end"].includes(type) || reply) this.store.recordSessionActivity(sessionId);
      if (reply && shown.message.content?.some((part) => part?.type === "text" && part.text?.trim())) {
        setImmediate(() => void this.#maybeAutoTitleRoot(sessionId));
      }
      if (["progress_entry", "agent_message_entry", "child_creation_entry"].includes(frame?.type)) {
        const createdAt = Date.parse(frame.createdAt);
        if (Number.isSafeInteger(createdAt) && createdAt >= 0) this.store.recordSessionActivity(sessionId, createdAt);
      }
      if (type === "tool_execution_start" && typeof shown.toolCallId === "string") record.notificationWork.add(`tool:${shown.toolCallId}`);
      if (type === "tool_execution_end") record.notificationWork.delete(`tool:${shown.toolCallId}`);
      if (["tool_execution_start", "tool_execution_end"].includes(type)) {
        this.#observeNotifications(sessionId); this.#syncPassivationTimer(sessionId);
      }
      if (type === "agent_start") this.store.setActorActivity(sessionId, record.generation, true);
      else if (type === "agent_settled") {
        // The session half says why the turn failed (live-view.mjs), if it did.
        const failure = this.store.submittedChildTask?.(sessionId) && typeof frame.failure === "string" ? frame.failure : null;
        this.store.completeSubmittedChildTask?.(sessionId, failure);
        if (failure) this.store.recordSessionLastError?.(sessionId, record.generation, failure);
        this.#coverTaken(record);
        this.store.setActorActivity(sessionId, record.generation, false);
        this.#retryChildExitMessages(); // delivers a root-idle report to Home, if one was queued
        this.#queueHistoryMaintenance(sessionId, { invalidate: true });
        setImmediate(() => void this.#completeCronRunsForSession(sessionId));
        setImmediate(() => void this.#maybeAutoTitleRoot(sessionId));
        if (!record.expectedLifecycle) {
          // Order only wake registration behind prior mutations. Readiness remains
          // owned outside that queue so it cannot delay later input admission.
          void this.#withSessionMutation(sessionId, () => {
            if (this.#actors.get(sessionId) !== record || record.expectedLifecycle || this.#stoppingPromise
              || this.store.isSessionDeleting(sessionId) || this.store.getSession(sessionId)?.actorGeneration !== record.generation) return;
            this.#queueActorInputWake(sessionId, record);
          }).catch(error => this.logger.error?.(`actor ${sessionId} settled wake failed: ${error.message}`));
          setImmediate(() => this.#retryQueuedMessages(sessionId));
        }
      }
      if (type === "agent_start" || type === "agent_settled") { this.#observeNotifications(sessionId); this.#syncPassivationTimers(); }
    } catch (error) { this.logger.error?.(`actor ${sessionId} event failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (visible) {
      const subscribers = [...this.#clientConnections].filter((client) => client.subscriptions.has(sessionId));
      const dialog = visible.type === "dialog_request" && ["select", "confirm", "input", "editor"].includes(visible.method);
      const recipients = dialog && !this.#trackDialogRequest(sessionId, record, visible) ? [] : dialog ? subscribers.slice(0, 1) : subscribers;
      this.#broadcast(recipients, event("actor_event", { sessionId, actorGeneration: record.generation, seq: record.eventSeq, event: visible }));
    }
    // Live rows that will never meet a saved message (live-view.mjs says which).
    if (live && Array.isArray(frame.drop)) for (const id of frame.drop) if (typeof id === "string") record.liveConversation.remove(id);
    if (type === "agent_start" || type === "agent_settled") this.#broadcastNavigator(type);
  }
  #onActorExit(sessionId, record, details) {
    this.#cancelIdlePreparation(sessionId, record);
    if (this.#actors.get(sessionId) !== record) return;
    const lifecycle = record.expectedLifecycle ?? "error"; const error = lifecycle === "error" ? record.exitError ?? details.error ?? `actor exited code=${details.code} signal=${details.signal}` : null;
    // A queued delivery can return after this record disappears. The actual
    // unexpected-exit owner must publish before retirement removes its fence.
    if (lifecycle === "error") this.#publishActorInputFailure(sessionId, record);
    this.#actors.delete(sessionId); this.#clearPassivation(sessionId);
    // No more events will come: receipts still waiting for some are refused, unapplied.
    for (const waiter of record.frameWaiters.splice(0)) waiter.reject(new Error("receipt refused: its session exited before the events it follows"));
    this.#clearDialogRequests(sessionId, record.generation);
    this.#rootOutput.failSession(sessionId, record.generation, record.expectedLifecycle ?? "actor_exit");
    this.store.markActorLifecycle(sessionId, record.generation, lifecycle, error, Date.now(), { reportChildExit: true }); if (error || lifecycle === "stopped") this.store.completeSubmittedChildTask?.(sessionId, error ?? "actor was explicitly stopped");
    this.#queueHistoryMaintenance(sessionId, { invalidate: true });
    if (error || lifecycle === "stopped") this.#failCronRunsForSession(sessionId, error ?? "session was explicitly stopped during scheduled execution");
    if (lifecycle === "error") this.#retryChildExitMessages();
    void this.#log("actor_stopped", { sessionId, generation: record.generation, lifecycle, ...(error ? { error } : {}) }); this.#broadcastNavigator(lifecycle === "error" ? "actor_error" : "actor_passivated"); setImmediate(() => this.#drainActorStarts());
  }
  async #stopActorAndDrainInputs(sessionId) {
    // General passivation is called by readiness itself; join only here.
    const retirement = this.#beginActorRetirement([sessionId]);
    try {
      let failure;
      try { await this.#stopActor(sessionId, "stopped"); } catch (error) { failure = error; }
      await retirement.done;
      if (failure) throw failure;
      if (this.#actors.get(sessionId)?.worker.isRunning) await this.#stopActor(sessionId, "stopped");
    } finally { retirement.release(); }
  }
  async #stopActor(sessionId, lifecycle = "passivated", error = null) {
    this.#cancelHistoryMaintenance(sessionId);
    this.#cancelIdlePreparation(sessionId);
    this.#clearPassivation(sessionId); this.#startQueue = this.#startQueue.filter((id) => id !== sessionId); const record = this.#actors.get(sessionId);
    if (record) {
      record.expectedLifecycle = lifecycle;
      if (error) {
        record.exitError = error;
        this.store.markActorLifecycle(sessionId, record.generation, lifecycle, error);
        this.#broadcastNavigator("actor_error");
      }
      await record.worker.close(); return;
    }
    const session = this.store.getSession(sessionId); if (session && session.lifecycle !== "deleted" && session.lifecycle !== lifecycle) {
      this.store.markActorLifecycle(sessionId, session.actorGeneration, lifecycle, error);
    }
    this.#broadcastNavigator(lifecycle === "error" ? "actor_error" : "actor_stopped");
  }
  #cancelIdlePreparation(sessionId) {
    if (this.#historyMaintenanceBusy(sessionId)) this.#cancelHistoryMaintenance(sessionId);
  }
  #isActorOwnIdle(sessionId, record = this.#actors.get(sessionId), mutationOwned = false, session = this.store.getSessionActorState(sessionId)) {
    return Boolean(record && this.#actors.get(sessionId) === record && record.worker.isRunning && !record.expectedLifecycle
      && session?.lifecycle === "resident" && session.actorGeneration === record.generation && session.quietSince != null
      && !record.notificationWork.size && !this.#startingActors.has(sessionId) && !this.#actorReadyPromises.has(sessionId)
      && !this.#actorInputWakes.has(sessionId) && (mutationOwned || !this.#sessionMutationTails.has(sessionId))
      && !this.store.isSessionDeleting(sessionId) && !this.store.hasPendingSessionWork(sessionId));
  }
  #syncPassivationTimer(sessionId) {
    if (!this.#store || this.#stoppingPromise) return;
    const record = this.#actors.get(sessionId), session = this.store.getSessionActorState(sessionId);
    if (this.#isActorOwnIdle(sessionId, record, false, session)) {
      if (!this.#passivationTimers.has(sessionId)) this.#schedulePassivation(sessionId, record, session);
      if (this.#startQueue.length) setImmediate(() => this.#drainActorStarts());
    } else {
      this.#clearPassivation(sessionId);
      this.#cancelIdlePreparation(sessionId, record);
    }
  }
  #syncPassivationTimers() {
    for (const sessionId of this.#actors.keys()) this.#syncPassivationTimer(sessionId);
  }
  #clearPassivation(sessionId) { const timer = this.#passivationTimers.get(sessionId); if (timer) clearTimeout(timer); this.#passivationTimers.delete(sessionId); }
  #schedulePassivation(sessionId, record, session) {
    this.#clearPassivation(sessionId);
    const deadline = this.actorInactivityMs === 0 ? Infinity : session.quietSince + this.actorInactivityMs;
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => {
      if (this.#passivationTimers.get(sessionId) !== timer) return;
      this.#passivationTimers.delete(sessionId);
      const current = this.store.getSessionActorState(sessionId);
      if (current?.quietSince !== session.quietSince || !this.#isActorOwnIdle(sessionId, record, false, current)) {
        this.#syncPassivationTimer(sessionId); return;
      }
      if (Date.now() >= deadline) {
        void this.#withSessionMutation(sessionId, async () => {
          const fresh = this.store.getSessionActorState(sessionId);
          if (fresh?.quietSince === session.quietSince && this.#isActorOwnIdle(sessionId, record, true, fresh)) {
            await this.#stopActor(sessionId, "passivated");
          }
        }).catch(error => this.logger.error?.(error));
        return;
      }
      this.#schedulePassivation(sessionId, record, current);
    }, Math.max(0, deadline - Date.now()));
    timer.unref(); this.#passivationTimers.set(sessionId, timer);
  }

  #consumeMessageToken(senderId, now = Date.now()) { const previous = this.#messageBuckets.get(senderId) ?? { tokens: this.messageRateCapacity, updatedAt: now }; const tokens = Math.min(this.messageRateCapacity, previous.tokens + Math.max(0, now - previous.updatedAt) / 1000 * this.messageRateRefillPerSecond); if (tokens < 1) { this.#messageBuckets.set(senderId, { tokens, updatedAt: now }); throw new Error("agent message rate limit exceeded"); } this.#messageBuckets.set(senderId, { tokens: tokens - 1, updatedAt: now }); }
  #actorConnectionKey(sessionId, generation) { return `${sessionId}\0${generation}`; }
  #matchingActorConnection(sessionId, generation) {
    const state = this.#actorConnections.get(sessionId);
    return state?.generation === generation && !state.cleaned && !state.closing && !state.socket.destroyed ? state : undefined;
  }
  #resolveActorConnectionWaiters(state) {
    const key = this.#actorConnectionKey(state.sessionId, state.generation);
    const waiters = this.#actorConnectionWaiters.get(key);
    if (!waiters) return;
    this.#actorConnectionWaiters.delete(key);
    for (const finish of waiters) finish(state);
  }
  #waitForActorConnection(sessionId, generation, timeoutMs) {
    const current = this.#matchingActorConnection(sessionId, generation);
    if (current) return Promise.resolve(current);
    const key = this.#actorConnectionKey(sessionId, generation);
    return new Promise((resolve) => {
      let timer;
      const finish = (state) => {
        if (timer) clearTimeout(timer);
        const waiters = this.#actorConnectionWaiters.get(key);
        waiters?.delete(finish); if (waiters?.size === 0) this.#actorConnectionWaiters.delete(key);
        resolve(state);
      };
      const waiters = this.#actorConnectionWaiters.get(key) ?? new Set();
      waiters.add(finish); this.#actorConnectionWaiters.set(key, waiters);
      timer = setTimeout(() => finish(undefined), timeoutMs); timer.unref();
      const raced = this.#matchingActorConnection(sessionId, generation);
      if (raced) finish(raced);
    });
  }
  async #deliverMessageWhenReady(message) {
    return this.#withSessionMutation(message.targetId, async () => {
      if (message.childExitGeneration != null) {
        const current = this.store.getMessage(message.messageId);
        const target = this.store.getSession(message.targetId);
        if (!current || !["queued", "delivered"].includes(current.state)
          || !["resident", "starting", "passivated"].includes(target?.lifecycle)
          || this.#stoppingPromise || this.store.isSessionDeleting(message.targetId)) return;
      } else this.#notifications.noteContinuation(message.senderId, `message:${message.messageId}`, message.createdAt);
      this.#cancelIdlePreparation(message.targetId);
      const residentBefore = this.#actors.get(message.targetId);
      let record = await this.#ensureActorReady(message.targetId);
      let targetState = this.#matchingActorConnection(message.targetId, record.generation)
        ?? await this.#waitForActorConnection(message.targetId, record.generation, ACTOR_CONNECTION_GRACE_MS);
      if (targetState) { this.#deliverMessage(targetState, message); return; }
      if (residentBefore !== record) {
        targetState = await this.#waitForActorConnection(message.targetId, record.generation, ACTOR_CONNECTION_RESTART_WAIT_MS);
        if (targetState) { this.#deliverMessage(targetState, message); return; }
      }

      let target = this.store.getSession(message.targetId);
      if (!target || target.lifecycle !== "resident" || this.#actors.get(message.targetId) !== record
        || record.messageTransportRepairAttempted || target.activity !== "idle") return;
      let workerState;
      try {
        workerState = await record.worker.request("get_state", {}, ACTOR_CONNECTION_STATE_TIMEOUT_MS);
      } catch (error) {
        throw new Error(`target actor state probe failed for ${message.targetId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      targetState = this.#matchingActorConnection(message.targetId, record.generation);
      if (targetState) { this.#deliverMessage(targetState, message); return; }
      target = this.store.getSession(message.targetId);
      if (!target || target.lifecycle !== "resident" || target.activity !== "idle"
        || this.#actors.get(message.targetId) !== record || !record.worker.isRunning
        || workerState?.isStreaming || workerState?.isCompacting || Number(workerState?.pendingMessageCount ?? 0) > 0) return;

      record.messageTransportRepairAttempted = true;
      await this.#stopActor(message.targetId, "passivated");
      record = await this.#ensureActorReady(message.targetId);
      record.messageTransportRepairAttempted = true;
      targetState = this.#matchingActorConnection(message.targetId, record.generation)
        ?? await this.#waitForActorConnection(message.targetId, record.generation, ACTOR_CONNECTION_RESTART_WAIT_MS);
      if (!targetState) throw new Error(`target actor transport did not register for ${message.targetId} generation ${record.generation}`);
      this.#deliverMessage(targetState, message);
    });
  }
  #childExitDeliveries = new Set();
  async #runReminders(sessionId) {
    const session = this.store.getSession(sessionId);
    if (session?.kind !== "root" || session.depth !== 0) return [];
    try {
      return await rootReminders({ rootId: sessionId, registryPath: path.join(path.dirname(this.databasePath), "working-state.json"),
        liveSessionIds: this.store.liveSessionIds() });
    } catch { return []; }
  }
  #homeSessionPath = null;
  #homeSessionId() {
    try { return JSON.parse(readFileSync(this.#homeSessionPath, "utf8")).sessionId ?? null; } catch { return null; }
  }
  #homeNudge = null;
  #nudgeHomeIfDue(now = Date.now()) {
    const due = this.#homeNudge.due(now);
    if (!due) return;
    const home = due.homeId === this.#homeSessionId() ? this.store.getSession(due.homeId) : null;
    if (!home) { this.#homeNudge.dropped(); return; }
    // A running Home settles that run first: success cancels the nudge, failure keeps it.
    if (home.activity === "working") return;
    this.store.queueHomeFailureNudge(due.homeId, home.actorGeneration, due.report, due.failedAt, now);
    this.#homeNudge.sent();
  }
  #childExitCursor = "";
  #retryChildExitMessages() {
    if (this.#stoppingPromise) return;
    const batch = this.store.listPendingChildExitMessages(this.#childExitCursor);
    this.#childExitCursor = batch.length ? batch.at(-1).messageId : "";
    for (const message of batch) {
      if (this.#childExitDeliveries.has(message.messageId)) continue;
      this.#childExitDeliveries.add(message.messageId);
      void this.#deliverMessageWhenReady(message).catch(() => {
        // The durable row remains retryable; never log child/private failure text here.
      }).finally(() => this.#childExitDeliveries.delete(message.messageId));
    }
  }
  #retryQueuedMessages(sessionId) {
    // The worker registers as it starts, before the session is resident, so registration skipped
    // redelivery. Hand that connection what an earlier generation never acknowledged.
    const record = this.#actors.get(sessionId);
    const connection = record && this.#matchingActorConnection(sessionId, record.generation);
    if (connection) void this.#withSessionMutation(sessionId, () => this.#deliverPending(connection));
    for (const message of this.store.listPendingMessages(sessionId)) {
      if (message.state !== "queued") continue;
      void this.#deliverMessageWhenReady(message)
        .catch((error) => { if (!this.#stoppingPromise) this.logger.error?.(`message target preparation failed for ${message.targetId}: ${error.message}`); });
    }
  }
  #deliverPendingOutgoingHistory(state) {
    if (state.role !== "actor" || this.#actorConnections.get(state.sessionId) !== state) return;
    for (const message of this.store.listMessagesAwaitingSenderEntry(state.sessionId, this.pendingMessageLimit)) {
      const target = this.store.getSession(message.targetId);
      this.#write(state, event("message_history_required", { message: { ...message,
        targetName: target?.name, targetShortId: target?.shortId, targetDepth: target?.depth } }));
    }
  }
  #deliverPendingChildCreationHistory(state) {
    if (state.role !== "actor" || this.#actorConnections.get(state.sessionId) !== state) return;
    for (const child of this.store.listPendingChildCreationHistory(state.sessionId, 1)) {
      this.#write(state, event("child_creation_history_required", { child }));
    }
  }
  #deliverPending(state) { if (state.role !== "actor") return; for (const message of this.store.listPendingMessages(state.sessionId)) this.#deliverMessage(state, message); }
  #deliverMessage(state, message) {
    if (this.store.isSessionDeleting(state.sessionId)) return;
    const session = this.store.getSession(state.sessionId); const record = this.#actors.get(state.sessionId);
    if (this.#actorConnections.get(state.sessionId) !== state || state.deliveryInFlight.has(message.messageId)
      || session?.lifecycle !== "resident" || session.actorGeneration !== state.generation
      || record?.generation !== state.generation || record.expectedLifecycle || !record.worker.isRunning) return;
    this.#cancelIdlePreparation(state.sessionId, record);
    let delivered; try { delivered = this.store.markMessageDelivered(message.messageId, state.sessionId, Date.now(), this.maxMessageDeliveryAttempts); } catch (error) { this.logger.error?.(error); return; }
    if (!delivered || delivered.permanentlyFailed) return;
    if (delivered.childExitGeneration == null) this.#notifications.noteContinuation(delivered.senderId, `message:${delivered.messageId}`, delivered.createdAt);
    state.deliveryInFlight.add(delivered.messageId);
    const sender = delivered.childExitGeneration != null
      ? { name: "Harness lifecycle", shortId: "child-exit", depth: undefined }
      : this.store.getSession(delivered.senderId);
    if (!this.#write(state, event("message_available", { message: { ...delivered, senderName: sender?.name, senderShortId: sender?.shortId, senderDepth: sender?.depth, relationship: receiverRelationship(delivered.relationship) }, deliverAs: "steer" }))) state.deliveryInFlight.delete(delivered.messageId);
  }

  #trackDialogRequest(sessionId, record, event) {
    const requestId = event.id ?? event.requestId;
    if (typeof requestId !== "string" || !requestId || requestId.length > 128) return false;
    const key = `${sessionId}\0${requestId}`;
    if (this.#dialogRequests.has(key) || this.#dialogRequests.size >= 256) return false;
    const timeout = Number.isSafeInteger(event.timeout) ? Math.min(event.timeout, 600_000) : 600_000;
    const expiresAt = Date.now() + Math.max(0, timeout);
    const session = this.store.getSession(sessionId);
    const notification = session?.kind === "root" && session.depth === 0 ? this.#notifications.create({
      key: `dialog:${sessionId}:${record.generation}:${requestId}`, rootId: sessionId, sessionId, kind: "attention",
      title: event.title || "Decision needed", body: event.message || event.title || "A live interactive request needs your response.", expiresAt,
      source: { type: "dialog", requestId, actorGeneration: record.generation } }) : null;
    const pending = { generation: record.generation, timer: null, event, expiresAt, notificationId: notification?.id };
    pending.timer = setTimeout(() => {
      if (this.#dialogRequests.get(key) !== pending) return;
      this.#dialogRequests.delete(key);
      this.#notifications.expire();
      const actor = this.#actors.get(sessionId);
      if (actor?.generation === pending.generation && actor.worker.isRunning) {
        try { actor.worker.send({ type: "dialog_response", id: requestId, cancelled: true }); } catch {}
      }
    }, timeout);
    pending.timer.unref(); this.#dialogRequests.set(key, pending); return true;
  }
  #pendingUiRequests(sessionId) {
    const actor = this.#actors.get(sessionId); if (!actor?.worker.isRunning) return [];
    return [...this.#dialogRequests.entries()].filter(([key, p]) => key.startsWith(`${sessionId}\0`) && p.generation === actor.generation && p.expiresAt > Date.now())
      .map(([, p]) => ({ ...p.event, timeout: Math.max(0, p.expiresAt - Date.now()) }));
  }
  #clearDialogRequests(sessionId, generation) {
    const prefix = `${sessionId}\0`;
    for (const [key, pending] of this.#dialogRequests) if (key.startsWith(prefix) && pending.generation === generation) {
      clearTimeout(pending.timer); this.#dialogRequests.delete(key);
      if (pending.notificationId) this.#notifications.transition(pending.notificationId, "cancelled");
    }
  }

  #boundedActorEvent(frame) { return boundedActorEvent(frame); }
  #boundedReplay(ring) { return boundedReplay(ring); }
  #boundedEntries(data) { return boundedEntries(data); }
  #encode(frame) { return encodeSupervisorFrame(frame, this.maxFrameBytes); }
  #broadcast(recipients, frame) { broadcastFrame(recipients, frame, this.maxFrameBytes); }
  #write(state, frame, callback) { return writeSocketFrame(state, frame, this.maxFrameBytes, callback); }
  #flushWrites(state) { flushSocketWrites(state); }
  #cleanupConnection(state) {
    if (state.cleaned) return; state.cleaned = true; state.closing = true;
    this.#history.abortForConnection(state);
    state.inFlightRequestIds.clear(); state.recentCompletedRequestIds.clear(); state.inFlightWorkCount = 0; state.inFlightRequestBytes = 0; state.continuationOwners.clear();
    state.outputQueue = []; state.outputQueueHead = 0; state.outputBytes = 0; state.outputBlocked = false; state.rootOutputSubscribed = false;
    this.#sockets.delete(state); this.#clientConnections.delete(state);
    if (state.role === "actor" && this.#actorConnections.get(state.sessionId) === state) this.#actorConnections.delete(state.sessionId);
  }

  #closeSessionHistoryIndex() {
    const index = this.sessionHistoryIndex;
    this.sessionHistoryIndex = null;
    if (!index) return;
    try { index.close?.(); }
    catch (error) { this.logger.error?.(`session history index close failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  status() {
    const navigator = this.#store ? this.#navigator() : { sessions: [], navigatorTotal: 0, navigatorTruncated: false };
    const daemon = { running: Boolean(this.#server), pid: process.pid, startedAt: this.#startedAt, socketPath: this.socketPath, databasePath: this.databasePath, logPath: this.logPath, protocolVersion: PROTOCOL_VERSION, schemaVersion: this.#store?.schemaVersion };
    return { ...daemon, daemon, ...navigator, capacity: { resident: this.#actors.size - this.#startingActors.size, starting: this.#startingActors.size, queued: this.#startQueue.length, maxResident: this.maxResidentActors, maxConcurrentStarts: this.maxConcurrentStarts }, usage: this.#store?.getUsageSummary?.(), counts: { ...(this.#store?.getOperationalCounts?.() ?? {}), cron: this.#cronStore?.getOperationalCounts?.() ?? { jobs: {}, runs: {} } }, diagnostics: [...(this.#store?.diagnose?.() ?? []), ...(this.#skills.diagnostic ? [this.#skills.diagnostic] : []), ...this.#history.diagnostics()], limits: this.#limits() };
  }
  async stop() {
    if (this.#stoppingPromise) return this.#stoppingPromise;
    this.#stoppingPromise = (async () => {
      this.#history.abortAll("supervisor is stopping");
      clearInterval(this.#notificationTimer);
      for (const timer of this.#passivationTimers.values()) clearTimeout(timer); this.#passivationTimers.clear(); this.#startQueue = [];
      await this.#backgroundCompletionMonitor?.stop(); this.#backgroundCompletionMonitor = undefined;
      await this.#coreReaper?.stop(); this.#coreReaper = undefined;
      await this.#cronScheduler?.stop(); this.#cronScheduler = undefined;
      if (this.#inboxServer) { this.#inboxServer.closeAllConnections?.(); await new Promise((resolve) => this.#inboxServer.close(resolve)); } this.#inboxServer = undefined;
      await Promise.all([...this.#actors.keys()].map((id) => this.#stopActor(id, "passivated"))); await Promise.all([...this.#launchPromises.values()]);
      await Promise.allSettled([...this.#actorInputWakes.values()].map((wake) => wake.done));
      await Promise.allSettled([...this.#actorActivationOwners.values()].flatMap(owners => [...owners].map(owner => owner.done)));
      // Records readers share the sessions' code cache; a failed close can leave a writer.
      await this.transcriptReader?.close?.();
      if ([...this.#actors.values()].every(({ worker }) => worker.isRunning === false)) {
        await (await this.#actorCompileCache)?.dispose();
      }
      for (const state of this.#sockets) state.socket.destroy();
      if (this.#server) await new Promise((resolve) => this.#server.close(resolve)); this.#server = undefined;
      if (this.#ownedSocketPath) try { await unlink(this.#ownedSocketPath); } catch {}
      if (this.#socketLinkTarget) await unlinkSocketLinkIfOwned(this.socketPath, this.#socketLinkTarget);
      await unlinkIfOwned(this.pidPath, this.#pidIdentity); await this.#log("daemon_stopped", { pid: process.pid }); await this.#logTail;
      await this.#history.drain();
      this.#closeSessionHistoryIndex();
      clearInterval(this.#notificationTimer); this.#notifications?.close(); this.#notifications = undefined;
      this.#cronStore?.close(); this.#cronStore = undefined;
      this.#inboxStore?.close(); this.#inboxStore = undefined;
      for (const waiters of this.#actorConnectionWaiters.values()) for (const finish of waiters) finish(undefined);
      this.#actorConnectionWaiters.clear();
      this.#store?.close(); this.#store = undefined; this.#actorConnections.clear(); this.#clientConnections.clear(); this.#actors.clear(); this.#messageBuckets.clear(); this.#actorReadyPromises.clear(); this.#actorActivationOwners.clear(); this.#actorRetirements.clear(); this.#actorInputWakes.clear(); this.#skills.clear(); this.#sessionMutationTails.clear(); this.#cronCompletionTails.clear(); this.#resolveStopped();
      await this.#releaseInstanceLock();
    })();
    return this.#stoppingPromise;
  }
}
