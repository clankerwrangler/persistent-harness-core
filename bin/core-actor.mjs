#!/usr/bin/env node
import { Console } from "node:console";
import { enableActorCompileCache } from "../src/actor-compile-cache.mjs";

// stdout is exclusively the actor protocol. Everything else goes to stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
enableActorCompileCache();
try {
  const { runWorkerRpc } = await import("../src/worker-rpc.mjs");
  const { bootstrapCoreWorker } = await import("../src/core-worker.mjs");
  await runWorkerRpc({ bootstrap: bootstrapCoreWorker });
}
catch (error) { console.error(`Core actor worker failed: ${error.message}`); process.exitCode = 1; }
