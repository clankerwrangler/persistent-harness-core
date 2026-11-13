import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { CoreTranscriptReader } from "../src/core-transcript-reader.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";
import { normalizeInputImages } from "../src/input-images.mjs";

const image = normalizeInputImages([{ type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }])[0];
class ReceiptActor extends EventEmitter {
  constructor(options, ready) { super(); this.session = options.session; this.ready = ready;
    this.pid = process.pid; this.isRunning = false; this.submits = []; this.closes = 0; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
    isStreaming: false, model: null, thinkingLevel: "off" }; }
  async start() { await this.ready; this.isRunning = true; return this.state(); }
  async request(type) { assert.equal(type, "get_state", "Proven historical internal input must not be delivered again"); return this.state(); }
  async submit(message, behavior, images, inputId) { this.submits.push({ message, behavior, images, inputId }); return { outcome: "accepted" }; }
  send() {}
  async close() { if (!this.isRunning) return; this.closes += 1; this.isRunning = false;
    this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}
async function eventually(predicate) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("Receipt reconciliation did not complete within the fixture bound");
}

// A session's history as the core hands it out (complete entries, one line, no branches).
function coreHistories() {
  const histories = new Map();
  const of = file => { if (!histories.has(file)) histories.set(file, []); return histories.get(file); };
  return { of, reader: store => new CoreTranscriptReader({ history: async file => structuredClone(of(file)),
    inputReceiptReader: (inputId, sessionId) => store().getActorInput(inputId, sessionId, { includeDigest: true }) }) };
}

