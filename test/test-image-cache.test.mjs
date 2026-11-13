// Test the test-image script's ownership and cleanup without a Docker daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(import.meta.dirname, "../bin/test-image.sh");
const fakeDocker = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1:$2" in
  image:inspect) exit 1 ;;
  buildx:create) [ "$FAKE_MODE" != createfail ] || exit 23 ;;
  buildx:build)
    [ "$FAKE_MODE" != buildfail ] || exit 17
    if [ "$FAKE_MODE" = hang ]; then exec sleep 30; fi ;;
esac
exit 0
`;

async function fixture(t, mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-build-cache-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"), seed = path.join(dir, "seed"), log = path.join(dir, "docker.log");
  await mkdir(bin); await mkdir(seed);
  await writeFile(path.join(bin, "docker"), fakeDocker);
  await chmod(path.join(bin, "docker"), 0o755);
  const child = spawn("sh", [script, "--core", dir, "--cpus", "0.5", "unit"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HARNESS_RUNTIME_SEED: seed, FAKE_LOG: log, FAKE_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, ended, log, stderr: () => stderr };
}

async function calls(log) {
  return (await readFile(log, "utf8")).trim().split("\n");
}

function builderOf(lines) {
  const create = lines.find((s) => s.startsWith("buildx create "));
  assert.ok(create, "a private builder is created");
  return /--name (\S+)/.exec(create)[1];
}

test("successful test builds remove only their private builder cache", async (t) => {
  const a = await fixture(t, "success"), b = await fixture(t, "success");
  assert.equal((await a.ended).code, 0); assert.equal((await b.ended).code, 0);
  const lines = await calls(a.log), other = await calls(b.log), builder = builderOf(lines);
  assert.notEqual(builder, builderOf(other));
  const build = lines.findIndex((s) => s.startsWith(`buildx build --builder ${builder} --load `));
  const remove = lines.findIndex((s) => s === `buildx rm ${builder}`);
  const run = lines.findIndex((s) => s.startsWith("run --rm "));
  assert.ok(build >= 0 && build < remove && remove < run, "the image is loaded before removing the builder and running tests");
  assert.ok(lines[run].includes("--network none") && lines[run].includes("--cpus 0.5"));
  assert.ok(!lines.some((s) => /(^| )prune( |$)/.test(s)), "no shared cache or images are pruned");
});

test("failed builds remove their builder without starting tests", async (t) => {
  const f = await fixture(t, "buildfail");
  assert.equal((await f.ended).code, 17);
  const lines = await calls(f.log), builder = builderOf(lines);
  assert.ok(lines.includes(`buildx rm ${builder}`));
  assert.ok(!lines.some((s) => s.startsWith("run ")));
});

test("failed builder creation never removes a builder it did not create", async (t) => {
  const f = await fixture(t, "createfail");
  assert.equal((await f.ended).code, 23);
  assert.ok(!(await calls(f.log)).some((s) => s.startsWith("buildx rm ")));
});

test("a signal stops the owned build and removes its builder", async (t) => {
  const f = await fixture(t, "hang");
  t.after(() => { if (f.child.exitCode === null) f.child.kill("SIGKILL"); });
  const deadline = Date.now() + 5000;
  let lines = [];
  while (Date.now() < deadline) {
    lines = await calls(f.log).catch(() => []);
    if (lines.some((s) => s.startsWith("buildx build "))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(lines.some((s) => s.startsWith("buildx build ")), "build reached its wait");
  f.child.kill("SIGTERM");
  assert.equal((await f.ended).code, 143);
  lines = await calls(f.log);
  assert.ok(lines.includes(`buildx rm ${builderOf(lines)}`));
  assert.ok(!lines.some((s) => s.startsWith("run ")));
});
