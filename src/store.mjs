import { createHash, randomUUID } from "node:crypto";
import { normalizeInputLocation } from "./input-location.mjs";
import { actorInputDigest, normalizeTurnFailure } from "./protocol.mjs";
import {
  MAX_NAVIGATOR_ANCESTOR_DEPTH,
  activityRank,
  mapActorInput,
  mapActorInputReceipt,
  mapMessage,
  mapSession,
  mapTask,
  normalizeInputProvenance,
  normalizeRetryIntent,
  parseJson,
  relationshipBetween,
  resolveFastModePreference,
  turnFailureBoundary,
} from "./store-mappers.mjs";
import { SCHEMA_VERSION, migrateHarnessDatabase } from "./store-schema.mjs";
import { HarnessUsageStore } from "./store-usage.mjs";
import { DatabaseSync } from "node:sqlite";
import { allocateUniqueRootName, defaultRootName, shortSessionId } from "./root-title.mjs";

export { SCHEMA_VERSION };
export const GLOBAL_ROOT_FAMILY_ID = "local-roots";
export const MAX_PENDING_INPUT_BYTES_PER_SESSION = 16 * 1024 * 1024;
export const MAX_PENDING_INPUT_BYTES_GLOBAL = 64 * 1024 * 1024;
export const MAX_NAVIGATOR_SESSIONS = 512;

export class HarnessStore {
  #db;
  // The root that hears about other roots' abnormal exits and turns (Home), or null.
  rootFailureObserver = () => null;
  // Messages and inputs a settle has covered whose receipts have not arrived (supervisor).
  coveredWork = () => ({ messages: new Set(), inputs: new Set() });
  #deletingSessions = new Set();
  #usage;

