import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

const support = path.resolve(import.meta.dirname, "../python-runtime");

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) if (entry.isFile()) out.push(entry.name);
  return out;
}

test("a real kernel keeps IPython history in memory and writes no history file", { timeout: 360000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-history-file-"));
  const ipythonDir = path.join(root, "ipython");
  const previousIpythonDir = process.env.IPYTHONDIR; process.env.IPYTHONDIR = ipythonDir;
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: [], consent: async () => true });
  const kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(support, "kernel.py"), runtimeSupportDir: support,
    cwd: root, stateDir: path.join(root, "state"), manifest: { version: 1, skills: [] }, hostHandlers: {} });
  t.after(async () => {
    kernel.interrupt(); await kernel.close({ snapshot: false });
    if (previousIpythonDir === undefined) delete process.env.IPYTHONDIR; else process.env.IPYTHONDIR = previousIpythonDir;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  assert.equal((await kernel.execute("value = 41")).ok, true);
  const result = await kernel.execute("print(get_ipython().history_manager.enabled, 'value = 41' in In)");
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.match(JSON.stringify(result), /False True/);
  assert.equal((await filesUnder(ipythonDir)).includes("history.sqlite"), false);
});
