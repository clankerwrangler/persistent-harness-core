#!/usr/bin/env node
// Run the test suite with private, offline state and auto-discovered Python.
//
//   node bin/run-tests.mjs [unit|integration|all] [test files...]
//
// unit:        tests that need neither the core nor Python (everything not listed in test/integration-files.txt)
// integration: tests listed in test/integration-files.txt; they need the conversation core and the managed Python
// Missing the core or Python skips the groups that need them, with the reason, instead of failing.
// bin/test-image.sh runs everything in an image that has both.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const checkout = path.resolve(import.meta.dirname, "..");
const [group = "all", ...explicit] = process.argv.slice(2);
if (!["unit", "integration", "all"].includes(group)) {
  console.error("usage: node bin/run-tests.mjs [unit|integration|all] [test files...]");
  process.exit(2);
}
const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

function discoverPython() {
  if (process.env.PI_HARNESS_PYTHON) return process.env.PI_HARNESS_PYTHON;
  const environments = path.join(agentDir, "harness/kernel-runtime/environments");
  if (!existsSync(environments)) return null;
  for (const name of readdirSync(environments).sort()) {
    const python = path.join(environments, name, "bin/python");
    if (existsSync(python)) return python;
  }
  return null;
}

// Managed-runtime tests provision Python from scratch; offline they need the uv binary,
// its cache and the installed interpreter. Copy them (never the live environments) so
// the tests cannot write into the live runtime.
function prepareManagedSeed(seedDir) {
  if (process.env.PI_HARNESS_TEST_MANAGED_SEED) return process.env.PI_HARNESS_TEST_MANAGED_SEED;
  const runtime = path.join(agentDir, "harness/kernel-runtime");
  const parts = ["bin", "cache", "python"];
  if (!parts.every((part) => existsSync(path.join(runtime, part)))) return null;
  for (const part of parts) cpSync(path.join(runtime, part), path.join(seedDir, part), { recursive: true, verbatimSymlinks: true });
  return seedDir;
}

const integration = new Set(readFileSync(path.join(checkout, "test/integration-files.txt"), "utf8")
  .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
const all = readdirSync(path.join(checkout, "test")).filter((name) => name.endsWith(".test.mjs")).sort();
const python = discoverPython();
// Sessions run on the conversation core: the integration group needs it and Python.
const core = Boolean(process.env.PI_HARNESS_CORE_BIN && process.env.PI_HARNESS_CORE_JS);
const missing = [!core && "the conversation core (set PI_HARNESS_CORE_BIN and PI_HARNESS_CORE_JS)", !python && "Python runtime (set PI_HARNESS_PYTHON)"].filter(Boolean);

let files;
if (explicit.length) files = explicit.map((file) => path.relative(path.join(checkout, "test"), path.resolve(file)));
else {
  files = [];
  if (group === "unit" || group === "all") files.push(...all.filter((name) => !integration.has(name)));
  if (group === "integration" || group === "all") files.push(...all.filter((name) => integration.has(name)));
}
const needsSetup = (name) => integration.has(name);
if (missing.length) {
  const skipped = files.filter(needsSetup);
  if (skipped.length) console.log(`skipped ${skipped.length} test file(s) that need ${missing.join(" and ")}`);
  files = files.filter((name) => !needsSetup(name));
}
if (!files.length) { console.log("no test files to run"); process.exit(0); }

const home = mkdtempSync(path.join(os.tmpdir(), "harness-tests-"));
const seedUsers = files.filter((name) => readFileSync(path.join(checkout, "test", name), "utf8").includes("PI_HARNESS_TEST_MANAGED_SEED"));
const managedSeed = seedUsers.length ? prepareManagedSeed(path.join(home, "managed-seed")) : null;
const env = {
  ...process.env,
  HOME: path.join(home, "home"),
  PI_CODING_AGENT_DIR: path.join(home, "agent"),
  // Tests must never download a runtime as a side effect.
  PI_HARNESS_AUTO_INSTALL: "0", UV_OFFLINE: "1",
  // Tests wait on background completion scans; the production 5 s cadence only slows them.
  PI_HARNESS_BACKGROUND_COMPLETION_TICK_MS: process.env.PI_HARNESS_BACKGROUND_COMPLETION_TICK_MS ?? "100",
  PI_HARNESS_SKILLS_PATH: process.env.PI_HARNESS_SKILLS_PATH ?? path.join(checkout, "skills"),
  PI_HARNESS_PRESENTATION_NAMESPACE: process.env.PI_HARNESS_PRESENTATION_NAMESPACE ?? "harness",
  ...(python ? { PI_HARNESS_PYTHON: python } : {}),
  ...(managedSeed ? { PI_HARNESS_TEST_MANAGED_SEED: managedSeed } : {}),
};
try {
  // Files run in separate processes with private temporary state, so a few can run at once.
  // Keep it modest: the suite shares the machine with live sessions.
  const concurrency = process.env.PI_HARNESS_TEST_CONCURRENCY ?? "3";
  // A test that hangs fails after this long instead of holding the whole run (tests may set their own).
  const timeout = process.env.PI_HARNESS_TEST_TIMEOUT_MS ?? "300000";
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, `--test-timeout=${timeout}`, ...files.map((name) => path.join("test", name))],
    { cwd: checkout, env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
