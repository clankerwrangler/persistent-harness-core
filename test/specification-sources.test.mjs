import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSpecificationSources } from "./specification-sources.mjs";

const entry = (source = "src/example.mjs") => `\\*   ${source}`;
const moduleText = (...entries) => `---- MODULE Example ----\n\\* Sources:\n${entries.length ? `${entries.join("\n")}\n` : ""}EXTENDS Naturals\n====\n`;

function fixture(t) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "harness-spec-sources-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  mkdirSync(path.join(root, "specification"), { recursive: true });
  function write(relative, contents) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return file;
  }
  write("src/example.mjs", "export const value = 1;\n");
  return { root, temporary, write, check: () => checkSpecificationSources(root) };
}

function expectFailure(result, ...patterns) {
  assert.ok(result.errors.length > 0, "invalid source metadata must fail");
  const detail = result.errors.join("\n");
  for (const pattern of patterns) assert.match(detail, pattern);
}

test("specification sources: every repository model names source files that exist", () => {
  const result = checkSpecificationSources(path.resolve(import.meta.dirname, ".."));
  assert.equal(result.errors.length, 0, `Model source names are invalid:\n${result.errors.join("\n")}\nSee specification/README.md.`);
});

test("synthetic: named files pass for nested modules and real test/helper sources", (t) => {
  const f = fixture(t);
  f.write("test/helpers/example-source.mjs", "export {};\n");
  f.write("specification/Example.tla", moduleText(entry(), entry("test/helpers/example-source.mjs")));
  f.write("specification/nested/deeper/Generated_TTrace_123.tla", moduleText(entry()));
  const result = f.check();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.modules, ["specification/Example.tla", "specification/nested/deeper/Generated_TTrace_123.tla"]);
  assert.equal(result.sourceCount, 2);
});

for (const [name, contents, pattern] of [
  ["missing Sources", "---- MODULE Example ----\nEXTENDS Naturals\n====\n", /missing Sources block/],
  ["misplaced Sources", `---- MODULE Example ----\nEXTENDS Naturals\n\\* Sources:\n${entry()}\n====\n`, /missing Sources block immediately after MODULE/],
  ["empty Sources", moduleText(), /empty Sources block/],
  ["missing MODULE", `\\* Sources:\n${entry()}\n====\n`, /missing MODULE declaration/],
]) {
  test(`synthetic: rejects ${name}`, (t) => {
    const f = fixture(t);
    f.write("specification/Example.tla", contents);
    expectFailure(f.check(), /specification\/Example\.tla/, pattern);
  });
}

test("synthetic: does not skip nested or generated modules without metadata", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(entry()));
  const nested = "specification/.generated/deep/Example_TTrace_123.tla";
  f.write(nested, "---- MODULE Example_TTrace_123 ----\nEXTENDS Naturals\n====\n");
  const result = f.check();
  assert.ok(result.modules.includes(nested));
  expectFailure(result, /\.generated\/deep\/Example_TTrace_123\.tla: missing Sources/);
});

test("synthetic: rejects missing source files", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(entry("src/missing.mjs")));
  expectFailure(f.check(), /specification\/Example\.tla: source src\/missing\.mjs/, /missing or unreadable \(ENOENT\)/);
});

test("synthetic: rejects non-file sources", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(entry("src")));
  expectFailure(f.check(), /source src is not a regular file/);
});

for (const [name, line] of [
  ["a trailing annotation", `${entry()} reviewed`],
  ["an old byte pin", `${entry()} sha256:${"0".repeat(64)}`],
  ["wrong indentation", entry().replace("\\*   ", "\\* ")],
  ["an empty entry", "\\*   "],
]) {
  test(`synthetic: rejects an entry with ${name}`, (t) => {
    const f = fixture(t);
    // A valid first entry must not conceal a malformed second entry.
    f.write("specification/Example.tla", moduleText(entry(), line));
    expectFailure(f.check(), /specification\/Example\.tla:4: malformed source entry/);
  });
}

for (const source of ["../outside.mjs", "src/../example.mjs", "./src/example.mjs", "/outside.mjs",
  "C:/outside.mjs", "C:outside.mjs", "src\\example.mjs", "src//example.mjs", "src/"]) {
  test(`synthetic: rejects noncanonical or escaping source path ${JSON.stringify(source)}`, (t) => {
    const f = fixture(t);
    f.write("specification/Example.tla", moduleText(entry(source)));
    expectFailure(f.check(), /source path .* must be canonical, repo-relative, and contained/);
  });
}

test("synthetic: rejects source symlinks that escape the repository", (t) => {
  const f = fixture(t);
  const outside = path.join(f.temporary, "outside.mjs");
  writeFileSync(outside, "export {};\n");
  symlinkSync(outside, path.join(f.root, "src/alias.mjs"));
  f.write("specification/Example.tla", moduleText(entry("src/alias.mjs")));
  expectFailure(f.check(), /source src\/alias\.mjs resolves outside the repository/);
});

test("synthetic: rejects symbolic links in the specification inventory instead of skipping them", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(entry()));
  const target = path.join(f.temporary, "external-specification");
  mkdirSync(target);
  writeFileSync(path.join(target, "Unnamed.tla"), "---- MODULE Unnamed ----\n====\n");
  symlinkSync(target, path.join(f.root, "specification/linked"), "dir");
  expectFailure(f.check(), /specification\/linked: symbolic links/);
});

test("synthetic: rejects a symbolic specification root", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, "specification"), { recursive: true });
  symlinkSync(f.temporary, path.join(f.root, "specification"), "dir");
  expectFailure(f.check(), /specification: specification directory must be a regular directory/);
});

test("synthetic: rejects duplicate source entries", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(entry(), entry()));
  expectFailure(f.check(), /duplicate source entry for src\/example\.mjs/);
});

test("synthetic: empty or missing specification inventories fail instead of passing vacuously", (t) => {
  const f = fixture(t);
  expectFailure(f.check(), /no \.tla modules found/);
  rmSync(path.join(f.root, "specification"), { recursive: true });
  expectFailure(f.check(), /specification: cannot inspect \(ENOENT\)/, /no \.tla modules found/);
});
