// The supervisor's part of sessions on the conversation core: creating one, the context a
// fork starts from, and removing one. Reading a session's records is the session half's
// (core-transcript-reader.mjs).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { coreBinary, coreLibraryPath, coreSessionsDirectory } from "./core-layout.mjs";

const exec = promisify(execFile);
const MAX_OUTPUT = 512 * 1024 * 1024;

async function coreLibrary(env) { return import(pathToFileURL(coreLibraryPath(env)).href); }

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

export async function removeCoreSession(sessionFile) {
  await rm(sessionFile, { recursive: true, force: true });
}
