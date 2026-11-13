import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionHistoryIndex, SESSION_HISTORY_SCHEMA_VERSION, parseSessionHistoryQuery } from "../src/session-history-index.mjs";

const at = (n) => new Date(Date.UTC(2026, 10, 9, 8, 0, n)).toISOString();
const say = (n, role, text, extra = []) => ({ type: "message", id: String(n), timestamp: at(n),
  message: { role, content: [...extra, { type: "text", text }], timestamp: Date.parse(at(n)), ...(role === "assistant" ? { stopReason: "stop" } : {}) } });

/** Sessions as the core holds them, and every history request the index makes. */
function core() {
  const sessions = new Map(), asked = [];
  return {
    sessions, asked,
    history: async (sessionFile, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) => {
      asked.push({ sessionFile, from, to });
      const entries = sessions.get(sessionFile);
      if (!entries) throw new Error("no such session");
      return structuredClone(entries.filter((entry) => Number(entry.id) >= from && Number(entry.id) <= to));
    },
  };
}

async function fixture(t, history) {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-history-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "history.sqlite");
  const open = () => { const index = new SessionHistoryIndex({ databasePath, history }); t.after(() => index.close()); return index; };
  return { root, databasePath, open };
}
const source = (id, extra = {}) => ({ sessionId: id, sessionFile: `/sessions/${id}`, ...extra });

test("search finds literal terms, phrases, prefixes and roles, with citations and snippets read through the core", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "alpha exact phrase prefixable"), say(2, "assistant", "alpha OR operator is text")]);
  const index = (await fixture(t, fake.history)).open();
  assert.deepEqual(await index.refresh([source("a")]), { indexed: ["a"], unchanged: [], removed: [], errors: [] });
  const phrase = await index.search({ sessions: [source("a")], query: 'alpha "exact phrase" pre*', limit: 5 });
  assert.deepEqual(phrase.matches.map((hit) => hit.entryId), ["1"]);
  assert.deepEqual(phrase.matches[0].citation, { sessionId: "a", entryId: "1" });
  assert.match(phrase.matches[0].snippet, /exact phrase/);
  assert.deepEqual((await index.search({ sessions: [source("a")], query: "OR", roles: ["assistant"] })).matches.map((hit) => hit.entryId), ["2"]);
  assert.deepEqual((await index.search({ sessions: [source("a")], query: "alpha", sort: "newest" })).matches.map((hit) => hit.entryId), ["2", "1"]);
  assert.deepEqual((await index.search({ sessions: [source("a")], query: "alpha", sort: "oldest" })).matches.map((hit) => hit.entryId), ["1", "2"]);
  await assert.rejects(index.search({ sessions: [source("a")], query: "alpha", limit: 21 }), /limit/);
  await assert.rejects(index.search({ sessions: [source("a")], query: "alpha", snippetChars: 801 }), /snippetChars/);
  assert.equal(parseSessionHistoryQuery("alpha OR beta").match, '"alpha" AND "OR" AND "beta"');
  assert.throws(() => parseSessionHistoryQuery('"unterminated'), /unterminated/);
  assert.throws(() => parseSessionHistoryQuery("bad*middle"), /supported only/);
});

test("a refresh asks the core only for entries after the last one indexed", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "first words"), say(2, "assistant", "first answer")]);
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a")]);
  assert.deepEqual(fake.asked.map((ask) => ask.from), [0]);
  assert.deepEqual((await index.refresh([source("a")])).unchanged, ["a"]);
  fake.sessions.get("/sessions/a").push(say(3, "user", "later words"), say(4, "assistant", "later answer"));
  assert.deepEqual((await index.refresh([source("a")])).indexed, ["a"]);
  assert.deepEqual(fake.asked.slice(1).map((ask) => ask.from), [3, 3]);
  assert.deepEqual((await index.search({ sessions: [source("a")], query: "words", sort: "oldest" })).matches.map((hit) => hit.entryId), ["1", "3"]);
});

test("only what the user sees is indexed: no reasoning, times, locations or bookkeeping", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [
    say(1, "user", "where are we", [{ type: "text", text: "[Mon, 9 Nov 2026, 09:00 CET]", harness: "time" }]),
    { type: "message", id: "2", timestamp: at(2), message: { role: "assistant", stopReason: "stop", timestamp: Date.parse(at(2)),
      content: [{ type: "thinking", thinking: "secretthought" }, { type: "text", text: "near the station" }] } },
    { type: "custom", customType: "persistent-harness-usage", id: "3", timestamp: at(3), data: { note: "bookkeepingword" } },
  ]);
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a")]);
  for (const hidden of ["secretthought", "CET", "bookkeepingword"]) {
    assert.deepEqual((await index.search({ sessions: [source("a")], query: hidden })).matches, [], hidden);
  }
  assert.equal((await index.search({ sessions: [source("a")], query: "station" })).matches.length, 1);
});

