// Session search over core sessions. A session's history is append-only and every entry
// has a fixed number, so the index remembers, per session, the last entry it indexed and
// asks the core only for the entries after it. The index holds no conversation text (its
// full-text table is contentless): a result's text, and an opened entry's neighbours, are
// asked of the core by entry number. Everything is read through the core.
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { setImmediate as yieldToIO } from "node:timers/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { coreSessionHistory } from "./core-session.mjs";
import { projectVisibleMessage } from "./conversation-projection.mjs";
import { PRESENTATION_HISTORY_PREFIX } from "./presentation-directive.mjs";

// Version 5: core sessions, indexed by entry number (older versions are rebuilt).
export const SESSION_HISTORY_SCHEMA_VERSION = 5;

const MAX_QUERY_BYTES = 512;
const MAX_QUERY_CLAUSES = 32;
const MAX_SESSIONS = 2048;
const MAX_LIMIT = 20;
const MAX_SNIPPET_CHARS = 800;
const MAX_OPEN_CHARS = 16_000;
const ROLES = new Set(["user", "assistant"]);
const SORTS = new Set(["relevance", "newest", "oldest"]);

function requireRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  return value;
}

function boundedInteger(value, context, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${context} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function codePoints(value) { return Array.from(String(value ?? "")); }
function charLength(value) { return codePoints(value).length; }

function truncatePrefix(value, maximum) {
  const chars = codePoints(value);
  if (chars.length <= maximum) return { text: chars.join(""), truncated: false };
  if (maximum <= 0) return { text: "", truncated: true };
  if (maximum === 1) return { text: "…", truncated: true };
  return { text: `${chars.slice(0, maximum - 1).join("")}…`, truncated: true };
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

function normalizedSession(value, context = "session") {
  const session = requireRecord(value, context);
  const { sessionId, sessionFile } = session;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new TypeError(`${context}.sessionId must be a non-empty string of at most 128 characters`);
  }
  if (typeof sessionFile !== "string" || !sessionFile || Buffer.byteLength(sessionFile, "utf8") > 4096) {
    throw new TypeError(`${context}.sessionFile must be a non-empty bounded path`);
  }
  if (session.sanitizePresentation !== undefined && typeof session.sanitizePresentation !== "boolean") {
    throw new TypeError(`${context}.sanitizePresentation must be boolean`);
  }
  if (session.updatedAt !== undefined && !Number.isSafeInteger(session.updatedAt)) {
    throw new TypeError(`${context}.updatedAt must be a time in milliseconds`);
  }
  return { sessionId, sessionFile: path.resolve(sessionFile), sanitizePresentation: session.sanitizePresentation === true,
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }) };
}

function normalizedSessions(values) {
  if (!Array.isArray(values) || values.length > MAX_SESSIONS) {
    throw new TypeError(`sessions must be an array of at most ${MAX_SESSIONS} items`);
  }
  const result = values.map((value, index) => normalizedSession(value, `sessions[${index}]`));
  const ids = new Set();
  for (const session of result) {
    if (ids.has(session.sessionId)) throw new TypeError(`duplicate sessionId: ${session.sessionId}`);
    ids.add(session.sessionId);
  }
  return result;
}

function quoteFts(value) { return `"${value.replaceAll('"', '""')}"`; }

