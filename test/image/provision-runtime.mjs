// Install the managed Python runtime for this checkout's skills into the test image.
//   node provision-runtime.mjs <runtime-dir>
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PythonRuntimeManager } from "./src/python-runtime.mjs";
import { discoverSkillsFromDirectory } from "./src/skills.mjs";

const [runtimeDir] = process.argv.slice(2);
if (!runtimeDir) throw new Error("usage: node provision-runtime.mjs <runtime-dir>");
const catalog = await discoverSkillsFromDirectory(path.resolve("skills"));
if (catalog.diagnostics.length) throw new Error(catalog.diagnostics.map((item) => item.error).join("\n"));
const runtime = await new PythonRuntimeManager({ runtimeDir }).ensure({
  skills: catalog.skills,
  consent: async () => true,
  onProgress: (message) => { if (message) console.log(message); },
});
// Packages tests install offline into fresh environments (the kernel test's changed
// skill), fetched now into the runtime's cache, which tests copy as their seed.
const scratch = await mkdtemp(path.join(os.tmpdir(), "seed-cache-"));
execFileSync(path.join(runtimeDir, "bin", "uv-0.12.3"), ["pip", "install", "--python", runtime.pythonPath, "--target", scratch,
  "six==1.17.0", "--cache-dir", path.join(runtimeDir, "cache"), "--no-config", "--no-progress"], { stdio: "inherit" });
await rm(scratch, { recursive: true, force: true });
// One fixed path for the tests (PI_HARNESS_PYTHON), whatever the environment's name. A
// script, not a symlink: Python finds its environment from the path it is started by.
await writeFile(path.join(runtimeDir, "test-python"), `#!/bin/sh\nexec ${JSON.stringify(runtime.pythonPath)} "$@"\n`, { mode: 0o755 });
console.log(`python runtime: ${runtime.pythonPath}`);
