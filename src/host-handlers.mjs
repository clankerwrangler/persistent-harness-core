import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findModels, supportedThinkingLevels } from "./model-capabilities.mjs";
import { readRecentEvents } from "./event-log-reader.mjs";
import { MAX_WRITE_BYTES, commitAtomicFile } from "./host-atomic-file.mjs";
import {
  MAX_GREP_FILES,
  MAX_GREP_LINE_BYTES,
  MAX_GREP_OUTPUT_BYTES,
  MAX_GREP_RUNTIME_MS,
  MAX_GREP_TOTAL_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_SOURCE_BYTES,
  MAX_SHELL_CAPTURE_BYTES,
  boundedInteger,
  requireRecord,
  requireString,
  resolvePath,
  runGrep,
  runShell,
  simpleDiff,
  walk,
} from "./host-tools.mjs";

const MAX_READ_BYTES = 50 * 1024;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 512 * 1024;

const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
]);

const COLD_MEMORY_STATES = new Set(["none", "deferred", "cancelled", "mark", "waiting", "pageout", "complete",
  "small", "hot", "no-swap", "no-pressure", "unsupported", "unreclaimable", "unavailable"]);
function coldMemoryStatus(kernel) {
  if (!kernel?.isRunning) return undefined;
  try {
    const value = kernel.coldMemoryStats;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const read = key => Object.getOwnPropertyDescriptor(value, key)?.value;
    if (read("version") !== 1) return undefined;
    const state = read("state");
    const result = { version: 1, state: COLD_MEMORY_STATES.has(state) ? state : "unavailable" };
    for (const key of ["calls", "markedBytes", "pageoutBytes", "durationNs", "rssBefore", "rssAfter", "swapBefore", "swapAfter",
      "adviceDurationNs", "maxAdviceDurationNs", "totalDurationNs", "maxStepDurationNs"]) {
      const number = read(key);
      if (Number.isSafeInteger(number) && number >= 0) result[key] = number;
    }
    return result;
  } catch { return undefined; }
}

// The Python capability boundary exposes management selectors, not process ownership.
export function projectManagedSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid managed session response");
  const fields = ["sessionId", "shortId", "sessionFile", "cwd", "repositoryRoot", "name", "kind", "familyId",
    "parentSessionId", "depth", "lineage", "relationship", "activity", "lifecycle", "quietSince", "lastError",
    "createdAt", "updatedAt", "lastActivityAt", "startedAt", "stoppedAt", "workingDescendantCount"];
  const result = Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  if (value.launch && typeof value.launch === "object") {
    const scalarFields = (item, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(item, key)
      && (item[key] === null || ["string", "number", "boolean"].includes(typeof item[key]))).map((key) => [key, item[key]]));
    const launch = value.launch; result.launch = {};
    if (launch.model && typeof launch.model === "object") {
      result.launch.model = scalarFields(launch.model, ["requested", "source", "resolved"]);
      if (launch.model.resolved && typeof launch.model.resolved === "object") {
        result.launch.model.resolved = scalarFields(launch.model.resolved, ["provider", "id"]);
      }
    }
    if (launch.thinking && typeof launch.thinking === "object") result.launch.thinking = scalarFields(launch.thinking, ["requested", "resolved", "source"]);
    if (launch.contextFork && typeof launch.contextFork === "object") {
      result.launch.contextFork = scalarFields(launch.contextFork, ["version", "readOnly", "sourceSessionId", "sourceLeafId", "snapshotHash", "messageCount"]);
    }
    if (Array.isArray(launch.capabilityIds)) result.launch.capabilityIds = launch.capabilityIds.filter((id) => typeof id === "string");
  }
  return result;
}

