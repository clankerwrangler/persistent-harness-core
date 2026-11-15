// The skills a session process may use: a read-only file the supervisor writes for each
// process generation and the session process reads at start. It names the granted skills
// and their Python capabilities, and carries what the session needs to use each skill
// (`manifestSkills`), so the session never reads skill folders itself. Part of the contract
// between the two halves; the file's name binds it to one session generation and its bytes.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const SKILL_GRANT_VERSION = 2;
export const SKILL_GRANT_ENV = "PI_HARNESS_ACTOR_SKILL_GRANT";

export function actorGenerationSkillGrantPath(sessionFile, generation, digest) {
  if (!Number.isSafeInteger(generation) || generation < 1 || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError("invalid actor generation grant identity");
  }
  return `${path.resolve(sessionFile)}.generation-${generation}-${digest}.skill-grant.json`;
}

export function actorGenerationGrantIdentity(filePath) {
  const match = path.basename(filePath).match(/\.generation-([1-9][0-9]*)-([a-f0-9]{64})\.skill-grant\.json$/);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("invalid actor generation grant path");
  return { generation: Number(match[1]), digest: match[2] };
}

/** The grant's bytes, exactly as written and as their digest names them. */
export function skillGrantContent({ sessionId, actorGeneration, skills, capabilities, manifestSkills }) {
  return `${JSON.stringify({ version: SKILL_GRANT_VERSION, sessionId, actorGeneration, skills, capabilities, manifestSkills }, null, 2)}\n`;
}

const text = (value, name, { optional = false, max = 1024 * 1024 } = {}) => {
  if (optional && (value === null || value === undefined)) return;
  if (typeof value !== "string" || value.length > max) throw new Error(`invalid granted skill ${name}`);
};
const strings = (value, name) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`invalid granted skill ${name}`);
};

function checkManifestSkills(grant) {
  if (!Array.isArray(grant.manifestSkills) || grant.manifestSkills.length !== grant.skills.length) {
    throw new Error("the skill grant does not describe each granted skill");
  }
  const capabilityIds = new Set(grant.capabilities.map((item) => item.id));
  grant.manifestSkills.forEach((skill, index) => {
    const granted = grant.skills[index];
    for (const key of ["id", "version", "contentHash", "skillPath"]) {
      text(skill?.[key], key, { max: 4096 });
      if (skill[key] !== granted?.[key]) throw new Error(`granted skill ${String(granted?.id)} is described differently: ${key}`);
    }
    text(skill.description, "description"); text(skill.instructions, "instructions"); text(skill.alias, "alias", { optional: true });
    if (Boolean(skill.python) !== granted.pythonBacked) throw new Error(`granted skill backing differs: ${skill.id}`);
    if (skill.python) {
      for (const key of ["packageName", "importName", "srcPath"]) text(skill.python[key], `python.${key}`, { max: 4096 });
      text(skill.python.entryPoint, "python.entryPoint", { optional: true, max: 4096 });
      strings(skill.python.dependencies, "python.dependencies"); strings(skill.python.hostRequests, "python.hostRequests");
      if (!capabilityIds.has(skill.id)) throw new Error(`Python skill exceeds actor capability manifest: ${skill.id}`);
    }
  });
  for (const capability of grant.capabilities) {
    const expected = grant.skills.find((skill) => skill.id === capability.id);
    if (!expected?.pythonBacked || expected.version !== capability.version || expected.contentHash !== capability.contentHash) {
      throw new Error(`invalid executable actor capability: ${capability.id}`);
    }
  }
}

let grantPromise;
/** The grant written for this session process generation, checked against its name. */
export async function readActorSkillGrant(env = process.env) {
  const grantPath = env[SKILL_GRANT_ENV] || null;
  if (!grantPath) return null;
  const actorId = env.PI_HARNESS_ACTOR_ID || null;
  const generation = env.PI_HARNESS_ACTOR_GENERATION ? Number(env.PI_HARNESS_ACTOR_GENERATION) : null;
  grantPromise ??= (async () => {
    const identity = actorGenerationGrantIdentity(grantPath);
    const stat = await lstat(grantPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o277)) throw new Error("invalid actor generation grant file");
    const content = await readFile(grantPath, "utf8");
    if (identity.generation !== generation || createHash("sha256").update(content).digest("hex") !== identity.digest) {
      throw new Error("actor generation skill grant identity mismatch");
    }
    const grant = JSON.parse(content);
    if (grant.sessionId !== actorId || grant.actorGeneration !== generation) throw new Error("actor generation skill grant binding mismatch");
    if (grant?.version !== SKILL_GRANT_VERSION || !Array.isArray(grant.skills) || !Array.isArray(grant.capabilities)) {
      throw new Error("invalid actor skill grant");
    }
    checkManifestSkills(grant);
    return grant;
  })();
  return grantPromise;
}
