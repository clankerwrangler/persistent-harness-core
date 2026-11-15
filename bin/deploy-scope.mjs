#!/usr/bin/env node
// Usage: deploy-scope.mjs <running-commit> [<new-commit>]   (in the harness checkout)
// Prints the deploy the change needs: "none", "session" (no supervisor restart) or "full".
import { execFileSync } from "node:child_process";
import { SESSION_ENTRIES, SUPERVISOR_ENTRY, deployScope, moduleGraph } from "../src/deploy-scope.mjs";

const [from, to = "HEAD"] = process.argv.slice(2);
if (!from) { console.error("usage: deploy-scope.mjs <running-commit> [<new-commit>]"); process.exit(2); }
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
// A file one side does not have reads as null; any other Git failure is an error.
const ABSENT = /does not exist in|exists on disk, but not in/;
const reader = (revision) => (file) => {
  try { return git("show", `${revision}:${file}`); }
  catch (error) { if (ABSENT.test(String(error.stderr))) return null; throw error; }
};
const changed = git("diff", "--name-only", `${from}..${to}`).split("\n").filter(Boolean);
const supervisorFiles = new Set([...moduleGraph(SUPERVISOR_ENTRY, reader(from)), ...moduleGraph(SUPERVISOR_ENTRY, reader(to))]);
const sessionFiles = new Set([...moduleGraph(SESSION_ENTRIES, reader(from)), ...moduleGraph(SESSION_ENTRIES, reader(to))]);
const result = deployScope(changed, { supervisorFiles, sessionFiles });
console.log(JSON.stringify({ from, to, ...result }, null, 2));
