// Start a session's Python kernel in a runtime the supervisor installed. Nothing is
// installed here: with no usable runtime, starting fails and says so.
import { access } from "node:fs/promises";
import { MANAGED_VERSIONS, PythonRuntimeRejection, assertManagedVersions, compatibleEnvironments,
  retireManagedSkillSources, runtimeEnvironment } from "./python-runtime-layout.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * `createKernel(runtime)` makes a kernel for a candidate runtime; the first candidate whose
 * kernel starts is used. Only a runtime rejection (a missing or wrong interpreter) moves on to
 * the next candidate; any other failure stops, after closing the kernel it started.
 */
export async function launchPython({ runtimeDir, pythonOverride = process.env.PI_HARNESS_PYTHON, skills, createKernel }) {
  const start = async (candidate) => {
    const kernel = await createKernel({ ...candidate, expectedVersions: candidate.managed ? { ...MANAGED_VERSIONS } : undefined });
    try {
      const ready = await kernel.start({ onRuntimeValidated: async (versions) => {
        if (!candidate.managed) return;
        try { assertManagedVersions(versions); }
        catch (error) { throw new PythonRuntimeRejection(error.message, { cause: error }); }
      } });
      return { ...candidate, versions: ready.versions, kernel, ready };
    } catch (error) {
      await kernel.close({ snapshot: false });
      throw error;
    }
  };
  if (pythonOverride) return start({ pythonPath: pythonOverride, managed: false, environmentId: "override" });
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("managed Python currently supports Linux x64 only; set PI_HARNESS_PYTHON to a compatible interpreter");
  }
  const environment = runtimeEnvironment(runtimeDir, skills);
  const candidates = [];
  if (await exists(environment.completePath)) {
    candidates.push({ environmentDir: environment.environmentDir, pythonPath: environment.pythonPath, managed: true, environmentId: environment.environmentId });
  }
  for (const found of await compatibleEnvironments(runtimeDir, environment.dependencies)) {
    if (found.environmentDir === environment.environmentDir) continue;
    candidates.push({ ...found, managed: true, compatible: true });
  }
  for (const { environmentDir, ...candidate } of candidates) {
    await retireManagedSkillSources(environmentDir);
    try { return await start(candidate); }
    catch (error) { if (!(error instanceof PythonRuntimeRejection)) throw error; }
  }
  throw new Error("the Python runtime for this session's skills is not installed; the supervisor installs it");
}
