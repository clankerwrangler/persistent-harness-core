import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { locationBlock, normalizeInputLocation } from "../src/input-location.mjs";
import { messageTimeBlock } from "../src/message-time.mjs";
import { actorInputDigest, validateRequest, PROTOCOL_VERSION } from "../src/protocol.mjs";
import { HarnessStore } from "../src/store.mjs";
import { pendingInputMessage, projectVisibleMessage } from "../src/conversation-projection.mjs";

const location = { latitude: 12.345678, longitude: -76.54321, accuracy: 8.5, timestamp: 1700000000123 };
const request = params => validateRequest({ version: PROTOCOL_VERSION, id: "request", type: "submit_input", params: { sessionId: "root", ...params } }).params;

test("location is an exact finite four-field attachment, never message text or original-Retry input", () => {
  assert.equal(normalizeInputLocation(undefined), undefined);
  assert.deepEqual(normalizeInputLocation(location), location);
  assert.notEqual(normalizeInputLocation(location), location);
  assert.deepEqual(normalizeInputLocation({ latitude: -0, longitude: -0, accuracy: -0, timestamp: 0 }), { latitude: 0, longitude: 0, accuracy: 0, timestamp: 0 });
  assert.deepEqual(request({ message: "  unchanged\n", location }).location, location);
  assert.equal(request({ message: "  unchanged\n", location }).message, "  unchanged\n");
  for (const value of [null, [], {}, { ...location, extra: true }, { ...location, latitude: "12" },
    { ...location, latitude: NaN }, { ...location, latitude: 90.1 }, { ...location, latitude: -90.1 },
    { ...location, longitude: Infinity }, { ...location, longitude: 180.1 }, { ...location, longitude: -180.1 },
    { ...location, accuracy: -1 }, { ...location, accuracy: Infinity }, { ...location, timestamp: -1 },
    { ...location, timestamp: 1.5 }, { ...location, timestamp: 8640000000000001 }]) {
    assert.throws(() => request({ message: "x", location: value }), error => /location/.test(error.message) && !error.message.includes("12.345678"));
  }
  assert.throws(() => request({ message: "", location }), /empty only with images/);
  assert.throws(() => request({ retryOriginal: true, retryOf: "answer", clientRequestId: "attempt", location }), /omitted/);
  assert.equal(Object.hasOwn(request({ retryOriginal: true, retryOf: "answer", clientRequestId: "attempt" }), "location"), false);
  const old = actorInputDigest("x", "[]", "auto");
  assert.equal(actorInputDigest("x", "[]", "auto", undefined), old);
  assert.notEqual(actorInputDigest("x", "[]", "auto", location), old);
  assert.equal(actorInputDigest("x", "[]", "auto", { timestamp: location.timestamp, accuracy: location.accuracy, longitude: location.longitude, latitude: location.latitude }), actorInputDigest("x", "[]", "auto", location));
});

test("durable location survives reopen, participates in equality/limits, and leaves only a digest on completion", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "location-store-"));
  const dbPath = path.join(dir, "state.sqlite"); let store = new HarnessStore(dbPath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "root", sessionFile: path.join(dir, "root.jsonl"), cwd: dir, name: "Fixture", actorToken: "fixture" });
  const payload = { inputId: "input", message: "exact", location };
  store.createActorInput("root", payload);
  store.close(); store = new HarnessStore(dbPath);
  assert.deepEqual(store.getActorInput("input", "root").location, location);
  assert.deepEqual(store.matchActorInputRequest("root", payload).location, location);
  for (const mutation of [undefined, { ...location, timestamp: location.timestamp + 1 }, { ...location, accuracy: 9 }, { ...location, latitude: 13 }, { ...location, longitude: -77 }]) {
    assert.throws(() => store.createActorInput("root", { ...payload, location: mutation }), /reused/);
    assert.throws(() => store.matchActorInputRequest("root", { ...payload, location: mutation }), /reused/);
  }
  assert.throws(() => store.createActorInput("root", { inputId: "limit", message: "x", location, pendingBytesLimit: 10 }), /byte limit/);
  assert.throws(() => store.createActorInput("root", { inputId: "internal", message: "x", location, source: "background", origin: { jobId: "job" } }), /genuine user/);
  store.completeActorInput("input", "root", 123, "canonical-entry");
  assert.equal(store.getActorInput("input", "root").location, undefined);
  assert.deepEqual(store.createActorInput("root", payload).location, location);
  assert.throws(() => store.matchActorInputRequest("root", { ...payload, location: undefined }), /reused/);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM actor_inputs").get().n, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM actor_input_receipts").all()), /12\.345678|76\.54321/);
  db.close();
});

test("pre-location schema supports read-only observation and additive writable migration", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "location-migrate-")), dbPath = path.join(dir, "state.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new HarnessStore(dbPath);
  store.createRoot({ sessionId: "root", cwd: dir, name: "Fixture", actorToken: "fixture" });
  store.createActorInput("root", { inputId: "old", message: "old input" }); store.close();
  const db = new DatabaseSync(dbPath); db.exec("ALTER TABLE actor_inputs DROP COLUMN location_json"); db.close();
  store = new HarnessStore(dbPath, { readOnly: true });
  assert.equal(store.getActorInput("old", "root").location, undefined);
  assert.deepEqual(store.listPendingActorInputs("root"), [store.getActorInput("old", "root")]);
  assert.equal(store.hasPendingActorInputs("root"), true); store.close();
  store = new HarnessStore(dbPath);
  try {
    assert.equal(store.getActorInput("old", "root").message, "old input");
    assert.deepEqual(store.createActorInput("root", { inputId: "new", message: "new", location }).location, location);
  } finally { store.close(); }
});

test("the model sees the shared location as a marked block; displays and pending views leave it and the time out", () => {
  const block = locationBlock(location);
  assert.equal(block.harness, "location");
  assert.match(block.text, /not independently verified.*latitude 12\.345678.*longitude -76\.54321.*accuracy 8\.5 m.*2023-11-14T22:13:20\.123Z/);
  const saved = { role: "user", id: "input", timestamp: 1,
    content: [messageTimeBlock(1, { timeZone: "UTC" }), { type: "text", text: "  exact user text\n" }, block] };
  const entry = { type: "message", id: "entry", timestamp: new Date(1).toISOString(), message: saved };
  const shown = projectVisibleMessage(entry);
  assert.equal(shown.text, "  exact user text\n");
  for (const publicValue of [shown, pendingInputMessage({ inputId: "input", source: "user", message: "  exact user text\n", location })]) {
    assert.doesNotMatch(JSON.stringify(publicValue), /12\.345678|76\.54321|"location"|\[Thu, 1 Jan 1970/);
  }
});
