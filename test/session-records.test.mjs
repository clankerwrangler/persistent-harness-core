import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRecords } from "../src/session-records.mjs";
import { CoreTranscriptReader } from "../src/core-transcript-reader.mjs";
import { RECOVERY_DETAIL_FIELDS } from "../src/python-recovery-fields.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 10, 15, 10, 0, seconds)).toISOString();
const entries = [
  { type: "message", id: "0", timestamp: at(0), message: { role: "user", content: [{ type: "text", text: "Where is the backup log?" }], timestamp: Date.parse(at(0)) } },
  { type: "message", id: "1", timestamp: at(1), message: { role: "assistant", content: [{ type: "text", text: "In /var/log." }], timestamp: Date.parse(at(1)), stopReason: "stop" } },
];

/** A stand-in for the core binary: `history <dir> [from to]` prints these entries. */
async function fakeCore(t, script = null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-records-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "core");
  await writeFile(bin, script ?? `#!${process.execPath}
const [op, , from, to] = process.argv.slice(2);
if (op !== "history") process.exit(9);
const all = ${JSON.stringify(entries)};
const lo = from === undefined ? 0 : Number(from), hi = to === undefined ? Infinity : Number(to);
process.stdout.write(JSON.stringify(all.filter(e => Number(e.id) >= lo && Number(e.id) <= hi)));
`);
  await chmod(bin, 0o755);
  return { env: { ...process.env, PI_HARNESS_CORE_BIN: bin }, dir };
}

test("the supervisor's reads are answered by the session half's one-off reader, as the reader itself answers them", async (t) => {
  const { env, dir } = await fakeCore(t);
  const records = new SessionRecords({ env });
  const local = new CoreTranscriptReader({ history: async (file, range) => {
    const { coreSessionHistory } = await import("../src/core-transcript-reader.mjs");
    return coreSessionHistory(file, range, env);
  } });
  const sessionFile = path.join(dir, "session");
  const options = { sessionFile, sessionId: "s", publicView: true };
  assert.deepEqual(await records.read(options), await local.read(options));
  const page = await records.read(options);
  assert.deepEqual(page.messages.map((message) => message.text), ["Where is the backup log?", "In /var/log."]);
  assert.deepEqual(await records.searchable(sessionFile, { from: 1, to: 5 }, false),
    { last: 1, messages: [{ id: "1", n: 1, role: "assistant", text: "In /var/log.", createdAt: at(1) }] });
  assert.deepEqual(await records.searchable(sessionFile, { from: 7, to: 9 }, false), { last: null, messages: [] });
  assert.deepEqual(await records.recoveryFields(), [...RECOVERY_DETAIL_FIELDS]);
});

test("the reader asks the supervisor for the receipts of the inputs it finds, once each", async (t) => {
  const marked = [{ ...entries[0], message: { ...entries[0].message,
    content: [{ type: "text", text: "Where is the backup log?\n\n<!-- persistent-harness-input:in-1 -->" }] } }, entries[1]];
  const { env, dir } = await fakeCore(t, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(marked))});\n`);
  const asked = [];
  const records = new SessionRecords({ env, inputReceiptReader: (id, sessionId) => { asked.push([id, sessionId]); return null; } });
  const page = await records.read({ sessionFile: path.join(dir, "session"), sessionId: "s" });
  assert.deepEqual(asked, [["in-1", "s"]]);
  assert.deepEqual(page.inputAssociationStates, { "in-1": "absent" }, "no receipt: the input is not proven");
  asked.length = 0;
  await records.read({ sessionFile: path.join(dir, "session"), sessionId: "s", inputProofIds: ["other"] });
  assert.deepEqual(asked, [], "only the inputs asked about are looked up");
});

test("a failure in the session half reaches the supervisor as an error, and a stuck reader is stopped", async (t) => {
  const failing = await fakeCore(t, `#!${process.execPath}\nprocess.stderr.write("no such session"); process.exit(3);\n`);
  await assert.rejects(new SessionRecords({ env: failing.env }).read({ sessionFile: path.join(failing.dir, "s"), sessionId: "s" }),
    /no such session|Command failed/);
  const stuck = await fakeCore(t, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await assert.rejects(new SessionRecords({ env: stuck.env, timeoutMs: 300 }).read({ sessionFile: path.join(stuck.dir, "s"), sessionId: "s" }),
    /did not answer in time/);
  await assert.rejects(new SessionRecords({ env: failing.env }).searchable(path.join(failing.dir, "s"), { from: "x" }, false));
});

test("a request of another version is refused by the session half", async (t) => {
  const { env } = await fakeCore(t);
  const { spawn } = await import("node:child_process");
  const reader = new URL("../bin/session-records.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [reader], { env, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(`${JSON.stringify({ version: 999, op: "recovery_fields" })}\n`);
  let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (text) => { out += text; });
  await new Promise((resolve) => child.once("close", resolve));
  assert.match(JSON.parse(out).message, /version 999 is not 1/);
});
