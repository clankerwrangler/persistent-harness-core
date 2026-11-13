// A real core worker in the middle of work: its first reply starts a Python call that
// waits for the test to release it, so a client can act while the turn is busy.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreLiveFixture, until } from "./core-live.mjs";

const HELD = "held-python";

export async function modelSwitchFixture(t, { maxRequests = 3, readNamespaceOnContinuation = true, holdContinuationResponse = false } = {}) {
  let releasePath, readyPath, countPath, continuationReleased = false;
  // The held call is native async, as the provider marks it; the namespace read is not.
  const call = (id, code, native = false) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "ipython", arguments: JSON.stringify({ code }),
    ...(native ? { async: true } : {}) });
  const complete = (f, response, output) => {
    f.send(response, { type: "response.completed", response: { id: `response-${f.responses.indexOf(response) + 1}`, status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
  };
  const f = await coreLiveFixture(t, "model-switch", ({ response, index, send, item }) => {
    if (index === 1) {
      const code = `import os, time
from pathlib import Path
counter = Path(${JSON.stringify(countPath)})
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else "1")
persistent_probe = 41
Path(${JSON.stringify(readyPath)}).write_text("HOLD_STARTED " + str(persistent_probe))
print("HOLD_STARTED", flush=True)
while not os.path.exists(${JSON.stringify(releasePath)}): time.sleep(0.05)
print("HOLD_DONE", persistent_probe)`;
      const tool = call(HELD, code, true);
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } });
      send(response, { type: "response.output_item.done", output_index: 0, item: tool });
    } else if (index === 2 && readNamespaceOnContinuation) {
      const tool = call("read-python", 'print("KEPT_NAMESPACE", persistent_probe + 1)');
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } });
      send(response, { type: "response.output_item.done", output_index: 0, item: tool });
      complete({ send, responses: f.responses }, response, [tool]);
    } else {
      if (holdContinuationResponse && !continuationReleased) return;
      const answer = item(0, "SWITCH_DONE");
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
      send(response, { type: "response.output_item.done", output_index: 0, item: answer });
      complete({ send, responses: f.responses }, response, [answer]);
    }
  }, { models: ["gpt-6-astra", "gpt-6.1-sol"], maxRequests, nativeAsync: true });
  releasePath = path.join(f.cwd, "release-tool");
  readyPath = path.join(f.cwd, "held-tool-ready"); countPath = path.join(f.cwd, "held-execute-count");
  t.after(() => writeFile(releasePath, "release").catch(() => {}));
  const inference = () => f.client.request("get_session_inference", { sessionId: f.sessionId });
  const heldResults = async () => (await f.entries()).filter(entry => entry.message?.role === "toolResult" && String(entry.message.toolCallId).startsWith(HELD));
  return { ...f, inference,
    async start() {
      await f.client.request("submit_input", { sessionId: f.sessionId, message: "Test model switching with retained Python", behavior: "auto", clientRequestId: "model-switch-input" });
      const ready = await until(() => readFile(readyPath, "utf8").catch(error => {
        if (error.code === "ENOENT") return false;
        throw error;
      }), "Python reaches its held execution");
      assert.equal(ready, "HOLD_STARTED 41");
      assert.equal(await readFile(countPath, "utf8"), "1");
      await until(() => f.toolStarted(HELD), "the held call's start reaches the supervisor");
      assert.equal(f.toolEnded(HELD), false);
      assert.deepEqual(await heldResults(), []);
    },
    finishStream() { complete(f, f.responses[0], []); },
    finishContinuation() {
      continuationReleased = true;
      for (const response of f.responses.slice(1)) {
        if (response.writableEnded || response.destroyed) continue;
        const answer = f.item(0, "SWITCH_DONE");
        f.send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
        f.send(response, { type: "response.output_item.done", output_index: 0, item: answer });
        complete(f, response, [answer]);
      }
    },
    async releaseTool() { await writeFile(releasePath, "release"); },
    async toolFinished() {
      await until(() => f.toolEnded(HELD), "the held call finishes");
      const results = await until(async () => { const found = await heldResults(); return found.length ? found : false; }, "the held result is saved");
      assert.equal(results.length, 1); assert.equal(results[0].message.isError, false);
      assert.match(JSON.stringify(results[0].message.content), /HOLD_DONE 41/);
      assert.equal(await readFile(countPath, "utf8"), "1", "the held Python runs once");
    },
    async settled() { await until(() => f.events.some(e => e.type === "agent_settled"), "model-switch settlement"); },
  };
}

/** A reply in flight with an explicit follow-up and an automatic input waiting behind it. The
 * automatic input joins the running turn; the follow-up starts the next one. */
export async function followUpBoundaryFixture(t) {
  const f = await coreLiveFixture(t, "follow-up-boundary", () => {}, { maxRequests: 3 });
  return { ...f,
    async start() {
      const receipt = await f.client.request("submit_input", { sessionId: f.sessionId, message: "An admitted message before the queued reports.",
        behavior: "auto", clientRequestId: "boundary-original" });
      await until(() => f.requests.length === 1, "first answer is in flight");
      return receipt;
    },
    async queue(message, behavior, clientRequestId) {
      const receipt = await f.client.request("submit_input", { sessionId: f.sessionId, message, behavior, clientRequestId });
      await until(() => f.supervisor.store.getActorInput(receipt.inputId, f.sessionId)?.state === "accepted", "input reaches the worker's queue");
      return receipt;
    },
    finishAnswer(index) {
      const response = f.responses[index], answer = f.item(index, ["The original answer is complete.", "The automatic report is answered.", "The follow-up is answered."][index]);
      f.send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
      f.send(response, { type: "response.output_item.done", output_index: 0, item: answer });
      f.send(response, { type: "response.completed", response: { id: `response-${index + 1}`, status: "completed", output: [answer],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    },
    async settled(count = 1) { await until(() => f.events.filter(event => event.type === "agent_settled").length >= count, "boundary settlement"); },
  };
}
