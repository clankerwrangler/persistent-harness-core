// The harness's Python tool as the session worker offers it: where the kernel lives, the
// session's skill grant, how a cell's result becomes the tool result, the skill part of
// the prompt, and the message a family member's message becomes.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INCOMING_AGENT_MESSAGE_TYPE } from "./agent-message-projection.mjs";
import { actorGenerationGrantIdentity } from "./session-paths.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PYTHON_RUNTIME_SUPPORT = path.join(PACKAGE_ROOT, "python-runtime");
export const KERNEL_SCRIPT = path.join(PYTHON_RUNTIME_SUPPORT, "kernel.py");
export const INCOMING_MESSAGE_TYPE = INCOMING_AGENT_MESSAGE_TYPE;
export const USAGE_ENTRY_TYPE = "persistent-harness-usage";

let actorGrantPromise;
/** The skills and capabilities the supervisor granted this worker generation. */
export async function actorSkillGrant(env = process.env) {
  const grantPath = env.PI_HARNESS_ACTOR_SKILL_GRANT || null;
  if (!grantPath) return null;
  const actorId = env.PI_HARNESS_ACTOR_ID || null;
  const generation = env.PI_HARNESS_ACTOR_GENERATION ? Number(env.PI_HARNESS_ACTOR_GENERATION) : null;
  actorGrantPromise ??= (async () => {
    const identity = actorGenerationGrantIdentity(grantPath);
    const stat = await lstat(grantPath);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o277)) throw new Error("invalid actor generation grant file");
    const content = await readFile(grantPath, "utf8");
    if (identity.generation !== generation || createHash("sha256").update(content).digest("hex") !== identity.digest) {
      throw new Error("actor generation skill grant identity mismatch");
    }
    const grant = JSON.parse(content);
    if (grant.sessionId !== actorId || grant.actorGeneration !== generation) throw new Error("actor generation skill grant binding mismatch");
    if (grant?.version !== 1 || !Array.isArray(grant.skills) || !Array.isArray(grant.capabilities)) {
      throw new Error("invalid actor skill grant");
    }
    return grant;
  })();
  return actorGrantPromise;
}

export function applyActorSkillGrant(skills, grant) {
  if (!grant) return skills;
  const discovered = new Map(skills.map((skill) => [skill.id, skill]));
  const capabilityIds = new Set(grant.capabilities.map((item) => item.id));
  const selected = grant.skills.map((expected) => {
    const skill = discovered.get(expected.id);
    if (!skill) throw new Error(`granted actor skill was not discovered: ${expected.id}`);
    if (skill.version !== expected.version || skill.contentHash !== expected.contentHash
      || path.resolve(skill.skillPath) !== path.resolve(expected.skillPath)) {
      throw new Error(`granted actor skill changed after admission: ${expected.id}`);
    }
    if (Boolean(skill.python) !== expected.pythonBacked) throw new Error(`granted actor skill backing changed: ${expected.id}`);
    if (skill.python && !capabilityIds.has(skill.id)) throw new Error(`Python skill exceeds actor capability manifest: ${skill.id}`);
    return skill;
  });
  for (const capability of grant.capabilities) {
    const expected = grant.skills.find((skill) => skill.id === capability.id);
    if (!expected?.pythonBacked || expected.version !== capability.version || expected.contentHash !== capability.contentHash) {
      throw new Error(`invalid executable actor capability: ${capability.id}`);
    }
  }
  return selected;
}

