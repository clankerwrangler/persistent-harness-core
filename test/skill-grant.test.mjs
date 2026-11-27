import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { actorGenerationSkillGrantPath, skillGrantContent } from "../src/skill-grant.mjs";

const skill = { id: "files", version: "1.0.0", contentHash: "a".repeat(64), skillPath: "/skills/files/SKILL.md", pythonBacked: true };
const described = { id: "files", version: "1.0.0", contentHash: "a".repeat(64), skillPath: "/skills/files/SKILL.md",
  description: "Files.", alias: "files", instructions: "# Files",
  python: { packageName: "files", importName: "files", entryPoint: null, dependencies: [], hostRequests: ["files.show"], srcPath: "/skills/files/src" } };
const capability = { id: "files", version: "1.0.0", contentHash: "a".repeat(64), skillPath: "/skills/files/SKILL.md" };

// Each read happens in a fresh process: the session process reads its grant once.
async function readIn(t, grant) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-grant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = skillGrantContent({ sessionId: "s", actorGeneration: 3, ...grant });
  const file = actorGenerationSkillGrantPath(path.join(dir, "session"), 3, createHash("sha256").update(content).digest("hex"));
  await writeFile(file, content); await chmod(file, 0o400);
  const { execFile } = await import("node:child_process");
  const module = new URL("../src/skill-grant.mjs", import.meta.url).href;
  return new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e",
    `import { readActorSkillGrant } from ${JSON.stringify(module)}; try { const g = await readActorSkillGrant(); console.log(JSON.stringify({ ok: g.manifestSkills.map(s => s.id) })); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`],
    { env: { ...process.env, HARNESS_ACTOR_SKILL_GRANT: file, HARNESS_ACTOR_ID: "s", HARNESS_ACTOR_GENERATION: "3" } },
    (_error, stdout) => resolve(JSON.parse(stdout))));
}

test("a session reads the skills it was granted from the grant, described as granted", async t => {
  assert.deepEqual(await readIn(t, { skills: [skill], capabilities: [capability], manifestSkills: [described] }), { ok: ["files"] });
});

test("a grant whose description does not match what was granted is refused", async t => {
  const changed = await readIn(t, { skills: [skill], capabilities: [capability], manifestSkills: [{ ...described, contentHash: "b".repeat(64) }] });
  assert.match(changed.error, /described differently: contentHash/);
  const missing = await readIn(t, { skills: [skill], capabilities: [capability], manifestSkills: [] });
  assert.match(missing.error, /does not describe each granted skill/);
  const unpermitted = await readIn(t, { skills: [skill], capabilities: [], manifestSkills: [described] });
  assert.match(unpermitted.error, /exceeds actor capability manifest/);
});