/** Parse the deliberately small public query language, never raw FTS MATCH syntax. */
export function parseSessionHistoryQuery(input) {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input, "utf8") > MAX_QUERY_BYTES) {
    throw new TypeError(`query must be a non-empty string of at most ${MAX_QUERY_BYTES} UTF-8 bytes`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(input)) throw new TypeError("query must not contain control characters");
  const clauses = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/u.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    if (input[index] === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < input.length) {
        const character = input[index++];
        if (character === '"') { closed = true; break; }
        if (character === "\\" && index < input.length && ['"', "\\"].includes(input[index])) {
          value += input[index++];
        } else value += character;
      }
      if (!closed) throw new TypeError("query contains an unterminated quoted phrase");
      if (!value.trim()) throw new TypeError("query phrases must not be empty");
      if (index < input.length && !/\s/u.test(input[index])) {
        throw new TypeError("a quoted phrase must be followed by whitespace");
      }
      clauses.push({ value, phrase: true, prefix: false });
    } else {
      const start = index;
      while (index < input.length && !/\s/u.test(input[index])) index += 1;
      let value = input.slice(start, index);
      const stars = [...value].filter((character) => character === "*").length;
      const prefix = stars === 1 && value.endsWith("*");
      if (stars && !prefix) throw new TypeError("query '*' is supported only once at the end of a term");
      if (prefix) value = value.slice(0, -1);
      if (!value) throw new TypeError("query prefix must contain text before '*'");
      clauses.push({ value, phrase: false, prefix });
    }
    if (clauses.length > MAX_QUERY_CLAUSES) throw new TypeError(`query must contain at most ${MAX_QUERY_CLAUSES} terms or phrases`);
  }
  if (!clauses.length) throw new TypeError("query must contain a term or phrase");
  return {
    clauses,
    match: clauses.map((clause) => `${quoteFts(clause.value)}${clause.prefix ? "*" : ""}`).join(" AND "),
  };
}