test("supervisor recovers historical inputs from core history, skips only ambiguity, and rechecks without replay", { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "receipt-reader-supervisor-"));
  const skillsPath = path.join(directory, "skills"); await mkdir(skillsPath);
  const ready = Promise.withResolvers(), actors = [], socketPath = path.join(directory, "supervisor.sock");
  const histories = coreHistories();
  let client;
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "harness.sqlite"),
    pidPath: path.join(directory, "supervisor.pid"), logPath: path.join(directory, "supervisor.jsonl"), skillsPath,
    actorInactivityMs: 0, backgroundJobsDirectory: path.join(directory, "background"), runtimeProvisioner: async () => ({}),
    transcriptReader: histories.reader(() => supervisor.store),
    actorFactory: options => { const actor = new ReceiptActor(options, ready.promise); actors.push(actor); return actor; },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "fixture", ownerToken: "fixture" }),
    processTerminator: async () => ({ terminated: true }) });
  t.after(async () => { ready.resolve(); await client?.stop(); await supervisor.stop(); await rm(directory, { recursive: true, force: true }); });
  await supervisor.start(); client = new HarnessClient({ requestTimeoutMs: 120_000, socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "receipt-reader-integration" });
  const { admission } = await client.request("create_root", { cwd: directory, repositoryRoot: null, name: "Receipt reader integration",
    provider: null, model: null, thinkingLevel: null });
  const sessionId = admission.sessionId;
  const inputEvents = []; let inputEventOverflow = false;
  client.on("event", frame => {
    if (frame.event !== "actor_event" || frame.data?.sessionId !== sessionId || frame.data.event?.type !== "input_state") return;
    if (inputEvents.length < 16) inputEvents.push(frame.data.event.message); else inputEventOverflow = true;
  });
  await client.request("subscribe_session", { selector: sessionId, passive: true });
  const deliveredEvents = inputId => inputEvents.filter(message => message.id === inputId && message.delivery?.state === "delivered");
  const canonicalImages = entryId => [{ type: "image", mimeType: image.mimeType, name: "Pasted image 1",
    size: Buffer.from(image.data, "base64").length, ref: { entryId, index: 0 },
    contentHash: "f11fb145fb56636723b20f30e40aaac672e9de2c9677de363551d82668cbd5cd" }];
  const history = histories.of(supervisor.store.getSession(sessionId).sessionFile);
  const now = Date.now(), timestamp = new Date(now + 1).toISOString(), suffix = inputId => `\n\n<!-- persistent-harness-input:${inputId} -->`;
  const reserve = (inputId, message, extra = {}) => supervisor.store.createActorInput(sessionId, { inputId, message, images: [image], ...extra }, now);
  const native = reserve("historical-native", "/template raw input");
  const legacy = reserve("historical-cron", "Scheduled original work", { source: "cron", origin: { jobId: "job", runId: "run" } });
  const custom = reserve("historical-background", "Completed original work", { source: "background", origin: { jobId: "job" } });
  const activeInput = reserve("active-canonical", "Raw ordinary active body");
  const ambiguous = reserve("ambiguous", "Ambiguous exact body", { behavior: "follow_up" });
  const absent = reserve("absent", "An actually absent user input");
  const user = (id, text, inputId) => ({ type: "message", id, timestamp,
    message: { role: "user", ...(inputId ? { id: inputId } : {}), content: [{ type: "text", text }, image], timestamp: now + 1 } });
  history.push(user("native-original", "Expanded original body" + suffix("literal-expansion"), native.inputId),
    user("legacy-original", legacy.message + suffix(legacy.inputId)),
    { type: "custom_message", id: "custom-original", timestamp, ...actorInputCustomPayload(custom) },
    user("active-original", "Expanded ordinary active body", activeInput.inputId),
    user("weak-a", ambiguous.message + suffix(ambiguous.inputId)),
    user("weak-b", ambiguous.message + suffix(ambiguous.inputId)),
    user("native-quotation", native.message + suffix(native.inputId)));
  const historyBefore = structuredClone(history), pendingBefore = supervisor.store.getActorInput(ambiguous.inputId, sessionId);
  ready.resolve(); await client.request("get_actor_state", { sessionId });
  const actor = actors[0];
  await eventually(() => (actor.submits.length === 1 && deliveredEvents(activeInput.inputId).length > 0) || actor.closes > 0);
  // Only the input absent from history is delivered; the rest are proven from history.
  assert.deepEqual(actor.submits.map(input => input.inputId), [absent.inputId]); assert.equal(actor.closes, 0); assert(actor.isRunning);
  for (const [input, entryId] of [[native, "native-original"], [legacy, "legacy-original"], [custom, "custom-original"], [activeInput, "active-original"]]) {
    const receipt = supervisor.store.getActorInput(input.inputId, sessionId);
    assert.equal(receipt.state, "completed"); assert.equal(receipt.entryId, entryId); assert.equal(receipt.delivery.state, "delivered");
  }
  assert.equal(deliveredEvents(activeInput.inputId).length, 1, "Delivery publishes once");
  assert.equal(deliveredEvents(activeInput.inputId)[0].text, "Expanded ordinary active body");
  assert.deepEqual(deliveredEvents(activeInput.inputId)[0].images, canonicalImages("active-original"));
  assert.deepEqual(supervisor.store.getActorInput(ambiguous.inputId, sessionId), pendingBefore, "Two weak matches stay unresolved");
  assert.deepEqual(history, historyBefore, "Reconciliation never rewrites history");
  const view = await client.request("get_visible_messages", { sessionId });
  for (const field of ["inputAssociationStates", "inputIds", "inputEntries", "inputDeliveries"]) assert.equal(Object.hasOwn(view, field), false);
  const quotation = view.messages.find(row => row.id === "native-quotation");
  assert.equal(quotation.text, native.message + suffix(native.inputId)); assert.equal(quotation.delivery, undefined);
  assert.equal(view.messages.find(row => row.id === ambiguous.inputId).delivery.state, "accepted");
  // A later strong match resolves the ambiguity without redelivering anything.
  const strong = user("resolved-native", "Actual transformed ambiguity resolution", ambiguous.inputId);
  history.push(strong);
  await client.request("submit_input", { sessionId, message: "Continue unrelated work", behavior: "auto", clientRequestId: "valid-next" });
  await eventually(() => supervisor.store.getActorInput(ambiguous.inputId, sessionId).state === "completed"
    && actor.submits.length === 2 && deliveredEvents(ambiguous.inputId).length > 0);
  assert.equal(supervisor.store.getActorInput(ambiguous.inputId, sessionId).entryId, strong.id);
  assert.equal(actor.submits[1].message, "Continue unrelated work");
  assert(![native.inputId, legacy.inputId, custom.inputId, ambiguous.inputId].includes(actor.submits[1].inputId));
  await client.request("get_visible_messages", { sessionId });
  assert.equal(deliveredEvents(ambiguous.inputId).length, 1, "Resolution publishes once");
  const resolvedEvent = deliveredEvents(ambiguous.inputId)[0];
  assert.equal(resolvedEvent.entryId, strong.id); assert.equal(resolvedEvent.text, "Actual transformed ambiguity resolution");
  assert.deepEqual(resolvedEvent.images, canonicalImages(strong.id));
  assert.equal(resolvedEvent.createdAt, resolvedEvent.delivery.deliveredAt);
  assert.equal(deliveredEvents(activeInput.inputId).length, 1);
  assert.equal(inputEventOverflow, false, "The fixture records a bounded set of input updates");
  assert.equal(actor.closes, 0); assert.equal(actors.length, 1); assert.equal(supervisor.store.getSession(sessionId).lifecycle, "resident");
  const log = await readFile(path.join(directory, "supervisor.jsonl"), "utf8");
  assert.match(log, /actor_input_unresolved/); assert.doesNotMatch(log, /Ambiguous exact body|Scheduled original work|Completed original work|"digest"/);
});
