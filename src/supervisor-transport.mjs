import { birthOrder } from "./conversation-birth.mjs";
import { encodeFrame } from "./framing.mjs";
import { MAX_FRAME_BYTES, errorResponse, event, normalizeProgressHeading } from "./protocol.mjs";

const SOCKET_OUTPUT_HEADROOM_BYTES = 256 * 1024;

export function socketOutputBufferLimit(maxFrameBytes = MAX_FRAME_BYTES) {
  // Reserve one full legal frame, including its newline, plus bounded small-frame traffic.
  return maxFrameBytes + 1 + SOCKET_OUTPUT_HEADROOM_BYTES;
}

export function requestFailure(code, message) { const error = new Error(message); error.code = code; return error; }

export function receiverRelationship(relationship) {
  if (relationship === "parent") return "child";
  if (relationship === "child") return "parent";
  return relationship;
}


// A frame that is not the live view, as clients are shown it: at most 32 KB.
export function boundedActorEvent(frame) {
  const projected = projectActorEvent(frame);
  if (!projected) return null;
  try { return Buffer.byteLength(JSON.stringify(projected)) <= 32 * 1024 ? projected : { type: projected.type ?? "unknown", truncated: true }; }
  catch { return { type: "unknown", truncated: true }; }
}

export function projectActorEvent(frame) {
  const type = typeof frame?.type === "string" ? frame.type : "unknown";
  if (type === "progress_entry") {
    const summary = normalizeProgressHeading(frame.summary);
    const createdAt = new Date(frame.createdAt);
    if (!summary || summary !== frame.summary || typeof frame.entryId !== "string" || !frame.entryId
      || frame.entryId.length > 128 || Number.isNaN(createdAt.valueOf())) return null;
    return { type, entryId: frame.entryId, summary, createdAt: createdAt.toISOString(), ...birthOrder(frame.harnessBirth) };
  }
  if (type === "agent_message_entry") {
    const createdAt = new Date(frame.createdAt);
    if (typeof frame.entryId !== "string" || !frame.entryId || frame.entryId.length > 128
      || typeof frame.messageId !== "string" || !frame.messageId || frame.messageId.length > 128
      || !["from", "to"].includes(frame.direction) || typeof frame.peerId !== "string" || !frame.peerId || frame.peerId.length > 128
      || typeof frame.peerName !== "string" || !frame.peerName || frame.peerName.length > 256
      || Buffer.byteLength(frame.peerName, "utf8") > 1024 || !["parent", "child", "sibling"].includes(frame.relationship)
      || typeof frame.body !== "string" || !frame.body || Buffer.byteLength(frame.body, "utf8") > 16 * 1024
      || Number.isNaN(createdAt.valueOf())) return null;
    return { type, entryId: frame.entryId, messageId: frame.messageId, direction: frame.direction,
      peerId: frame.peerId, peerName: frame.peerName, relationship: frame.relationship,
      body: frame.body, createdAt: createdAt.toISOString() };
  }
  if (type === "child_creation_entry") {
    const createdAt = new Date(frame.createdAt);
    if (typeof frame.entryId !== "string" || !frame.entryId || frame.entryId.length > 128
      || typeof frame.taskId !== "string" || !frame.taskId || frame.taskId.length > 128
      || typeof frame.childId !== "string" || !frame.childId || frame.childId.length > 128
      || typeof frame.childName !== "string" || !frame.childName || frame.childName.length > 256
      || Buffer.byteLength(frame.childName, "utf8") > 1024 || frame.relationship !== "child"
      || typeof frame.body !== "string" || !frame.body || Buffer.byteLength(frame.body, "utf8") > 32 * 1024
      || Number.isNaN(createdAt.valueOf())) return null;
    return { type, entryId: frame.entryId, taskId: frame.taskId, childId: frame.childId,
      childName: frame.childName, relationship: "child", body: frame.body, createdAt: createdAt.toISOString() };
  }
  if (type === "dialog_request") {
    const result = { type };
    for (const key of ["id", "requestId", "method", "title", "message", "placeholder", "prefill", "statusKey", "statusText", "notifyType"]) {
      if (typeof frame[key] === "string") result[key] = frame[key];
    }
    if (Number.isSafeInteger(frame.timeout) && frame.timeout >= 1 && frame.timeout <= 600_000) result.timeout = frame.timeout;
    if (Array.isArray(frame.options) && frame.options.every((item) => typeof item === "string")) result.options = frame.options.slice(0, 128);
    return result;
  }
  return { type };
}

