// The real shipped catalog must enable async Python and the wait tool must be a barrier.
import assert from "node:assert/strict";
import test from "node:test";
import { coreLiveFixture, until } from "./fixtures/core-live.mjs";

const ready = Boolean(process.env.PI_HARNESS_CORE_BIN && process.env.PI_HARNESS_CORE_JS && process.env.PI_HARNESS_PYTHON);

test("shipped Codex catalog enables Python async and wait receives its real result first", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  assert(process.env.PI_HARNESS_CORE_MODELS, "PI_HARNESS_CORE_MODELS must name the core's shipped models.json");
  const f = await coreLiveFixture(t, "catalog-async", ({ response, body, index, send, done }) => {
    if (index === 1) {
      const python = body.tools.find((tool) => tool.name === "ipython");
      const wait = body.tools.find((tool) => tool.name === "wait_for_ipython");
      assert.equal(python?.async, true, "actual catalog enables native async on the outgoing schema");
      assert(wait, "the Python wait barrier is offered");
      send(response, { type: "response.output_item.done", item: { type: "function_call", id: "fc_python", call_id: "python",
        name: "ipython", arguments: JSON.stringify({ code: "import time\ntime.sleep(1)\nprint('ASYNC_FINISHED')" }), async: true, status: "completed" } });
      send(response, { type: "response.output_item.done", item: { type: "function_call", id: "fc_wait", call_id: "wait",
        name: "wait_for_ipython", arguments: "{}", status: "completed" } });
    } else {
      const outputs = body.input.filter((item) => item.type === "function_call_output");
      assert.deepEqual(outputs.map((item) => item.call_id), ["python", "wait"]);
      assert.match(JSON.stringify(outputs[0].output), /ASYNC_FINISHED/);
      assert.match(JSON.stringify(outputs[1].output), /Prior Python calls have settled/);
      done(response, 0, "PYTHON_WAIT_VERIFIED");
    }
    send(response, { type: "response.completed", response: { id: `response-${index}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } });
    response.end();
  }, { models: ["gpt-6.1-sol"], nativeAsync: true, shippedModels: true });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "exercise the Python wait barrier", behavior: "auto" });
  await until(() => f.requests.length === 2, "the second provider request");
  await until(async () => (await f.visible()).some((row) => row.text === "PYTHON_WAIT_VERIFIED"), "the final answer");
});

test("a shipped Codex model without native support does not advertise async", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  assert(process.env.PI_HARNESS_CORE_MODELS, "PI_HARNESS_CORE_MODELS must name the core's shipped models.json");
  const f = await coreLiveFixture(t, "catalog-ordinary", ({ response, body, index, send, done }) => {
    assert.notEqual(body.tools.find((tool) => tool.name === "ipython")?.async, true);
    assert.equal(body.tools.some((tool) => tool.name === "wait_for_ipython"), false);
    done(response, 0, "ORDINARY_VERIFIED");
    send(response, { type: "response.completed", response: { id: `response-${index}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } });
    response.end();
  }, { models: ["gpt-6-sol"], nativeAsync: true, shippedModels: true });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "check ordinary mode", behavior: "auto" });
  await until(async () => (await f.visible()).some((row) => row.text === "ORDINARY_VERIFIED"), "the ordinary-mode answer");
});

test("refreshed Codex metadata retains shipped async capability in worker preparation", { skip: !ready && "core or Python runtime not configured", timeout: 120_000 }, async (t) => {
  assert(process.env.PI_HARNESS_CORE_MODELS, "PI_HARNESS_CORE_MODELS must name the core's shipped models.json");
  const f = await coreLiveFixture(t, "catalog-refreshed", ({ response, body, index, send, done }) => {
    assert.equal(body.tools.find((tool) => tool.name === "ipython")?.async, true);
    assert(body.tools.some((tool) => tool.name === "wait_for_ipython"));
    assert.match(JSON.stringify(body.input.at(-1)), /of 333k tokens/, "the worker used the refreshed window");
    done(response, 0, "REFRESH_VERIFIED");
    send(response, { type: "response.completed", response: { id: `response-${index}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } });
    response.end();
  }, { models: ["gpt-6.1-terra"], nativeAsync: true, shippedModels: true, refreshedCatalog: true });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "check refreshed catalog", behavior: "auto" });
  await until(async () => (await f.visible()).some((row) => row.text === "REFRESH_VERIFIED"), "the refreshed-mode answer");
});
