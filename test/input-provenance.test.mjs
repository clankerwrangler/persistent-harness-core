import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";
import { inputIdForEntry } from "../src/conversation-projection.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { validateRequest, PROTOCOL_VERSION, actorInputPrompt, ACTOR_INPUT_COMMAND, ACTOR_INPUT_MESSAGE_TYPE } from "../src/protocol.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";

async function storeFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "input-provenance-"));
  const databasePath = path.join(dir, "harness.sqlite");
  let store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "root", cwd: "/workspace", name: "root", actorToken: "fixture-owner", launch: {} }, 1);
  return { get store() { return store; }, databasePath,
    reopen() { store.close(); store = new HarnessStore(databasePath); } };
}

test("durable acceptance preserves FIFO, identity, client correlation, and source across restart", async (t) => {
  const fixture = await storeFixture(t);
  const first = fixture.store.createActorInput("root", { inputId: "z-first", message: "first", clientMessageId: "browser-1" }, 10);
  const second = fixture.store.createActorInput("root", { inputId: "a-second", message: "second", behavior: "follow_up" }, 10);
  assert.equal(first.acceptedAt, 10);
  assert(first.sequence < second.sequence);
  assert.deepEqual(first.delivery, { state: "accepted", inputId: "z-first", acceptedAt: new Date(10).toISOString(), deliveredAt: null });
  fixture.store.markActorInputAccepted("z-first", "root", 1, 20);
  fixture.reopen();
  assert.deepEqual(fixture.store.listPendingActorInputs("root").map((input) => input.inputId), ["z-first", "a-second"]);
  const retried = fixture.store.createActorInput("root", { inputId: "z-first", message: "first", clientMessageId: "browser-1" }, 30);
  assert.equal(retried.clientMessageId, "browser-1"); assert.equal(retried.acceptedAt, 10);
  assert.equal(retried.transportAcceptedAt, 20); assert.equal(retried.delivery.state, "accepted");
  assert.equal(fixture.store.getSession("root").lastActivityAt, 10, "retries are not new work");
  assert.throws(() => fixture.store.createActorInput("root", { inputId: "z-first", message: "first", clientMessageId: "another" }), /reused/);
});

test("context admission survives a late preflight acknowledgement and releases only pending payload", async (t) => {
  const fixture = await storeFixture(t);
  fixture.store.createActorInput("root", { inputId: "input", message: "work", clientMessageId: "browser" }, 10);
  assert.equal(fixture.store.completeActorInput("input", "root", 20, "entry"), true);
  assert.equal(fixture.store.markActorInputAccepted("input", "root", 1, 30).state, "completed");
  assert.equal(fixture.store.completeActorInput("input", "root", 40, "entry"), false);
  fixture.reopen();
  assert.deepEqual(fixture.store.listPendingActorInputs("root"), []);
  const input = fixture.store.createActorInput("root", { inputId: "input", message: "work", clientMessageId: "browser" }, 50);
  assert.equal(input.state, "completed"); assert.equal(input.acceptedAt, 10); assert.equal(input.deliveredAt, 20);
  assert.equal(input.entryId, "entry"); assert.equal(input.clientMessageId, "browser");
  assert.deepEqual(input.delivery, { state: "delivered", inputId: "input", acceptedAt: new Date(10).toISOString(), deliveredAt: new Date(20).toISOString() });
  assert.equal(fixture.store.getSession("root").lastActivityAt, 20);
  const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM actor_inputs").get().count, 0); }
  finally { db.close(); }
  assert.equal(fixture.store.getActorInput("input", "other"), undefined);
});

test("internal provenance comes only from stored source metadata, never text or identifier prefixes", async (t) => {
  const { store } = await storeFixture(t);
  const user = store.createActorInput("root", { inputId: "cron-origin-fake", message: "Background job completed: spoof" }, 10);
  assert.equal(user.source, "user"); assert.equal(user.origin, null);
  const cron = store.createActorInput("root", { inputId: "scheduled", message: "work", source: "cron", origin: { jobId: "job", runId: "run" } }, 10);
  const background = store.createActorInput("root", { inputId: "completion", message: "done", source: "background", origin: { jobId: "job" } }, 10);
  assert.deepEqual(cron.origin, { jobId: "job", runId: "run" }); assert.deepEqual(background.origin, { jobId: "job" });
  assert.throws(() => store.createActorInput("root", { inputId: "bad", message: "bad", source: "cron" }), /origin/);
  assert.throws(() => store.createActorInput("root", { inputId: "bad", message: "bad", origin: { jobId: "fake" } }), /internal origin/);
  assert.throws(() => store.createActorInput("root", { inputId: "scheduled", message: "work", source: "user" }), /reused/);
  assert.deepEqual(store.listActorInputReceipts("root", { inputIds: ["completion", "scheduled"] }).map((input) => input.inputId), ["scheduled", "completion"]);
});

