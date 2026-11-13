// What the supervisor shows and checks of a session, read through the core: the
// session's current chunk as complete history entries (pi's entry shapes), projected
// with the same functions that projected pi transcripts. It replaces the reader of pi's
// files; it never opens the core's files itself.
import { createHash } from "node:crypto";
import { normalizeInputImages } from "./input-images.mjs";
import {
  assistantMessageParts, associateVisibleInput, createActorInputAssociation, inputIdForEntry,
  projectVisibleMessage, sortVisibleHistory, toolResultImages,
} from "./conversation-projection.mjs";
import { projectAgentMessageEntry, selectIncomingFamilyMessages } from "./agent-message-projection.mjs";
import { projectProgressEntry } from "./progress-projection.mjs";
import { firstCompletedTitleTurn, rootTitleExcerpt } from "./root-title.mjs";
import { boundVisibleHistory } from "./visible-page.mjs";
import { sanitizePresentationText } from "./presentation-directive.mjs";
import { coreSessionHistory } from "./core-session.mjs";

export class CoreTranscriptReader {
  constructor({ inputReceiptReader = null, history = coreSessionHistory } = {}) {
    this.inputReceiptReader = inputReceiptReader;
    this.history = history;
  }

  // Each read asks the core; nothing is cached, so there is nothing to clear.
  clear() {}

