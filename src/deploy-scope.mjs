// Which kind of deploy a change needs. The supervisor loads its code once and keeps it;
// session code is loaded from the checkout each time it runs: a session process when it
// starts, and the one-off records reader for each read. So a change that
// touches only session code reaches every session as it next starts, with the supervisor
// left running ("session"); a change to anything the supervisor has loaded, or may load
// later, needs the supervisor restarted ("full"); tests and documents need neither ("none").
import path from "node:path";

export const SUPERVISOR_ENTRY = "bin/harness-supervisor.mjs";
/** The session half's programs, which the supervisor starts (never imports). */
export const SESSION_ENTRIES = Object.freeze(["bin/core-actor.mjs", "bin/session-records.mjs"]);
const RANK = { none: 0, session: 1, full: 2 };
// Skills are read at run time even though they are documents, so they are not listed here.
const NO_RUNTIME = [/^test\//, /^docs\//, /^specification\//, /^[^/]+\.md$/, /^\.gitignore$/, /^LICENSE$/];

/** Relative paths a module loads: static and dynamic imports, and workers it starts by URL. */
export function moduleReferences(source) {
  const found = new Set();
  const patterns = [
    /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']/g,
    /(?:^|[\s;])import\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1].startsWith(".")) found.add(match[1]);
  return [...found];
}

/** Every repository file reachable from `entry` (one path or several); `read(path)` returns a
 * file's text or null. */
export function moduleGraph(entry, read) {
  const seen = new Set(), queue = [entry].flat();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    const source = read(file);
    if (source == null) continue;
    seen.add(file);
    for (const reference of moduleReferences(source)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), reference)));
  }
  return seen;
}

/**
 * The deploy a set of changed files needs. `supervisorFiles` are the files the running
 * supervisor has loaded or may load (its graph before and after the change); `sessionFiles`
 * the session process's graph.
 */
export function deployScope(changed, { supervisorFiles, sessionFiles }) {
  const files = changed.map((file) => {
    if (supervisorFiles.has(file)) return { file, scope: "full", reason: "the supervisor loads it" };
    if (sessionFiles.has(file)) return { file, scope: "session", reason: "only session processes load it" };
    if (NO_RUNTIME.some((pattern) => pattern.test(file))) return { file, scope: "none", reason: "not loaded at run time" };
    return { file, scope: "full", reason: "not known to be session-only" };
  });
  const scope = files.reduce((worst, item) => RANK[item.scope] > RANK[worst] ? item.scope : worst, "none");
  return { scope, files };
}