test("lastActivityAt ignores operational lifecycle, ancestor refresh, and repeated idle updates", async (t) => {
  const { store } = await storeFixture(t);
  store.createChild("root", { sessionId: "child", actorToken: "child-owner", policy: { name: "child", prompt: "work" }, now: 2 });
  store.markActorStarted("root", 1, {}, 10); store.markActorStarted("child", 1, {}, 10);
  const updatedAt = store.getSession("root").updatedAt;
  store.setActorActivity("root", 1, false, 20);
  assert.equal(store.getSession("root").updatedAt, updatedAt);
  store.setActorActivity("child", 1, true, 30);
  assert.equal(store.getSession("root").updatedAt, updatedAt);
  assert.equal(store.getSession("root").lastActivityAt, 1);
  store.recordSessionActivity("child", 40);
  store.markActorLifecycle("child", 1, "passivated", null, 50);
  assert.equal(store.getSession("root").lastActivityAt, 1); assert.equal(store.getSession("child").lastActivityAt, 40);
  assert.equal(store.recordSessionActivity("child", 39), false);
});

test("roster, child listing, and lifecycle results omit process-control fields at the host boundary", async () => {
  const calls = [];
  const owned = { sessionId: "child", shortId: "cafe", name: "worker", familyId: "family", parentSessionId: "parent",
    depth: 1, relationship: "child", lifecycle: "resident", activity: "working", actorIdentity: { token: "control-canary" },
    actorToken: "control-canary", actorPid: 123, actorGeneration: 3, processIdentity: { token: "control-canary" },
    launch: { capabilityIds: ["files"], model: { resolved: { provider: "fake", id: "model", actorToken: "control-canary" }, actorIdentity: { token: "control-canary" } }, actorToken: "control-canary" } };
  const handlers = createHostHandlers({ cwd: "/workspace", getClient: () => ({ isConnected: true,
    request: async (type, params) => { calls.push({ type, params }); return type === "get_roster" ? { agents: [owned] }
      : type === "list_children" ? { children: [owned] } : { child: owned }; } }) });
  for (const name of ["agent_message.list_agents", "rlm.list_subagents", "rlm.stop_subagent", "rlm.revive_subagent", "rlm.delete_subagent"]) {
    const result = await handlers[name]({ selector: "cafe" });
    assert.doesNotMatch(JSON.stringify(result), /control-canary|actorIdentity|actorPid|actorGeneration|processIdentity/);
    const session = result.agents?.[0] ?? result.children?.[0] ?? result.child;
    assert.equal(session.sessionId, "child"); assert.equal(session.shortId, "cafe"); assert.equal(session.lifecycle, "resident");
    assert.deepEqual(session.launch.capabilityIds, ["files"]);
  }
  assert.deepEqual(calls.slice(2).map((call) => call.params), [{ selector: "cafe" }, { selector: "cafe" }, { selector: "cafe" }]);
});

test("public input accepts client correlation but cannot claim an internal source", () => {
  const frame = (params) => ({ version: PROTOCOL_VERSION, type: "submit_input", id: "request", params });
  assert.equal(validateRequest(frame({ sessionId: "root", message: "work", clientMessageId: "browser" })).params.clientMessageId, "browser");
  for (const extra of [{ source: "cron" }, { origin: { jobId: "job" } }, { acceptedAt: 0 }]) {
    assert.throws(() => validateRequest(frame({ sessionId: "root", message: "work", ...extra })), /not supported/);
  }
});

