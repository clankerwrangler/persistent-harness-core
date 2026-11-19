import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runtimeVersions } from "./python-runtime.mjs";
import { sessionSidecarPaths } from "./session-paths.mjs";
import { discoverSkills, discoverSkillsFromDirectory, materializeSkills, skillCatalogForSkills } from "./skills.mjs";
import { writeJsonAtomic } from "./supervisor-instance.mjs";
import { requestFailure } from "./supervisor-transport.mjs";

export function sameSkillCatalog(left = [], right = []) {
  return left.length === right.length && left.every((skill, index) => {
    const other = right[index];
    return other && skill.id === other.id && skill.version === other.version
      && skill.contentHash === other.contentHash && path.resolve(skill.skillPath) === path.resolve(other.skillPath)
      && skill.pythonBacked === other.pythonBacked;
  });
}

export function skillCatalogFingerprint(skills) {
  return createHash("sha256").update(JSON.stringify(skills)).digest("hex");
}

export function executableCapabilities(skills) {
  return skills.filter((skill) => skill.pythonBacked).map(({ id, version, contentHash, skillPath }) => ({
    id, version, contentHash, skillPath,
  }));
}



export class SkillRuntimeCoordinator {
  #skillsPath;
  #skillArtifactRoot;
  #runtimeProvisioner;
  #getStore;
  #withActorActivation;
  #log;
  #skillGrantPromises = new Map();
  #runtimeReadinessPromises = new Map();
  #diagnostic;

  constructor({ skillsPath, skillArtifactRoot, runtimeProvisioner, getStore, withActorActivation, log }) {
    this.#skillsPath = skillsPath;
    this.#skillArtifactRoot = skillArtifactRoot;
    this.#runtimeProvisioner = runtimeProvisioner;
    this.#getStore = getStore;
    this.#withActorActivation = withActorActivation;
    this.#log = log;
  }

