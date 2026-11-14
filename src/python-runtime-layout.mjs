// Where an installed Python runtime lives and how to tell it is ready: the agreement between
// the supervisor, which installs runtimes (python-runtime.mjs), and the session process,
// which starts its kernel in one (python-launch.mjs). Part of the contract between them.
import { createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export const PYTHON_VERSION = "3.12.12";
export const IPYTHON_VERSION = "9.10.0";
export const DILL_VERSION = "0.3.8";
export const MANAGED_VERSIONS = Object.freeze({ python: PYTHON_VERSION, ipython: IPYTHON_VERSION, dill: DILL_VERSION });

/** A runtime that cannot serve: a missing or wrong interpreter. Another candidate may be tried. */
export class PythonRuntimeRejection extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PythonRuntimeRejection";
  }
}

export function assertManagedVersions(versions) {
  if (versions.python !== PYTHON_VERSION || versions.ipython !== IPYTHON_VERSION || versions.dill !== DILL_VERSION) {
    throw new Error(`managed runtime version mismatch: ${JSON.stringify(versions)}`);
  }
}

/** The environment a set of skills needs, named by what goes into it. */
export function runtimeEnvironment(runtimeDir, skills) {
  const dependencies = [...new Set(skills.flatMap((skill) => skill.python?.dependencies ?? []))].sort();
  const environmentSpec = {
    python: PYTHON_VERSION,
    ipython: IPYTHON_VERSION,
    dill: DILL_VERSION,
    dependencies,
    skills: skills.map((skill) => [skill.id, skill.version, skill.contentHash, skill.python?.srcPath ?? null]),
  };
  const environmentId = createHash("sha256").update(JSON.stringify(environmentSpec)).digest("hex").slice(0, 20);
  const environmentDir = path.join(runtimeDir, "environments", environmentId);
  return { dependencies, environmentSpec, environmentId, environmentDir,
    pythonPath: path.join(environmentDir, "bin", "python"), completePath: path.join(environmentDir, "runtime.json") };
}

/** Finished environments with the same dependencies, in name order: usable for these skills too. */
export async function compatibleEnvironments(runtimeDir, dependencies) {
  const environmentsDir = path.join(runtimeDir, "environments");
  let entries;
  try { entries = await readdir(environmentsDir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const environmentDir = path.join(environmentsDir, entry.name);
    try {
      const record = JSON.parse(await readFile(path.join(environmentDir, "runtime.json"), "utf8"));
      if (record?.version !== 1 || JSON.stringify(record.environmentSpec?.dependencies ?? []) !== JSON.stringify(dependencies)) continue;
      assertManagedVersions(record.versions ?? {});
      found.push({ environmentDir, environmentId: record.environmentId ?? entry.name, pythonPath: path.join(environmentDir, "bin", "python") });
    } catch { continue; }
  }
  return found;
}

/**
 * Remove the harness's own skill shim from an environment before it is used. Only that
 * file goes; the manifest's PYTHONPATH is authoritative, and other site customization stays.
 */
export async function retireManagedSkillSources(environmentDir) {
  const pythonMinor = PYTHON_VERSION.split(".").slice(0, 2).join(".");
  try {
    await unlink(path.join(environmentDir, "lib", `python${pythonMinor}`, "site-packages", "persistent-harness-skills.pth"));
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
