// Rows the supervisor shows for what it holds itself: inputs it has accepted and messages
// from other sessions still on their way. Rows from saved history come from the session
// half's records reader (core-transcript-reader.mjs), in the same shape, under the same ids.
import { createHash } from "node:crypto";
import { publicInputRole } from "./protocol.mjs";

const MAX_BODY_BYTES = 16 * 1024;

function iso(value) { if (value === undefined || value === null) return null; const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function bounded(value, maxCharacters, maxBytes = maxCharacters * 4) {
  return typeof value === "string" && value.length > 0 && value.length <= maxCharacters
    && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}
function imageContentHash(image) {
  return createHash("sha256").update(image.mimeType).update("\0").update(image.data, "base64").digest("hex");
}

/** An accepted input not yet in the session's history. */
export function pendingInputMessage(input) {
  return { id: input.inputId, role: publicInputRole(input.source), text: input.message ?? "",
    createdAt: iso(input.acceptedAt ?? input.createdAt), status: "complete", delivery: input.delivery,
    source: input.source, origin: input.origin, behavior: input.behavior, ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.images?.length ? { images: input.images.map((image, index) => ({ type: "image", mimeType: image.mimeType,
      ref: { entryId: input.inputId, index }, contentHash: imageContentHash(image), size: Buffer.from(image.data, "base64").length })) } : {}) };
}

/** A message from another session (`message`, a stored route) not yet delivered; `sender`
 * names who sent it. Undefined when the route cannot be shown. */
export function pendingFamilyMessage(message, sender) {
  const messageId = bounded(message?.messageId, 128, 512), peerId = bounded(message?.senderId, 128, 512);
  const accepted = new Date(message?.acceptedAt);
  const createdAt = Number.isNaN(accepted.valueOf()) ? undefined : accepted.toISOString();
  const peerName = bounded(sender?.name ?? sender?.shortId ?? message?.senderId, 256, 1024);
  // The route names the relationship from the sender's side; the row, from the receiver's.
  const relationship = { parent: "child", child: "parent", sibling: "sister", sister: "sister" }[message?.relationship];
  const body = bounded(message?.body, MAX_BODY_BYTES, MAX_BODY_BYTES);
  if (!messageId || !peerId || !createdAt || !peerName || !relationship || !body) return undefined;
  return { id: `family-${messageId}`, role: "agent_message", text: body, direction: "from", relationship, peerName, createdAt,
    status: "complete", familyMessageId: messageId, peerId,
    ...(message.deliveryMode !== undefined ? { deliveryMode: message.deliveryMode } : {}),
    ...(message.state !== undefined ? { transportState: message.state } : {}),
    delivery: { state: "accepted", acceptedAt: createdAt, deliveredAt: null } };
}
