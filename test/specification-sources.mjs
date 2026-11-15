import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const moduleLine = /^-+[ \t]+MODULE[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+-+[ \t]*$/;
const sourcesLine = /^\\\* Sources:[ \t]*$/;
const sourceName = /^\\\* {3}(\S+)[ \t]*$/;
const lineComment = /^[ \t]*\\\*/;
const contained = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonicalSource = (source) => !/[\\:\x00-\x1f\x7f]/.test(source)
  && !path.posix.isAbsolute(source)
  && source.split("/").every((part) => part && part !== "." && part !== "..");

// Test-only validator: every model names the source files it models, and each one exists.
// It says nothing about whether a model still matches its code; that is a review.
export function checkSpecificationSources(repoRoot) {
  const root = realpathSync(repoRoot);
  const modules = [], errors = [], sources = new Set();
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const reportIO = (file, error) => errors.push(`${relative(file)}: cannot inspect (${error.code ?? error.message})`);

  function walk(directory) {
    let entries;
    try {
      if (!lstatSync(directory).isDirectory()) {
        errors.push(`${relative(directory)}: specification directory must be a regular directory, not a symbolic link`);
        return;
      }
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) { reportIO(directory, error); return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) errors.push(`${relative(file)}: symbolic links in specification/ are not supported`);
      else if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".tla")) {
        if (entry.isFile()) modules.push(file);
        else errors.push(`${relative(file)}: specification module must be a regular file`);
      }
    }
  }
  walk(path.join(root, "specification"));
  if (!modules.length) errors.push("specification/: no .tla modules found");

  for (const file of modules) {
    const model = relative(file);
    let lines;
    try { lines = readFileSync(file, "utf8").split(/\r?\n/); }
    catch (error) { reportIO(file, error); continue; }
    const declaration = lines.findIndex((line) => moduleLine.test(line));
    if (declaration === -1) {
      errors.push(`${model}: missing MODULE declaration`);
      continue;
    }
    if (!sourcesLine.test(lines[declaration + 1] ?? "")) {
      errors.push(`${model}: missing Sources block immediately after MODULE declaration`);
      continue;
    }
    const seen = new Set();
    let entries = 0;
    for (let i = declaration + 2; i < lines.length && lineComment.test(lines[i]); i++) {
      entries++;
      const match = sourceName.exec(lines[i]);
      if (!match) {
        errors.push(`${model}:${i + 1}: malformed source entry; expected \\*   repo/relative/file`);
        continue;
      }
      const source = match[1];
      if (!canonicalSource(source)) {
        errors.push(`${model}:${i + 1}: source path ${JSON.stringify(source)} must be canonical, repo-relative, and contained`);
        continue;
      }
      if (seen.has(source)) {
        errors.push(`${model}:${i + 1}: duplicate source entry for ${source}`);
        continue;
      }
      seen.add(source);
      try {
        const resolved = realpathSync(path.join(root, source));
        if (!contained(root, resolved)) errors.push(`${model}: source ${source} resolves outside the repository`);
        else if (!statSync(resolved).isFile()) errors.push(`${model}: source ${source} is not a regular file`);
        else sources.add(resolved);
      } catch (error) {
        errors.push(`${model}: source ${source} is missing or unreadable (${error.code ?? error.message})`);
      }
    }
    if (entries === 0) errors.push(`${model}: empty Sources block; name at least one modeled source file`);
  }
  return { modules: modules.map(relative), sourceCount: sources.size, errors };
}
