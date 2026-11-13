import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sessionSidecarPaths } from "../src/session-paths.mjs";

test("derives every session-local sidecar from the session's core folder", () => {
  const sessionFile = path.resolve("/tmp/conversation-core/sessions/2f6c0a64-0d5e-4b2f-9a43-2c1d0f1b7e10");
  const basePath = sessionFile;
  const paths = sessionSidecarPaths(sessionFile);

  assert.deepEqual(paths, {
    sessionFile,
    basePath,
    skillManifestPath: `${basePath}.skill-manifest.json`,
    capabilitiesPath: `${basePath}.capabilities.json`,
    skillGrantPath: `${basePath}.skill-grant.json`,
    kernelStatePath: `${basePath}.kernel-state`,
  });
  assert(Object.isFrozen(paths));
});

test("rejects paths that cannot name a session folder", () => {
  assert.throws(() => sessionSidecarPaths(""), /non-empty/);
  assert.throws(() => sessionSidecarPaths("/"), /session folder/);
});
