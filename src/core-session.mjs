// Sessions on the conversation core: where they live, creating one, and reading one
// through the core (never by opening its files).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const MAX_OUTPUT = 512 * 1024 * 1024;

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

async function coreLibrary(env) { return import(pathToFileURL(coreLibraryPath(env)).href); }

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

/**
 * A new session folder. With `context` (a fork), the child starts from those messages:
 * they become its first checkpoint, so its first request sends exactly them.
 */
export async function createCoreSession({ sessionsDirectory = coreSessionsDirectory(), context = null, env = process.env } = {}) {
  const sessionId = randomUUID();
  const sessionFile = path.join(sessionsDirectory, sessionId);
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  try {
    const { Core } = await coreLibrary(env);
    // `core run` creates the folder; a checkpoint is taken while it is idle.
    const core = Core.start({ bin: coreBinary(env), dir: sessionFile, env });
    try {
      if (context) await core.checkpoint(context);
      else await core.history();
    } finally { await core.close(); }
    return { sessionId, sessionFile };
  } catch (error) {
    await rm(sessionFile, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A fork's copy of a parent's context: everything its next request would send, minus tool
 * calls that have no result yet (the parent's own work in progress, such as the call
 * creating this child). A provider refuses a call without its result.
 */
export function forkableContext(messages) {
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((block) => block.type !== "toolCall" || answered.has(block.id));
    return content.length ? [{ ...message, content }] : [];
  });
}

/** The context a session's next request would send, through the core. */
export async function coreSessionContext(sessionFile, env = process.env) {
  const { stdout } = await exec(coreBinary(env), ["context", sessionFile], { env, maxBuffer: MAX_OUTPUT });
  const messages = JSON.parse(stdout);
  if (!Array.isArray(messages)) throw new Error("the core did not return a context");
  return messages;
}

/** History entries of a session that is not running: its current chunk, or `from`..`to`. */
export async function coreSessionHistory(sessionFile, { from, to } = {}, env = process.env) {
  const args = from === undefined ? ["history", sessionFile] : ["history", sessionFile, String(from), String(to ?? Number.MAX_SAFE_INTEGER)];
  const { stdout } = await exec(coreBinary(env), args, { env, maxBuffer: MAX_OUTPUT });
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error("the core did not return history");
  return entries;
}

export async function removeCoreSession(sessionFile) {
  await rm(sessionFile, { recursive: true, force: true });
}
