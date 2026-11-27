import assert from "node:assert/strict";
import test from "node:test";
import { requestTimeoutFor } from "../src/client.mjs";

test("child lifecycle and history requests get the long budget; others stay short", () => {
  const budgets = { requestTimeoutMs: 3000, historyRequestTimeoutMs: 28_000 };
  for (const type of ["stop_child", "delete_child", "revive_child"]) assert.equal(requestTimeoutFor(type, {}, budgets), 28_000, type);
  assert.equal(requestTimeoutFor("session_history", { operation: "search" }, budgets), 28_000);
  assert.equal(requestTimeoutFor("session_history", { operation: "list" }, budgets), 3000);
  for (const type of ["heartbeat", "spawn_child", "get_child", "record_agent_message_entry"]) assert.equal(requestTimeoutFor(type, {}, budgets), 3000, type);
});
