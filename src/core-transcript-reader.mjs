// A session's records as the supervisor is shown them, read through the core: the session's
// current chunk (or an older range) as complete history entries, projected into visible
// rows, what they prove about inputs and messages, and what search sees. Session code: the
// supervisor runs it through the one-off reader (bin/session-records.mjs), never itself.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { normalizeInputImages } from "./input-images.mjs";
import {
  assistantMessageParts, associateVisibleInput, createActorInputAssociation, inputIdForEntry,
  projectVisibleMessage, sortVisibleHistory, toolResultImages,
} from "./conversation-projection.mjs";
import { projectAgentMessageEntry, selectIncomingFamilyMessages } from "./agent-message-projection.mjs";
import { projectProgressEntry } from "./progress-projection.mjs";
import { boundVisibleHistory } from "./visible-page.mjs";
import { PRESENTATION_HISTORY_PREFIX, sanitizePresentationText } from "./presentation-directive.mjs";
import { coreBinary } from "./core-layout.mjs";
import { RECOVERY_DETAIL_FIELDS } from "./python-recovery-fields.mjs";

const exec = promisify(execFile);
const MAX_OUTPUT = 512 * 1024 * 1024;
const ROLES = new Set(["user", "assistant"]);
const MAX_TITLE_TEXT = 16 * 1024;


export class CoreTranscriptReader {
  /** `inputReceipts(ids, sessionId)`: a Map of the inputs' receipts (the supervisor's), or
   * `inputReceiptReader(id, sessionId)` for one at a time. */
  constructor({ inputReceiptReader = null, inputReceipts = null, history = coreSessionHistory } = {}) {
    this.inputReceipts = inputReceipts
      ?? (async (ids, sessionId) => new Map(ids.map((id) => [id, inputReceiptReader?.(id, sessionId) ?? null])));
    this.history = history;
  }

  /** The tool-result detail fields Python recovery reads, which cleanup must keep. */
  recoveryFields() { return [...RECOVERY_DETAIL_FIELDS]; }