export function createHostHandlers({ cwd, scratch = null, getClient, getContext = () => undefined, getManifest = () => undefined, getKernel = () => undefined, getKernelRestore = () => undefined, recordAgentMessage = () => {}, recordChildCreation = () => {}, restartKernel = () => { throw new Error("kernel restart is unavailable"); } }) {
  return {
    async "files.read"(payload) {
      const value = requireRecord(payload, "files.read payload");
      const filePath = resolvePath(cwd, value.path);
      const offset = boundedInteger(value.offset, "offset", 1, 10_000_000, 1);
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 2000);
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_SOURCE_BYTES) throw new Error(`file exceeds ${MAX_SOURCE_BYTES} byte read-source limit`);
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      const bytes = Buffer.byteLength(selected);
      const bounded = bytes > MAX_READ_BYTES ? Buffer.from(selected).subarray(0, MAX_READ_BYTES).toString("utf8") : selected;
      return {
        path: filePath,
        content: bounded,
        offset,
        returnedLines: bounded.split(/\r?\n/).length,
        totalLines: lines.length,
        truncated: bytes > MAX_READ_BYTES || offset - 1 + limit < lines.length,
      };
    },

    async "files.write"(payload, context = {}) {
      const value = requireRecord(payload, "files.write payload");
      const filePath = resolvePath(cwd, value.path);
      const content = requireString(value.content, "content", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES });
      const result = await commitAtomicFile({
        filePath,
        content,
        createParents: true,
        signal: context.signal,
        operation: "write",
      });
      return { path: filePath, bytes: Buffer.byteLength(content), created: result.created };
    },

    async "files.edit"(payload, context = {}) {
      const value = requireRecord(payload, "files.edit payload");
      const filePath = resolvePath(cwd, value.path);
      const oldText = requireString(value.oldText, "oldText", { maxBytes: MAX_WRITE_BYTES });
      const newText = requireString(value.newText, "newText", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES });
      if (typeof value.replaceAll !== "boolean") throw new Error("replaceAll must be boolean");
      const result = await commitAtomicFile({
        filePath,
        createParents: false,
        replaceExisting: true,
        signal: context.signal,
        operation: "edit",
        buildContent(source) {
          let content;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(source.content);
          } catch {
            throw new Error("existing file is not valid UTF-8; edit was not committed");
          }
          const parts = content.split(oldText);
          const occurrences = parts.length - 1;
          if (occurrences === 0) throw new Error("oldText was not found exactly");
          if (!value.replaceAll && occurrences !== 1) {
            throw new Error(`oldText matched ${occurrences} times; use replace_all=True explicitly`);
          }
          const updated = parts.join(newText);
          if (Buffer.byteLength(updated) > MAX_WRITE_BYTES) throw new Error("edited file exceeds write limit");
          return {
            content: updated,
            replacements: value.replaceAll ? occurrences : 1,
            bytes: Buffer.byteLength(updated),
          };
        },
      });
      return {
        path: filePath,
        replacements: result.replacements,
        bytes: result.bytes,
        diff: simpleDiff(filePath, oldText, newText),
      };
    },

    "files.grep": (payload, context) => runGrep(payload, { cwd, ...context }),

    async "files.find"(payload) {
      const value = requireRecord(payload, "files.find payload");
      const root = resolvePath(cwd, value.path);
      const pattern = requireString(value.pattern, "pattern", { maxBytes: 4096 });
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 500);
      const matches = [];
      await walk(root, async (filePath) => {
        const relative = path.relative(root, filePath) || path.basename(filePath);
        if (matches.length < limit && (path.matchesGlob(relative, pattern) || path.matchesGlob(path.basename(filePath), pattern))) {
          matches.push(filePath);
        }
      });
      return { path: root, pattern, matches, truncated: matches.length >= limit };
    },

    async "files.list"(payload) {
      const value = requireRecord(payload, "files.list payload");
      const directory = resolvePath(cwd, value.path);
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 500);
      const allEntries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const entries = allEntries.slice(0, limit)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
      return { path: directory, entries, truncated: allEntries.length > limit };
    },

    async "files.attachment"(payload) {
      const value = requireRecord(payload, "files.attachment payload");
      const filePath = resolvePath(cwd, value.path);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("attachment path must be a file");
      if (fileStat.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
      const data = await readFile(filePath);
      return {
        path: filePath,
        fileName: path.basename(filePath),
        mimeType: MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
        bytes: data.length,
        data: data.toString("base64"),
      };
    },

    "shell.run": (payload, context) => runShell(payload, { cwd, scratch, ...context }),

    "kernel.status"() {
      const kernel = getKernel();
      const coldMemory = coldMemoryStatus(kernel);
      return { running: Boolean(kernel?.isRunning), busy: Boolean(kernel?.isBusy), restore: getKernelRestore() ?? null,
        ...(coldMemory ? { coldMemory } : {}) };
    },

    "kernel.restart"() {
      restartKernel();
      return { admitted: true, message: "kernel restart admitted; the next ipython call will restore the latest valid snapshot" };
    },

    async "operations.status"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const status = await client.request("get_status", {});
      const capacity = requireRecord(status.capacity, "status.capacity");
      const allowedCapacity = new Set(["resident", "starting", "queued", "maxResident", "maxConcurrentStarts"]);
      for (const key of Object.keys(capacity)) {
        if (!allowedCapacity.has(key)) throw new Error(`unsupported capacity field: ${key}`);
      }
      for (const key of allowedCapacity) {
        if (capacity[key] === undefined) throw new Error(`capacity.${key} is required`);
      }
      return {
        daemon: status.daemon,
        capacity: {
          resident: boundedInteger(capacity.resident, "capacity.resident", 0, 10_000),
          starting: boundedInteger(capacity.starting, "capacity.starting", 0, 10_000),
          queued: boundedInteger(capacity.queued, "capacity.queued", 0, 10_000),
          maxResident: boundedInteger(capacity.maxResident, "capacity.maxResident", 1, 128),
          maxConcurrentStarts: boundedInteger(capacity.maxConcurrentStarts, "capacity.maxConcurrentStarts", 1, 32),
        },
        counts: status.counts,
        usage: status.usage,
        diagnostics: status.diagnostics,
        sessions: status.sessions.map((session) => ({
          sessionId: session.sessionId,
          shortId: session.shortId,
          name: session.name,
          kind: session.kind,
          depth: session.depth,
          lineage: session.lineage,
          activity: session.activity,
          lifecycle: session.lifecycle,
          workingDescendantCount: session.workingDescendantCount,
          model: session.launch?.model ?? null,
          thinking: session.launch?.thinking ?? null,
          capabilityIds: session.launch?.capabilityIds ?? [],
        })),
      };
    },

    async "operations.diagnose"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const status = await client.request("get_status", {});
      return { healthy: status.diagnostics.length === 0, issues: status.diagnostics };
    },

    async "operations.usage"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "operations.usage payload");
      for (const key of Object.keys(value)) if (key !== "windowMinutes") throw new Error(`unsupported usage option: ${key}`);
      const windowMinutes = boundedInteger(value.windowMinutes, "windowMinutes", 1, 10_080, 60);
      return client.request("get_usage", { windowMinutes });
    },

    async "operations.events"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "operations.events payload");
      const limit = boundedInteger(value.limit, "limit", 1, 500, 100);
      const status = await client.request("get_status", {});
      return readRecentEvents(status.daemon.logPath, limit);
    },

    async "session_history.query"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "session_history.query payload");
      const supported = new Set(["operation", "query", "sessionId", "entryId", "kind", "includeDeleted",
        "includeCurrent", "roles", "limit", "sort", "snippetChars", "before", "after", "maxChars", "refresh"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported session history option: ${key}`);
      return client.request("session_history", value);
    },

    async "cron.manage"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      return client.request("cron_job", requireRecord(payload, "cron.manage payload"));
    },

    async "agent_message.request_attention"(payload) {
      const client = getClient(); if (!client?.isConnected) throw new Error("harness is offline");
      return client.request("request_attention", requireRecord(payload, "agent_message.request_attention payload"));
    },
    async "agent_message.resolve_attention"(payload) {
      const client = getClient(); if (!client?.isConnected) throw new Error("harness is offline");
      return client.request("resolve_attention", requireRecord(payload, "agent_message.resolve_attention payload"));
    },
    async "agent_message.list_agents"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const result = await client.request("get_roster", {});
      return { agents: result.agents.map(projectManagedSession) };
    },

    async "agent_message.send"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "agent_message.send payload");
      const result = await client.request("send_message", {
        target: requireString(value.target, "target", { maxBytes: 256 }),
        body: requireString(value.body, "body", { maxBytes: 16 * 1024 }),
        deliveryMode: value.deliveryMode ?? "auto",
      });
      await recordAgentMessage(result.message);
      return result;
    },

    async "agent_message.start_session"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "agent_message.start_session payload");
      for (const key of Object.keys(value)) if (!["name", "task", "cwd"].includes(key)) throw new Error(`unsupported start_session option: ${key}`);
      const name = requireString(value.name, "name", { maxBytes: 256 });
      const task = requireString(value.task, "task", { maxBytes: 16 * 1024 });
      const cwd = requireString(value.cwd, "cwd", { maxBytes: 4096 });
      if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
      const { admission } = await client.request("create_root", { cwd, repositoryRoot: null, name, provider: null, model: null, thinkingLevel: null });
      // The task arrives as an ordinary sister message, so the room can reply to Home.
      const sent = await client.request("send_message", { target: admission.sessionId, body: task, deliveryMode: "auto" });
      await recordAgentMessage(sent.message);
      return { sessionId: admission.sessionId, shortId: admission.shortId, name: admission.name, message: sent.message };
    },

    async "agent_message.set_default_model"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "agent_message.set_default_model payload");
      for (const key of Object.keys(value)) if (!["model", "apply"].includes(key)) throw new Error(`unsupported set_default_model option: ${key}`);
      if (typeof value.apply !== "boolean") throw new Error("apply must be boolean");
      return client.request("set_default_inference", { target: requireString(value.model, "model", { maxBytes: 256 }), apply: value.apply });
    },

    async "rlm.spawn"(payload) {
      const client = getClient();
      const context = getContext();
      const manifest = getManifest();
      if (!client?.isConnected) throw new Error("harness is offline");
      if (client.connectedSession.depth >= client.limits.maxDepth) {
        throw new Error(`maximum child depth ${client.limits.maxDepth} would be exceeded`);
      }
      if (!context?.model) throw new Error("the parent session has no resolved model");
      if (!manifest) throw new Error("the parent skill manifest is unavailable");
      const value = requireRecord(payload, "rlm.spawn payload");
      const supported = new Set(["prompt", "name", "model", "thinkingLevel", "forkContext"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported rlm option: ${key}`);
      const forkContext = value.forkContext === undefined ? false : value.forkContext;
      if (typeof forkContext !== "boolean") throw new Error("fork_context must be boolean");
      // A fork copies the parent's current context; the supervisor reads it through the core.
      let catalogWarning;
      try {
        const result = await context.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(15_000) });
        if (result.aborted || result.errors.size || context.modelRegistry.getError()) catalogWarning = "Model catalog reload failed; using cached models.";
      } catch { catalogWarning = "Model catalog reload failed; using cached models."; }
      if (catalogWarning) context.ui?.notify(catalogWarning, "warning");
      const models = context.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning === true,
        thinkingLevels: supportedThinkingLevels(model),
      }));
      const skillCatalog = manifest.skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        contentHash: skill.contentHash,
        skillPath: skill.skillPath,
        pythonBacked: Boolean(skill.python),
      }));
      await client.request("set_skill_manifest", { skills: skillCatalog });
      const prompt = requireString(value.prompt, "prompt", { maxBytes: 32 * 1024 });
      const result = await client.request("spawn_child", {
        prompt,
        ...(forkContext ? { forkContext: true } : {}),
        name: value.name === null || value.name === undefined ? null : requireString(value.name, "name", { maxBytes: 64 }),
        model: value.model === null || value.model === undefined ? null : requireString(value.model, "model", { maxBytes: 384 }),
        thinkingLevel: value.thinkingLevel === null || value.thinkingLevel === undefined
          ? null
          : requireString(value.thinkingLevel, "thinking_level", { maxBytes: 16 }),
        parentModel: {
          provider: context.model.provider,
          id: context.model.id,
          name: context.model.name ?? context.model.id,
          reasoning: context.model.reasoning === true,
          thinkingLevels: supportedThinkingLevels(context.model),
        },
        parentThinkingLevel: context.thinkingLevel ?? "off",
        availableModels: models,
      });
      await recordChildCreation(result?.childCreation);
      const { childCreation: _childCreation, ...publicResult } = result;
      return publicResult;
    },

    async "rlm.find_models"(payload) {
      const context = getContext();
      if (!context) throw new Error("session context is unavailable");
      const value = requireRecord(payload, "rlm.find_models payload");
      const supported = new Set(["query", "limit"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported find_models option: ${key}`);
      let warning;
      try {
        const result = await context.modelRegistry.refresh({ signal: AbortSignal.timeout(15_000) });
        if (result.aborted || result.errors.size || context.modelRegistry.getError()) warning = "Model catalog refresh failed; showing cached models.";
      } catch { warning = "Model catalog refresh failed; showing cached models."; }
      if (warning) context.ui?.notify(warning, "warning");
      const models = context.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning === true,
        thinkingLevels: supportedThinkingLevels(model),
      }));
      const preferred = [];
      if (context.model?.provider && context.model?.id) {
        preferred.push({ provider: context.model.provider, id: context.model.id });
      }
      if (models.some((model) => model.provider === "grok-cli" && model.id === "grok-4.6")) {
        preferred.push({ provider: "grok-cli", id: "grok-4.6" });
      }
      return {
        models: findModels(models, value.query ?? "", value.limit ?? 50, preferred),
        ...(warning ? { warning } : {}),
      };
    },

    // The list is for choosing a child: name, address, one state and when it last did anything.
    // Idle includes sleeping children. One child's full record comes from rlm.get_subagent.
    async "rlm.list_subagents"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const result = await client.request("list_children", {});
      const state = (child) => child.lifecycle === "error" ? "failed" : child.lifecycle === "stopped" ? "stopped"
        : child.lifecycle === "starting" || ["working", "delegating"].includes(child.activity) ? "working" : "idle";
      return { children: result.children.map((child) => ({ name: child.name, shortId: child.shortId, state: state(child),
        ...(child.lastActivityAt == null ? {} : { lastActivityAt: child.lastActivityAt }) })) };
    },

    async "rlm.get_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.get_subagent payload");
      const result = await client.request("get_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },

    async "rlm.stop_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.stop_subagent payload");
      const result = await client.request("stop_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },

    async "rlm.revive_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.revive_subagent payload");
      const result = await client.request("revive_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },

    async "rlm.delete_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.delete_subagent payload");
      const result = await client.request("delete_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },
  };
}

export const hostLimits = {
  maxReadBytes: MAX_READ_BYTES,
  maxWriteBytes: MAX_WRITE_BYTES,
  maxSearchFiles: MAX_SEARCH_FILES,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxShellCaptureBytes: MAX_SHELL_CAPTURE_BYTES,
  maxGrepFiles: MAX_GREP_FILES,
  maxGrepFileBytes: MAX_SEARCH_SOURCE_BYTES,
  maxGrepTotalBytes: MAX_GREP_TOTAL_BYTES,
  maxGrepLineBytes: MAX_GREP_LINE_BYTES,
  maxGrepOutputBytes: MAX_GREP_OUTPUT_BYTES,
  maxGrepRuntimeMs: MAX_GREP_RUNTIME_MS,
};
