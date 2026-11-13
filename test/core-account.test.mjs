import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coreAuthArgs, coreSignIn, coreUsage } from "../src/core-account.mjs";
import { coreArgs, coreBinary, coreLibraryPath, coreSessionsDirectory } from "../src/core-session.mjs";

/** A stand-in core: records its arguments, then answers as FAKE_MODE says. */
async function fakeCore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "core-account-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "core");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE;
if (mode === "usage") console.log(JSON.stringify({ provider: process.argv[3], model: null, status: "ready", remaining: { kind: "rate_limits", percentUsed: 40 } }));
else if (mode === "broken") { console.log("not json"); }
else if (mode === "fail") process.exit(2);
else if (mode === "signin") { console.log(JSON.stringify({ step: "device_code", url: "https://example.test/device", code: "ABCD-1234", expiresIn: 900 })); setTimeout(() => console.log(JSON.stringify({ done: "signed in" })), 50); }
else if (mode === "refused") { console.log(JSON.stringify({ error: "device code login is not enabled" })); process.exit(1); }
else if (mode === "hang") { console.log(JSON.stringify({ step: "device_code", url: "https://example.test/device", code: "WXYZ-0000", expiresIn: 900 })); setInterval(() => {}, 1000); }
`.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
  await chmod(bin, 0o755);
  const env = (mode, extra = {}) => ({ ...process.env, PI_HARNESS_CORE_BIN: bin, FAKE_MODE: mode, ...extra });
  return { env, args: async () => JSON.parse(await readFile(path.join(dir, "args.json"), "utf8")) };
}

test("the sessions' credentials file is passed on; none means the agent folder's core/auth.json", () => {
  assert.deepEqual(coreAuthArgs({ PI_HARNESS_CORE_ARGS: JSON.stringify(["--models", "m.json", "--auth", "/a/auth.json"]) }), ["--auth", "/a/auth.json"]);
  assert.deepEqual(coreAuthArgs({ PI_CODING_AGENT_DIR: "/agent" }), ["--auth", path.resolve("/agent/core/auth.json")]);
  assert.deepEqual(coreAuthArgs({ PI_HARNESS_CORE_ARGS: "not json" }), []);
});

test("every core runs with the agent folder's instructions and the core home's sign-ins and catalog", async (t) => {
  const agent = await mkdtemp(path.join(os.tmpdir(), "core-args-"));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const home = path.join(agent, "core");
  assert.deepEqual(coreArgs({ PI_CODING_AGENT_DIR: agent }),
    ["--agent-dir", agent, "--auth", path.join(home, "auth.json"), "--catalog", path.join(home, "catalog")]);
  await mkdir(home); await writeFile(path.join(home, "models.json"), '{"models": {}}');
  assert.deepEqual(coreArgs({ PI_CODING_AGENT_DIR: agent }).slice(-2), ["--models", path.join(home, "models.json")]);
  // A flag given in PI_HARNESS_CORE_ARGS replaces its default instead of repeating it.
  assert.deepEqual(coreArgs({ PI_CODING_AGENT_DIR: agent, PI_HARNESS_CORE_ARGS: JSON.stringify(["--auth", "/a/auth.json"]) }),
    ["--agent-dir", agent, "--catalog", path.join(home, "catalog"), "--models", path.join(home, "models.json"), "--auth", "/a/auth.json"]);
  assert.equal(coreBinary({ PI_CODING_AGENT_DIR: agent }), path.join(home, "bin", "core"));
  assert.equal(coreLibraryPath({ PI_CODING_AGENT_DIR: agent }), path.join(home, "js", "core.mjs"));
  assert.equal(coreSessionsDirectory({ PI_CODING_AGENT_DIR: agent }), path.join(home, "sessions"));
  assert.throws(() => coreArgs({ PI_HARNESS_CORE_ARGS: '["--auth", 1]' }), /JSON list of strings/);
});

test("remaining usage is asked of the core; a failing or garbled answer reads as unavailable", async (t) => {
  const fake = await fakeCore(t);
  const auth = { PI_HARNESS_CORE_ARGS: JSON.stringify(["--auth", "/a/auth.json"]) };
  assert.deepEqual(await coreUsage("openai-codex", { env: fake.env("usage", auth) }),
    { provider: "openai-codex", model: null, status: "ready", remaining: { kind: "rate_limits", percentUsed: 40 } });
  assert.deepEqual(await fake.args(), ["usage", "openai-codex", "--auth", "/a/auth.json"]);
  for (const mode of ["broken", "fail"]) {
    assert.deepEqual(await coreUsage("grok-cli", { env: fake.env(mode) }), { provider: "grok-cli", model: null, status: "unavailable", remaining: null });
  }
});

test("signing in shows the device code, then finishes when the core has saved it", async (t) => {
  const fake = await fakeCore(t);
  const steps = [];
  await coreSignIn("openai-codex", { env: fake.env("signin"), onStep: (step) => steps.push(step) });
  assert.deepEqual(steps, [{ url: "https://example.test/device", code: "ABCD-1234", expiresIn: 900 }]);
  // The sign-in goes to the same credentials file the sessions' cores use.
  assert.deepEqual(await fake.args(), ["login", "openai-codex", "device", "--json", ...coreAuthArgs(fake.env("signin"))]);
  await assert.rejects(coreSignIn("openai-codex", { env: fake.env("refused") }), /device code login is not enabled/);
});

test("a sign-in can be stopped while it waits for the code to be entered", async (t) => {
  const fake = await fakeCore(t);
  const controller = new AbortController();
  const running = coreSignIn("openai-codex", { env: fake.env("hang"), signal: controller.signal,
    onStep: () => controller.abort() });
  await assert.rejects(running, /aborted/);
});