  /** What search sees of entries `from`..`to`: the user and assistant messages' visible
   * text, and the newest entry number read (`last`, null when there were none). */
  async searchable(sessionFile, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}, sanitizePresentation = false) {
    const entries = await this.history(sessionFile, { from, to });
    if (!Array.isArray(entries)) throw new Error("the core did not return history");
    let last = null; const messages = [];
    for (const entry of entries) {
      const n = entryNumber(entry);
      if (n === undefined || n < from || n > to) continue;
      last = Math.max(last ?? n, n);
      const message = searchableMessage(entry, sanitizePresentation);
      if (message) messages.push(message);
    }
    return { last, messages };
  }

  /** The receipts of the inputs these entries name that are not in `known` yet, added to it. */
  async #receipts(entries, sessionId, inputIds, known) {
    const wanted = new Set();
    for (const entry of entries) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId !== "string" || !inputId || inputId.length > 128 || (inputIds && !inputIds.has(inputId)) || known.has(inputId)) continue;
      wanted.add(inputId);
    }
    if (wanted.size) for (const [id, receipt] of await this.inputReceipts([...wanted], sessionId)) known.set(id, receipt);
    return known;
  }

  // Each read asks the core; nothing is cached, so there is nothing to clear.
  clear() {}

  #associations(entries, sessionId, inputIds, receipts) {
    const groups = new Map();
    for (const entry of entries) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId !== "string" || !inputId || inputId.length > 128 || (inputIds && !inputIds.has(inputId))) continue;
      if (!groups.has(inputId)) groups.set(inputId, createActorInputAssociation({ sessionId,
        inputReceipt: receipts.get(inputId) ?? undefined }));
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
      if (from === 0 || (await project(entries)).length >= maxMessages) return entries;
    }
  }

  async read({ sessionFile, sessionId, maxMessages = 512, maxBytes = 48 * 1024, sanitizePresentation = false,
    includeTitleTurn = false, publicView = false, allowToolImages = false, inputProofIds = null,
    familyMessageId = null, familyDeliveryOnly = false, before = null } = {}) {
    const inputIds = Array.isArray(inputProofIds) ? new Set(inputProofIds) : null;
    const options = { sanitizePresentation, publicView, allowToolImages };
    const receipts = new Map();
    const project = async (entries) => this.#items(entries,
      this.#associations(entries, sessionId, inputIds, await this.#receipts(entries, sessionId, inputIds, receipts)), options);
    // The current chunk, or for scroll-back the entries older than the cursor.
    const cursor = before === null || before === undefined ? null : Number(before);
    if (cursor !== null && !(Number.isSafeInteger(cursor) && cursor >= 0 && String(cursor) === String(before))) {
      throw new Error("history cursor is invalid");
    }
    const entries = cursor === null ? await this.history(sessionFile) : await this.#older(sessionFile, cursor, project, maxMessages);
    const associations = this.#associations(entries, sessionId, inputIds, await this.#receipts(entries, sessionId, inputIds, receipts));
    const entryOf = new Map();
    const items = this.#items(entries, associations, options, entryOf);
    const page = boundVisibleHistory(items, { maxMessages, maxBytes });
    // Older rows exist if the oldest entry shown is not the history's first. Rows are in time
    // order, so the oldest entry is the smallest number among them.
    const shown = page.history.map((item) => entryOf.get(item.id)).filter(Number.isSafeInteger);
    const oldest = shown.length ? Math.min(...shown) : entryNumber(entries[0]);
    const hasMore = Number.isSafeInteger(oldest) && oldest > 0;
    const title = includeTitleTurn ? titleMessagesOf(items) : {};
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

/** What the supervisor picks a root's title from: the visible messages in order (assistant
 * text without presentation directives), and the first user message. */
function titleMessagesOf(items) {
  const messages = items.filter((item) => item.kind === "message").map((item) => item.message);
  const firstUser = messages.find((message) => message.role === "user");
  const clip = (text) => String(text ?? "").slice(0, MAX_TITLE_TEXT);
  const titleMessages = messages.filter((message) => !(message.role === "user" && message.text.startsWith("Automated post-restart continuation:")))
    .map((message) => ({ role: message.role, text: clip(message.role === "assistant" ? sanitizePresentationText(message.text).text : message.text) }));
  return { titleMessages, titleUser: firstUser?.text ?? null };
}

/** An entry's number in its session's history (the core names entries by number). */
function entryNumber(entry) {
  const n = Number(entry?.id);
  return typeof entry?.id === "string" && Number.isSafeInteger(n) && n >= 0 && String(n) === entry.id ? n : undefined;
}

/** History entries of a session that is not running: its current chunk, or `from`..`to`. */
export async function coreSessionHistory(sessionFile, { from, to } = {}, env = process.env) {
  const args = from === undefined ? ["history", sessionFile] : ["history", sessionFile, String(from), String(to ?? Number.MAX_SAFE_INTEGER)];
  const { stdout } = await exec(coreBinary(env), args, { env, maxBuffer: MAX_OUTPUT });
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error("the core did not return history");
  return entries;
}


/** What search sees of an entry: a user or assistant message's visible text, as shown. */
function searchableMessage(entry, sanitizePresentation) {
  const message = projectVisibleMessage(entry, { sanitizePresentation });
  if (!message || !ROLES.has(message.role) || entryNumber(entry) === undefined) return undefined;
  let text = sanitizeSessionHistoryText(message.text);
  if (sanitizePresentation && message.role === "assistant") text = text.replace(PRESENTATION_HISTORY_PREFIX, "");
  if (!text.trim()) return undefined;
  return { id: entry.id, n: entryNumber(entry), role: message.role, text, createdAt: message.createdAt };
}

/** Remove terminal escape sequences and non-printing controls while preserving plain layout. */
export function sanitizeSessionHistoryText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    // Operating-system command strings, terminated by BEL or string terminator.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/gu, "")
    // Control Sequence Introducer (7-bit ESC [ and 8-bit C1 forms).
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    // Remaining two-byte ANSI escape functions.
    .replace(/\u001B[@-_]/gu, "")
    // C0/C1 controls other than tab, LF, and CR.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    // Bidirectional layout controls can visually reorder otherwise plain text.
    .replace(/[؜‎‏‪-‮⁦-⁩]/gu, "");
}
