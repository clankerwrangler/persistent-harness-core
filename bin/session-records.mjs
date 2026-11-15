#!/usr/bin/env node
// "Read my records": a one-off the supervisor starts to read a session's conversation
// records. It is session code, loaded fresh for each read, so a session-only update reaches
// it without restarting the supervisor; nothing else knows the records' shapes.
// JSON lines on stdin and stdout (session-channel.mjs): one request comes in
// ({ version, op, ... }); the reader may ask for input receipts
// ({ type: "receipts", sessionId, ids }, answered { type: "receipts", receipts: { id: receipt | null } });
// then one { type: "result", value } or { type: "error", message } goes out and it exits.
import { Console } from "node:console";
import { enableActorCompileCache } from "../src/actor-compile-cache.mjs";

// stdout is only the reply. Everything else goes to stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
enableActorCompileCache();
const { SESSION_RECORDS_VERSION, sessionLineDecoder } = await import("../src/session-channel.mjs");
const { CoreTranscriptReader } = await import("../src/core-transcript-reader.mjs");

const decoder = sessionLineDecoder();
const queued = [], waiting = [];
let ended = false;
process.stdin.on("data", (chunk) => {
  for (const value of decoder.push(chunk)) (waiting.shift() ?? ((line) => queued.push(line)))(value);
});
process.stdin.on("end", () => { ended = true; for (const resolve of waiting.splice(0)) resolve(null); });
const nextLine = () => queued.length ? Promise.resolve(queued.shift()) : ended ? Promise.resolve(null)
  : new Promise((resolve) => waiting.push(resolve));
const send = (value) => new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));

async function answer(request) {
  if (request?.version !== SESSION_RECORDS_VERSION) {
    throw new Error(`records request version ${String(request?.version)} is not ${SESSION_RECORDS_VERSION}`);
  }
  const reader = new CoreTranscriptReader({
    inputReceipts: async (ids, sessionId) => {
      await send({ type: "receipts", sessionId, ids });
      const reply = await nextLine();
      if (reply?.type !== "receipts" || !reply.receipts || typeof reply.receipts !== "object") throw new Error("no input receipts came back");
      return new Map(ids.map((id) => [id, reply.receipts[id] ?? null]));
    },
  });
  switch (request.op) {
    case "read": return reader.read(request.options);
    case "image": return reader.readImage(request.options);
    case "searchable": return reader.searchable(request.sessionFile, request.range ?? {}, request.sanitizePresentation === true);
    case "recovery_fields": return reader.recoveryFields();
    default: throw new Error(`unknown records request: ${String(request.op)}`);
  }
}

try {
  const value = await answer(await nextLine());
  await send({ type: "result", value });
} catch (error) {
  await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
process.stdin.destroy();