export function boundedReplay(ring) {
  let selected = ring.slice(-128).map((item) => ({ seq: item.seq, event: item.event }));
  let bytes = selected.length > 1 ? Buffer.byteLength(JSON.stringify(selected)) : 0;
  while (selected.length > 1 && bytes > 40 * 1024) {
    // Public events are JSON-plain; removing a wrapper also removes one comma.
    bytes -= Buffer.byteLength(JSON.stringify(selected[0])) + 1;
    selected.shift();
  }
  return selected;
}

export function boundedEntries(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : []; let selected = entries.slice(-256);
  let bytes = selected.length ? Buffer.byteLength(JSON.stringify(selected)) : 0;
  while (selected.length && bytes > 48 * 1024) {
    const drop = Math.ceil(selected.length / 4);
    // JSON-plain worker rows make prefix-array bytes minus one the exact decrease.
    if (drop < selected.length) bytes -= Buffer.byteLength(JSON.stringify(selected.slice(0, drop))) - 1;
    selected = selected.slice(drop);
  }
  return { entries: selected, leafId: data?.leafId ?? null, truncated: selected.length < entries.length };
}

export function encodeSupervisorFrame(frame, maxFrameBytes) {
  try { return encodeFrame(frame, { maxFrameBytes }); }
  catch (error) {
    if (error?.code !== "frame_too_large") throw error;
    const fallback = frame.type === "response"
      ? errorResponse(frame.id, frame.requestType, new Error("response exceeds protocol frame limit"), "response_too_large")
      : event("frame_truncated", { originalType: frame.type, originalEvent: frame.event });
    return encodeFrame(fallback, { maxFrameBytes });
  }
}

export function broadcastFrame(recipients, frame, maxFrameBytes) {
  let attempted = false, encoded, encodingError;
  // Resolve inside writeSocketFrame's eligibility check; queues retain only the immutable bytes.
  const shared = () => {
    if (!attempted) {
      attempted = true;
      try { encoded = encodeSupervisorFrame(frame, maxFrameBytes); } catch (error) { encodingError = error; }
    }
    if (encoded === undefined) throw encodingError;
    return encoded;
  };
  for (const state of recipients) writeSocketFrame(state, shared, maxFrameBytes);
}

export function writeSocketFrame(state, frame, maxFrameBytes, callback) {
  if (state.closing || state.cleaned || state.socket.destroyed || state.socket.writableEnded) return false;
  let encoded;
  try { encoded = typeof frame === "function" ? frame() : Buffer.isBuffer(frame) ? frame : encodeSupervisorFrame(frame, maxFrameBytes); }
  catch { state.socket.destroy(); return false; }
  const limit = socketOutputBufferLimit(maxFrameBytes);
  if (state.outputBytes + state.socket.writableLength + encoded.length > limit) {
    state.socket.destroy(); return false;
  }
  state.outputQueue.push({ encoded, callback }); state.outputBytes += encoded.length;
  flushSocketWrites(state);
  return !state.socket.destroyed;
}

export function flushSocketWrites(state) {
  if (state.cleaned || state.socket.destroyed || state.socket.writableEnded) return;
  while (!state.outputBlocked && state.outputQueueHead < state.outputQueue.length) {
    const { encoded, callback } = state.outputQueue[state.outputQueueHead];
    state.outputQueue[state.outputQueueHead++] = undefined; state.outputBytes -= encoded.length;
    try { state.outputBlocked = !state.socket.write(encoded, callback); }
    catch { state.socket.destroy(); return; }
  }
  if (state.outputQueueHead === state.outputQueue.length) {
    state.outputQueue = []; state.outputQueueHead = 0;
  } else if (state.outputQueueHead >= 1024 && state.outputQueueHead * 2 >= state.outputQueue.length) {
    state.outputQueue = state.outputQueue.slice(state.outputQueueHead); state.outputQueueHead = 0;
  }
}