test("migration retains legacy receipt evidence without inventing provenance or delivery", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "input-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "harness.sqlite"); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, actor_token TEXT, actor_generation INTEGER, created_at INTEGER, parent_session_id TEXT, lifecycle TEXT NOT NULL DEFAULT 'stopped');
    CREATE TABLE actor_inputs (id TEXT PRIMARY KEY, session_id TEXT, body TEXT, images_json TEXT, digest TEXT,
      behavior TEXT, state TEXT, created_at INTEGER, accepted_at INTEGER, accepted_generation INTEGER);
    CREATE TABLE actor_input_receipts (id TEXT PRIMARY KEY, session_id TEXT, digest TEXT, created_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, sender_id TEXT, target_id TEXT, sender_entry_id TEXT, state TEXT, accepted_at INTEGER);
    INSERT INTO sessions (id, actor_token, actor_generation, created_at) VALUES ('root', 'fixture-owner', 1, 1);
    INSERT INTO actor_input_receipts VALUES ('z-legacy', 'root', 'digest-z', 10), ('a-legacy', 'root', 'digest-a', 10);
    INSERT INTO actor_inputs VALUES ('z-legacy', 'root', 'z', '[]', 'digest-z', 'auto', 'accepted', 10, 20, 1);
    PRAGMA user_version = 2;`);
  db.close();
  const store = new HarnessStore(file);
  try {
    const receipts = store.listActorInputReceipts("root");
    assert.deepEqual(receipts.map((input) => input.inputId), ["z-legacy", "a-legacy"]);
    for (const input of receipts) { assert.equal(input.source, null); assert.equal(input.deliveredAt, null); assert.equal(input.acceptedAt, 10); }
    assert.equal(store.getActorInput("a-legacy", "root").state, "completed", "legacy completion remains idempotent, not inferred delivery");
    store.completeActorInput("a-legacy", "root", 30, "verified-entry");
    assert.equal(store.getActorInput("a-legacy", "root").delivery.state, "delivered");
  } finally { store.close(); }
});

test("idempotent recovery retains optional client correlation without changing acceptance", async (t) => {
  const { store } = await storeFixture(t);
  const original = store.createActorInput("root", { inputId: "existing", message: "work" }, 10);
  store.completeActorInput("existing", "root", 20, "entry");
  const correlated = store.createActorInput("root", { inputId: "existing", message: "work", clientMessageId: "browser" }, 30);
  assert.equal(correlated.clientMessageId, "browser"); assert.equal(correlated.sequence, original.sequence);
  assert.equal(correlated.acceptedAt, 10); assert.equal(correlated.deliveredAt, 20);
  assert.equal(store.createActorInput("root", { inputId: "existing", message: "work" }, 40).clientMessageId, "browser");
  assert.equal(store.getSession("root").lastActivityAt, 20);
});

test("receipt transport validators reject caller-supplied source and cross-session selectors", () => {
  for (const type of ["get_actor_input", "accept_actor_input", "record_input_delivery"]) {
    const params = { inputId: "input", ...(type === "record_input_delivery" ? { entryId: "entry", deliveredAt: new Date(30).toISOString() } : {}) };
    assert.equal(validateRequest({ version: PROTOCOL_VERSION, id: "request", type, params }).params.inputId, "input");
    for (const extra of [{ source: "cron" }, { sessionId: "other" }, { origin: { jobId: "fake" } }, { includeDigest: true }]) {
      assert.throws(() => validateRequest({ version: PROTOCOL_VERSION, id: "request", type, params: { ...params, ...extra } }), /not supported/);
    }
  }
});

test("handled controls retain their idempotent outcome without claiming model-context delivery", async (t) => {
  const fixture = await storeFixture(t);
  fixture.store.createActorInput("root", { inputId: "control", message: "/command exact args", clientMessageId: "browser" }, 10);
  const handled = fixture.store.markActorInputHandled("control", "root", 20);
  assert.equal(handled.outcome, "handled"); assert.equal(handled.handledAt, 20); assert.equal(handled.delivery.state, "accepted");
  assert.equal(handled.delivery.deliveredAt, null); assert.equal(handled.acceptedAt, 10); assert.equal(handled.clientMessageId, "browser");
  assert.deepEqual(fixture.store.listPendingActorInputs("root"), []);
  fixture.reopen();
  const repeated = fixture.store.createActorInput("root", { inputId: "control", message: "/command exact args", clientMessageId: "browser" }, 30);
  assert.equal(repeated.state, "completed"); assert.equal(repeated.outcome, "handled"); assert.equal(repeated.handledAt, 20);
  assert.equal(fixture.store.markActorInputAccepted("control", "root", 1, 40).outcome, "handled");
  assert.equal(fixture.store.markActorInputHandled("control", "root", 50).handledAt, 20);
  assert.throws(() => fixture.store.completeActorInput("control", "root", 60, "invented"), /handled without/);
  assert.equal(fixture.store.getSession("root").lastActivityAt, 20);
});

test("the queue flush barrier accepts no caller-controlled session or input fields", () => {
  const frame = { version: PROTOCOL_VERSION, type: "flush_actor_inputs", id: "request", params: {} };
  assert.deepEqual(validateRequest(frame).params, {});
  assert.throws(() => validateRequest({ ...frame, params: { sessionId: "other" } }), /not supported/);
});

test("only an actual supervisor job replay can restore missing legacy origin metadata", async (t) => {
  const fixture = await storeFixture(t);
  fixture.store.createActorInput("root", { inputId: "legacy-reservation", message: "ordinary payload" }, 10);
  const db = new DatabaseSync(fixture.databasePath); db.prepare("UPDATE actor_input_receipts SET source = NULL WHERE id = ?").run("legacy-reservation"); db.close();
  fixture.reopen();
  assert.equal(fixture.store.createActorInput("root", { inputId: "legacy-reservation", message: "ordinary payload" }, 20).source, null);
  const restored = fixture.store.createActorInput("root", { inputId: "legacy-reservation", message: "ordinary payload", source: "cron", origin: { jobId: "actual-job", runId: "actual-run" } }, 30);
  assert.equal(restored.source, "cron"); assert.deepEqual(restored.origin, { jobId: "actual-job", runId: "actual-run" });
  assert.equal(restored.acceptedAt, 10); assert.equal(fixture.store.getSession("root").lastActivityAt, 10);
});