  get diagnostic() { return this.#diagnostic; }

  clear() {
    this.#skillGrantPromises.clear();
    this.#runtimeReadinessPromises.clear();
  }

  async #discoverSkillRuntimePlan() {
    const catalog = await discoverSkillsFromDirectory(this.#skillsPath);
    if (catalog.diagnostics.length) throw requestFailure("invalid_skill_catalog", catalog.diagnostics.map((item) => item.error).join("; "));
    catalog.skills = await materializeSkills(catalog.skills, { artifactRoot: this.#skillArtifactRoot });
    const skills = skillCatalogForSkills(catalog.skills);
    const fingerprint = skillCatalogFingerprint(skills);
    const dependencies = [...new Set(catalog.skills.flatMap((skill) => skill.python?.dependencies ?? []))].sort();
    if (dependencies.some((item) => typeof item !== "string" || !item || Buffer.byteLength(item, "utf8") > 4096 || /[\0-]/.test(item))) {
      throw requestFailure("invalid_skill_catalog", "skill dependencies must be non-empty bounded single-line package requirements");
    }
    return {
      catalogSkills: catalog.skills,
      fingerprint,
      pythonVersion: runtimeVersions.python,
      packages: [`ipython==${runtimeVersions.ipython}`, `dill==${runtimeVersions.dill}`, ...dependencies],
      skills: skills.map(({ id, version, contentHash, pythonBacked }) => ({ id, version, contentHash, pythonBacked })),
    };
  }

  #projectSkillRuntime(plan, status, runtime = null) {
    const environment = runtime ? {
      managed: Boolean(runtime.managed),
      environmentId: typeof runtime.environmentId === "string" ? runtime.environmentId : null,
      versions: runtime.versions && typeof runtime.versions === "object" ? {
        python: runtime.versions.python ?? null, ipython: runtime.versions.ipython ?? null, dill: runtime.versions.dill ?? null,
      } : null,
    } : null;
    return { status, fingerprint: plan.fingerprint, pythonVersion: plan.pythonVersion,
      packages: plan.packages, skills: plan.skills, ...(environment ? { environment } : {}) };
  }

  async skillRuntimePlan() {
    const plan = await this.#discoverSkillRuntimePlan();
    try {
      const runtime = await this.#runtimeProvisioner(plan.catalogSkills, { approved: false });
      return this.#projectSkillRuntime(plan, "ready", runtime);
    } catch (error) {
      if (/installation was not approved/i.test(error instanceof Error ? error.message : String(error))) {
        return this.#projectSkillRuntime(plan, "approval_required");
      }
      throw requestFailure("runtime_plan_unavailable", "the verified Python runtime plan could not be prepared");
    }
  }

  async provisionSkillRuntime(expectedFingerprint) {
    const plan = await this.#discoverSkillRuntimePlan();
    if (plan.fingerprint !== expectedFingerprint) {
      throw requestFailure("stale_skill_runtime_plan", "the skill catalog changed; review the updated package plan before approving");
    }
    let runtime;
    try { runtime = await this.#runtimeProvisioner(plan.catalogSkills, { approved: true }); }
    catch { throw requestFailure("runtime_provision_failed", "the approved Python runtime could not be provisioned"); }
    this.#runtimeReadinessPromises.set(plan.fingerprint, Promise.resolve(runtime));
    this.#diagnostic = undefined;
    return this.#projectSkillRuntime(plan, "ready", runtime);
  }

  async #verifyRetainedSkillCatalog(skills) {
    const catalog = await discoverSkills(skills.map((skill) => ({ source: "skill", path: skill.skillPath })));
    if (catalog.diagnostics.length) throw new Error(catalog.diagnostics.map((item) => item.error).join("; "));
    const verified = skillCatalogForSkills(catalog.skills);
    if (!sameSkillCatalog(verified, skills)) throw new Error("the retained skill catalog no longer matches disk");
    return skills;
  }

  #assertSkillRuntimeReady(skills) {
    const key = skillCatalogFingerprint(skillCatalogForSkills(skills));
    const current = this.#runtimeReadinessPromises.get(key);
    if (current) return current;
    const operation = Promise.resolve().then(() => this.#runtimeProvisioner(skills)).catch((error) => {
      if (this.#runtimeReadinessPromises.get(key) === operation) this.#runtimeReadinessPromises.delete(key);
      throw error;
    });
    this.#runtimeReadinessPromises.set(key, operation);
    while (this.#runtimeReadinessPromises.size > 32) this.#runtimeReadinessPromises.delete(this.#runtimeReadinessPromises.keys().next().value);
    return operation;
  }

  async #rootSkillCatalog(previous) {
    try {
      const catalog = await discoverSkillsFromDirectory(this.#skillsPath);
      if (catalog.diagnostics.length) throw new Error(catalog.diagnostics.map((item) => item.error).join("; "));
      catalog.skills = await materializeSkills(catalog.skills, { artifactRoot: this.#skillArtifactRoot });
      const skills = skillCatalogForSkills(catalog.skills);
      if (previous && !sameSkillCatalog(previous.skills, skills)) await this.#assertSkillRuntimeReady(catalog.skills);
      this.#diagnostic = undefined;
      return skills;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#diagnostic = { code: "skill_catalog_not_ready", message };
      if (previous) {
        try {
          const retained = await this.#verifyRetainedSkillCatalog(previous.skills);
          await this.#log("skill_catalog_retained", { skillsPath: this.#skillsPath, error: message });
          return retained;
        } catch {}
      }
      throw new Error(`skill catalog reconciliation failed: ${message}`);
    }
  }


  reconcileSkillGrant(sessionId, ancestry = new Set(), check = () => {}) {
    if (ancestry.has(sessionId)) return Promise.reject(new Error("session family contains a cycle"));
    return this.#withActorActivation(sessionId, validate => {
      const run = () => {
        validate();
        const current = this.#skillGrantPromises.get(sessionId);
        if (current) return current.then(run, run);
        const nextAncestry = new Set(ancestry).add(sessionId);
        const operation = this.#reconcileSkillGrantOnce(sessionId, nextAncestry, validate)
          .finally(() => { if (this.#skillGrantPromises.get(sessionId) === operation) this.#skillGrantPromises.delete(sessionId); });
        this.#skillGrantPromises.set(sessionId, operation);
        return operation;
      };
      return run();
    }, check);
  }

  async #reconcileSkillGrantOnce(sessionId, ancestry, check) {
    const session = this.#getStore().getSessionSkillGrantContext(sessionId);
    if (!session || session.lifecycle === "deleted" || !session.sessionFile) throw new Error("session does not exist");
    const previous = this.#getStore().getSessionSkillGrant(sessionId);
    let skills;
    if (session.kind === "root") {
      skills = await this.#rootSkillCatalog(previous);
    } else {
      if (!session.parentSessionId) throw new Error("child session has no immediate parent");
      const parent = await this.reconcileSkillGrant(session.parentSessionId, ancestry, check);
      skills = parent.skills;
    }
    check();
    const changed = !previous || !sameSkillCatalog(previous.skills, skills);
    const grant = changed ? this.#getStore().setSessionSkillGrant(sessionId, skills) : previous;
    const capabilities = executableCapabilities(skills);
    const sidecars = sessionSidecarPaths(session.sessionFile);
    let grantSidecarCurrent = false;
    try {
      const persisted = JSON.parse(await readFile(sidecars.skillGrantPath, "utf8"));
      grantSidecarCurrent = persisted?.version === 1 && sameSkillCatalog(persisted.skills, skills)
        && sameSkillCatalog(persisted.capabilities?.map((item) => ({ ...item, pythonBacked: true })) ?? [], capabilities.map((item) => ({ ...item, pythonBacked: true })));
    } catch {}
    // Once the grant is stored, finish its paired sidecars before releasing ownership.
    if (changed || !grantSidecarCurrent) {
      await writeJsonAtomic(sidecars.skillGrantPath, { version: 1, skills, capabilities });
    }
    if (changed) await writeJsonAtomic(sidecars.capabilitiesPath, { version: 1, capabilities });
    return { ...grant, skills, capabilities, changed, fingerprint: skillCatalogFingerprint(skills) };
  }

}
