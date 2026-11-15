import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { actorGenerationSkillGrantPath, skillGrantContent } from "./skill-grant.mjs";

/**
 * Derive every harness-owned session-local path from the session's core folder: the
 * harness's own files sit beside it, named after it. No directory is created here.
 */
export function sessionSidecarPaths(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    throw new TypeError("sessionFile must be a non-empty path");
  }
  const resolvedSessionFile = path.resolve(sessionFile);
  if (resolvedSessionFile === path.parse(resolvedSessionFile).root) throw new Error("sessionFile must name a session folder");
  const basePath = resolvedSessionFile;
  return Object.freeze({
    sessionFile: resolvedSessionFile,
    basePath,
    skillManifestPath: `${basePath}.skill-manifest.json`,
    capabilitiesPath: `${basePath}.capabilities.json`,
    skillGrantPath: `${basePath}.skill-grant.json`,
    kernelStatePath: `${basePath}.kernel-state`,
    pythonStepsPath: `${basePath}.python-steps.json`,
  });
}


export async function publishActorGenerationSkillGrant(session, grant) {
  const content = skillGrantContent({ sessionId: session.sessionId, actorGeneration: session.actorGeneration,
    skills: grant.skills, capabilities: grant.capabilities, manifestSkills: grant.manifestSkills });
  const digest = createHash("sha256").update(content).digest("hex");
  const filePath = actorGenerationSkillGrantPath(session.sessionFile, session.actorGeneration, digest);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await writeFile(filePath, content, { flag: "wx", mode: 0o400 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o277) || await readFile(filePath, "utf8") !== content) {
    throw new Error("actor generation skill grant differs from expected immutable bytes");
  }
  return filePath;
}
