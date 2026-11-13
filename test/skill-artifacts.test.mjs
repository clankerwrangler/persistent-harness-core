import assert from "node:assert/strict";
import fs, { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { HarnessClient } from "../src/client.mjs";
import { publishActorGenerationSkillGrant, sessionSidecarPaths } from "../src/session-paths.mjs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkills, manifestForSkills, materializeSkills, verifyManifest } from "../src/skills.mjs";
import { prepareSkillArtifact, skillArtifactLocation, verifySkillArtifact } from "../src/skill-artifacts.mjs";
import { PythonRuntimeManager, runtimeVersions } from "../src/python-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-artifacts-"));
  const beforeCleanup = [];
  t.after(async () => {
    try { for (const cleanup of beforeCleanup) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const source = path.join(root, "source"), artifactRoot = path.join(root, "objects");
  await mkdir(path.join(source, "src", "demo"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: demo\ndescription: Synthetic artifact.\n---\n\n# Demo\n");
  await writeFile(path.join(source, "pyproject.toml"), '[project]\nname = "demo"\nversion = "1"\ndependencies = []\n[tool.persistent-harness]\nid = "demo"\nimport-name = "demo"\nalias = "demo"\nentry-point = "run"\nhost-requests = ["demo.echo"]\n');
  await writeFile(path.join(source, "src", "demo", "__init__.py"), 'def run():\n    return "first"\n');
  const discover = async () => {
    const catalog = await discoverSkills([{ source: "skill", path: path.join(source, "SKILL.md") }]);
    assert.deepEqual(catalog.diagnostics, []); return catalog.skills;
  };
  return { root, source, artifactRoot, beforeCleanup, discover, freeze: async () => materializeSkills(await discover(), { artifactRoot }) };
}

test("shared immutable artifacts retain raw source identity and old generation bytes", async t => {
  const f = await fixture(t), source = await f.discover(), [first] = await f.freeze();
  assert.equal(first.contentHash, source[0].contentHash);
  assert.notEqual(first.skillPath, source[0].skillPath);
  assert.equal(first.python.srcPath, path.join(path.dirname(first.skillPath), "src"));
  const old = manifestForSkills([first]);
  await writeFile(path.join(f.source, "src", "demo", "__init__.py"), 'def run():\n    return "second"\n');
  const [second] = await f.freeze();
  assert.notEqual(second.skillPath, first.skillPath);
  assert.notEqual(second.contentHash, first.contentHash);
  assert.match(await readFile(path.join(first.python.srcPath, "demo", "__init__.py"), "utf8"), /first/);
  assert.deepEqual(await verifyManifest(old), old);
  const imported = execFileSync(process.env.PI_HARNESS_PYTHON || "python3", ["-c", "import demo; print(demo.run()); print(demo.__file__)"], {
    env: { ...process.env, PYTHONPATH: first.python.srcPath, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 120_000, maxBuffer: 65536,
  }).trim().split("\n");
  assert.equal(imported[0], "first"); assert(imported[1].startsWith(first.python.srcPath));
  assert.equal((await lstat(path.join(first.python.srcPath, "demo", "__init__.py"))).mode & 0o222, 0);
});

test("build, dist, temporary resources and unknown cache data are frozen despite legacy hash exclusions", async t => {
  const f = await fixture(t);
  for (const folder of ["build", "dist", "__pycache__"]) await mkdir(path.join(f.source, folder));
  await writeFile(path.join(f.source, "build", "runtime.txt"), "first build");
  await writeFile(path.join(f.source, "dist", "runtime.txt"), "dist runtime");
  await writeFile(path.join(f.source, "runtime.tmp"), "runtime temporary resource");
  await writeFile(path.join(f.source, "__pycache__", "owned-data"), "not disposable");
  const [first] = await f.freeze();
  for (const file of ["build/runtime.txt", "dist/runtime.txt", "runtime.tmp", "__pycache__/owned-data"]) {
    assert.equal(await readFile(path.join(path.dirname(first.skillPath), file), "utf8"), await readFile(path.join(f.source, file), "utf8"));
  }
  await writeFile(path.join(f.source, "build", "runtime.txt"), "second build");
  const [second] = await f.freeze();
  assert.equal(second.contentHash, first.contentHash, "source hash retains its exact old meaning");
  assert.notEqual(second.skillPath, first.skillPath, "materialized identity covers the ignored runtime bytes");
  assert.equal(await readFile(path.join(path.dirname(first.skillPath), "build", "runtime.txt"), "utf8"), "first build");
});

test("only proven disposable Python caches are skipped; unchanged warm preparation rereads no payload", async t => {
  const f = await fixture(t), cache = path.join(f.source, "src", "demo", "__pycache__");
  await mkdir(cache); await writeFile(path.join(cache, "__init__.cpython-312.pyc"), "disposable");
  const skills = await f.discover(), original = fs.open, originalRead = fs.readFile; let reads = 0;
  fs.readFile = async (...args) => { reads++; return originalRead(...args); };
  fs.open = async (...args) => {
    const handle = await original(...args), read = handle.readFile.bind(handle);
    handle.readFile = async (...options) => { reads++; return read(...options); }; return handle;
  };
  syncBuiltinESMExports();
  try {
    const [first] = await materializeSkills(skills, { artifactRoot: f.artifactRoot }); assert(reads > 0);
    assert.equal(await readdir(path.join(first.python.srcPath, "demo")).then(names => names.includes("__pycache__")), false);
    await writeFile(path.join(cache, "__init__.cpython-312.pyc"), "changed disposable bytecode");
    reads = 0; const [second] = await materializeSkills(skills, { artifactRoot: f.artifactRoot });
    assert.equal(second.skillPath, first.skillPath); assert.equal(reads, 0, "metadata-only warm reuse");
  } finally { fs.open = original; fs.readFile = originalRead; syncBuiltinESMExports(); }
});

test("concurrent materialization and identical source trees share one published object", async t => {
  const f = await fixture(t);
  const [left, right] = await Promise.all([f.freeze(), f.freeze()]);
  assert.equal(left[0].skillPath, right[0].skillPath);
  assert.deepEqual((await readdir(f.artifactRoot)).filter(name => !name.startsWith(".")), [skillArtifactLocation(left[0].skillPath).id]);
  assert.equal((await readdir(f.artifactRoot)).some(name => name.startsWith(".staging-")), false);
  const again = await materializeSkills(left, { artifactRoot: f.artifactRoot });
  assert.equal(again[0].skillPath, left[0].skillPath);
  const other = await fixture(t);
  const twin = await materializeSkills(await other.discover(), { artifactRoot: f.artifactRoot });
  assert.equal(twin[0].skillPath, left[0].skillPath, "identical source trees share one artifact");
});

test("source changes during capture never publish a candidate", async t => {
  const f = await fixture(t), [skill] = await f.discover();
  await assert.rejects(prepareSkillArtifact(skill, { artifactRoot: f.artifactRoot, verifyTree: async () => {
    await writeFile(path.join(f.source, "src", "demo", "__init__.py"), "changed during capture");
  } }), /SOURCE_CHANGED/);
  assert.deepEqual(await readdir(f.artifactRoot), []);
});

test("unsupported links or special entries fail before publication without changing an old artifact", async t => {
  for (const kind of ["link", "fifo"]) await t.test(kind, async t => {
    const f = await fixture(t), source = await f.discover(), [old] = await f.freeze();
    if (kind === "link") await symlink("../outside", path.join(f.source, "foreign"));
    else execFileSync("mkfifo", [path.join(f.source, "special")]);
    await assert.rejects(materializeSkills(source, { artifactRoot: f.artifactRoot }), /UNSUPPORTED_ENTRY/);
    if (kind === "fifo") {
      const unsupported = await discoverSkills([{ source: "skill", path: path.join(f.source, "SKILL.md") }]);
      assert.match(unsupported.diagnostics[0].error, /unsupported skill entry type/);
    }
    assert.deepEqual((await discoverSkills([{ source: "skill", path: old.skillPath }])).diagnostics, []);
    assert.equal((await readdir(f.artifactRoot)).some(name => name.startsWith(".staging-")), false);
  });
});

test("artifact drift including legacy-ignored runtime bytes has no mutable-source fallback", async t => {
  const f = await fixture(t); await mkdir(path.join(f.source, "build"));
  await writeFile(path.join(f.source, "build", "runtime"), "first");
  const [skill] = await f.freeze(), resource = path.join(path.dirname(skill.skillPath), "build", "runtime");
  await chmod(resource, 0o600); await writeFile(resource, "drift");
  const discovered = await discoverSkills([{ source: "skill", path: skill.skillPath }]);
  assert.equal(discovered.skills.length, 0);
  assert.match(discovered.diagnostics[0].error, /ARTIFACT_CONTENT_CHANGED/);
  assert.equal(await readFile(path.join(f.source, "build", "runtime"), "utf8"), "first");
});

test("standalone guidance keeps decoded-string source hashing without adjacent backing", async t => {
  const f = await fixture(t), file = path.join(f.root, "guide.md");
  await writeFile(file, "---\nname: guide\ndescription: Standalone.\n---\n");
  await writeFile(path.join(f.root, "pyproject.toml"), "not valid backing");
  const original = await discoverSkills([{ source: "skill", path: file }]);
  const [frozen] = await materializeSkills(original.skills, { artifactRoot: f.artifactRoot });
  assert.equal(frozen.contentHash, original.skills[0].contentHash); assert.equal(frozen.python, null);
  assert.deepEqual(await readdir(path.dirname(frozen.skillPath)), ["guide.md"]);
});

test("managed compatible reuse retires only harness-owned .pth without installation", async t => {
  const f = await fixture(t), environment = path.join(f.root, "runtime", "environments", "completed");
  const site = path.join(environment, "lib", "python3.12", "site-packages");
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, "persistent-harness-skills.pth"), "/mutable/source\n");
  await writeFile(path.join(site, "unrelated.pth"), "unrelated customization\n");
  const versions = { python: runtimeVersions.python, ipython: runtimeVersions.ipython, dill: runtimeVersions.dill };
  await writeFile(path.join(environment, "runtime.json"), JSON.stringify({ version: 1, environmentId: "completed", versions, environmentSpec: { dependencies: [] } }));
  const manager = new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
  let starts = 0;
  const selected = await manager.launch({ skills: await f.freeze(), consent: () => assert.fail("no environment install"),
    createKernel: async candidate => ({ start: async ({ onRuntimeValidated }) => {
      starts++; assert.equal(candidate.environmentId, "completed"); await onRuntimeValidated(versions); return { versions };
    }, close: async () => {} }) });
  assert.equal(selected.environmentId, "completed"); assert.equal(starts, 1);
  await assert.rejects(readFile(path.join(site, "persistent-harness-skills.pth")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(site, "unrelated.pth"), "utf8"), "unrelated customization\n");
});


test("executable mode is materialized identity without redefining the legacy hash", async t => {
  const f = await fixture(t), script = path.join(f.source, "helper.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  const [first] = await f.freeze();
  await chmod(script, 0o700);
  const [second] = await f.freeze();
  assert.equal(first.contentHash, second.contentHash); assert.notEqual(first.skillPath, second.skillPath);
  assert.equal((await lstat(path.join(path.dirname(first.skillPath), "helper.sh"))).mode & 0o111, 0);
  assert.equal((await lstat(path.join(path.dirname(second.skillPath), "helper.sh"))).mode & 0o111, 0o100);
});

test("copy corruption of legacy-ignored runtime bytes is refused before publication", async t => {
  const f = await fixture(t); await mkdir(path.join(f.source, "dist"));
  await writeFile(path.join(f.source, "dist", "runtime"), "original bytes");
  const [source] = await f.discover();
  await assert.rejects(prepareSkillArtifact(source, { artifactRoot: f.artifactRoot, verifyTree: async skillPath => {
    await writeFile(path.join(path.dirname(skillPath), "dist", "runtime"), "corrupt candidate");
  } }), /CONTENT_CHANGED/);
  assert.deepEqual(await readdir(f.artifactRoot), []);
});


test("a failed harness .pth cleanup is not treated as permission to rebuild an environment", async t => {
  const f = await fixture(t), environment = path.join(f.root, "runtime", "environments", "completed");
  const pth = path.join(environment, "lib", "python3.12", "site-packages", "persistent-harness-skills.pth");
  await mkdir(pth, { recursive: true });
  const versions = { python: runtimeVersions.python, ipython: runtimeVersions.ipython, dill: runtimeVersions.dill };
  await writeFile(path.join(environment, "runtime.json"), JSON.stringify({ version: 1, environmentId: "completed", versions, environmentSpec: { dependencies: [] } }));
  await assert.rejects(new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null }).ensure({
    skills: [], consent: () => assert.fail("cleanup failure must not install"),
  }), { code: "EISDIR" });
});


test("generation snapshot publication is create-only, exact-byte checked and private", async t => {
  const f = await fixture(t), session = { sessionId: "snapshot-session", actorGeneration: 1, sessionFile: path.join(f.root, "snapshot.jsonl") };
  const grant = { skills: [], capabilities: [] };
  const file = await publishActorGenerationSkillGrant(session, grant), before = await lstat(file);
  assert.equal(before.mode & 0o777, 0o400);
  assert.equal(await publishActorGenerationSkillGrant(session, grant), file);
  assert.equal((await lstat(file)).ino, before.ino, "unchanged publication does not replace an admitted grant");
  await chmod(file, 0o600); await writeFile(file, "wrong bytes"); await chmod(file, 0o400);
  await assert.rejects(publishActorGenerationSkillGrant(session, grant), /expected immutable bytes/);
  assert.equal(await readFile(file, "utf8"), "wrong bytes", "a mismatched existing grant must never be overwritten");
});


test("an occupied artifact identity is never replaced, including an incomplete empty directory", async t => {
  const f = await fixture(t), [first] = await f.freeze(), object = skillArtifactLocation(first.skillPath).object;
  await rm(object, { recursive: true }); await mkdir(object, { mode: 0o700 });
  const occupied = await lstat(object), other = await fixture(t);
  await assert.rejects(materializeSkills(await other.discover(), { artifactRoot: f.artifactRoot }), { code: "ENOENT" });
  assert.equal((await lstat(object)).ino, occupied.ino); assert.deepEqual(await readdir(object), []);
  assert.equal((await readdir(f.artifactRoot)).some(name => name.startsWith(".staging-")), false);
});

test("a symlinked published object is refused instead of becoming a mutable external dependency", async t => {
  const f = await fixture(t), [skill] = await f.freeze(), location = skillArtifactLocation(skill.skillPath);
  const moved = path.join(f.root, "moved-object");
  await fs.rename(location.object, moved); await symlink(moved, location.object);
  const result = await discoverSkills([{ source: "skill", path: skill.skillPath }]);
  assert.equal(result.skills.length, 0); assert.match(result.diagnostics[0].error, /ROOT_INVALID/);
});
