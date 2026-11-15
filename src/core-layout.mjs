// Where the conversation core and its sessions live, and the flags every core runs with.
// Both halves start cores (the supervisor creates and cleans sessions, a session runs its
// own), so this is part of the contract between them.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function agentDirectory(env = process.env) {
  return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

/**
 * The core's own files for these sessions, kept together in the agent folder so they last
 * as long as it does: `core/bin/core`, `core/js/core.mjs`, `core/auth.json` (sign-ins),
 * `core/catalog/`, `core/models.json` (optional) and `core/sessions/`.
 */
export function coreHome(env = process.env) {
  return path.resolve(env.PI_HARNESS_CORE_HOME || path.join(agentDirectory(env), "core"));
}

export function coreSessionsDirectory(env = process.env) {
  return path.resolve(env.PI_HARNESS_CORE_SESSIONS || path.join(coreHome(env), "sessions"));
}

export function coreBinary(env = process.env) { return env.PI_HARNESS_CORE_BIN || path.join(coreHome(env), "bin", "core"); }

export function coreLibraryPath(env = process.env) { return env.PI_HARNESS_CORE_JS || path.join(coreHome(env), "js", "core.mjs"); }

/**
 * The flags every core of these sessions runs with: instructions from the agent folder
 * (`--agent-dir`), sign-ins and catalog from the core home, the models file when there is
 * one, then PI_HARNESS_CORE_ARGS (a JSON list). A flag given there replaces the default.
 */
export function coreArgs(env = process.env) {
  const extra = env.PI_HARNESS_CORE_ARGS ? JSON.parse(env.PI_HARNESS_CORE_ARGS) : [];
  if (!Array.isArray(extra) || extra.some((value) => typeof value !== "string")) throw new Error("PI_HARNESS_CORE_ARGS must be a JSON list of strings");
  const home = coreHome(env);
  const models = path.join(home, "models.json");
  const defaults = [["--agent-dir", agentDirectory(env)], ["--auth", path.join(home, "auth.json")], ["--catalog", path.join(home, "catalog")],
    ...(existsSync(models) ? [["--models", models]] : [])];
  return [...defaults.filter(([flag]) => !extra.includes(flag)).flat(), ...extra];
}
