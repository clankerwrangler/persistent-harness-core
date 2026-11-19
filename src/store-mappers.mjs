import { normalizeInputLocation } from "./input-location.mjs";

export const MAX_NAVIGATOR_ANCESTOR_DEPTH = 64;

export function parseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Resolve only actual parent edges. Shared family labels are not root identities.
// The bound matches the navigator's ancestor snapshot; partial ancestry is unknown.
export function resolveFastModePreference(sessionId, readRow) {
  const unknown = { fastMode: null, fastModeRootSessionId: null };
  const seen = new Set();
  let id = sessionId, expectedDepth = null;
  for (let hops = 0; hops <= MAX_NAVIGATOR_ANCESTOR_DEPTH; hops += 1) {
    if (seen.has(id)) return unknown;
    seen.add(id);
    const row = readRow(id);
    if (!row || row.id !== id || row.lifecycle === "deleted" || !Number.isSafeInteger(row.depth)
      || row.depth < 0 || row.depth > MAX_NAVIGATOR_ANCESTOR_DEPTH
      || (expectedDepth !== null && row.depth !== expectedDepth)) return unknown;
    if (row.kind === "root") {
      if (row.depth !== 0 || row.parent_session_id !== null) return unknown;
      const launch = parseJson(row.launch_json);
      let fastMode = null;
      if (launch !== null && typeof launch === "object" && !Array.isArray(launch)) {
        // Retained pre-feature roots default off without rewriting their launch state.
        if (!Object.hasOwn(launch, "fastMode")) fastMode = false;
        else if (typeof launch.fastMode === "boolean") fastMode = launch.fastMode;
      }
      return { fastMode, fastModeRootSessionId: row.id };
    }
    if (row.kind !== "child" || row.depth === 0 || typeof row.parent_session_id !== "string" || !row.parent_session_id) return unknown;
    expectedDepth = row.depth - 1;
    id = row.parent_session_id;
  }
  return unknown;
}

export function publicLaunch(value, preference) {
  const launch = typeof value === "string" ? parseJson(value) : value;
  if (!launch) return null;
  return {
    model: launch.model,
    thinking: launch.thinking,
    pendingInference: launch.pendingInference ?? null,
    ...preference,
    fastModeSupported: typeof launch.fastModeSupported === "boolean" ? launch.fastModeSupported : null,
    ...(launch.contextFork ? { contextFork: launch.contextFork } : {}),
    capabilityIds: Array.isArray(launch.capabilities) ? launch.capabilities.map((item) => item.id) : [],
  };
}

export function turnFailureBoundary(turnFailure) {
  return turnFailure.dispatchBoundary === "before_provider_dispatch"
    ? "This turn stopped before provider dispatch. Local input or extension effects may already be committed."
    : turnFailure.dispatchBoundary === "tool_effects_possible"
      ? "Tool execution was admitted or started in this turn; external effects may already have occurred. Completion is unknown."
      : "Provider dispatch was attempted in this turn; completion and external effects are unknown.";
}

export function mapSession(row, preference) {
  if (!row) return undefined;
  return {
    sessionId: row.id,
    shortId: row.short_id,
    sessionFile: row.session_file,
    cwd: row.cwd,
    repositoryRoot: row.repository_root,
    name: row.display_name,
    kind: row.kind,
    familyId: row.family_id,
    parentSessionId: row.parent_session_id,
    depth: Number(row.depth),
    activity: row.activity,
    lifecycle: row.lifecycle,
    actorGeneration: Number(row.actor_generation),
    actorPid: row.actor_pid == null ? null : Number(row.actor_pid),
    actorIdentity: parseJson(row.actor_identity_json),
    quietSince: row.quiet_since,
    lastError: row.last_error,
    launch: publicLaunch(row.launch_json, preference),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? row.created_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    workingDescendantCount: Number(row.working_descendant_count ?? 0),
  };
}

export function mapMessage(row) {
  if (!row) return undefined;
  return {
    messageId: row.id,
    senderId: row.sender_id,
    targetId: row.target_id,
    relationship: row.relationship,
    deliveryMode: row.delivery_mode,
    body: row.body,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    acceptedAt: row.accepted_at,
    queuedAt: row.queued_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    lastError: row.last_error ?? null,
    senderEntryId: row.sender_entry_id ?? null,
    ...(row.child_exit_generation != null ? { childExitGeneration: Number(row.child_exit_generation) } : {}),
  };
}