  constructor(databasePath, { readOnly = false } = {}) {
    this.#db = new DatabaseSync(databasePath, { readOnly });
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16384;");
    this.#usage = new HarnessUsageStore(this.#db, (sessionId) => Boolean(this.#sessionRow(sessionId)));
    // Native read-only connections can still create local WAL coordination sidecars.
    if (readOnly) return;
    if (databasePath !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    migrateHarnessDatabase(this.#db);
  }

  get database() { return this.#db; }

  #terminalizeSessionWork(sessionId, now = Date.now()) {
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE target_id = ? AND state IN ('accepted', 'queued', 'delivered')`)
      .run("target session was deleted", now, sessionId);
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE sender_id = ? AND state = 'accepted'`)
      .run("sender session was deleted before its transcript entry was recorded", now, sessionId);
    this.#db.prepare(`UPDATE child_tasks SET state = 'failed', completed_at = coalesce(completed_at, ?), error = ?
      WHERE child_id = ? AND state IN ('queued', 'submitted')`)
      .run(now, "child session was deleted before its task completed", sessionId);
  }

  #terminalizeDeletedSessionWork(now = Date.now()) {
    // One set-based pass per table. Looping over every deleted session rescanned
    // messages per session (34 s with 1,503 deleted sessions) on each daemon start.
    const deleted = "SELECT id FROM sessions WHERE lifecycle = 'deleted'";
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE state IN ('accepted', 'queued', 'delivered') AND target_id IN (${deleted})`)
      .run("target session was deleted", now);
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE state = 'accepted' AND sender_id IN (${deleted})`)
      .run("sender session was deleted before its transcript entry was recorded", now);
    this.#db.prepare(`UPDATE child_tasks SET state = 'failed', completed_at = coalesce(completed_at, ?), error = ?
      WHERE state IN ('queued', 'submitted') AND child_id IN (${deleted})`)
      .run(now, "child session was deleted before its task completed");
  }

  getSessionRoot(sessionId) {
    const seen = new Set();
    let id = sessionId, expectedDepth = null;
    for (let hops = 0; hops <= MAX_NAVIGATOR_ANCESTOR_DEPTH; hops += 1) {
      const row = this.#sessionRow(id);
      if (!row || seen.has(id) || !Number.isSafeInteger(row.depth) || row.depth < 0
        || row.depth > MAX_NAVIGATOR_ANCESTOR_DEPTH || (expectedDepth !== null && row.depth !== expectedDepth)) break;
      seen.add(id);
      if (row.kind === "root" && row.depth === 0 && row.parent_session_id === null) return mapSession(row);
      if (row.kind !== "child" || row.depth === 0 || !row.parent_session_id) break;
      expectedDepth = row.depth - 1; id = row.parent_session_id;
    }
    throw new Error("session root ancestry is invalid");
  }

  getRootScratch(sessionId) {
    const root = this.getSessionRoot(sessionId);
    const value = this.#sessionRow(root.sessionId).scratch_json;
    if (value === null) return null;
    const record = parseJson(value);
    if (!record || record.version !== 1 || !["ready", "deleting", "removed"].includes(record.state)) throw new Error("root scratch ownership is invalid");
    return record;
  }

  rootScratchCleanupState(rootId) {
    try { return this.getRootScratch(rootId)?.state ?? "unowned"; }
    catch { return "unknown"; }
  }

  listPendingScratchRoots() {
    return this.#db.prepare(`SELECT id FROM sessions WHERE kind = 'root' AND lifecycle = 'deleted'
      AND CASE WHEN json_valid(scratch_json) THEN json_extract(scratch_json, '$.state') END = 'deleting'`)
      .all().map(row => row.id);
  }

  setRootScratch(rootId, record) {
    if (this.getSessionRoot(rootId).sessionId !== rootId) throw new Error("scratch owner must be a root");
    this.#db.prepare("UPDATE sessions SET scratch_json = ? WHERE id = ?").run(JSON.stringify(record), rootId);
  }

  get schemaVersion() { return Number(this.#db.prepare("PRAGMA user_version").get().user_version); }

  #sessionRow(sessionId) {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  }

  #workingDescendantCount(sessionId) {
    return Number(this.#db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM sessions WHERE parent_session_id = ? AND lifecycle <> 'deleted'
        UNION
        SELECT s.id FROM sessions s JOIN descendants d ON s.parent_session_id = d.id WHERE s.lifecycle <> 'deleted'
      )
      SELECT count(*) AS count FROM sessions WHERE id IN descendants AND id <> ? AND activity = 'working'
    `).get(sessionId, sessionId).count);
  }

  // The session and its descendants that still have, or may resume, a worker.
  liveSessionIds() {
    return this.#db.prepare("SELECT id FROM sessions WHERE lifecycle IN ('starting', 'resident', 'passivated')").all().map(row => row.id);
  }

  #sessionLineage(sessionId) {
    const names = [];
    const seen = new Set();
    let current = this.#db.prepare("SELECT id, display_name, parent_session_id FROM sessions WHERE id = ?").get(sessionId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.display_name);
      current = current.parent_session_id
        ? this.#db.prepare("SELECT id, display_name, parent_session_id FROM sessions WHERE id = ?").get(current.parent_session_id)
        : undefined;
    }
    return names.join("/");
  }

  #mappedSession(sessionId) {
    const row = this.#sessionRow(sessionId);
    if (!row) return undefined;
    row.working_descendant_count = this.#workingDescendantCount(sessionId);
    return { ...mapSession(row, resolveFastModePreference(sessionId, (id) => id === sessionId ? row : this.#sessionRow(id))),
      lineage: this.#sessionLineage(sessionId) };
  }

  #insertRoot(params, now) {
    const id = params.sessionId;
    if (!id) throw new Error("root sessionId is required");
    if (!params.cwd) throw new Error("root cwd is required");
    const name = params.name?.trim() || defaultRootName(params.cwd, id);
    if (!params.actorToken) throw new Error("root actorToken is required");
    const actorToken = params.actorToken;
    this.#db.prepare(`
      INSERT INTO sessions (id, short_id, session_file, cwd, repository_root, display_name, kind,
        family_id, parent_session_id, depth, activity, streaming, lifecycle, actor_token,
        actor_generation, launch_json, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, 'root', ?, NULL, 0, 'inactive', 0, 'starting', ?, 1, ?, ?, ?, ?)
    `).run(id, shortSessionId(id), params.sessionFile ?? null, params.cwd, params.repositoryRoot ?? null,
      name, GLOBAL_ROOT_FAMILY_ID, actorToken, JSON.stringify({ ...params.launch, fastMode: false }), now, now, now);
    return id;
  }

  createRoot(params, now = params.now ?? Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#sessionRow(params.sessionId)) throw new Error("session already exists");
      const id = this.#insertRoot(params, now);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(id) };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  admitRoot(params, now = params.now ?? Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#sessionRow(params.sessionId);
      if (!existing) {
        const id = this.#insertRoot(params, now);
        this.#db.exec("COMMIT");
        return { session: this.#mappedSession(id), created: true };
      }
      if (existing.kind !== "root") throw new Error("child Pi session cannot be admitted as a root");
      if (existing.lifecycle === "deleted") throw new Error("root was deleted");
      const name = params.name?.trim() || existing.display_name;
      this.#db.prepare(`UPDATE sessions SET session_file = coalesce(?, session_file), cwd = ?,
        repository_root = ?, display_name = ?, launch_json = coalesce(?, launch_json), updated_at = ? WHERE id = ?`)
        .run(params.sessionFile ?? null, params.cwd ?? existing.cwd,
          params.repositoryRoot ?? existing.repository_root, name,
          params.launch == null ? null : JSON.stringify({ ...params.launch, fastMode: parseJson(existing.launch_json, {}).fastMode === true }), now, existing.id);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(existing.id), created: false };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createChild(parentId, { sessionId, sessionFile, policy, actorToken, now = Date.now() }) {
    this.assertSessionAvailable(parentId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.#sessionRow(parentId);
      if (!parent || parent.lifecycle === "deleted") throw new Error("parent session does not exist");
      if (this.#sessionRow(sessionId)) throw new Error("session already exists");
      const depth = parent.depth + 1;
      if (policy.depth != null && policy.depth !== depth) throw new Error("child depth does not match its parent edge");
      const displayName = policy.name?.trim() || `subagent-${shortSessionId(sessionId)}`;
      if (!actorToken) throw new Error("child actorToken is required");
      this.#db.prepare(`
        INSERT INTO sessions (id, short_id, session_file, cwd, repository_root, display_name, kind,
          family_id, parent_session_id, depth, activity, streaming, lifecycle, actor_token,
          actor_generation, launch_json, created_at, updated_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, 'child', ?, ?, ?, 'inactive', 0, 'starting', ?, 1, ?, ?, ?, ?)
      `).run(sessionId, shortSessionId(sessionId), sessionFile ?? null, policy.cwd ?? parent.cwd,
        policy.repositoryRoot ?? parent.repository_root, displayName, parent.family_id, parentId, depth,
        actorToken, JSON.stringify({ ...policy, depth, fastMode: false }), now, now, now);
      this.#db.prepare("INSERT INTO children(session_id) VALUES (?)").run(sessionId);
      const taskId = randomUUID();
      this.#db.prepare("INSERT INTO child_tasks(id, child_id, kind, prompt, state, created_at, history_peer_name, history_entry_id) VALUES (?, ?, 'initial', ?, 'queued', ?, ?, NULL)")
        .run(taskId, sessionId, policy.prompt ?? null, now, displayName);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(sessionId), task: this.getChildTask(taskId) };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  registerActor(params, now = Date.now()) {
    const sessionId = params.sessionId ?? params.actorId;
    const generation = params.generation ?? params.actorGeneration;
    this.assertSessionAvailable(sessionId);
    const row = this.#sessionRow(sessionId);
    if (!row) throw new Error("actor admission does not exist");
    if (row.lifecycle === "deleted") throw new Error("actor was deleted");
    if (row.actor_token !== params.actorToken || row.actor_generation !== generation) {
      throw new Error("actor generation or token is stale");
    }
    this.#db.prepare(`UPDATE sessions SET session_file = coalesce(?, session_file), cwd = coalesce(?, cwd),
      repository_root = coalesce(?, repository_root), updated_at = ? WHERE id = ?`)
      .run(params.sessionFile ?? null, params.cwd ?? null, params.repositoryRoot ?? null, now, sessionId);
    return { session: this.#mappedSession(sessionId) };
  }

  prepareActorRevival(sessionId, actorToken, now = Date.now(), { force = false, error = null } = {}) {
    this.assertSessionAvailable(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row) throw new Error("actor does not exist");
      if (row.lifecycle === "deleted") throw new Error("actor was deleted");
      if (!actorToken) throw new Error("actorToken is required for revival");
      if (!force && ["resident", "starting"].includes(row.lifecycle)) {
        this.#db.exec("COMMIT");
        return this.#mappedSession(sessionId);
      }
      this.#db.prepare(`UPDATE sessions SET lifecycle = 'starting', actor_token = ?,
        actor_generation = actor_generation + 1, actor_pid = NULL, actor_identity_json = NULL,
        streaming = 0, activity = 'inactive', quiet_since = NULL, last_error = ?, stopped_at = NULL,
        updated_at = ? WHERE id = ?`).run(actorToken, error, now, sessionId);
      this.#refreshAncestors(sessionId, now);
      this.#db.exec("COMMIT");
      return this.#mappedSession(sessionId);
    } catch (error_) { this.#db.exec("ROLLBACK"); throw error_; }
  }

  reconcileAfterDaemonStart(now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previousOwners = this.#db.prepare(`SELECT * FROM sessions WHERE lifecycle IN ('starting', 'resident')
        OR (lifecycle = 'passivated' AND EXISTS (SELECT 1 FROM actor_inputs WHERE session_id = sessions.id))`)
        .all().map((row) => ({
          sessionId: row.id,
          actorId: row.id,
          kind: row.kind,
          activity: row.activity,
          lifecycle: row.lifecycle,
          actorGeneration: Number(row.actor_generation),
          actorPid: row.actor_pid == null ? null : Number(row.actor_pid),
          actorIdentity: parseJson(row.actor_identity_json),
        }));
      for (const owner of previousOwners) {
        const lastError = owner.lifecycle === "starting"
          ? "daemon restarted during actor startup"
          : ["working", "delegating"].includes(owner.activity)
            ? "daemon restarted during active work; completion is unknown"
            : "daemon restarted; actor is queued for recovery";
        this.#db.prepare(`UPDATE sessions SET lifecycle = 'starting', actor_token = ?,
          actor_generation = actor_generation + 1, actor_pid = NULL, actor_identity_json = NULL,
          streaming = 0, activity = 'inactive', quiet_since = NULL, stopped_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`).run(randomUUID(), now, lastError, now, owner.sessionId);
      }
      this.#db.prepare(`UPDATE child_tasks SET state = 'failed', completed_at = ?,
        error = 'daemon restarted during submitted work; completion is unknown' WHERE state = 'submitted'`).run(now);
      this.#terminalizeDeletedSessionWork(now);
      this.#db.exec("COMMIT");
      return previousOwners;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  listQueuedActorIds() {
    return this.#db.prepare("SELECT id FROM sessions WHERE lifecycle = 'starting' ORDER BY created_at, id")
      .all().map((row) => row.id);
  }

  getActorLaunch(sessionId) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted") return undefined;
    return {
      ...mapSession(row),
      lineage: this.#sessionLineage(sessionId),
      launch: parseJson(row.launch_json, {}),
      actorToken: row.actor_token,
    };
  }

  recordResolvedSessionInference(sessionId, generation, selection, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      if (Number(row.actor_generation) !== generation) throw new Error("actor generation does not own the session");
      const launch = parseJson(row.launch_json, {});
      const currentModel = launch.model?.resolved;
      const currentThinking = launch.thinking?.resolved;
      if (currentModel && (currentModel.provider !== selection.provider || currentModel.id !== selection.model)) {
        throw new Error("resolved actor model differs from its launch policy");
      }
      if (currentThinking && currentThinking !== selection.thinkingLevel) {
        throw new Error("resolved actor thinking level differs from its launch policy");
      }
      if (!currentModel) launch.model = { requested: launch.model?.requested ?? null,
        resolved: { provider: selection.provider, id: selection.model }, source: launch.model?.source ?? "settings" };
      if (!currentThinking) launch.thinking = { requested: launch.thinking?.requested ?? null,
        resolved: selection.thinkingLevel, source: launch.thinking?.source ?? "settings" };
      if (!currentModel || !currentThinking || launch.fastModeSupported !== (selection.fastModeSupported === true) || typeof launch.fastMode !== "boolean") {
        launch.fastMode = launch.fastMode === true;
        launch.fastModeSupported = selection.fastModeSupported === true;
        this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(launch), now, sessionId);
      }
      this.#db.exec("COMMIT");
      return this.getActorLaunch(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  getSessionFastModePreference(sessionId) {
    return resolveFastModePreference(sessionId, (id) => this.#sessionRow(id));
  }

  // Sample the canonical root at request preparation, never a worker-local flag.
  getSessionFastMode(sessionId) {
    const preference = this.getSessionFastModePreference(sessionId);
    if (typeof preference.fastMode !== "boolean") throw new Error("session Fast preference is unavailable: missing, deleted, or invalid ancestry");
    return preference.fastMode;
  }

  updateSessionFastMode(sessionId, enabled, expected, now = Date.now()) {
    if (typeof enabled !== "boolean" || typeof expected !== "boolean") throw new TypeError("fastMode must be boolean");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      const preference = this.getSessionFastModePreference(sessionId);
      if (preference.fastModeRootSessionId !== sessionId) throw new Error("only the root session can change family Fast mode");
      if (typeof preference.fastMode !== "boolean") throw new Error("session Fast preference is unavailable");
      const launch = parseJson(row.launch_json, {});
      if (preference.fastMode !== expected) throw new Error("session Fast preference changed concurrently");
      launch.fastMode = enabled;
      this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(launch), now, sessionId);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  queueSessionInference(sessionId, selection, activeSelection, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
    const launch = parseJson(row.launch_json, {});
    // Capture the observed active baseline only when accepting explicit picker
    // intent. Existing idle service setters retain their session-only lifetime.
    if (!launch.pendingInference) {
      launch.model = { ...launch.model, resolved: { provider: activeSelection.provider, id: activeSelection.model } };
      launch.thinking = { ...launch.thinking, resolved: activeSelection.thinkingLevel };
      launch.fastModeSupported = activeSelection.fastModeSupported === true;
    }
    launch.pendingInference = { requestId: randomUUID(), provider: selection.provider,
      model: selection.model, thinkingLevel: selection.thinkingLevel };
    this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(launch), now, sessionId);
    return launch.pendingInference;
  }

  // Move sessions following the default to a new model. Deliberate picks, and
  // children inheriting one, keep theirs. Stopped and passivated actors read
  // launch policy at startup; live ones apply the queued selection between turns.
  retargetDefaultInference({ from, to, liveSessionIds = new Set(), thinkingFor = (level) => level, apply = false }, now = Date.now()) {
    if (apply) this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare("SELECT id, parent_session_id, display_name, launch_json FROM sessions WHERE deleted_at IS NULL AND lifecycle != 'deleted'").all()
        .map((row) => ({ id: row.id, parent: row.parent_session_id, name: row.display_name, launch: parseJson(row.launch_json, {}) }));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const follows = (row, depth = 0) => {
        const source = row?.launch.model?.source;
        if (source === "settings") return true;
        return source === "parent" && depth < 64 && follows(byId.get(row.parent), depth + 1);
      };
      const result = { moved: [], pinned: [], pending: [], otherModels: [] };
      for (const row of rows) {
        const { launch } = row;
        const resolved = launch.model?.resolved;
        const current = resolved?.provider === from.provider && resolved?.id === from.model;
        const entry = { sessionId: row.id, name: row.name };
        if (!follows(row)) { if (current) result.pinned.push(entry); continue; }
        if (!current) { if (resolved) result.otherModels.push({ ...entry, model: resolved.id }); continue; }
        if (launch.pendingInference) { result.pending.push(entry); continue; }
        const live = liveSessionIds.has(row.id);
        result.moved.push({ ...entry, live });
        if (!apply) continue;
        const thinkingLevel = thinkingFor(launch.thinking?.resolved);
        if (live) {
          launch.pendingInference = { requestId: randomUUID(), provider: to.provider, model: to.id, thinkingLevel, followDefault: true };
        } else {
          launch.model = { ...launch.model, resolved: { provider: to.provider, id: to.id } };
          if (thinkingLevel) launch.thinking = { ...launch.thinking, resolved: thinkingLevel };
          launch.fastModeSupported = to.fastModeSupported === true;
        }
        this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(launch), now, row.id);
      }
      if (apply) this.#db.exec("COMMIT");
      return result;
    } catch (error) { if (apply) this.#db.exec("ROLLBACK"); throw error; }
  }

  recordSessionInferenceResult(sessionId, generation, result) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted" || Number(row.actor_generation) !== generation) return false;
    let launch = parseJson(row.launch_json, {});
    if (result.error) {
      if (result.selection && !launch.pendingInference?.followDefault) launch = this.updateSessionInference(sessionId, result.selection, launch).launch;
      if (launch.pendingInference?.requestId !== result.requestId) return false;
      launch.pendingInference.error = "Selection could not be applied. Choose again or retry after reconnecting.";
      this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(launch), Date.now(), sessionId);
    } else {
      this.updateSessionInference(sessionId, result.selection, launch, Date.now(), result.requestId);
    }
    return true;
  }

  updateSessionInference(sessionId, selection, expectedLaunch = undefined, now = Date.now(), requestId = null) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      const launch = parseJson(row.launch_json, {});
      if (expectedLaunch !== undefined && JSON.stringify(launch) !== JSON.stringify(expectedLaunch)) {
        throw new Error("session inference policy changed concurrently");
      }
      // A default move leaves the session following the default.
      if (requestId && launch.pendingInference?.requestId === requestId && launch.pendingInference.followDefault) {
        launch.model = { ...launch.model, resolved: { provider: selection.provider, id: selection.model } };
        launch.thinking = { ...launch.thinking, resolved: selection.thinkingLevel };
      } else {
        launch.model = { requested: `${selection.provider}/${selection.model}`, resolved: { provider: selection.provider, id: selection.model }, source: "explicit" };
        launch.thinking = { requested: selection.thinkingLevel, resolved: selection.thinkingLevel, source: "explicit" };
      }
      launch.fastModeSupported = selection.fastModeSupported === true;
      if (requestId && launch.pendingInference?.requestId === requestId) delete launch.pendingInference;
      this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(launch), now, sessionId);
      if (Number.isSafeInteger(selection.contextWindow) && selection.contextWindow > 0) {
        this.#db.prepare(`INSERT INTO session_context_usage(session_id, context_tokens, context_window, percent, updated_at)
          VALUES (?, NULL, ?, NULL, ?) ON CONFLICT(session_id) DO UPDATE SET context_tokens = NULL,
          context_window = excluded.context_window, percent = NULL, updated_at = excluded.updated_at`)
          .run(sessionId, selection.contextWindow, now);
      } else this.#db.prepare("DELETE FROM session_context_usage WHERE session_id = ?").run(sessionId);
      this.#db.exec("COMMIT");
      return this.getActorLaunch(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }


  hasPendingSessionWork(sessionId) {
    const input = this.#db.prepare("SELECT 1 FROM actor_inputs WHERE session_id = ? LIMIT 1").get(sessionId);
    const task = this.#db.prepare("SELECT 1 FROM child_tasks WHERE child_id = ? AND state IN ('queued', 'submitted') LIMIT 1").get(sessionId);
    const message = this.#db.prepare("SELECT 1 FROM messages WHERE target_id = ? AND state IN ('queued', 'delivered') LIMIT 1").get(sessionId);
    return Boolean(input || task || message);
  }

  markActorStarted(sessionId, generation, { pid = null, sessionFile = null, processIdentity = null } = {}, now = Date.now()) {
    this.assertSessionAvailable(sessionId);
    const result = this.#db.prepare(`UPDATE sessions SET lifecycle = 'resident', actor_pid = ?,
      actor_identity_json = ?, session_file = coalesce(?, session_file), started_at = ?, stopped_at = NULL,
      streaming = 0, activity = ?, quiet_since = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND actor_generation = ? AND lifecycle = 'starting'`)
      .run(pid, processIdentity ? JSON.stringify(processIdentity) : null, sessionFile, now,
        this.#workingDescendantCount(sessionId) > 0 ? "delegating" : "idle", now, now, sessionId, generation);
    if (result.changes !== 1) throw new Error("actor generation is stale or not starting");
    this.#refreshAncestors(sessionId, now);
    return this.#mappedSession(sessionId);
  }

  markActorLifecycle(sessionId, generation, lifecycle, error = null, now = Date.now(), { reportChildExit = false } = {}) {
    if (!["passivated", "stopped", "error"].includes(lifecycle)) throw new Error(`unsupported actor lifecycle: ${lifecycle}`);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#sessionRow(sessionId);
      if (reportChildExit && !["resident", "starting", "error"].includes(previous?.lifecycle)) {
        this.#db.exec("COMMIT"); return false;
      }
      // A session without a worker still delegates while any descendant works.
      const activity = this.#workingDescendantCount(sessionId) > 0 ? "delegating" : "inactive";
      const result = this.#db.prepare(`UPDATE sessions SET lifecycle = ?, actor_pid = NULL,
        actor_identity_json = NULL, streaming = 0, activity = ?, stopped_at = ?, quiet_since = NULL,
        last_error = ?, updated_at = ? WHERE id = ? AND actor_generation = ? AND lifecycle <> 'deleted'`)
        .run(lifecycle, activity, now, error, now, sessionId, generation);
      if (result.changes !== 1) { this.#db.exec("COMMIT"); return false; }
      if (reportChildExit && lifecycle === "error") this.#queueChildFailure(sessionId, generation, error, now);
      this.#refreshAncestors(sessionId, now);
      // A child stopped mid-turn ends that turn without a settle.
      if (previous.streaming && previous.kind === "child") this.#reportQuietFamily(sessionId, now);
      this.#db.exec("COMMIT");
      return true;
    } catch (failure) { this.#db.exec("ROLLBACK"); throw failure; }
  }

  recordActorTurnFailure(sessionId, generation, value, now = Date.now()) {
    const report = normalizeTurnFailure(value);
    const row = this.#sessionRow(sessionId);
    if (!row || row.actor_generation !== generation || !["starting", "resident"].includes(row.lifecycle)
      || this.isSessionDeleting(sessionId)) throw new Error("actor generation is stale or unavailable");
    this.#queueChildFailure(sessionId, generation, null, now, report);
  }

  #queueChildFailure(sessionId, generation, error, now, turnFailure = null) {
    const session = this.#sessionRow(sessionId);
    let target = null;
    if (session?.kind === "child") target = this.#sessionRow(session.parent_session_id);
    else if (session?.kind === "root") {
      const observerId = this.rootFailureObserver();
      const observer = typeof observerId === "string" && observerId !== sessionId ? this.#sessionRow(observerId) : null;
      if (observer?.kind === "root") target = observer;
    }
    if (!target || target.lifecycle === "deleted" || this.isSessionDeleting(target.id)
      || this.isSessionDeleting(sessionId)) return;
    const [subject, noun, relationship] = session.kind === "child" ? ["direct child", "child", "parent"] : ["root session", "session", "sibling"];
    // This receipt is supervisor-authored, not a fabricated child transcript entry.
    // Exit keys are generation-bound; turn keys survive lost ACKs and revival.
    // The legacy child_exit_generation column marks both lifecycle receipt kinds.
    const childKey = createHash("sha256").update(sessionId).digest("hex");
    const id = turnFailure
      ? `child-exit:turn:${createHash("sha256").update(sessionId).update("\0").update(turnFailure.turnId).digest("hex")}`
      : `child-exit:${childKey}:${generation}`;
    const identity = /^[a-zA-Z0-9-]{1,128}$/.test(sessionId) ? sessionId : "[invalid child ID]";
    const failureClass = typeof error === "string" && error.includes("JavaScript heap out of memory")
      ? "heap_exhausted" : "actor_exit";
    let body = `Harness lifecycle report (supervisor-generated, not ${noun}-authored): ${subject} ${identity}, generation ${generation}, exited unexpectedly. Failure class: ${failureClass}. Completion is unknown. Inspect retained ${noun} state and saved artifacts before deciding recovery. No ${noun} restart or work replay was requested.`;
    if (turnFailure) {
      body = `Harness lifecycle report (supervisor-generated, not ${noun}-authored): ${subject} ${identity}, turn ${turnFailure.turnId}, stopped abnormally. Failure class: ${turnFailure.failureClass}. ${turnFailureBoundary(turnFailure)} Inspect retained ${noun} state and saved artifacts before deciding recovery. No ${noun} restart or work replay was requested.`;
    }
    this.#db.prepare(`INSERT OR IGNORE INTO messages
      (id, sender_id, target_id, relationship, delivery_mode, body, state, attempt_count, accepted_at, queued_at, child_exit_generation)
      VALUES (?, ?, ?, ?, 'auto', ?, 'queued', 0, ?, ?, ?)`)
      .run(id, sessionId, target.id, relationship, body, now, now, generation);
  }

  // Nobody observes Home's own failed turn. The supervisor queues this later, through
  // the same lifecycle delivery that wakes a passivated target.
  queueHomeFailureNudge(sessionId, generation, turnFailure, failedAt, now = Date.now()) {
    const report = normalizeTurnFailure(turnFailure);
    const session = this.#sessionRow(sessionId);
    if (session?.kind !== "root" || session.lifecycle === "deleted" || this.isSessionDeleting(sessionId)
      || !Number.isSafeInteger(generation) || generation < 1) return false;
    const id = `home-nudge:${createHash("sha256").update(sessionId).update("\0").update(report.turnId).digest("hex")}`;
    const body = `Harness lifecycle report (supervisor-generated, not session-authored): your own turn ${report.turnId} stopped abnormally at ${new Date(failedAt).toISOString()}, and you have not run since. Failure class: ${report.failureClass}. ${turnFailureBoundary(report)} Nothing was retried. Other sessions may have stopped at the same time, and their reports may have reached you inside the failed turn. Check every root session and your own work, then resume as normal. Do not replay interrupted work. No restart was requested.`;
    return this.#db.prepare(`INSERT OR IGNORE INTO messages
      (id, sender_id, target_id, relationship, delivery_mode, body, state, attempt_count, accepted_at, queued_at, child_exit_generation)
      VALUES (?, ?, ?, 'sibling', 'auto', ?, 'queued', 0, ?, ?, ?)`)
      .run(id, sessionId, sessionId, body, now, now, generation).changes === 1;
  }

  listPendingChildExitMessages(after = "") {
    return this.#db.prepare(`SELECT m.* FROM messages m JOIN sessions p ON p.id = m.target_id
      WHERE m.child_exit_generation IS NOT NULL AND m.state IN ('queued', 'delivered') AND m.id > ?
      AND p.lifecycle IN ('resident', 'starting', 'passivated')
      ORDER BY m.id LIMIT 100`).all(after).map(mapMessage);
  }

  setActorActivity(sessionId, generation, streaming, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.actor_generation !== generation || row.lifecycle !== "resident") {
      throw new Error("actor generation is stale or not resident");
    }
    const descendants = this.#workingDescendantCount(sessionId);
    const activity = streaming ? "working" : descendants > 0 ? "delegating" : "idle";
    const changed = row.streaming !== Number(streaming) || row.activity !== activity;
    this.#db.prepare("UPDATE sessions SET streaming = ?, activity = ?, quiet_since = ?, updated_at = ? WHERE id = ?")
      .run(streaming ? 1 : 0, activity, !streaming ? (row.quiet_since ?? now) : null,
        changed ? now : row.updated_at, sessionId);
    this.#refreshAncestors(sessionId, now);
    if (row.streaming && !streaming) this.#reportQuietFamily(sessionId, now);
    return this.#mappedSession(sessionId);
  }

  // Home hears when a root's family (the root and its descendants) goes quiet: nobody is in
  // a turn and no input, task or message waits for anyone. It is checked only when a member's
  // turn ends (specification/RootIdleReport.tla). A member is in a turn from the moment its
  // core takes work until the settle that covers it; covered work whose receipt is still on
  // its way (coveredWork, from the supervisor) is done, not waiting. The report describes the
  // transition; later input may start the family again.
  #reportQuietFamily(memberId, now) {
    let row = this.#sessionRow(memberId);
    const seen = new Set();
    while (row?.parent_session_id && !seen.has(row.id)) { seen.add(row.id); row = this.#sessionRow(row.parent_session_id); }
    const homeId = this.rootFailureObserver();
    const home = row && typeof homeId === "string" && homeId !== row.id ? this.#sessionRow(homeId) : null;
    if (row?.kind !== "root" || row.lifecycle === "deleted" || home?.kind !== "root" || home.lifecycle === "deleted"
      || this.isSessionDeleting(home.id) || this.isSessionDeleting(row.id) || !this.#familyQuiet(row.id)) return;
    const generation = row.actor_generation;
    const identity = /^[a-zA-Z0-9-]{1,128}$/.test(row.id) ? row.id : "[invalid session ID]";
    const id = `root-idle:${createHash("sha256").update(row.id).update("\0").update(String(generation)).update("\0").update(String(now)).digest("hex")}`;
    const body = `Harness lifecycle report (supervisor-generated, not session-authored): root session ${identity} finished its turn and is now idle.`;
    this.#db.prepare(`INSERT OR IGNORE INTO messages
      (id, sender_id, target_id, relationship, delivery_mode, body, state, attempt_count, accepted_at, queued_at, child_exit_generation)
      VALUES (?, ?, ?, 'sibling', 'auto', ?, 'queued', 0, ?, ?, ?)`)
      .run(id, row.id, home.id, body, now, now, generation);
  }

  // A child task counts only while its child can still run it; a failed child's
  // unfinished task would otherwise keep its family busy for good.
  #familyQuiet(rootId) {
    const covered = this.coveredWork();
    return Boolean(this.#db.prepare(`
      WITH RECURSIVE family(id) AS (
        SELECT id FROM sessions WHERE id = ?
        UNION
        SELECT s.id FROM sessions s JOIN family f ON s.parent_session_id = f.id WHERE s.lifecycle <> 'deleted'
      )
      SELECT NOT EXISTS (SELECT 1 FROM sessions WHERE id IN family AND streaming = 1)
        AND NOT EXISTS (SELECT 1 FROM actor_inputs WHERE session_id IN family AND id NOT IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM messages WHERE target_id IN family AND state IN ('accepted', 'queued', 'delivered')
          AND id NOT IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM child_tasks t JOIN sessions s ON s.id = t.child_id
          WHERE t.child_id IN family AND t.state IN ('queued', 'submitted') AND s.lifecycle IN ('starting', 'resident', 'passivated'))
        AS quiet
    `).get(rootId, JSON.stringify([...covered.inputs]), JSON.stringify([...covered.messages])).quiet);
  }

  #refreshAncestors(sessionId, now) {
    let current = this.#db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(sessionId)?.parent_session_id;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.#sessionRow(current);
      if (!row) break;
      const descendants = this.#workingDescendantCount(current);
      let activity = descendants > 0 ? "delegating" : "inactive";
      if (row.lifecycle === "resident") {
        activity = row.streaming ? "working" : descendants > 0 ? "delegating" : "idle";
      }
      // Family display does not own the resident worker's idle interval.
      const quietSince = row.lifecycle === "resident" && !row.streaming ? (row.quiet_since ?? now) : null;
      this.#db.prepare("UPDATE sessions SET activity = ?, quiet_since = ? WHERE id = ?")
        .run(activity, quietSince, current);
      current = row.parent_session_id;
    }
  }

  setSessionName(sessionId, name, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
    const displayName = name?.trim() || (row.kind === "root" ? defaultRootName(row.cwd, row.id) : row.display_name);
    if (row.kind === "child" && displayName !== row.display_name) throw new Error("child names are immutable after admission");
    this.#db.prepare("UPDATE sessions SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, now, sessionId);
    return this.#mappedSession(sessionId);
  }

  autoNameDefaultRoot(sessionId, title, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted" || row.kind !== "root") {
      return { renamed: false, session: row ? this.#mappedSession(sessionId) : undefined };
    }
    if (row.display_name !== defaultRootName(row.cwd, row.id)) {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    if (typeof title !== "string" || !title.trim() || title === row.display_name) {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    let name;
    try {
      name = allocateUniqueRootName(title, row.short_id, (candidate) => this.#rootNameTaken(candidate, row.id));
    } catch {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    try {
      this.#db.prepare("UPDATE sessions SET display_name = ?, updated_at = ? WHERE id = ?").run(name, now, sessionId);
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.code === "SQLITE_CONSTRAINT") {
        return { renamed: false, session: this.#mappedSession(sessionId) };
      }
      throw error;
    }
    return { renamed: true, session: this.#mappedSession(sessionId) };
  }

  #rootNameTaken(name, exceptSessionId) {
    const row = this.#db.prepare(`SELECT id FROM sessions WHERE kind = 'root' AND lifecycle <> 'deleted'
      AND display_name = ? AND id <> ? LIMIT 1`).get(name, exceptSessionId);
    return Boolean(row);
  }

  getSession(sessionId) { return this.#mappedSession(sessionId); }

  getSessionActorState(sessionId) {
    const row = this.#db.prepare("SELECT lifecycle, actor_generation, activity, quiet_since, last_error FROM sessions WHERE id = ?").get(sessionId);
    return row ? { lifecycle: row.lifecycle, actorGeneration: Number(row.actor_generation),
      activity: row.activity, quietSince: row.quiet_since, lastError: row.last_error } : undefined;
  }
  resolveSession(selector) {
    const rows = this.#db.prepare(`SELECT id FROM sessions WHERE lifecycle <> 'deleted'
      AND (id = ? OR short_id = ? OR display_name = ?) ORDER BY created_at, id LIMIT 2`).all(selector, selector, selector);
    if (rows.length === 0) throw new Error(`session not found: ${selector}`);
    if (rows.length > 1) throw new Error(`session selector is ambiguous: ${selector}`);
    return this.#mappedSession(rows[0].id);
  }
  listSessions() {
    return this.#db.prepare("SELECT id FROM sessions WHERE lifecycle <> 'deleted' ORDER BY created_at, id")
      .all().map((row) => this.#mappedSession(row.id));
  }
  listNavigatorSessions({ limit = MAX_NAVIGATOR_SESSIONS, preferredSessionIds = [] } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NAVIGATOR_SESSIONS) throw new Error(`navigator limit must be from 1 through ${MAX_NAVIGATOR_SESSIONS}`);
    const preferred = [...new Set(preferredSessionIds.filter((id) => typeof id === "string" && id))].slice(0, limit);
    const preferredJson = JSON.stringify(preferred); let queryCount = 0;
    const total = Number(this.#db.prepare("SELECT count(*) AS count FROM sessions WHERE lifecycle <> 'deleted'").get().count); queryCount += 1;
    if (total === 0) return { sessions: [], total: 0, truncated: false,
      work: { queryCount, priorityRows: 0, newestRows: 0, candidateRows: 0, contextRows: 0, mappedRows: 0, newestReserve: 0 } };

    const priorityRows = this.#db.prepare(`WITH preferred(id) AS (SELECT value FROM json_each(?))
      SELECT s.*, CASE
        WHEN EXISTS (SELECT 1 FROM preferred p WHERE p.id = s.id) THEN 0
        WHEN s.activity = 'working' THEN 1 WHEN s.activity = 'delegating' THEN 2
        WHEN s.lifecycle = 'starting' THEN 3
        WHEN EXISTS (SELECT 1 FROM actor_inputs i WHERE i.session_id = s.id)
          OR EXISTS (SELECT 1 FROM child_tasks t WHERE t.child_id = s.id AND t.state IN ('queued', 'submitted'))
          OR EXISTS (SELECT 1 FROM messages m WHERE m.target_id = s.id AND m.state IN ('queued', 'delivered')) THEN 4
        WHEN s.lifecycle = 'resident' THEN 5 ELSE 6 END AS navigator_rank
      FROM sessions s WHERE s.lifecycle <> 'deleted' AND (EXISTS (SELECT 1 FROM preferred p WHERE p.id = s.id)
        OR s.activity IN ('working', 'delegating') OR s.lifecycle IN ('starting', 'resident')
        OR EXISTS (SELECT 1 FROM actor_inputs i WHERE i.session_id = s.id)
        OR EXISTS (SELECT 1 FROM child_tasks t WHERE t.child_id = s.id AND t.state IN ('queued', 'submitted'))
        OR EXISTS (SELECT 1 FROM messages m WHERE m.target_id = s.id AND m.state IN ('queued', 'delivered')))
      ORDER BY navigator_rank, s.updated_at DESC, s.created_at DESC, s.id DESC LIMIT ?`).all(preferredJson, limit); queryCount += 1;
    const newestRows = this.#db.prepare(`SELECT *, 6 AS navigator_rank FROM sessions WHERE lifecycle <> 'deleted'
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit); queryCount += 1;
    const byId = new Map(); const candidates = [];
    for (const row of [...priorityRows, ...newestRows]) if (!byId.has(row.id)) { byId.set(row.id, row); candidates.push(row); }

    const candidateJson = JSON.stringify(candidates.map((row) => row.id));
    // Shared ancestors expand once per (id, hops), before final row deduplication.
    const contextRows = this.#db.prepare(`WITH RECURSIVE parent_chain(id, hops) AS (
        SELECT parent_session_id, 1 FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND parent_session_id IS NOT NULL
        UNION
        SELECT s.parent_session_id, p.hops + 1 FROM sessions s JOIN parent_chain p ON s.id = p.id
          WHERE s.parent_session_id IS NOT NULL AND p.hops < ?
      )
      SELECT DISTINCT s.* FROM sessions s JOIN parent_chain p ON p.id = s.id
      WHERE s.lifecycle <> 'deleted' ORDER BY s.depth, s.created_at, s.id LIMIT ?`)
      .all(candidateJson, MAX_NAVIGATOR_ANCESTOR_DEPTH, limit * MAX_NAVIGATOR_ANCESTOR_DEPTH); queryCount += 1;
    for (const row of contextRows) if (!byId.has(row.id)) byId.set(row.id, row);

    const newestReserve = Math.max(1, Math.floor(limit / 8));
    const orderedCandidates = []; const orderedIds = new Set();
    for (const row of [...newestRows.slice(0, newestReserve), ...priorityRows, ...newestRows]) {
      if (!orderedIds.has(row.id)) { orderedIds.add(row.id); orderedCandidates.push(row); }
    }
    const selectedIds = new Set();
    for (const candidate of orderedCandidates) {
      const chain = []; const seen = new Set(); let row = candidate;
      while (row && !seen.has(row.id) && chain.length <= MAX_NAVIGATOR_ANCESTOR_DEPTH) {
        seen.add(row.id); chain.unshift(row); row = row.parent_session_id ? byId.get(row.parent_session_id) : undefined;
      }
      const missing = chain.filter((item) => !selectedIds.has(item.id));
      if (selectedIds.size + missing.length <= limit) for (const item of missing) selectedIds.add(item.id);
      if (selectedIds.size === limit) break;
    }
    const selectedRows = [...selectedIds].map((id) => byId.get(id)).filter(Boolean)
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
    const selectedJson = JSON.stringify(selectedRows.map((row) => row.id));
    const workingCounts = this.#db.prepare(`WITH RECURSIVE working(descendant_id, ancestor_id, hops) AS (
        SELECT id, parent_session_id, 1 FROM (SELECT id, parent_session_id FROM sessions
          WHERE lifecycle <> 'deleted' AND activity = 'working' ORDER BY updated_at DESC, id LIMIT ?)
        WHERE parent_session_id IS NOT NULL
        UNION ALL
        SELECT w.descendant_id, s.parent_session_id, w.hops + 1 FROM working w JOIN sessions s ON s.id = w.ancestor_id
          WHERE s.parent_session_id IS NOT NULL AND w.hops < ?
      )
      SELECT ancestor_id, count(DISTINCT descendant_id) AS count FROM working
      WHERE ancestor_id IN (SELECT value FROM json_each(?)) GROUP BY ancestor_id`)
      .all(limit, MAX_NAVIGATOR_ANCESTOR_DEPTH, selectedJson); queryCount += 1;
    const counts = new Map(workingCounts.map((row) => [row.ancestor_id, Number(row.count)]));
    const sessions = selectedRows.map((row) => {
      const names = []; const seen = new Set(); let current = row;
      while (current && !seen.has(current.id) && names.length <= MAX_NAVIGATOR_ANCESTOR_DEPTH) {
        seen.add(current.id); names.unshift(current.display_name); current = current.parent_session_id ? byId.get(current.parent_session_id) : undefined;
      }
      return { ...mapSession({ ...row, working_descendant_count: counts.get(row.id) ?? 0 }, resolveFastModePreference(row.id, (id) => byId.get(id))), lineage: names.join("/") };
    });
    return { sessions, total, truncated: total > sessions.length,
      work: { queryCount, priorityRows: priorityRows.length, newestRows: newestRows.length,
        candidateRows: candidates.length, contextRows: contextRows.length, mappedRows: sessions.length, newestReserve } };
  }
  listChildren(parentId) {
    return this.#db.prepare(`SELECT s.id FROM sessions s JOIN children c ON c.session_id = s.id
      WHERE s.parent_session_id = ? AND s.lifecycle <> 'deleted' ORDER BY s.created_at, s.id`)
      .all(parentId).map((row) => this.#mappedSession(row.id));
  }

  resolveDirectChild(parentId, selector) {
    const rows = this.#db.prepare(`SELECT s.* FROM sessions s JOIN children c ON c.session_id = s.id
      WHERE s.parent_session_id = ? AND s.lifecycle <> 'deleted'`).all(parentId);
    const exact = rows.find((row) => row.id === selector || row.short_id === selector);
    if (exact) return this.#mappedSession(exact.id);
    const matches = rows.filter((row) => row.display_name === selector);
    if (matches.length === 0) throw new Error(`no direct child matches: ${selector}`);
    if (matches.length > 1) throw new Error(`child selector is ambiguous: ${selector}`);
    return this.#mappedSession(matches[0].id);
  }

  // Traverse tombstones too: older deletions could leave live grandchildren.
  getSessionSubtree(sessionId) {
    if (!this.#sessionRow(sessionId)) throw new Error("session does not exist");
    return this.#db.prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM sessions WHERE id = ?
      UNION SELECT s.id FROM sessions s JOIN subtree t ON s.parent_session_id = t.id
    ) SELECT s.id FROM sessions s JOIN subtree t ON t.id = s.id ORDER BY s.depth DESC, s.id`)
      .all(sessionId).map((row) => this.#mappedSession(row.id));
  }

  isSessionDeleting(sessionId) { return this.#deletingSessions.has(sessionId); }
  assertSessionAvailable(sessionId) {
    if (this.isSessionDeleting(sessionId)) {
      throw Object.assign(new Error("session subtree is being deleted"), { code: "session_deleting" });
    }
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
  }

  // The supervisor owns this synchronous fence across asynchronous actor shutdown.
  beginSessionDeletion(sessionId) {
    const sessions = this.getSessionSubtree(sessionId);
    if (sessions.some((session) => this.isSessionDeleting(session.sessionId))) {
      throw Object.assign(new Error("session subtree is already being deleted"), { code: "session_deleting" });
    }
    for (const session of sessions) this.#deletingSessions.add(session.sessionId);
    return sessions;
  }
  endSessionDeletion(sessions) {
    for (const session of sessions) this.#deletingSessions.delete(session.sessionId);
  }

  deleteChild(parentId, selector, now = Date.now()) {
    const child = this.resolveDirectChild(parentId, selector);
    return this.deleteSession(child.sessionId, now);
  }

  deleteSession(sessionId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const sessions = this.getSessionSubtree(sessionId);
      const selected = this.getSession(sessionId);
      if (selected.kind === "root") {
        let scratch;
        try { scratch = this.getRootScratch(sessionId); } catch {}
        if (scratch?.state === "ready") this.setRootScratch(sessionId, { ...scratch, state: "deleting" });
      }
      const tombstone = this.#db.prepare(`UPDATE sessions SET display_name = display_name || '-deleted-' || short_id,
        lifecycle = 'deleted', actor_token = '', actor_pid = NULL, actor_identity_json = NULL,
        streaming = 0, activity = 'inactive', quiet_since = NULL, last_error = NULL,
        deleted_at = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND lifecycle <> 'deleted'`);
      for (const session of sessions) {
        this.#db.prepare("DELETE FROM actor_inputs WHERE session_id = ?").run(session.sessionId);
        this.#terminalizeSessionWork(session.sessionId, now);
        tombstone.run(now, now, now, session.sessionId);
      }
      this.#refreshAncestors(sessionId, now);
      this.#db.exec("COMMIT");
      return this.#mappedSession(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  findIdleResidentActor(excludeId = null, { kind, excludeIds = [] } = {}) {
    const row = this.#db.prepare(`SELECT id FROM sessions WHERE lifecycle = 'resident' AND streaming = 0
      AND quiet_since IS NOT NULL AND id <> ? AND (? IS NULL OR kind = ?)
      AND id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM actor_inputs WHERE session_id = sessions.id)
      AND NOT EXISTS (SELECT 1 FROM child_tasks WHERE child_id = sessions.id AND state IN ('queued', 'submitted'))
      AND NOT EXISTS (SELECT 1 FROM messages WHERE target_id = sessions.id AND state IN ('queued', 'delivered'))
      ORDER BY quiet_since, created_at, id LIMIT 1`)
      .get(excludeId ?? "", kind ?? null, kind ?? null, JSON.stringify(excludeIds));
    return row ? this.#mappedSession(row.id) : undefined;
  }

  findIdleResidentChild(excludeId = null) { return this.findIdleResidentActor(excludeId, { kind: "child" }); }

  getChildTask(taskId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE id = ?").get(taskId)); }
  nextQueuedChildTask(childId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE child_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1").get(childId)); }
  submittedChildTask(childId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE child_id = ? AND state = 'submitted' ORDER BY submitted_at, id LIMIT 1").get(childId)); }
  markChildTaskSubmitted(taskId, now = Date.now()) {
    const result = this.#db.prepare("UPDATE child_tasks SET state = 'submitted', submitted_at = ? WHERE id = ? AND state = 'queued'").run(now, taskId);
    if (result.changes !== 1) throw new Error("child task is not queued");
    return this.getChildTask(taskId);
  }
  completeSubmittedChildTask(childId, error = null, now = Date.now()) {
    const task = this.submittedChildTask(childId);
    if (!task) return undefined;
    this.#db.prepare("UPDATE child_tasks SET state = ?, completed_at = ?, error = ? WHERE id = ?")
      .run(error ? "failed" : "completed", now, error, task.taskId);
    return this.getChildTask(task.taskId);
  }

  recordSessionLastError(sessionId, generation, error, now = Date.now()) {
    if (typeof error !== "string" || !error) return false;
    const result = this.#db.prepare(`UPDATE sessions SET last_error = ?, updated_at = ?
      WHERE id = ? AND actor_generation = ? AND lifecycle <> 'deleted'`).run(error, now, sessionId, generation);
    return result.changes === 1;
  }

  listPendingChildCreationHistory(parentId, limit = 100) {
    return this.#db.prepare(`SELECT t.id AS task_id, t.child_id, t.history_peer_name, t.prompt, t.created_at
      FROM child_tasks t JOIN sessions child ON child.id = t.child_id
      WHERE child.parent_session_id = ? AND t.history_entry_id IS NULL
      ORDER BY t.created_at, t.id LIMIT ?`).all(parentId, limit).map((row) => ({
      taskId: row.task_id, childId: row.child_id, childName: row.history_peer_name,
      relationship: "child", body: row.prompt, createdAt: row.created_at,
    }));
  }

  recordChildCreationEntry(parentId, { taskId, childId, childName, relationship, entryId, body }, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(`SELECT t.*, child.parent_session_id, child.kind AS child_kind
        FROM child_tasks t JOIN sessions child ON child.id = t.child_id
        WHERE t.id = ? AND t.child_id = ?`).get(taskId, childId);
      if (!row || row.parent_session_id !== parentId || row.child_kind !== "child") throw new Error("child creation task does not belong to this parent");
      if (row.kind !== "initial" || row.prompt !== body || row.history_peer_name !== childName || relationship !== "child") {
        throw new Error("child creation history entry does not match its durable task");
      }
      if (row.history_entry_id && row.history_entry_id !== entryId) throw new Error("child creation already has a different transcript entry");
      let newlyRecorded = false;
      if (!row.history_entry_id) {
        this.#db.prepare("UPDATE child_tasks SET history_entry_id = ? WHERE id = ? AND history_entry_id IS NULL")
          .run(entryId, taskId);
        newlyRecorded = true;
      }
      const updated = this.#db.prepare("SELECT * FROM child_tasks WHERE id = ?").get(taskId);
      this.#db.exec("COMMIT");
      return { task: mapTask(updated), newlyRecorded };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  setSessionSkillGrant(sessionId, skills, now = Date.now()) {
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    if (!Array.isArray(skills) || skills.length > 128) throw new Error("skill grant must contain at most 128 skills");
    if (session.kind === "child") {
      const parentGrant = this.getSessionSkillGrant(session.parent_session_id);
      if (!parentGrant) throw new Error("immediate parent skill grant is unavailable");
      const allowed = new Map(parentGrant.skills.map((skill) => [skill.id, skill]));
      for (const skill of skills) {
        const expected = allowed.get(skill.id);
        if (!expected || expected.version !== skill.version || expected.contentHash !== skill.contentHash
          || expected.skillPath !== skill.skillPath || expected.pythonBacked !== skill.pythonBacked) {
          throw new Error(`child skill grant exceeds or differs from immediate parent: ${skill.id}`);
        }
      }
    }
    this.#db.prepare(`INSERT INTO session_skill_grants(session_id, manifest_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`)
      .run(sessionId, JSON.stringify(skills), now);
    return { version: 1, skills, updatedAt: now };
  }

  getSessionSkillGrantContext(sessionId) {
    const row = this.#db.prepare("SELECT lifecycle, session_file, kind, parent_session_id FROM sessions WHERE id = ?").get(sessionId);
    if (!row) return undefined;
    return { lifecycle: row.lifecycle, sessionFile: row.session_file, kind: row.kind, parentSessionId: row.parent_session_id };
  }

  getSessionSkillGrant(sessionId) {
    const row = this.#db.prepare("SELECT manifest_json, updated_at FROM session_skill_grants WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    return { version: 1, skills: parseJson(row.manifest_json, []), updatedAt: row.updated_at };
  }

  recordUsage(sessionId, usage, now = Date.now()) { return this.#usage.recordUsage(sessionId, usage, now); }
  recordContextUsage(sessionId, usage, now = Date.now()) { return this.#usage.recordContextUsage(sessionId, usage, now); }
  getSessionTelemetry(sessionId) { return this.#usage.getSessionTelemetry(sessionId); }
  getUsageSummary() { return this.#usage.getUsageSummary(); }
  getUsageWindow(windowMinutes, observedAt = Date.now()) { return this.#usage.getUsageWindow(windowMinutes, observedAt); }
  getOperationalCounts() { return this.#usage.getOperationalCounts(); }
  diagnose() { return this.#usage.diagnose(); }

  createActorInput(sessionId, { inputId = randomUUID(), message, images = [], location, behavior = "auto", source = "user",
    origin = null, clientMessageId = null, retryIntent = null, pendingLimit = 100, pendingBytesLimit = MAX_PENDING_INPUT_BYTES_PER_SESSION,
    globalPendingBytesLimit = MAX_PENDING_INPUT_BYTES_GLOBAL }, now = Date.now()) {
    this.assertSessionAvailable(sessionId);
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    const provenance = normalizeInputProvenance(source, origin);
    const retryIntentJson = normalizeRetryIntent(retryIntent);
    if (retryIntent && behavior !== "auto") throw new Error("retry input behavior must be auto");
    if (clientMessageId !== null && (typeof clientMessageId !== "string" || !clientMessageId.length || clientMessageId.length > 128)) {
      throw new Error("clientMessageId must be a non-empty string of at most 128 characters");
    }
    location = normalizeInputLocation(location);
    if (location !== undefined && source !== "user") throw new Error("location requires a genuine user input");
    const locationJson = location === undefined ? null : JSON.stringify(location);
    const imagesJson = JSON.stringify(images); const digest = actorInputDigest(message, imagesJson, behavior, location);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ?").get(inputId);
      if (receipt) {
        if (receipt.session_id !== sessionId || receipt.digest !== digest || receipt.retry_intent_json !== retryIntentJson
          || (receipt.source !== null && (receipt.source !== source || receipt.origin_json !== provenance.originJson))
          || (receipt.client_message_id !== null && clientMessageId !== null && receipt.client_message_id !== clientMessageId)) {
          throw new Error("actor input id was reused with different input");
        }
        // A supervisor job replay can restore missing legacy metadata from its actual origin.
        if (receipt.source === null && source !== "user") {
          this.#db.prepare("UPDATE actor_input_receipts SET source = ?, origin_json = ? WHERE id = ?")
            .run(source, provenance.originJson, inputId);
        }
        if (receipt.client_message_id === null && clientMessageId !== null) {
          this.#db.prepare("UPDATE actor_input_receipts SET client_message_id = ? WHERE id = ?").run(clientMessageId, inputId);
        }
        const result = this.getActorInput(inputId, sessionId);
        this.#db.exec("COMMIT");
        return result.state === "completed" ? { ...result, message, images, behavior, ...(location === undefined ? {} : { location }) } : result;
      }
      const pending = Number(this.#db.prepare("SELECT count(*) AS count FROM actor_inputs WHERE session_id = ?").get(sessionId).count);
      if (pending >= pendingLimit) throw new Error("target pending user-input limit exceeded");
      const payloadBytes = Buffer.byteLength(message, "utf8") + Buffer.byteLength(imagesJson, "utf8") + Buffer.byteLength(locationJson ?? "", "utf8");
      const sessionBytes = Number(this.#db.prepare("SELECT coalesce(sum(length(CAST(body AS BLOB)) + length(CAST(images_json AS BLOB)) + coalesce(length(CAST(location_json AS BLOB)), 0)), 0) AS bytes FROM actor_inputs WHERE session_id = ?").get(sessionId).bytes);
      const globalBytes = Number(this.#db.prepare("SELECT coalesce(sum(length(CAST(body AS BLOB)) + length(CAST(images_json AS BLOB)) + coalesce(length(CAST(location_json AS BLOB)), 0)), 0) AS bytes FROM actor_inputs").get().bytes);
      if (sessionBytes + payloadBytes > pendingBytesLimit) throw new Error("target pending user-input byte limit exceeded");
      if (globalBytes + payloadBytes > globalPendingBytesLimit) throw new Error("global pending user-input byte limit exceeded");
      this.#db.prepare(`INSERT INTO actor_input_receipts(id, session_id, digest, created_at, sequence, source, origin_json, client_message_id, retry_intent_json)
        VALUES (?, ?, ?, ?, (SELECT coalesce(max(sequence), 0) + 1 FROM actor_input_receipts), ?, ?, ?, ?)`)
        .run(inputId, sessionId, digest, now, source, provenance.originJson, clientMessageId, retryIntentJson);
      this.#db.prepare("INSERT INTO actor_inputs(id, session_id, body, images_json, location_json, digest, behavior, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
        .run(inputId, sessionId, message, imagesJson, locationJson, digest, behavior, now);
      this.recordSessionActivity(sessionId, now);
      const result = this.getActorInput(inputId, sessionId);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  matchActorInputRequest(sessionId, { inputId, message, images, location, behavior = "auto", retryIntent = null, clientMessageId = null }) {
    const retryIntentJson = normalizeRetryIntent(retryIntent);
    if (retryIntent && behavior !== "auto") throw new Error("retry input behavior must be auto");
    if (retryIntent?.mode === "original" && (message !== undefined || images !== undefined || location !== undefined)) {
      throw new Error("original retry request must omit message, images, and location");
    }
    if (inputId === undefined) return undefined;
    const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ?").get(inputId);
    if (!receipt) return undefined;
    const explicit = retryIntent?.mode !== "original";
    if (receipt.session_id !== sessionId || receipt.retry_intent_json !== retryIntentJson
      || (receipt.client_message_id !== null && clientMessageId !== null && receipt.client_message_id !== clientMessageId)
      || (explicit && (receipt.digest !== actorInputDigest(message, JSON.stringify(images ?? []), behavior, location)
        || (receipt.source !== null && receipt.source !== "user")))) {
      throw new Error("actor input id was reused with different input");
    }
    return this.getActorInput(inputId, sessionId);
  }

  getActorInput(inputId, sessionId, { includeDigest = false } = {}) {
    const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
    if (!receipt) return undefined;
    const pending = this.#db.prepare("SELECT * FROM actor_inputs WHERE id = ? AND session_id = ?").get(inputId, sessionId);
    return mapActorInput(receipt, pending, { includeDigest });
  }

  listActorInputReceipts(sessionId, { inputIds = null, limit = 1000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("receipt limit must be from 1 through 10000");
    if (inputIds !== null && (!Array.isArray(inputIds) || inputIds.length > 10000 || inputIds.some((id) => typeof id !== "string"))) {
      throw new Error("inputIds must be an array of at most 10000 strings");
    }
    return (inputIds === null
      ? this.#db.prepare("SELECT * FROM actor_input_receipts WHERE session_id = ? ORDER BY sequence DESC LIMIT ?").all(sessionId, limit).reverse()
      : this.#db.prepare("SELECT * FROM actor_input_receipts WHERE session_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence LIMIT ?")
        .all(sessionId, JSON.stringify(inputIds), limit)).map(mapActorInputReceipt);
  }

  hasPendingActorInputs(sessionId) {
    return Boolean(this.#db.prepare(`SELECT 1 FROM actor_inputs i JOIN actor_input_receipts r
      ON r.id = i.id AND r.session_id = i.session_id WHERE i.session_id = ? LIMIT 1`).get(sessionId));
  }

  #pendingActorInputs(sessionId, inputIds = null) {
    // Keep additive fields optional for read-only legacy schemas. The receipt,
    // not the pending payload, owns acceptance time and ordering.
    const rows = this.#db.prepare(`SELECT i.*, r.*, r.created_at AS receipt_created_at
      FROM actor_inputs i JOIN actor_input_receipts r ON r.id = i.id AND r.session_id = i.session_id
      WHERE i.session_id = ? ${inputIds === null ? "" : "AND i.id IN (SELECT value FROM json_each(?))"}
      ORDER BY r.sequence`).iterate(...(inputIds === null ? [sessionId] : [sessionId, JSON.stringify(inputIds)]));
    return Array.from(rows, (row) => mapActorInput({ ...row, created_at: row.receipt_created_at }, row));
  }

  listPendingActorInputs(sessionId) { return this.#pendingActorInputs(sessionId); }

  setActorInputWakeError(sessionId, generation = null) {
    if (generation !== null && (!Number.isSafeInteger(generation) || generation < 1)) throw new Error("invalid actor generation");
    const update = `UPDATE actor_inputs SET wake_error_generation = ?
      WHERE session_id = ? AND wake_error_generation IS NOT ?`;
    if (generation !== null) {
      this.#db.prepare(update).run(generation, sessionId, generation);
      // Repeated failure publication still returns the complete pending queue.
      return this.listPendingActorInputs(sessionId);
    }
    const changed = this.#db.prepare(`${update} RETURNING id`).all(generation, sessionId, generation);
    if (changed.length === 0) return [];
    return this.#pendingActorInputs(sessionId, changed.map((row) => row.id))
      .filter((input) => input.delivery.state === "accepted");
  }

  markActorInputAccepted(inputId, sessionId, generation, now = Date.now()) {
    this.#db.prepare("UPDATE actor_inputs SET state = 'accepted', accepted_at = coalesce(accepted_at, ?), accepted_generation = ? WHERE id = ? AND session_id = ?")
      .run(now, generation, inputId, sessionId);
    // Context admission can finish before the RPC preflight acknowledgement arrives.
    const input = this.getActorInput(inputId, sessionId);
    if (!input) throw new Error("actor input does not exist");
    return input;
  }

  completeActorInput(inputId, sessionId, now = Date.now(), entryId = null) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
      if (!receipt) { this.#db.exec("COMMIT"); return false; }
      if (receipt.handled_at !== null) throw new Error("input was handled without a model message");
      if (receipt.delivered_entry_id && entryId && receipt.delivered_entry_id !== entryId) throw new Error("input has a different delivered entry");
      const changed = receipt.delivered_at === null;
      this.#db.prepare(`UPDATE actor_input_receipts SET delivered_at = coalesce(delivered_at, ?),
        delivered_entry_id = coalesce(delivered_entry_id, ?) WHERE id = ? AND session_id = ?`)
        .run(Math.max(now, receipt.created_at), entryId, inputId, sessionId);
      this.#db.prepare("DELETE FROM actor_inputs WHERE id = ? AND session_id = ?").run(inputId, sessionId);
      if (changed) this.recordSessionActivity(sessionId, now);
      this.#db.exec("COMMIT");
      return changed;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  markActorInputHandled(inputId, sessionId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
      if (!receipt) throw new Error("actor input does not exist");
      if (receipt.source !== null && receipt.source !== "user") throw new Error("only a user control input can be handled without a model message");
      if (receipt.delivered_at !== null) throw new Error("input was already delivered to model context");
      const changed = receipt.handled_at === null;
      this.#db.prepare("UPDATE actor_input_receipts SET handled_at = coalesce(handled_at, ?) WHERE id = ? AND session_id = ?")
        .run(Math.max(now, receipt.created_at), inputId, sessionId);
      this.#db.prepare("DELETE FROM actor_inputs WHERE id = ? AND session_id = ?").run(inputId, sessionId);
      if (changed) this.recordSessionActivity(sessionId, now);
      const input = this.getActorInput(inputId, sessionId);
      this.#db.exec("COMMIT"); return input;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordSessionActivity(sessionId, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("activity timestamp must be nonnegative integer milliseconds");
    return this.#db.prepare(`UPDATE sessions SET last_activity_at = ?
      WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`)
      .run(now, sessionId, now).changes === 1;
  }

  listSearchableSessions(callerId, { includeDeleted = false, includeSelf = false, includeFastMode = true } = {}) {
    const caller = this.#sessionRow(callerId);
    if (!caller || caller.lifecycle === "deleted") throw new Error("caller session does not exist");
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE family_id = ? AND session_file IS NOT NULL")
      .all(caller.family_id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const historicalName = (row) => {
      const suffix = `-deleted-${row.short_id}`;
      return row.lifecycle === "deleted" && row.display_name.endsWith(suffix)
        ? row.display_name.slice(0, -suffix.length) : row.display_name;
    };
    const lineage = (row) => {
      const names = [historicalName(row)]; const seen = new Set([row.id]); let current = row;
      while (current.parent_session_id) {
        current = byId.get(current.parent_session_id);
        if (!current || seen.has(current.id)) break;
        seen.add(current.id); names.unshift(historicalName(current));
      }
      return names.join("/");
    };
    return rows.filter((row) => (includeDeleted || row.lifecycle !== "deleted")
      && (includeSelf || row.id !== caller.id))
      .map((row) => ({ ...mapSession(row, includeFastMode ? this.getSessionFastModePreference(row.id) : undefined), name: historicalName(row), lineage: lineage(row) }))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
  }

  getRoster(callerId) {
    const rows = this.#db.prepare(`SELECT id, short_id, display_name, kind, depth,
      parent_session_id, family_id, activity, lifecycle, cwd, repository_root
      FROM sessions WHERE lifecycle <> 'deleted'`).all();
    const caller = rows.find((row) => row.id === callerId);
    if (!caller) throw new Error("caller session does not exist");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const lineage = (row) => {
      const names = [row.display_name];
      const seen = new Set([row.id]);
      let current = row;
      while (current.parent_session_id) {
        current = byId.get(current.parent_session_id);
        if (!current || seen.has(current.id)) break;
        seen.add(current.id);
        names.unshift(current.display_name);
      }
      return names.join("/");
    };
    return rows.filter((row) => row.family_id === caller.family_id && relationshipBetween(caller, row)).map((row) => ({
      sessionId: row.id, shortId: row.short_id, name: row.display_name, kind: row.kind, depth: Number(row.depth),
      lineage: lineage(row), relationship: relationshipBetween(caller, row), activity: row.activity,
      lifecycle: row.lifecycle, cwd: row.cwd, repositoryRoot: row.repository_root,
      workingDescendantCount: this.#workingDescendantCount(row.id),
    })).sort((left, right) => {
      if (left.relationship === "self" && right.relationship !== "self") return -1;
      if (right.relationship === "self" && left.relationship !== "self") return 1;
      return activityRank(left.activity) - activityRank(right.activity)
        || left.name.localeCompare(right.name) || left.sessionId.localeCompare(right.sessionId);
    });
  }

  #resolveReachableTarget(senderId, selector) {
    const sender = this.#sessionRow(senderId);
    if (!sender || sender.lifecycle === "deleted") throw new Error("sender session does not exist");
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE family_id = ? AND lifecycle <> 'deleted'").all(sender.family_id);
    const exact = rows.find((row) => row.id === selector || row.short_id === selector);
    if (exact) {
      const relationship = relationshipBetween(sender, exact);
      if (relationship === "self") throw new Error("cannot send a message to the same session");
      if (!relationship) throw new Error("target is outside permitted family reach");
      return { target: exact, relationship };
    }
    const matches = rows.filter((row) => row.display_name === selector && relationshipBetween(sender, row) !== undefined);
    if (matches.length === 0) throw new Error(`no reachable target matches: ${selector}`);
    if (matches.length > 1) throw new Error(`target name is ambiguous; use a stable ID: ${selector}`);
    const relationship = relationshipBetween(sender, matches[0]);
    if (relationship === "self") throw new Error("cannot send a message to the same session");
    return { target: matches[0], relationship };
  }

  createMessage(senderId, params, { pendingLimit = 100, now = Date.now() } = {}) {
    if (!["auto", "follow_up"].includes(params.deliveryMode ?? "auto")) throw new Error("invalid family delivery mode");
    if (params.messageId?.startsWith("child-exit:")) throw new Error("message ID is reserved for supervisor lifecycle receipts");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const { target, relationship } = this.#resolveReachableTarget(senderId, params.target);
      this.assertSessionAvailable(senderId);
      this.assertSessionAvailable(target.id);
      const id = params.messageId ?? randomUUID();
      const existing = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      if (existing) {
        // Legacy family mode is receipt metadata, not a different operation.
        if (existing.sender_id !== senderId || existing.target_id !== target.id
          || existing.body !== params.body) {
          throw new Error(`message ID already exists with different content: ${id}`);
        }
        this.#db.exec("COMMIT");
        return mapMessage(existing);
      }
      const pending = Number(this.#db.prepare(`SELECT count(*) AS count FROM messages
        WHERE target_id = ? AND state IN ('accepted', 'queued', 'delivered')`).get(target.id).count);
      if (pending >= pendingLimit) throw new Error(`target pending-message limit reached: ${pendingLimit}`);
      this.#db.prepare(`INSERT INTO messages (id, sender_id, target_id, relationship, delivery_mode, body,
        state, attempt_count, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?)`)
        .run(id, senderId, target.id, relationship, "auto", params.body, now);
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      this.#db.exec("COMMIT");
      return mapMessage(row);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordMessageSenderEntry(senderId, { messageId, entryId, peerId, relationship, body }, now = Date.now()) {
    this.assertSessionAvailable(senderId);
    this.assertSessionAvailable(peerId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND sender_id = ?").get(messageId, senderId);
      if (!row) throw new Error("message does not exist for this sender");
      if (row.target_id !== peerId || row.relationship !== relationship || row.body !== body) {
        throw new Error("agent message transcript entry does not match its durable message");
      }
      if (row.sender_entry_id && row.sender_entry_id !== entryId) throw new Error("message already has a different transcript entry");
      let newlyQueued = false;
      if (!row.sender_entry_id) {
        if (row.state !== "accepted") throw new Error(`message cannot record its sender entry from state ${row.state}`);
        this.#db.prepare("UPDATE messages SET sender_entry_id = ?, state = 'queued', queued_at = ? WHERE id = ?")
          .run(entryId, now, messageId);
        newlyQueued = true;
      }
      const updated = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return { message: mapMessage(updated), newlyQueued };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  listMessagesAwaitingSenderEntry(senderId, limit = 100) {
    return this.#db.prepare("SELECT * FROM messages WHERE sender_id = ? AND state = 'accepted' ORDER BY accepted_at, id LIMIT ?")
      .all(senderId, limit).map(mapMessage);
  }

  listWaitingIncomingMessages(targetId, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid waiting message limit");
    return this.#db.prepare("SELECT * FROM messages WHERE target_id = ? AND state IN ('accepted', 'queued', 'delivered') ORDER BY accepted_at, id LIMIT ?")
      .all(targetId, limit).map(mapMessage);
  }

  listPendingMessages(targetId) {
    return this.#db.prepare("SELECT * FROM messages WHERE target_id = ? AND state IN ('queued', 'delivered') ORDER BY accepted_at, id")
      .all(targetId).map(mapMessage);
  }

  markMessageDelivered(messageId, targetId, now = Date.now(), maxAttempts = 5) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND target_id = ?").get(messageId, targetId);
      if (!row || !["queued", "delivered"].includes(row.state)) { this.#db.exec("COMMIT"); return undefined; }
      if (row.state === "delivered") { this.#db.exec("COMMIT"); return mapMessage(row); }
      if (row.attempt_count >= maxAttempts) {
        this.#db.prepare("UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = ? WHERE id = ?")
          .run(`delivery attempt limit reached: ${maxAttempts}`, now, messageId);
        const rejected = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
        this.#db.exec("COMMIT");
        return { ...mapMessage(rejected), permanentlyFailed: true };
      }
      this.#db.prepare(`UPDATE messages SET state = 'delivered', attempt_count = attempt_count + 1,
        delivered_at = ?, last_error = NULL WHERE id = ?`).run(now, messageId);
      const delivered = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return mapMessage(delivered);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  acknowledgeMessage(messageId, targetId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND target_id = ?").get(messageId, targetId);
      if (!row) throw new Error("message does not exist for this target");
      if (row.state === "acknowledged") { this.#db.exec("COMMIT"); return mapMessage(row); }
      if (row.state !== "delivered") throw new Error(`message cannot be acknowledged from state ${row.state}`);
      this.#db.prepare("UPDATE messages SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?").run(now, messageId);
      const updated = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return mapMessage(updated);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  getMessage(messageId) { return mapMessage(this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId)); }
  listMessages() { return this.#db.prepare("SELECT * FROM messages ORDER BY accepted_at, id").all().map(mapMessage); }
  close() { this.#db.close(); }
}
