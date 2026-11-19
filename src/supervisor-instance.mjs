import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function fileIdentity(stat, content) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
    content,
  };
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev
    && stat.ino === identity.ino
    && stat.ctimeMs === identity.ctimeMs
    && stat.birthtimeMs === identity.birthtimeMs;
}

export async function unlinkIfOwned(filePath, identity) {
  if (!identity) return false;
  try {
    const current = await lstat(filePath);
    if (!sameIdentity(current, identity)) return false;
    if (identity.content !== undefined && await readFile(filePath, "utf8") !== identity.content) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function probeSocket(socketPath, timeoutMs = 250) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out probing existing socket ${socketPath}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

export async function unlinkSocketLinkIfOwned(socketPath, ownedTarget) {
  try {
    const currentTarget = await readlink(socketPath);
    if (currentTarget !== ownedTarget) return false;
    await unlink(socketPath);
    return true;
  } catch (error) {
    if (["ENOENT", "EINVAL"].includes(error?.code)) return false;
    throw error;
  }
}

export function ownedSocketPath(socketPath, ownerToken) {
  const compactToken = ownerToken.replaceAll("-", "").slice(0, 16);
  return path.join(path.dirname(socketPath), `.persistent-harness-${compactToken}.sock`);
}

const SUPERVISOR_PID_STARTED_AT_SLOP_MS = 120_000;
const PROC_CLK_TCK = 100;

async function readProcCmdline(pid) {
  try {
    return (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ").trim();
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) return null;
    throw error;
  }
}

function cmdlineLooksLikeHarnessSupervisor(cmdline) {
  if (typeof cmdline !== "string" || !cmdline) return false;
  return cmdline.split(/\s+/).some((arg) => {
    const base = path.basename(arg);
    return base === "harness-supervisor" || base === "harness-supervisor.mjs";
  });
}

async function estimateProcessStartWallClockMs(pid) {
  try {
    const [uptimeContent, stat] = await Promise.all([
      readFile("/proc/uptime", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const startTicks = Number(stat.slice(close + 2).trim().split(/\s+/)[19]);
    const uptimeSeconds = Number.parseFloat(uptimeContent);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return null;
    return Date.now() - (uptimeSeconds - startTicks / PROC_CLK_TCK) * 1000;
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) return null;
    throw error;
  }
}

function recordHasOwnerToken(record) {
  return typeof record?.ownerToken === "string" && record.ownerToken.length > 0;
}

async function processMatchesSupervisorPidRecord(record, pid = record?.pid) {
  if (!recordHasOwnerToken(record) || !Number.isInteger(pid) || pid <= 0) return false;
  if (cmdlineLooksLikeHarnessSupervisor(await readProcCmdline(pid))) return true;
  if (!Number.isFinite(record.startedAt)) return false;
  const started = await estimateProcessStartWallClockMs(pid);
  return started != null && Math.abs(started - record.startedAt) <= SUPERVISOR_PID_STARTED_AT_SLOP_MS;
}

async function socketIsListening(socketPath) {
  try {
    return await probeSocket(socketPath);
  } catch {
    return false;
  }
}

async function ownedSupervisorSocketIsListening(record) {
  if (typeof record?.socketPath !== "string" || !record.socketPath) return false;
  if (recordHasOwnerToken(record) && await socketIsListening(ownedSocketPath(record.socketPath, record.ownerToken))) return true;
  return await socketIsListening(record.socketPath);
}

async function pidRecordIsLiveSupervisor(record, { currentPid = process.pid } = {}) {
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === currentPid) return false;
  if (!processIsAlive(pid)) return false;
  if (!await processMatchesSupervisorPidRecord(record, pid)) return false;
  return await ownedSupervisorSocketIsListening(record);
}

export async function prepareSocketPath(socketPath) {
  let socketStat;
  try {
    socketStat = await lstat(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (await probeSocket(socketPath)) throw new Error(`a harness supervisor is already listening at ${socketPath}`);
  if (socketStat.isSymbolicLink()) {
    const target = await readlink(socketPath);
    await unlinkSocketLinkIfOwned(socketPath, target);
    const resolvedTarget = path.resolve(path.dirname(socketPath), target);
    const isOwnedEndpoint = path.dirname(resolvedTarget) === path.dirname(socketPath)
      && /^\.persistent-harness-[a-f0-9]{16}\.sock$/.test(path.basename(resolvedTarget));
    if (isOwnedEndpoint) {
      try {
        await unlink(resolvedTarget);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return;
  }
  await unlinkIfOwned(socketPath, fileIdentity(socketStat));
}

export async function publishSocketLink(socketPath, ownedSocketPath, ownerToken) {
  const target = path.basename(ownedSocketPath);
  const temporary = `${socketPath}.${ownerToken}.link.tmp`;
  await symlink(target, temporary);
  await rename(temporary, socketPath);
  return target;
}

export async function preparePidPath(pidPath) {
  let stat;
  try {
    stat = await lstat(pidPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  let record;
  let content;
  try {
    content = await readFile(pidPath, "utf8");
    record = JSON.parse(content);
  } catch {
    await unlinkIfOwned(pidPath, fileIdentity(stat, content));
    return;
  }
  if (await pidRecordIsLiveSupervisor(record)) {
    throw new Error(`harness PID file points to live process ${record.pid}`);
  }
  await unlinkIfOwned(pidPath, fileIdentity(stat, content));
}

export async function writeOwnedPidFile(pidPath, record) {
  const temporaryPath = `${pidPath}.${record.ownerToken}.tmp`;
  const content = `${JSON.stringify(record)}\n`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
  await rename(temporaryPath, pidPath);
  await chmod(pidPath, 0o600);
  return fileIdentity(await lstat(pidPath), content);
}

// One supervisor per PID path, claimed before the database is opened. The PID
// file is published only once the socket listens, so on its own it leaves a
// startup window in which a second `start` would open the same database.
const heldInstanceLocks = new Map();

async function instanceLockOwnerIsLive(lockPath, record) {
  if (record?.pid === process.pid) return heldInstanceLocks.has(lockPath);
  return processIsAlive(record?.pid) && await processMatchesSupervisorPidRecord(record);
}

export async function acquireInstanceLock(lockPath, ownerToken) {
  const content = `${JSON.stringify({ pid: process.pid, ownerToken, startedAt: Date.now() })}\n`;
  const temporaryPath = `${lockPath}.${ownerToken}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // link() publishes the complete record atomically and fails if any owner exists.
        await link(temporaryPath, lockPath);
        heldInstanceLocks.set(lockPath, ownerToken);
        // Dropping the second name changes the file's ctime, so record identity after it.
        await unlink(temporaryPath);
        return fileIdentity(await lstat(lockPath), content);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      let stat;
      let existing;
      let record;
      try {
        stat = await lstat(lockPath);
        existing = await readFile(lockPath, "utf8");
        record = JSON.parse(existing);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
      }
      if (await instanceLockOwnerIsLive(lockPath, record)) {
        throw new Error(`another harness supervisor (pid ${record.pid}) is already starting or running for ${lockPath}`);
      }
      await unlinkIfOwned(lockPath, fileIdentity(stat, existing));
    }
    throw new Error(`could not claim supervisor instance lock ${lockPath}`);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function releaseInstanceLock(lockPath, ownerToken, identity) {
  if (heldInstanceLocks.get(lockPath) === ownerToken) heldInstanceLocks.delete(lockPath);
  await unlinkIfOwned(lockPath, identity);
}

export const supervisorInternals = {
  acquireInstanceLock,
  processIsAlive,
  pidRecordIsLiveSupervisor,
  processMatchesSupervisorPidRecord,
  ownedSupervisorSocketIsListening,
  ownedSocketPath,
  preparePidPath,
  prepareSocketPath,
};
