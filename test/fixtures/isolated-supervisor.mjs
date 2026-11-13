import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessSupervisor as Supervisor } from "../../src/supervisor.mjs";
import { CoreTranscriptReader } from "../../src/core-transcript-reader.mjs";
import { coreSessionHistory } from "../../src/core-session.mjs";
export * from "../../src/supervisor.mjs";

/**
 * A test session's history. A core folder is read through the core; a `.jsonl` file stands
 * in for one: one history entry per line, in the shape the core hands entries out (a leading
 * `session` header line, if any, is not an entry).
 */
export async function fixtureHistory(sessionFile) {
  if (!sessionFile.endsWith(".jsonl")) return coreSessionHistory(sessionFile);
  let text = "";
  try { text = await readFile(sessionFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !["session", "session_info"].includes(entry.type));
}

/** Sessions the supervisor creates as `.jsonl` stand-ins in `directory` (option `coreSessions`), so a test can write their history. */
export function fileSessions(directory) {
  return {
    create: async () => {
      const sessionId = randomUUID(), sessionFile = path.join(directory, `${sessionId}.jsonl`);
      await writeFile(sessionFile, "", { flag: "wx" });
      return { sessionId, sessionFile };
    },
    context: async (sessionFile) => (await fixtureHistory(sessionFile)).filter((entry) => entry.type === "message").map((entry) => entry.message),
    remove: async (sessionFile) => rm(sessionFile, { force: true }),
  };
}

// Lifecycle fixtures must not create workspace scratch or inspect live background owners.
export class HarnessSupervisor extends Supervisor {
  constructor(options) {
    const state = path.dirname(options.databasePath);
    let supervisor;
    const transcriptReader = options.transcriptReader ?? new CoreTranscriptReader({ history: fixtureHistory,
      inputReceiptReader: (inputId, sessionId) => supervisor.store.getActorInput(inputId, sessionId, { includeDigest: true }) });
    super({ scratchDirectory: path.join(state, "scratch"), backgroundJobsDirectory: path.join(state, "background-jobs"), ...options, transcriptReader });
    supervisor = this;
  }
}
