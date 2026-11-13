// A real supervisor and a real core worker talking to a fake Codex provider: a local server
// speaking the Responses API over plain HTTP streaming (the core falls back to it when it
// cannot open a WebSocket). `script({ response, body, index, send, item, done })` answers
// each model request; it may hold the response open. Needs a Python runtime
// (PI_HARNESS_PYTHON) for the ipython tool. `nativeAsync` turns on native asynchronous Python calls
// (a call the provider marks `async: true` does not hold up the next request).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor } from "./isolated-supervisor.mjs";

export async function until(probe, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${description}`);
}

/** A sign-in token the core accepts for Codex: it reads the account id from the token. */
function fakeCodexToken(account) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: account } })}.fixture`;
}

const ENV = ["PI_CODING_AGENT_DIR", "PI_HARNESS_CORE_ARGS", "PI_HARNESS_CORE_SESSIONS", "PI_HARNESS_AUTO_INSTALL", "PI_HARNESS_NATIVE_ASYNC"];

export async function coreLiveFixture(t, name, script, { models = ["gpt-6-astra"], maxRequests = 2, nativeAsync = false, shippedModels = false, refreshedCatalog = false } = {}) {
  assert(process.env.PI_HARNESS_PYTHON, "the core live fixture needs a Python runtime (PI_HARNESS_PYTHON)");
  const directory = await mkdtemp(path.join(os.tmpdir(), "core-live-"));
  const cwd = path.join(directory, "project"), coreDir = path.join(directory, "core"), agentDir = path.join(directory, "agent");
  await Promise.all([mkdir(cwd), mkdir(coreDir), mkdir(agentDir)]);
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const events = [], snapshots = [], errors = [], responses = [], requests = [];
  let supervisor, client, sessionId;
  const send = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const item = (index, value) => ({ type: "message", id: `msg_${index}`, role: "assistant", status: "completed", phase: "commentary",
    content: [{ type: "output_text", text: value, annotations: [] }] });
  const done = (response, index, value) => send(response, { type: "response.output_item.done", output_index: index, item: item(index, value) });
  // No WebSocket: an upgrade request is dropped, so the core sends each request over HTTP.
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/codex/responses");
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      assert(models.includes(body.model), `the fixture refuses an unexpected model ${body.model}`);
      responses.push(response); requests.push(body);
      assert(requests.length <= maxRequests, "the fixture's request bound was exceeded");
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(response, { type: "response.created", response: { id: `response-${requests.length}`, status: "in_progress" } });
      await script({ response, body, index: requests.length, send, item, done });
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.on("upgrade", (request, socket) => socket.destroy());
  t.after(async () => {
    for (const response of responses) response.end();
    await client?.stop(); await supervisor?.stop();
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(errors, []);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const modelsFile = path.join(coreDir, "models.json"), auth = path.join(coreDir, "auth.json");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // For the catalog integration test, use the actual shipped entries, changing only
  // the endpoint to the local fake provider. Never hand-author their capabilities.
  const shipped = shippedModels ? JSON.parse(await readFile(process.env.PI_HARNESS_CORE_MODELS, "utf8")).models : null;
  const definitions = Object.fromEntries(models.map((id) => [id, shipped
    ? { ...shipped[id], baseUrl }
    : { provider: "openai-codex", id, name: id, api: "openai-codex-responses", baseUrl,
      contextWindow: 272_000, reasoning: false, ...(nativeAsync ? { compat: { supportsAsyncTools: true } } : {}) }]));
  if (shipped) for (const id of models) assert(shipped[id], `shipped model missing: ${id}`);
  await writeFile(modelsFile, JSON.stringify({ models: definitions }));
  if (refreshedCatalog) {
    assert(shipped, "a refreshed catalog test must use the shipped model data");
    // Codex discovery returns provider metadata without pi's capability overrides.
    const discovered = models.map((id) => {
      const model = { ...definitions[id], contextWindow: 333_333 };
      delete model.compat;
      return model;
    });
    const catalog = path.join(coreDir, "catalog");
    await mkdir(catalog);
    await writeFile(path.join(catalog, "openai-codex.json"), JSON.stringify({ checkedAt: Date.now(), models: discovered }));
  }
  await writeFile(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: fakeCodexToken("fixture-account"), refresh: "fixture-refresh",
    expires: Date.now() + 365 * 24 * 3600_000, accountId: "fixture-account" } }), { mode: 0o600 });
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_AUTO_INSTALL: "0", PI_HARNESS_NATIVE_ASYNC: nativeAsync ? "1" : "0", PI_HARNESS_CORE_SESSIONS: path.join(coreDir, "sessions"),
    PI_HARNESS_CORE_ARGS: JSON.stringify(["--models", modelsFile, "--auth", auth, "--catalog", path.join(coreDir, "catalog"), "--agent-dir", agentDir]),
  });
  const socketPath = path.join(directory, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "state", "harness.sqlite"),
    pidPath: path.join(directory, "run", "supervisor.pid"), backgroundJobsDirectory: path.join(agentDir, "state", "background-jobs"),
    skillsPath: process.env.PI_HARNESS_SKILLS_PATH ?? path.resolve(import.meta.dirname, "../../skills"), actorInactivityMs: 0 });
  await supervisor.start();
  client = new HarnessClient({ requestTimeoutMs: 120_000, socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: randomUUID() });
  client.on("event", (frame) => { if (frame.event === "actor_event") events.push(frame.data.event); });
  sessionId = (await client.request("create_root", { cwd, repositoryRoot: null, name, provider: "openai-codex", model: models[0], thinkingLevel: "off" })).admission.sessionId;
  await client.request("subscribe_session", { selector: sessionId });
  const visible = async () => {
    const result = await client.request("get_visible_messages", { sessionId }); snapshots.push(result);
    return result.messages.filter((row) => row.role === "assistant");
  };
  // Tool calls as clients see them: the call id begins with the provider's call_id.
  const toolEvents = (type, prefix) => events.filter((event) => event.type === type && String(event.toolCallId ?? "").startsWith(prefix));
  return { cwd, client, supervisor, sessionId, events, snapshots, responses, requests, visible, send, item, done,
    toolStarted: (prefix) => toolEvents("tool_execution_start", prefix).length > 0,
    toolEnded: (prefix) => toolEvents("tool_execution_end", prefix).length > 0,
    toolEvents,
    entries: async () => (await client.request("get_actor_entries", { sessionId })).entries };
}