function firstMatch(text, clauses) {
  const folded = text.toLocaleLowerCase();
  let selected = -1;
  for (const clause of clauses) {
    let found = -1;
    if (clause.prefix) {
      const escaped = clause.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try { found = text.search(new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${escaped})`, "iu")); } catch {}
    } else found = folded.indexOf(clause.value.toLocaleLowerCase());
    if (found >= 0 && (selected < 0 || found < selected)) selected = found;
  }
  return selected;
}

function plainSnippet(text, clauses, maximum) {
  const chars = codePoints(text);
  if (chars.length <= maximum) return chars.join("");
  const codeUnitOffset = firstMatch(text, clauses);
  const matchOffset = codeUnitOffset < 0 ? 0 : codePoints(text.slice(0, codeUnitOffset)).length;
  const leading = matchOffset > 0;
  const markerBudget = (leading ? 1 : 0) + 1;
  const bodyLength = Math.max(0, maximum - markerBudget);
  let start = Math.max(0, matchOffset - Math.floor(bodyLength / 3));
  if (start + bodyLength > chars.length) start = Math.max(0, chars.length - bodyLength);
  const trailing = start + bodyLength < chars.length;
  const adjustedLength = Math.max(0, maximum - (start > 0 ? 1 : 0) - (trailing ? 1 : 0));
  return `${start > 0 ? "…" : ""}${chars.slice(start, start + adjustedLength).join("")}${trailing ? "…" : ""}`;
}

function textHash(text) { return createHash("sha256").update(String(text ?? "")).digest("hex"); }

function publicMessage(message, text = message.text) {
  return { entryId: message.id, role: message.role, text, createdAt: message.createdAt,
    citation: { sessionId: null, entryId: message.id } };
}

/** An entry's number in its session's history, or undefined for anything else. */
function entryNumber(entry) {
  const n = Number(entry?.id);
  return typeof entry?.id === "string" && Number.isSafeInteger(n) && n >= 0 && String(n) === entry.id ? n : undefined;
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

export class SessionHistoryIndex {
  #db;
  #closed = false;
  // Sessions whose history disagreed with the index: the next refresh indexes them again.
  #stale = new Set();

  /** `history(sessionFile, { from, to })`: the session's entries from `from` through `to`, through the core. */
  constructor({ databasePath, history = coreSessionHistory }) {
    if (typeof databasePath !== "string" || !databasePath) throw new TypeError("databasePath is required");
    if (typeof history !== "function") throw new TypeError("history is required");
    this.databasePath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
    this.history = history;
    if (this.databasePath !== ":memory:") {
      const parent = path.dirname(this.databasePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if ((statSync(parent).mode & 0o077) !== 0) {
        throw new Error("session history database directory must not be accessible by group or other users");
      }
    }
    try { this.#db = this.#openDatabase(); }
    catch (error) {
      if (this.databasePath === ":memory:") throw error;
      this.#discardDatabase();
      this.#db = this.#openDatabase();
    }
  }

  #secureDatabaseFiles() {
    if (this.databasePath === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${this.databasePath}${suffix}`, 0o600); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }

  #discardDatabase() {
    try { this.#db?.close(); } catch {}
    this.#db = undefined;
    if (this.databasePath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.databasePath}${suffix}`, { force: true });
    }
  }

  #openDatabase() {
    const db = new DatabaseSync(this.databasePath);
    try {
      this.#secureDatabaseFiles();
      const version = Number(db.prepare("PRAGMA user_version").get().user_version);
      // Older indexes read pi transcripts: derived data, rebuilt from the core.
      if (version !== 0 && version !== SESSION_HISTORY_SCHEMA_VERSION) throw new Error("derived session history schema version is unsupported");
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      if (this.databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          session_id TEXT PRIMARY KEY,
          session_file TEXT NOT NULL,
          sanitize_presentation INTEGER NOT NULL CHECK (sanitize_presentation IN (0, 1)),
          indexed_through INTEGER NOT NULL CHECK (indexed_through >= -1),
          indexed_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS documents (
          document_id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sources(session_id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          entry_n INTEGER NOT NULL CHECK (entry_n >= 0),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          created_at TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          UNIQUE(session_id, entry_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS documents_session_entry ON documents(session_id, entry_n);
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
          text,
          content='',
          contentless_delete=1,
          tokenize='unicode61 remove_diacritics 2'
        );
        PRAGMA user_version = ${SESSION_HISTORY_SCHEMA_VERSION};
      `);
      const check = db.prepare("PRAGMA quick_check").all();
      if (!check.length || check.some((row) => Object.values(row)[0] !== "ok")) {
        throw new Error("derived session history database integrity check failed");
      }
      this.#secureDatabaseFiles();
      return db;
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
  }

  #isDatabaseFailure(error) {
    return (typeof error?.code === "string" && (error.code.startsWith("ERR_SQLITE") || error.code.startsWith("SQLITE")))
      || (error instanceof Error && error.message.startsWith("derived session history"));
  }

  #recoverDatabase() {
    if (this.databasePath === ":memory:") throw new Error("in-memory session history index cannot be recovered");
    this.#discardDatabase();
    this.#db = this.#openDatabase();
  }

  #assertOpen() { if (this.#closed) throw new Error("session history index is closed"); }

  #deleteSession(sessionId) {
    this.#db.prepare("DELETE FROM message_fts WHERE rowid IN (SELECT document_id FROM documents WHERE session_id = ?)").run(sessionId);
    this.#db.prepare("DELETE FROM documents WHERE session_id = ?").run(sessionId);
    this.#db.prepare("DELETE FROM sources WHERE session_id = ?").run(sessionId);
  }

  /** The session's entries numbered from `from` through `to`, through the core. */
  async #entries(session, from, to = Number.MAX_SAFE_INTEGER) {
    const entries = await this.history(session.sessionFile, { from, to });
    if (!Array.isArray(entries)) throw new Error("the core did not return history");
    return entries.filter((entry) => { const n = entryNumber(entry); return n !== undefined && n >= from && n <= to; });
  }

  /** Index what is new in each session. `automatic` (maintenance) and strict (a caller) refresh alike. */
  async refresh(sessions, { signal } = {}) {
    signal?.throwIfAborted();
    this.#assertOpen();
    const allowed = normalizedSessions(sessions);
    try { return await this.#refreshAllowed(allowed, signal); }
    catch (error) {
      if (!this.#isDatabaseFailure(error)) throw error;
      this.#recoverDatabase();
      return this.#refreshAllowed(allowed, signal);
    }
  }

  async #refreshAllowed(allowed, signal) {
    const removed = [], indexed = [], unchanged = [], errors = [];
    // The array is caller-scoped, not a global inventory: never erase another caller's
    // indexed session merely because it is absent here.
    for (const session of allowed) {
      signal?.throwIfAborted();
      let source = this.#db.prepare("SELECT * FROM sources WHERE session_id = ?").get(session.sessionId);
      // A session now read from another place, or shown differently, starts again.
      const restart = source && (this.#stale.has(session.sessionId) || source.session_file !== session.sessionFile
        || Number(source.sanitize_presentation) !== Number(session.sanitizePresentation));
      const from = source && !restart ? Number(source.indexed_through) + 1 : 0;
      let added;
      try { added = await this.#entries(session, from); }
      catch (error) {
        signal?.throwIfAborted();
        if (source) {
          this.#db.exec("BEGIN IMMEDIATE");
          try { this.#deleteSession(session.sessionId); this.#db.exec("COMMIT"); }
          catch (deleteError) { this.#db.exec("ROLLBACK"); throw deleteError; }
          removed.push(session.sessionId);
        }
        errors.push({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      signal?.throwIfAborted();
      if (source && !restart && !added.length) {
        this.#db.prepare("UPDATE sources SET indexed_at = ? WHERE session_id = ?").run(Date.now(), session.sessionId);
        unchanged.push(session.sessionId);
        continue;
      }
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        if (restart) { this.#deleteSession(session.sessionId); source = undefined; }
        const through = added.reduce((max, entry) => Math.max(max, entryNumber(entry)), source ? Number(source.indexed_through) : -1);
        this.#db.prepare(`INSERT INTO sources(session_id, session_file, sanitize_presentation, indexed_through, indexed_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET indexed_through = excluded.indexed_through, indexed_at = excluded.indexed_at`)
          .run(session.sessionId, session.sessionFile, session.sanitizePresentation ? 1 : 0, through, Date.now());
        const insertDocument = this.#db.prepare(`INSERT OR IGNORE INTO documents(session_id, entry_id, entry_n, role, created_at, text_hash)
          VALUES (?, ?, ?, ?, ?, ?)`);
        const insertFts = this.#db.prepare("INSERT INTO message_fts(rowid, text) VALUES (?, ?)");
        let count = 0;
        for (const entry of added) {
          if (count++ % 128 === 0) { await yieldToIO(); signal?.throwIfAborted(); }
          const message = searchableMessage(entry, session.sanitizePresentation);
          if (!message) continue;
          const row = insertDocument.run(session.sessionId, message.id, message.n, message.role, message.createdAt, textHash(message.text));
          if (row.changes) insertFts.run(Number(row.lastInsertRowid), message.text);
        }
        signal?.throwIfAborted();
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      this.#stale.delete(session.sessionId);
      indexed.push(session.sessionId);
    }
    this.#secureDatabaseFiles();
    return { indexed, unchanged, removed, errors };
  }

  /** The indexed rows' messages, read through the core and checked against what was indexed. */
  async #messages(session, rows, signal) {
    signal?.throwIfAborted();
    if (!rows.length) return [];
    const numbers = rows.map((row) => Number(row.entry_n));
    const entries = await this.#entries(session, Math.min(...numbers), Math.max(...numbers));
    signal?.throwIfAborted();
    const byId = new Map();
    for (const entry of entries) {
      const message = searchableMessage(entry, session.sanitizePresentation);
      if (message) byId.set(message.id, message);
    }
    return rows.map((row) => {
      const message = byId.get(row.entry_id);
      if (!message || message.role !== row.role || textHash(message.text) !== row.text_hash) {
        this.#stale.add(session.sessionId);
        throw new Error("history from the core does not match what was indexed");
      }
      return message;
    });
  }

  #indexedSession(session, db = this.#db) {
    const source = db.prepare("SELECT * FROM sources WHERE session_id = ?").get(session.sessionId);
    return source && source.session_file === session.sessionFile
      && Number(source.sanitize_presentation) === Number(session.sanitizePresentation);
  }

  async #withSnapshot(operation) {
    // A separate WAL reader pins committed rows while indexing writes. Never rebuild here.
    if (this.databasePath === ":memory:") throw new Error("indexed snapshots require a persistent history database");
    const db = new DatabaseSync(this.databasePath, { readOnly: true });
    try { db.exec("BEGIN"); return await operation(db); }
    finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
  }

  /** How current the index is for these sessions: not indexed, or changed since. */
  #coverage(sessions, db, unavailable = new Set()) {
    let indexed = 0, changed = 0, missing = 0, oldest = null, newest = null;
    const pending = new Set(unavailable);
    for (const session of sessions) {
      const source = db.prepare("SELECT * FROM sources WHERE session_id = ?").get(session.sessionId);
      if (!source || source.session_file !== session.sessionFile
        || Number(source.sanitize_presentation) !== Number(session.sanitizePresentation)) { missing++; pending.add(session.sessionId); continue; }
      indexed++;
      oldest = oldest === null ? source.indexed_at : Math.min(oldest, source.indexed_at);
      newest = newest === null ? source.indexed_at : Math.max(newest, source.indexed_at);
      if (session.updatedAt !== undefined && session.updatedAt > source.indexed_at) { changed++; pending.add(session.sessionId); }
    }
    return { pendingSessionIds: [...pending],
      freshness: { mode: "indexed", current: false, branch: "indexed", sources: sessions.length,
        indexedSources: indexed, changedSources: changed, missingSources: missing,
        unavailableSources: unavailable.size, pendingSources: pending.size,
        oldestIndexedAt: oldest === null ? null : new Date(oldest).toISOString(),
        newestIndexedAt: newest === null ? null : new Date(newest).toISOString() } };
  }

  /** Search indexed metadata, then read bounded plain snippets through the core. */
  async search(options = {}) {
    this.#assertOpen();
    if (options.snapshot) return this.#withSnapshot((db) => this.#searchOnce({ ...options, db }));
    try { return await this.#searchOnce(options); }
    catch (error) {
      if (!this.#isDatabaseFailure(error)) throw error;
      this.#recoverDatabase();
      await this.refresh(options.sessions, { signal: options.signal });
      return this.#searchOnce(options);
    }
  }

  async #searchOnce({ sessions, query, roles = ["user", "assistant"], limit = 10,
    sort = "relevance", snippetChars = 320, signal, db = this.#db, snapshot = false } = {}) {
    signal?.throwIfAborted();
    const allowed = normalizedSessions(sessions);
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 2
      || roles.some((role) => !ROLES.has(role)) || new Set(roles).size !== roles.length) {
      throw new TypeError("roles must contain unique user and/or assistant values");
    }
    limit = boundedInteger(limit, "limit", 1, MAX_LIMIT, 10);
    snippetChars = boundedInteger(snippetChars, "snippetChars", 16, MAX_SNIPPET_CHARS, 320);
    if (!SORTS.has(sort)) throw new TypeError("sort must be relevance, newest, or oldest");
    const parsed = parseSessionHistoryQuery(query);
    const permitted = allowed.filter((session) => this.#indexedSession(session, db));
    const unavailable = new Set();
    const finish = (matches, truncated) => {
      const coverage = snapshot ? this.#coverage(allowed, db, unavailable) : {};
      return { query, matches, truncated, ...coverage,
        ...(snapshot ? { unavailableSessionIds: [...unavailable].slice(0, 20), unavailableTruncated: unavailable.size > 20 } : {}) };
    };
    if (!permitted.length) return finish([], false);
    const sessionById = new Map(permitted.map((session) => [session.sessionId, session]));
    const ordering = sort === "newest" ? "d.created_at DESC, d.session_id, d.entry_n"
      : sort === "oldest" ? "d.created_at, d.session_id, d.entry_n"
        : "bm25(message_fts), d.created_at DESC, d.session_id, d.entry_n";
    const candidateLimit = Math.min(1000, (limit + 1) * 8);
    const rows = db.prepare(`SELECT d.*, bm25(message_fts) AS score FROM message_fts JOIN documents d ON d.document_id = message_fts.rowid
      WHERE message_fts MATCH ? AND d.session_id IN (${permitted.map(() => "?").join(", ")})
        AND d.role IN (${roles.map(() => "?").join(", ")}) ORDER BY ${ordering} LIMIT ?`)
      .all(parsed.match, ...permitted.map((session) => session.sessionId), ...roles, candidateLimit);
    // One read through the core per session, for the rows that can still be returned.
    const wanted = rows.slice(0, limit + 1);
    const read = new Map();
    for (const sessionId of new Set(wanted.map((row) => row.session_id))) {
      try { read.set(sessionId, await this.#messages(sessionById.get(sessionId), wanted.filter((row) => row.session_id === sessionId), signal)); }
      catch (error) {
        signal?.throwIfAborted();
        if (!snapshot || this.#isDatabaseFailure(error)) throw error;
        unavailable.add(sessionId);
      }
    }
    const matches = [];
    for (const row of wanted) {
      const message = read.get(row.session_id)?.find((item) => item.id === row.entry_id);
      if (!message) continue;
      matches.push({ sessionId: row.session_id, entryId: message.id, role: message.role, createdAt: message.createdAt,
        snippet: plainSnippet(message.text, parsed.clauses, snippetChars),
        citation: { sessionId: row.session_id, entryId: message.id },
        score: sort === "relevance" ? Number(row.score) : undefined });
    }
    const truncated = matches.length > limit || rows.length > limit;
    return finish(matches.slice(0, limit), truncated);
  }

  /** Open one indexed message with its nearest indexed neighbours, read through the core. */
  async open(options = {}) {
    this.#assertOpen();
    return options.snapshot ? this.#withSnapshot((db) => this.#openOnce({ ...options, db })) : this.#openOnce(options);
  }

  async #openOnce({ session, entryId, before = 2, after = 2, maxChars = 8_000, signal, db = this.#db, snapshot = false } = {}) {
    signal?.throwIfAborted();
    this.#assertOpen();
    const selected = normalizedSession(session);
    if (!this.#indexedSession(selected, db)) throw new Error("session is not present in the allowed history index");
    if (typeof entryId !== "string" || !entryId || entryId.length > 128) {
      throw new TypeError("entryId must be a non-empty string of at most 128 characters");
    }
    before = boundedInteger(before, "before", 0, 8, 2);
    after = boundedInteger(after, "after", 0, 8, 2);
    maxChars = boundedInteger(maxChars, "maxChars", 1, MAX_OPEN_CHARS, 8_000);
    const target = db.prepare("SELECT * FROM documents WHERE session_id = ? AND entry_id = ?").get(selected.sessionId, entryId);
    if (!target) throw new Error("entry does not exist in the indexed history");
    const earlier = db.prepare("SELECT * FROM documents WHERE session_id = ? AND entry_n < ? ORDER BY entry_n DESC LIMIT ?")
      .all(selected.sessionId, target.entry_n, before).reverse();
    const later = db.prepare("SELECT * FROM documents WHERE session_id = ? AND entry_n > ? ORDER BY entry_n LIMIT ?")
      .all(selected.sessionId, target.entry_n, after);
    const messages = await this.#messages(selected, [...earlier, target, ...later], signal);
    const targetIndex = earlier.length;
    const chosen = new Map();
    let remaining = maxChars;
    const targetText = truncatePrefix(messages[targetIndex].text, remaining);
    chosen.set(targetIndex, targetText);
    remaining -= charLength(targetText.text);
    let beforeContiguous = true, afterContiguous = true;
    for (let distance = 1; remaining > 0 && (targetIndex - distance >= 0 || targetIndex + distance < messages.length); distance += 1) {
      for (const [index, side] of [[targetIndex - distance, "before"], [targetIndex + distance, "after"]]) {
        if (index < 0 || index >= messages.length || remaining <= 0) continue;
        if ((side === "before" && !beforeContiguous) || (side === "after" && !afterContiguous)) continue;
        const text = messages[index].text, length = charLength(text);
        if (length <= remaining) { chosen.set(index, { text, truncated: false }); remaining -= length; }
        else if (side === "before") beforeContiguous = false;
        else afterContiguous = false;
      }
    }
    const opened = [...chosen.entries()].sort(([left], [right]) => left - right).map(([index, bounded]) => ({
      ...publicMessage(messages[index], bounded.text),
      citation: { sessionId: selected.sessionId, entryId: messages[index].id },
    }));
    const truncatedBefore = Array.from({ length: targetIndex }, (_, index) => index).some((index) => !chosen.has(index));
    const truncatedAfter = Array.from({ length: messages.length - targetIndex - 1 }, (_, offset) => targetIndex + 1 + offset).some((index) => !chosen.has(index));
    return {
      sessionId: selected.sessionId,
      entryId,
      ...(snapshot ? this.#coverage([selected], db) : {}),
      messages: opened,
      truncated: targetText.truncated || truncatedBefore || truncatedAfter,
      truncatedBefore,
      truncatedAfter,
      citation: { sessionId: selected.sessionId, entryId },
    };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db?.close(); } catch {}
  }
}