test("the index keeps no conversation text, and an older index is rebuilt", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "distinctiveword")]);
  const { databasePath, open } = await fixture(t, fake.history);
  const old = new DatabaseSync(databasePath); old.exec("CREATE TABLE stale(x); PRAGMA user_version = 4;"); old.close();
  const index = open();
  await index.refresh([source("a")]);
  index.close();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SESSION_HISTORY_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'stale'").get().n, 0);
    const columns = db.prepare("PRAGMA table_info(documents)").all().map((column) => column.name);
    assert(!columns.includes("text"));
    assert.equal(db.prepare("SELECT text FROM message_fts").all().every((row) => row.text === null), true, "full-text rows are contentless");
  } finally { db.close(); }
});

test("open returns a message and its nearest indexed neighbours, read through the core", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", Array.from({ length: 9 }, (_, i) => say(i + 1, i % 2 ? "assistant" : "user", `message ${i + 1}`)));
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a")]);
  const opened = await index.open({ session: source("a"), entryId: "5", before: 2, after: 1 });
  assert.deepEqual(opened.messages.map((m) => m.entryId), ["3", "4", "5", "6"]);
  assert.equal(opened.truncated, false);
  const tight = await index.open({ session: source("a"), entryId: "5", before: 2, after: 2, maxChars: 20 });
  assert.equal(tight.messages.find((m) => m.entryId === "5").text, "message 5");
  assert.equal(tight.truncated, true);
  await assert.rejects(index.open({ session: source("a"), entryId: "99" }), /does not exist/);
});

test("a session whose history disagrees with what was indexed is refused, then indexed again", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "original words")]);
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a")]);
  fake.sessions.set("/sessions/a", [say(1, "user", "original words, changed")]);
  await assert.rejects(index.search({ sessions: [source("a")], query: "original" }), /does not match/);
  const snapshot = await index.search({ sessions: [source("a")], query: "original", snapshot: true });
  assert.deepEqual(snapshot.matches, []); assert.deepEqual(snapshot.unavailableSessionIds, ["a"]);
  assert.deepEqual((await index.refresh([source("a")])).indexed, ["a"], "the next refresh starts the session again");
  assert.match((await index.search({ sessions: [source("a")], query: "changed" })).matches[0].snippet, /changed/);
});

test("refresh is per caller: one session's failure removes only its own rows", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "shared word")]);
  fake.sessions.set("/sessions/b", [say(1, "user", "shared word")]);
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a"), source("b")]);
  fake.sessions.delete("/sessions/b");
  const result = await index.refresh([source("b")]);
  assert.deepEqual(result.removed, ["b"]); assert.equal(result.errors[0].sessionId, "b");
  assert.deepEqual((await index.search({ sessions: [source("a"), source("b")], query: "shared" })).matches.map((hit) => hit.sessionId), ["a"]);
});

test("snapshot coverage marks sessions not indexed or changed since", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "word")]);
  fake.sessions.set("/sessions/b", [say(1, "user", "word")]);
  const index = (await fixture(t, fake.history)).open();
  await index.refresh([source("a")]);
  const found = await index.search({ sessions: [source("a", { updatedAt: Date.now() + 60_000 }), source("b")], query: "word", snapshot: true });
  assert.deepEqual(found.pendingSessionIds.sort(), ["a", "b"]);
  assert.equal(found.freshness.changedSources, 1); assert.equal(found.freshness.missingSources, 1);
});

test("a damaged index file is rebuilt, and its files stay private", async (t) => {
  const fake = core();
  fake.sessions.set("/sessions/a", [say(1, "user", "recoverable")]);
  const { databasePath, open } = await fixture(t, fake.history);
  await writeFile(databasePath, "not a database");
  const previous = process.umask(0o022); t.after(() => process.umask(previous));
  const index = open();
  await index.refresh([source("a")]);
  assert.equal((await index.search({ sessions: [source("a")], query: "recoverable" })).matches.length, 1);
  assert.equal((await stat(databasePath)).mode & 0o077, 0);
});