export function normalizeInputProvenance(source, origin) {
  if (!["user", "cron", "background"].includes(source)) throw new Error("input source must be user, cron, or background");
  if (source === "user") {
    if (origin !== null) throw new Error("user input must not carry an internal origin");
    return { originJson: null };
  }
  const fields = source === "cron" ? ["jobId", "runId"] : ["jobId"];
  if (!origin || typeof origin !== "object" || Array.isArray(origin)
    || Object.keys(origin).some((key) => !fields.includes(key))
    || fields.some((key) => typeof origin[key] !== "string" || !origin[key].length || origin[key].length > 128)) {
    throw new Error("internal input requires an authenticated job origin");
  }
  return { originJson: JSON.stringify(Object.fromEntries(fields.map((key) => [key, origin[key]]))) };
}

export function normalizeRetryIntent(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["targetId", "mode"].includes(key))
    || typeof value.targetId !== "string" || !value.targetId || value.targetId.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.targetId) || !["original", "explicit"].includes(value.mode)) {
    throw new Error("retryIntent must contain a bounded targetId and original or explicit mode");
  }
  return JSON.stringify({ targetId: value.targetId, mode: value.mode });
}

export function mapActorInputReceipt(row) {
  const acceptedAt = Number(row.created_at), deliveredAt = row.delivered_at == null ? null : Number(row.delivered_at);
  return { inputId: row.id, sessionId: row.session_id, sequence: Number(row.sequence),
    createdAt: acceptedAt, acceptedAt, deliveredAt, entryId: row.delivered_entry_id ?? null,
    outcome: row.handled_at == null ? "accepted" : "handled", handledAt: row.handled_at ?? null,
    source: row.source ?? null, origin: parseJson(row.origin_json), retryIntent: parseJson(row.retry_intent_json),
    ...(row.client_message_id === null ? {} : { clientMessageId: row.client_message_id }),
    delivery: { state: deliveredAt === null ? "accepted" : "delivered", inputId: row.id,
      acceptedAt: new Date(acceptedAt).toISOString(), deliveredAt: deliveredAt === null ? null : new Date(deliveredAt).toISOString() } };
}

export function mapActorInput(receipt, pending, { includeDigest = false } = {}) {
  const receiptValue = mapActorInputReceipt(receipt);
  if (pending?.wake_error_generation != null && receiptValue.delivery.state === "accepted") receiptValue.delivery.retryableError = {
    code: "actor_wake_failed", generation: Number(pending.wake_error_generation),
    message: "Message saved. The agent could not receive it. Retry sending." };
  return { ...receiptValue, ...(includeDigest ? { digest: receipt.digest } : {}), state: pending?.state ?? "completed",
    transportAcceptedAt: pending?.accepted_at ?? null,
    acceptedGeneration: pending?.accepted_generation == null ? null : Number(pending.accepted_generation),
    ...(pending ? { message: pending.body, images: parseJson(pending.images_json, []), behavior: pending.behavior,
      ...(pending.location_json == null ? {} : { location: normalizeInputLocation(JSON.parse(pending.location_json)) }) } : {}) };
}

export function mapTask(row) {
  if (!row) return undefined;
  return {
    taskId: row.id,
    childId: row.child_id,
    kind: row.kind,
    prompt: row.prompt,
    state: row.state,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    error: row.error,
    historyPeerName: row.history_peer_name ?? null,
    historyEntryId: row.history_entry_id ?? null,
  };
}

export function relationshipBetween(sender, target) {
  if (sender.id === target.id) return "self";
  if (sender.parent_session_id === target.id) return "parent";
  if (target.parent_session_id === sender.id) return "child";
  if (sender.kind === "root" && target.kind === "root" && sender.family_id === target.family_id) return "sibling";
  if (sender.parent_session_id && sender.parent_session_id === target.parent_session_id) return "sibling";
  return undefined;
}

export function activityRank(activity) {
  return { working: 0, delegating: 1, idle: 2, inactive: 3 }[activity] ?? 4;
}
