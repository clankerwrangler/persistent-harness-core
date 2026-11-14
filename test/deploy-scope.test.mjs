import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SESSION_ENTRY, SUPERVISOR_ENTRY, deployScope, moduleGraph, moduleReferences } from "../src/deploy-scope.mjs";

const repository = new URL("../", import.meta.url);
const read = (file) => { try { return readFileSync(new URL(file, repository), "utf8"); } catch { return null; } };

test("references cover static, dynamic and worker loads, not packages", () => {
  const source = `import a from "./a.mjs";\nimport { b } from './b.mjs';\nexport * from "./c.mjs";\nimport "./d.mjs";\n`
    + `const e = await import("./e.mjs");\nnew Worker(new URL("./f.mjs", import.meta.url));\nimport ws from "ws";\nimport fs from "node:fs";`;
  assert.deepEqual(moduleReferences(source).sort(), ["./a.mjs", "./b.mjs", "./c.mjs", "./d.mjs", "./e.mjs", "./f.mjs"]);
});

test("the supervisor never loads the session entry or session-only code", () => {
  const supervisor = moduleGraph(SUPERVISOR_ENTRY, read), session = moduleGraph(SESSION_ENTRY, read);
  assert(supervisor.has("src/supervisor.mjs") && session.has("src/core-worker.mjs"));
  for (const file of [SESSION_ENTRY, "src/core-worker.mjs", "src/python-recovery.mjs", "src/kernel.mjs", "src/grep-worker.mjs"]) {
    assert.equal(supervisor.has(file), false, `${file} is session-only`);
  }
  assert(session.has("src/grep-worker.mjs"), "a worker started by URL is part of the graph");
  assert(supervisor.has("src/protocol.mjs") && session.has("src/protocol.mjs"), "the shared wire format belongs to both");
});

test("a change is as wide as its widest file", () => {
  const graphs = { supervisorFiles: moduleGraph(SUPERVISOR_ENTRY, read), sessionFiles: moduleGraph(SESSION_ENTRY, read) };
  assert.equal(deployScope(["test/x.test.mjs", "docs/a.md"], graphs).scope, "none");
  assert.equal(deployScope(["src/python-recovery.mjs", "test/x.test.mjs"], graphs).scope, "session");
  assert.equal(deployScope(["src/python-recovery.mjs", "src/protocol.mjs"], graphs).scope, "full");
  assert.equal(deployScope(["src/supervisor.mjs"], graphs).scope, "full");
  assert.equal(deployScope(["package.json"], graphs).scope, "full", "dependencies are shared");
  assert.equal(deployScope(["README.md", "docs/deploy.md"], graphs).scope, "none");
  assert.equal(deployScope(["skills/files/SKILL.md"], graphs).scope, "full", "skills are read at run time");
  assert.equal(deployScope(["python-runtime/kernel.py"], graphs).scope, "full", "files not known to be session-only need a full deploy");
});
