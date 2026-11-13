// The fake model provider for end-to-end tests, as the core reaches it: a models file and a
// sign-in for one provider (default `harness-fake`, model `fake-model`) at a test server
// speaking Chat Completions; the core's global folder (AGENTS files, skills) is `agentDir`.
// Returns the environment a supervisor (and its workers) need.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function coreFakeProvider(root, baseUrl, { provider = "harness-fake", models = ["fake-model"], contextWindow = 200_000, agentDir = path.join(root, "core", "agent") } = {}) {
  const directory = path.join(root, "core"); await mkdir(directory, { recursive: true });
  const modelsFile = path.join(directory, "models.json"), auth = path.join(directory, "auth.json");
  await writeFile(modelsFile, JSON.stringify({ models: Object.fromEntries(models.map((id) => [id, { provider, id, name: id,
    api: "openai-completions", baseUrl, contextWindow, reasoning: false }])) }));
  await writeFile(auth, JSON.stringify({ [provider]: { type: "api_key", key: "fake" } }), { mode: 0o600 });
  return {
    PI_HARNESS_CORE_ARGS: JSON.stringify(["--models", modelsFile, "--auth", auth, "--catalog", path.join(directory, "catalog"), "--agent-dir", agentDir]),
    PI_HARNESS_CORE_SESSIONS: path.join(directory, "sessions"),
  };
}

export function messageText(message) {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join("");
}

/** The core's context usage line, which it sends as the request's last message. */
export function isUsageLine(message) { return /^Context: about /.test(messageText(message)); }

/** The request's newest message, leaving out the core's context usage line. */
export function lastMessage(body) { return (body.messages ?? []).findLast((message) => !isUsageLine(message)); }
