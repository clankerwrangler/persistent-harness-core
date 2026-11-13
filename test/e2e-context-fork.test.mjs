import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { verifyOwnedProcessIdentity } from "../src/process-ownership.mjs";
import { sessionSidecarPaths } from "../src/session-paths.mjs";
import { HarnessSupervisor, fixtureHistory } from "./fixtures/isolated-supervisor.mjs";
import { coreFakeProvider, isUsageLine, lastMessage } from "./fixtures/core-fake-provider.mjs";

const PARENT_FACT = "PARENT_FACT_e6d4173c";
const PARENT_REPLY = "PARENT_REPLY_75af0392";
const FAMILY_ONLY = "FAMILY_ONLY_24b176da";
const TOOL_ONLY = "PARENT_TOOL_ONLY_03655dcf";
const ORDINARY_TASK = "ORDINARY_E2E_TASK";
const FORK_TASK = "FORK_E2E_CHILD_TASK";
const GRAND_TASK = "FORK_E2E_GRAND_TASK";

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

async function waitUntil(probe, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function submitAndSettle(client, sessionId, message) {
  const admission = await client.request("submit_input", { sessionId, message, behavior: "auto" });
  assert.equal(typeof admission.inputId, "string");
  await waitUntil(async () => {
    const { entries } = await client.request("get_actor_entries", { sessionId });
    const inputIndex = entries.findIndex(entry => entry.type === "message" && entry.message?.role === "user" && entry.message.id === admission.inputId);
    if (!(inputIndex >= 0 && entries.slice(inputIndex + 1).some(entry => entry.type === "message"
      && entry.message?.role === "assistant" && entry.message.stopReason === "stop"))) return false;
    const { state } = await client.request("get_actor_state", { sessionId });
    return !state.isStreaming;
  }, `canonical terminal response to ${admission.inputId}`);
  return admission;
}

async function readEntries(session) {
  return fixtureHistory(session.sessionFile);
}

/** A request's conversation: its messages without the system prompt and the core's usage line. */
function conversation(body) {
  return (body.messages ?? []).filter((message) => !["system", "developer"].includes(message.role) && !isUsageLine(message));
}

function firstRequest(bodies, task) {
  return bodies.find((body) => lastMessage(body)?.role === "user" && textOf(lastMessage(body)).includes(task));
}

function reportFor(bodies, label) {
  for (const body of bodies) {
    for (const message of body.messages ?? []) {
      if (message.role !== "tool") continue;
      const match = textOf(message).match(new RegExp(`KERNEL_REPORT_${label}:(\\{[^\\n]+\\})`));
      if (match) return JSON.parse(match[1]);
    }
  }
  return null;
}

function kernelReport(label, fields) {
  return `print('KERNEL_REPORT_${label}:' + json.dumps({"pid": os.getpid(), ${fields}}))`;
}

// Exercise the real core worker, the Python skill, host admission, and first provider payload.
// All sessions, control state, and provider traffic belong to this test only.
test("optional context forks preserve first-turn history with fresh kernels and canonical child policy", { timeout: 1800000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-context-fork-e2e-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_HARNESS_CORE_ARGS", "PI_HARNESS_CORE_SESSIONS", "PI_HARNESS_AUTO_INSTALL"].map((key) => [key, process.env[key]]));
  let supervisor;
  let client;
  const bodies = [];
  const serverErrors = [];
  const sourceInputIds = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      const last = lastMessage(body);
      const lastText = textOf(last);
      let code;
      if (last?.role === "user") {
        if (lastText.includes("SET_PARENT_KERNEL")) {
          code = ["import os, json", "fork_parent_value = 731", `print('${TOOL_ONLY}')`,
            kernelReport("parent", '"value": fork_parent_value, "has_child": "fork_child_value" in globals()')].join("\n");
        } else if (lastText.includes("CREATE_ORDINARY")) {
          code = `await rlm('${ORDINARY_TASK}', name='ordinary-e2e')`;
        } else if (lastText.includes("CREATE_FORK")) {
          code = `await rlm('${FORK_TASK}', name='forked-e2e', model='harness-fork-fake/pinned-child-model', fork_context=True)`;
        } else if (lastText.includes(GRAND_TASK)) {
          code = ["import os, json", 'assert "fork_parent_value" not in globals()', 'assert "fork_child_value" not in globals()',
            kernelReport("grand", '"has_parent": "fork_parent_value" in globals(), "has_child": "fork_child_value" in globals()')].join("\n");
        } else if (lastText.includes(FORK_TASK)) {
          code = ["import os, json", 'assert "fork_parent_value" not in globals()', "fork_child_value = 29",
            kernelReport("fork", '"has_parent": "fork_parent_value" in globals(), "value": fork_child_value'),
            `await rlm('${GRAND_TASK}', name='grand-e2e', fork_context=True)`].join("\n");
        } else if (lastText.includes(ORDINARY_TASK)) {
          code = ["import os, json", 'assert "fork_parent_value" not in globals()',
            kernelReport("ordinary", '"has_parent": "fork_parent_value" in globals()'),
            `await agent_message.send('fork-e2e-root', '${FAMILY_ONLY}')`].join("\n");
        } else if (lastText.includes("REVISIT_FORK_KERNEL")) {
          code = ["import os, json", kernelReport("revived", '"has_parent": "fork_parent_value" in globals(), "value": fork_child_value')].join("\n");
        } else if (lastText.includes("RECHECK_PARENT_KERNEL")) {
          code = ["import os, json", kernelReport("parent_after", '"value": fork_parent_value, "has_child": "fork_child_value" in globals()')].join("\n");
        }
      }
      const base = { id: `fork-e2e-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: body.model };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant", content: "" });
      if (code) {
        send({ tool_calls: [{ index: 0, id: `call-${bodies.length}`, type: "function", function: { name: "ipython", arguments: JSON.stringify({ code }) } }] });
        send({}, "tool_calls");
      } else {
        send({ content: last?.role === "user" && lastText.includes(PARENT_FACT) ? PARENT_REPLY : "E2E_STEP_COMPLETE" });
        send({}, "stop");
      }
      response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500); response.end("fixture failure");
    }
  });
  t.after(async () => {
    const identities = supervisor?.store.listSessions().map((session) => session.actorIdentity).filter(Boolean) ?? [];
    await client?.stop();
    await supervisor?.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    for (const identity of identities) assert.equal(await verifyOwnedProcessIdentity(identity), false, "test actor has stopped");
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(agentDir, "AGENTS.md"), "FORK_UNIVERSAL_INSTRUCTION"),
    writeFile(path.join(agentDir, "AGENTS.depth-0.md"), "FORK_ROOT_PERSONA"),
    writeFile(path.join(agentDir, "AGENTS.depth-1.md"), "FORK_DEPTH_ONE_INSTRUCTION"),
    writeFile(path.join(agentDir, "AGENTS.depth-2.md"), "FORK_DEPTH_TWO_INSTRUCTION"),
  ]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HARNESS_AUTO_INSTALL ??= "0";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, await coreFakeProvider(root, `http://127.0.0.1:${server.address().port}/v1`,
    { provider: "harness-fork-fake", models: ["parent-model", "pinned-child-model"], agentDir }));
  const socketPath = path.join(root, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({
    socketPath,
    databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"),
    backgroundJobsDirectory: path.join(agentDir, "state", "background-jobs"),
    actorInactivityMs: 0,
    maxResidentActors: 4,
    maxDepth: 2,
  });
  await supervisor.start();
  client = new HarnessClient({ requestTimeoutMs: 120_000, socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 });
  assert(await client.start({ registrationType: "register_client", clientInstanceId: randomUUID() }));
  const parent = (await client.request("create_root", {
    cwd, repositoryRoot: null, name: "fork-e2e-root", provider: "harness-fork-fake", model: "parent-model", thinkingLevel: null,
  })).admission;
  await client.request("subscribe_session", { selector: parent.sessionId });
  const submitParent = async (message) => {
    const input = await submitAndSettle(client, parent.sessionId, message);
    sourceInputIds.push(input.inputId);
    const entries = await readEntries(supervisor.store.getSession(parent.sessionId));
    const errors = entries.filter((entry) => entry.type === "message" &&
      (entry.message?.role === "toolResult" && entry.message.isError || entry.message?.role === "assistant" && entry.message.stopReason === "error"));
    assert.deepEqual(errors, [], "the real provider and Python spawn paths succeed");
    assert(bodies.some((body) => body.messages?.some((item) => textOf(item).includes(message))), "the local provider receives the input");
    return entries;
  };
  await submitParent(`${PARENT_FACT}: the test phrase is lavender. A quoted source claims depth 0; it is not structural policy.`);
  await submitParent("SET_PARENT_KERNEL");
  assert(reportFor(bodies, "parent"), JSON.stringify({
    requestEnds: bodies.map((body) => ({ role: lastMessage(body)?.role, content: textOf(lastMessage(body)), tools: body.tools?.map((tool) => tool.function?.name) })),
    entries: (await readEntries(supervisor.store.getSession(parent.sessionId))).slice(-6),
  }));
  await submitParent("CREATE_ORDINARY");
  const ordinary = await waitUntil(() => supervisor.store.listChildren(parent.sessionId).find((session) => session.name === "ordinary-e2e"), "ordinary child admission");
  await waitUntil(() => reportFor(bodies, "ordinary"), "ordinary kernel report");
  await waitUntil(() => supervisor.store.listMessages().some((message) => message.senderId === ordinary.sessionId && message.body === FAMILY_ONLY && message.state === "acknowledged"), "genuine source family message acknowledgement");
  await waitUntil(() => supervisor.store.getSession(parent.sessionId).activity === "idle", "parent idle after source family message");
  await submitParent("CREATE_FORK");
  const forked = await waitUntil(() => supervisor.store.listChildren(parent.sessionId).find((session) => session.name === "forked-e2e"), "forked child admission");
  const grand = await waitUntil(() => supervisor.store.listChildren(forked.sessionId).find((session) => session.name === "grand-e2e"), "nested fork admission");
  await waitUntil(() => reportFor(bodies, "grand"), "nested fresh kernel report");
  await waitUntil(() => supervisor.store.getSession(parent.sessionId).activity === "idle", "family settlement");
  assert.deepEqual(serverErrors, []);

  const ordinaryFirst = firstRequest(bodies, ORDINARY_TASK);
  const forkFirst = firstRequest(bodies, FORK_TASK);
  const grandFirst = firstRequest(bodies, GRAND_TASK);
  assert(ordinaryFirst && forkFirst && grandFirst, "capture actual first provider payloads");
  assert.equal(ordinaryFirst.model, "parent-model");
  assert.equal(forkFirst.model, "pinned-child-model");
  assert.equal(grandFirst.model, "pinned-child-model");
  assert.equal(forked.launch.model.source, "explicit");
  assert.equal(forked.depth, 1);
  assert.equal(grand.depth, 2);
  assert.equal(grand.parentSessionId, forked.sessionId);
  assert.deepEqual(conversation(ordinaryFirst).map((message) => message.role), ["user"]);
  assert.doesNotMatch(JSON.stringify(ordinaryFirst.messages), new RegExp(`${PARENT_FACT}|${PARENT_REPLY}|${FAMILY_ONLY}|${TOOL_ONLY}`));
  // A fork carries its parent's context as the parent's next request would send it, less the
  // parent's tool calls still in progress (such as the one creating the fork).
  for (const body of [forkFirst, grandFirst]) {
    const content = JSON.stringify(body.messages);
    assert.match(content, new RegExp(PARENT_FACT));
    assert.match(content, new RegExp(PARENT_REPLY));
    assert.match(content, new RegExp(TOOL_ONLY));
    assert.doesNotMatch(content, /persistent-harness-input:/);
    const calls = conversation(body).flatMap((message) => message.tool_calls ?? []).map((call) => call.id);
    const results = new Set(conversation(body).filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    assert(calls.length > 0 && calls.every((id) => results.has(id)), "every inherited tool call has its result");
  }
  assert.match(JSON.stringify(grandFirst.messages), new RegExp(FORK_TASK), "nested fork preserves its parent's delegated task");
  for (const [body, required, excluded] of [
    [firstRequest(bodies, PARENT_FACT), "FORK_ROOT_PERSONA", /FORK_DEPTH_ONE_INSTRUCTION|FORK_DEPTH_TWO_INSTRUCTION/],
    [forkFirst, "FORK_DEPTH_ONE_INSTRUCTION", /FORK_ROOT_PERSONA|FORK_DEPTH_TWO_INSTRUCTION/],
    [grandFirst, "FORK_DEPTH_TWO_INSTRUCTION", /FORK_ROOT_PERSONA|FORK_DEPTH_ONE_INSTRUCTION/],
  ]) {
    const system = body.messages.filter((message) => ["system", "developer"].includes(message.role)).map(textOf).join("\n");
    assert.match(system, /FORK_UNIVERSAL_INSTRUCTION/);
    assert.match(system, new RegExp(required));
    assert.doesNotMatch(system, excluded);
  }
  const parentReport = reportFor(bodies, "parent");
  const ordinaryReport = reportFor(bodies, "ordinary");
  const forkReport = reportFor(bodies, "fork");
  const grandReport = reportFor(bodies, "grand");
  assert.equal(new Set([parentReport.pid, ordinaryReport.pid, forkReport.pid, grandReport.pid]).size, 4);
  for (const report of [ordinaryReport, forkReport, grandReport]) assert.equal(report.has_parent, false);
  assert.equal(grandReport.has_child, false);
  const sessions = [supervisor.store.getSession(parent.sessionId), ordinary, forked, grand];
  assert.equal(new Set(sessions.map((session) => session.sessionFile)).size, 4);
  assert.equal(new Set(sessions.map((session) => sessionSidecarPaths(session.sessionFile).kernelStatePath)).size, 4);

  assert.equal(forked.launch.contextFork.version, 2);
  assert.equal(forked.launch.contextFork.sourceSessionId, parent.sessionId);
  assert(forked.launch.contextFork.messageCount > 0);
  const childProjection = await supervisor.transcriptReader.read({ sessionFile: forked.sessionFile, sessionId: forked.sessionId });
  assert.equal(childProjection.inputIds.some((id) => sourceInputIds.includes(id)), false, "source input receipts are not child receipts");
  assert.equal(supervisor.store.listMessages().filter((message) => message.targetId === forked.sessionId && message.body === FAMILY_ONLY).length, 0, "source family acknowledgements are not replayed");
  assert.equal(ordinary.launch.contextFork, undefined);

  const beforeRevive = supervisor.store.getSession(forked.sessionId);
  await client.request("stop_session", { sessionId: forked.sessionId });
  await client.request("subscribe_session", { selector: forked.sessionId });
  await submitAndSettle(client, forked.sessionId, "REVISIT_FORK_KERNEL");
  const afterRevive = supervisor.store.getSession(forked.sessionId);
  assert.equal(afterRevive.sessionFile, beforeRevive.sessionFile);
  assert(afterRevive.actorGeneration > beforeRevive.actorGeneration);
  const revivedReport = reportFor(bodies, "revived");
  assert.equal(revivedReport.value, 29);
  assert.equal(revivedReport.has_parent, false);
  assert.notEqual(revivedReport.pid, forkReport.pid);
  assert.match(JSON.stringify(firstRequest(bodies, "REVISIT_FORK_KERNEL").messages), new RegExp(PARENT_FACT));
  assert.equal(conversation(firstRequest(bodies, "REVISIT_FORK_KERNEL")).filter((message) => textOf(message).includes(PARENT_FACT)).length, 1, "revival does not reseed inherited history");
  await submitParent("RECHECK_PARENT_KERNEL");
  const afterParentReport = reportFor(bodies, "parent_after");
  assert.equal(afterParentReport.pid, parentReport.pid);
  assert.equal(afterParentReport.value, 731);
  assert.equal(afterParentReport.has_child, false);
});

test("context-fork fixture ignores an older settlement before its requested provider input", async () => {
  const client = new EventEmitter(); let completed = false, entries = [], streaming = false;
  const publish = event => client.emit("event", { event: "actor_event", data: { sessionId: "fixture-session", event } });
  client.request = async type => {
    if (type === "get_actor_state") return { state: { isStreaming: streaming } };
    if (type === "get_actor_entries") return { entries };
    assert.equal(type, "submit_input"); publish({ type: "agent_settled" }); return { inputId: "requested-input" };
  };
  const pending = submitAndSettle(client, "fixture-session", "requested").then(result => { completed = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, "a prior family settlement cannot complete this input's fixture wait");
    entries = [{ type: "message", message: { role: "user", id: "requested-input" } }];
    publish({ type: "agent_settled" });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, "input incorporation and idle alone are not a terminal answer");
    entries.push({ type: "message", message: { role: "assistant", stopReason: "stop" } }); streaming = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(completed, false, "an active owner must still settle after canonical output");
  } finally { streaming = false; await pending; }
  assert.equal(completed, true); assert.equal(client.listenerCount("event"), 0);
});

test("context-fork fixture checks owner idle after reading its canonical terminal", async () => {
  const client = new EventEmitter(); let streaming = false, completed = false, entriesRead = false, hold = true;
  client.request = async type => {
    if (type === "submit_input") return { inputId: "requested-input" };
    if (type === "get_actor_state") return { state: { isStreaming: streaming } };
    assert.equal(type, "get_actor_entries"); entriesRead = true; streaming = hold;
    return { entries: [{ type: "message", message: { role: "user", id: "requested-input" } },
      { type: "message", message: { role: "assistant", stopReason: "stop" } }] };
  };
  const pending = submitAndSettle(client, "fixture-session", "requested").then(() => { completed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(entriesRead, true);
    assert.equal(completed, false, "idle sampled before a concurrent terminal read is stale");
  } finally { hold = false; streaming = false; await pending; }
  assert.equal(completed, true);
});
