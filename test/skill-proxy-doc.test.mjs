import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "python-runtime");
const python = process.env.HARNESS_PYTHON || "python3";

test("skill help shows the current SKILL.md and falls back to the startup text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-doc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillPath = path.join(root, "SKILL.md");
  await writeFile(skillPath, "---\nname: demo\ndescription: Demo.\n---\n\nold text\n");
  const script = `
import json, sys, os
sys.path.insert(0, ${JSON.stringify(runtime)})
from _persistent_harness import SkillProxy
p = SkillProxy({"id": "demo", "alias": "demo", "skillPath": ${JSON.stringify(skillPath)}, "version": "1", "instructions": "startup text"})
before = p.__doc__
open(${JSON.stringify(skillPath)}, "w").write("---\\nname: demo\\ndescription: Demo.\\n---\\n\\nnew text\\n")
after = p.__doc__
os.remove(${JSON.stringify(skillPath)})
print(json.dumps([before, after, p.__doc__]))
`;
  const [before, after, missing] = JSON.parse(execFileSync(python, ["-c", script], { encoding: "utf8" }));
  assert.match(before, /old text/);
  assert.match(after, /new text/);
  assert.equal(missing, "startup text");
});
