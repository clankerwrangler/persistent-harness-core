import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkillsFromDirectories, skillDirectories } from "../src/skills.mjs";

async function skill(root, id) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${id} skill.\n---\n\n# ${id}\n`);
}

test("skills load from every folder in a delimited skills path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skill-dirs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared"); const own = path.join(root, "own");
  await skill(shared, "wiki"); await skill(shared, "web"); await skill(own, "kernel");
  const catalog = await discoverSkillsFromDirectories([own, shared].join(path.delimiter));
  assert.deepEqual(catalog.skills.map((s) => s.id), ["kernel", "web", "wiki"]);
  assert.deepEqual(skillDirectories(`${own}${path.delimiter}${path.delimiter}${shared}`), [own, shared]);
  assert.deepEqual((await discoverSkillsFromDirectories(shared)).skills.map((s) => s.id), ["web", "wiki"]);
});

test("a skill ID in two skill folders is rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skill-dirs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await skill(path.join(root, "a"), "wiki"); await skill(path.join(root, "b"), "wiki");
  await assert.rejects(discoverSkillsFromDirectories([path.join(root, "a"), path.join(root, "b")].join(path.delimiter)), /duplicate skill ID across skill folders: wiki/);
});
