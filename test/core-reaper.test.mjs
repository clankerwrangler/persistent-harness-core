// The daily cleanup of stored tool output and reasoning (src/core-reaper.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreReaper, coreReap, REAP_AGE_SECONDS } from "../src/core-reaper.mjs";

async function folder(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "core-reaper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("each session folder is cleaned once per pass, sidecars and failures do not stop it", async (t) => {
  const dir = await folder(t);
  for (const name of ["a", "b", "c", "a.kernel-state", ".scratch"]) await mkdir(path.join(dir, name));
  await writeFile(path.join(dir, "a.skill-grant.json"), "{}");
  const asked = [], runs = [];
  const reaper = new CoreReaper({ sessionsDirectory: dir, onRun: (s) => runs.push(s), logger: { error() {} },
    reap: async (session, age) => {
      asked.push([path.basename(session), age]);
      if (path.basename(session) === "b") throw new Error("broken");
      return { deleted: ["log/000001.payload.jsonl"], bytes: 10 };
    } });
  const summary = await reaper.runOnce();
  assert.deepEqual(asked.map(([name]) => name).sort(), ["a", "b", "c"]);
  assert.ok(asked.every(([, age]) => age === REAP_AGE_SECONDS));
  assert.equal(REAP_AGE_SECONDS, 14 * 24 * 3600);
  assert.deepEqual(summary, { sessions: 3, files: 2, bytes: 20, failed: 1 });
  assert.deepEqual(runs, [summary]);
});

test("a missing sessions folder is an empty pass", async (t) => {
  const dir = await folder(t);
  const reaper = new CoreReaper({ sessionsDirectory: path.join(dir, "none"), reap: async () => assert.fail("nothing to clean") });
  assert.deepEqual(await reaper.runOnce(), { sessions: 0, files: 0, bytes: 0, failed: 0 });
});

test("passes repeat at the interval after the first delay and stop waits for a running pass", async (t) => {
  const dir = await folder(t);
  await mkdir(path.join(dir, "s"));
  let passes = 0, release;
  const reaper = new CoreReaper({ sessionsDirectory: dir, firstDelayMs: 5, intervalMs: 5, logger: { error() {} },
    reap: async () => { passes += 1; if (passes === 3) await new Promise((resolve) => { release = resolve; }); return { deleted: [], bytes: 0 }; } });
  reaper.start();
  while (passes < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  const stopped = reaper.stop();
  let done = false; void stopped.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, "stop waits for the pass in progress");
  release(); await stopped;
  const after = passes;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(passes, after, "no pass after stop");
});

const coreReady = Boolean(process.env.PI_HARNESS_CORE_BIN);

test("the core deletes only old unreferenced tool output, keeps messages and the current chunk", { skip: !coreReady && "core binary not configured" }, async (t) => {
  const dir = await folder(t), session = path.join(dir, "s");
  const old = "2026-01-01T00:00:00.000Z", now = new Date().toISOString();
  const line = (...values) => values.map((v) => JSON.stringify(v)).join("\n") + "\n";
  const tool = (n, t, key) => ({ n, t, k: "tool", m: { role: "toolResult", toolCallId: `c${n}`, toolName: "ipython",
    content: { $ref: { f: "payload", k: key } }, isError: false } });
  await mkdir(path.join(session, "log"), { recursive: true }); await mkdir(path.join(session, "checkpoints"));
  await writeFile(path.join(session, "meta.json"), JSON.stringify({ format: 1, id: "s", created: old }));
  await writeFile(path.join(session, "log/000001.jsonl"), line({ n: 1, t: old, k: "chunk" }, tool(2, old, "2.0")));
  await writeFile(path.join(session, "log/000001.payload.jsonl"), line({ key: "2.0", v: [{ type: "text", text: "old output" }] }));
  await writeFile(path.join(session, "log/000001.reasoning.jsonl"), line({ key: "2.r", v: "old thinking" }));
  await writeFile(path.join(session, "log/000002.jsonl"), line({ n: 3, t: now, k: "chunk" }, { n: 4, t: now, k: "checkpoint", id: "c1" }, tool(5, now, "5.0")));
  await writeFile(path.join(session, "log/000002.payload.jsonl"), line({ key: "5.0", v: [{ type: "text", text: "current" }] }));
  await writeFile(path.join(session, "checkpoints/c1.json"), JSON.stringify({ id: "c1", through: 4,
    messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }] }));
  const result = await coreReap(session, REAP_AGE_SECONDS);
  assert.deepEqual(result.deleted, ["log/000001.payload.jsonl", "log/000001.reasoning.jsonl"]);
  assert.ok(result.bytes > 0);
  assert.ok(existsSync(path.join(session, "log/000001.jsonl")), "messages stay");
  assert.ok(existsSync(path.join(session, "log/000002.payload.jsonl")), "the current chunk stays");
  assert.deepEqual((await coreReap(session, REAP_AGE_SECONDS)).deleted, [], "a second pass finds nothing");
  await assert.rejects(coreReap(path.join(dir, "missing"), REAP_AGE_SECONDS));
});