  #associations(entries, sessionId, inputIds) {
    const groups = new Map();
    for (const entry of entries) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId !== "string" || !inputId || inputId.length > 128 || (inputIds && !inputIds.has(inputId))) continue;
      if (!groups.has(inputId)) groups.set(inputId, createActorInputAssociation({ sessionId,
        inputReceipt: this.inputReceiptReader?.(inputId, sessionId) }));
      groups.get(inputId).add(entry);
    }
    return new Map([...groups].map(([inputId, association]) => [inputId, association.result()]));
  }

  #items(entries, associations, { sanitizePresentation, publicView, allowToolImages }, entryOf = new Map()) {
    const items = [];
    for (const entry of entries) {
      // Each row remembers the entry it came from, for the scroll-back cursor.
      const push = (item) => { items.push(item); entryOf.set(item.kind === "message" ? item.message.id : item.id, entryNumber(entry)); };
      const association = associations.get(inputIdForEntry(entry));
      const message = projectVisibleMessage(entry, { imageReferences: true, sanitizePresentation, inputAssociation: association });
      if (publicView && allowToolImages && entry.message?.role === "toolResult") {
        const images = projectVisibleMessage(entry, { imageReferences: true, allowToolImages: true });
        if (images) push({ kind: "message", message: images });
        continue;
      }
      if (publicView && entry.message?.role === "assistant") {
        for (const part of assistantMessageParts(entry, { sanitizePresentation })) push({ kind: "message", message: part });
        continue;
      }
      if (message) {
        let shown = associateVisibleInput(message, entry, association);
        if (publicView && shown.inputId) shown = { ...shown, id: shown.inputId, entryId: shown.id };
        push({ kind: "message", message: shown });
        continue;
      }
      const other = projectProgressEntry(entry) ?? projectAgentMessageEntry(entry);
      // An incoming message's transport receipt shows only until the message itself is in.
      if (other && !(other.kind === "agent_message" && other.direction === "from" && other.delivery?.state === "accepted"
        && entries.some((e) => e.type === "custom_message" && e.details?.messageId === other.familyMessageId))) push(other);
    }
    const families = selectIncomingFamilyMessages(items.filter((item) => item.kind === "agent_message"));
    const kept = items.filter((item) => item.kind !== "agent_message" || families.includes(item));
    return publicView ? sortVisibleHistory(kept) : kept;
  }

  /** Entries older than `before` (an entry number): a range widened back until it holds
   * a page of rows or reaches the start of the history. */
  async #older(sessionFile, before, project, maxMessages) {
    for (let span = 256; ; span *= 4) {
      const from = Math.max(0, before - span);
      const entries = (await this.history(sessionFile, { from, to: before - 1 }))
        .filter((entry) => { const n = entryNumber(entry); return n !== undefined && n >= from && n < before; });
      if (from === 0 || project(entries).length >= maxMessages) return entries;
    }
  }

  async read({ sessionFile, sessionId, maxMessages = 512, maxBytes = 48 * 1024, sanitizePresentation = false,
    includeTitleTurn = false, publicView = false, allowToolImages = false, inputProofIds = null,
    familyMessageId = null, familyDeliveryOnly = false, before = null } = {}) {
    const inputIds = Array.isArray(inputProofIds) ? new Set(inputProofIds) : null;
    const options = { sanitizePresentation, publicView, allowToolImages };
    const project = (entries, entryOf) => this.#items(entries, this.#associations(entries, sessionId, inputIds), options, entryOf);
    // The current chunk, or for scroll-back the entries older than the cursor.
    const cursor = before === null || before === undefined ? null : Number(before);
    if (cursor !== null && !(Number.isSafeInteger(cursor) && cursor >= 0 && String(cursor) === String(before))) {
      throw new Error("history cursor is invalid");
    }
    const entries = cursor === null ? await this.history(sessionFile) : await this.#older(sessionFile, cursor, project, maxMessages);
    const associations = this.#associations(entries, sessionId, inputIds);
    const entryOf = new Map();
    const items = this.#items(entries, associations, options, entryOf);
    const page = boundVisibleHistory(items, { maxMessages, maxBytes });
    // Older rows exist if the oldest entry shown is not the history's first. Rows are in time
    // order, so the oldest entry is the smallest number among them.
    const shown = page.history.map((item) => entryOf.get(item.id)).filter(Number.isSafeInteger);
    const oldest = shown.length ? Math.min(...shown) : entryNumber(entries[0]);
    const hasMore = Number.isSafeInteger(oldest) && oldest > 0;
    const title = includeTitleTurn ? titleOf(items) : {};
    const familyMessages = {};
    for (const item of items) {
      if (item.kind !== "agent_message" || item.direction !== "from" || !item.familyMessageId) continue;
      if (familyMessageId && item.familyMessageId !== familyMessageId) continue;
      familyMessages[item.familyMessageId] = familyDeliveryOnly ? { delivery: item.delivery } : item;
    }
    const proven = [...associations].filter(([, result]) => result.state === "proven");
    // The core's history has one line that only grows, so a session has one fixed branch id
    // (a hash: clients take branch ids as 64 hex digits).
    const branchId = createHash("sha256").update(String(sessionId ?? sessionFile)).digest("hex");
    return { ...page, historyPage: { hasMore, nextCursor: hasMore ? String(oldest) : null, branchId }, ...title,
      leafId: entries.at(-1)?.id ?? null, familyMessages,
      inputIds: proven.map(([inputId]) => inputId),
      inputEntries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, result.entryId])),
      inputDeliveries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, { entryId: result.entryId, deliveredAt: result.deliveredAt }])),
      inputAssociationStates: Object.fromEntries([...associations].map(([inputId, result]) => [inputId, result.state])) };
  }

  async readImage({ sessionFile, entryId, index, allowToolImages = false }) {
    const entry = (await this.history(sessionFile)).find((item) => item.id === entryId);
    const content = entry?.type === "message" && entry.message?.role === "user" ? entry.message.content
      : allowToolImages && entry?.type === "message" && entry.message?.role === "toolResult" ? toolResultImages(entry.message)
      : entry?.type === "custom_message" ? entry.content : null;
    if (!Array.isArray(content)) throw new Error("visible image does not exist in the current history");
    const image = normalizeInputImages(content.filter((part) => part?.type === "image")
      .map((part) => ({ type: "image", data: part.data, mimeType: part.mimeType })))[index];
    if (!image) throw new Error("visible image index does not exist");
    return image;
  }
}

function titleOf(items) {
  const messages = items.filter((item) => item.kind === "message").map((item) => item.message);
  const firstUser = messages.find((message) => message.role === "user");
  const usable = messages.filter((message) => !(message.role === "user" && message.text.startsWith("Automated post-restart continuation:")))
    .map((message) => message.role === "assistant" ? { ...message, text: sanitizePresentationText(message.text).text } : message);
  const turn = firstCompletedTitleTurn(usable);
  return { titleTurn: turn ? rootTitleExcerpt(turn) : null, titleUser: firstUser?.text ?? null };
}

/** An entry's number in its session's history (the core names entries by number). */
function entryNumber(entry) {
  const n = Number(entry?.id);
  return typeof entry?.id === "string" && Number.isSafeInteger(n) && n >= 0 && String(n) === entry.id ? n : undefined;
}