// files.show(): an image for the user only. It travels in the result's details, which the
// conversation displays and the model never receives; the model gets a note in its place.
export const SHOWN_IMAGE_MIME = "application/x-harness-shown-image";
// files.attachment(): images the model sees that are also meant for the user. Other
// image outputs are working material the conversation keeps folded away.
export const FOR_USER_MIME = "application/x-harness-for-user";
const SHOWABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function pythonOutputContent(result, shown = null, marks = null) {
  const outputs = Array.isArray(result.outputs) ? result.outputs : [
    ...[result.stdout, result.stderr].filter(Boolean).map((text) => ({ text: text.trimEnd() })),
    ...(result.mime ? [{ mime: result.mime }] : []),
  ];
  const content = [];
  for (const output of outputs) {
    if (typeof output.text === "string" && output.text) content.push({ type: "text", text: output.text });
    const mime = output.mime ?? {};
    if (marks && mime[FOR_USER_MIME] === true) marks.forUser = true;
    const text = [mime["text/plain"], mime["text/x-diff"]].filter(Boolean).map(String).join("\n");
    if (text) content.push({ type: "text", text });
    for (const [mimeType, data] of Object.entries(mime)) {
      if (SHOWABLE_IMAGE_TYPES.includes(mimeType) && typeof data === "string") {
        content.push({ type: "image", data, mimeType });
      } else if (mimeType === SHOWN_IMAGE_MIME && data && SHOWABLE_IMAGE_TYPES.includes(data.mimeType) && typeof data.data === "string") {
        const name = typeof data.fileName === "string" ? data.fileName.slice(0, 200) : "image";
        shown?.push({ type: "image", data: data.data, mimeType: data.mimeType, name });
        content.push({ type: "text", text: `[Image shown to the user: ${name}. It is not visible to you.]` });
      }
    }
  }
  if (result.error) content.push({ type: "text", text: `${result.errorType ?? "Error"}: ${result.error}` });
  if (!content.length) content.push({ type: "text", text: result.ok ? "Execution completed." : "Execution failed." });
  return content;
}

export function pythonResultText(result) {
  return pythonOutputContent(result).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

// Payload fields already persisted once: output in `content`, code in the call's
// arguments. Keeping them in details stored every cell two or three times.
const PYTHON_DETAIL_PAYLOAD_KEYS = ["code", "stdout", "stderr", "outputs", "mime"];

export function pythonToolResult(result) {
  const details = { ...result };
  for (const key of PYTHON_DETAIL_PAYLOAD_KEYS) delete details[key];
  const shown = [], marks = {};
  const content = pythonOutputContent(result, shown, marks);
  if (shown.length) details.shownImages = shown;
  if (marks.forUser) details.imagesForUser = true;
  if (result.namespaceCheckpointState === "pending") {
    content.push({ type: "text", text: "Python execution has ended; its namespace save is pending." });
  }
  return { content, details };
}

export function skillPrompt(skills, nativeAsync = false) {
  const rows = skills.map((skill) => {
    const calls = skill.python
      ? skill.python.entryPoint
        ? `${skill.alias}(...) or ${skill.alias}.operation(...)`
        : `${skill.alias}.operation(...)`
      : "guidance-only";
    return `- ${skill.alias}? — ${skill.description} [${calls}]`;
  });
  return [
    "# Persistent Python skill interface",
    "`ipython` is the only execution tool. Ordinary Pi tools are unavailable.",
    "Every skill is one Python object. Use `<skill>?` to display its complete SKILL.md.",
    "If a skill has Python backing, call `<skill>(...)` when it defines an entry point or `<skill>.operation(...)`.",
    "Calling a guidance-only skill raises a clear error; read its instructions with `?` and follow them using Python or backed skills.",
    ...(nativeAsync ? [
      "Python calls can run while you continue thinking. Their results become visible on a subsequent model request.",
      "Continue independent work while Python runs. When your next step depends on a Python result, call wait_for_ipython as the last tool call of the current response.",
      "The wait is a handoff, not task completion. When it returns, read the original Python results and continue from them.",
      "Do not repeat a call just because its result is not visible yet. Pending results alone do not mean the tool channel has failed.",
      "Claim an action was dispatched or succeeded only after reading the corresponding call result; reading instructions does not dispatch an action.",
      "Python results arrive before namespace saving finishes. The next cell waits for the save in the existing Python queue. A pending save is not proof of recoverable state; a save failure arrives as a separate diagnostic. Never replay external side effects to repair a save failure.",
    ] : []),
    "Available skill aliases:",
    ...rows,
  ].join("\n");
}

export function nativeAsyncEnabled(model, enabled = process.env.PI_HARNESS_NATIVE_ASYNC) {
  return enabled === "1" && model?.provider === "openai-codex"
    && model?.api === "openai-codex-responses"
    && model?.compat?.supportsAsyncTools === true;
}

/** A message from another session, as the model sees it. */
export function incomingCustomPayload(message) {
  const source = `${message.senderName ?? "agent"} ${message.senderShortId ?? "unknown"} [d${message.senderDepth ?? "?"}]`;
  return {
    customType: INCOMING_MESSAGE_TYPE,
    content: `Direct agent message from ${source}:\n${message.body}`,
    display: true,
    details: {
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderShortId: message.senderShortId,
      senderDepth: message.senderDepth,
      relationship: message.relationship,
      deliveryMode: message.deliveryMode,
      body: message.body,
    },
  };
}
