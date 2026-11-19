import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_WRITE_BYTES = 1024 * 1024;

const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const REGULAR_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const TEMP_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"]);
const COMMITTED_ATOMIC_FILE_ERROR_CODE = "ERR_ATOMIC_FILE_COMMITTED";
const COMMITTED_ATOMIC_FILE_ERROR_MESSAGE = "atomic file publication committed, but post-publication verification, durability, or cleanup failed";

export class CommittedAtomicFileError extends Error {
  constructor() {
    super(COMMITTED_ATOMIC_FILE_ERROR_MESSAGE);
    this.name = "CommittedAtomicFileError";
    this.code = COMMITTED_ATOMIC_FILE_ERROR_CODE;
    this.committed = true;
    this.phase = "post-publication";
  }
}

function procFdChild(directoryHandle, name) {
  if (!name || name === "." || name === ".." || name.includes(path.sep)) {
    throw new Error("invalid anchored path component");
  }
  return `/proc/self/fd/${directoryHandle.fd}/${name}`;
}

async function syncDirectory(directoryHandle) {
  try {
    await directoryHandle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)) throw error;
  }
}

async function openAnchoredDirectory(directoryPath, { create = false } = {}) {
  const absolute = path.resolve(directoryPath);
  if (path.parse(absolute).root !== path.sep) throw new Error("atomic file operations require an absolute POSIX path");
  let current = await open(path.sep, DIRECTORY_OPEN_FLAGS);
  try {
    const components = absolute.slice(path.sep.length).split(path.sep).filter(Boolean);
    for (const component of components) {
      const childPath = procFdChild(current, component);
      let child;
      try {
        child = await open(childPath, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        if (!create || error?.code !== "ENOENT") {
          if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
            throw new Error(`parent path component is a symlink or non-directory: ${component}`);
          }
          throw error;
        }
        try {
          await mkdir(childPath);
          await syncDirectory(current);
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
        try {
          child = await open(childPath, DIRECTORY_OPEN_FLAGS);
        } catch (openError) {
          if (["ELOOP", "ENOTDIR"].includes(openError?.code)) {
            throw new Error(`parent path component changed during creation: ${component}`);
          }
          throw openError;
        }
      }
      try {
        await current.close();
      } catch (error) {
        await child.close().catch(() => {});
        throw error;
      }
      current = child;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("file operation cancelled");
  error.name = "AbortError";
  throw error;
}

function sameStableStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBoundedHandle(handle, maximumBytes) {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error(`existing file exceeds ${maximumBytes} byte atomic-source limit`);
  return buffer.subarray(0, offset);
}

async function readRegularSnapshot(leafPath) {
  let leafStat;
  try {
    leafStat = await lstat(leafPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (leafStat.isSymbolicLink()) throw new Error("file path must not be a symlink");
  if (!leafStat.isFile()) throw new Error("file path must be a regular file");

  let handle;
  try {
    handle = await open(leafPath, REGULAR_READ_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("file path must not be a symlink");
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("file path must be a regular file");
    if (before.dev !== leafStat.dev || before.ino !== leafStat.ino) {
      throw new Error("file changed concurrently while opening");
    }
    if (before.size > BigInt(MAX_WRITE_BYTES)) {
      throw new Error(`existing file exceeds ${MAX_WRITE_BYTES} byte atomic-source limit`);
    }
    const content = await readBoundedHandle(handle, MAX_WRITE_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!sameStableStat(before, after) || BigInt(content.length) !== after.size) {
      throw new Error("file changed concurrently while being read");
    }
    return { stat: after, content };
  } finally {
    await handle.close();
  }
}


async function createOwnedTemp(parentHandle, content, { mode, owner = null }) {
  const tempName = `.pi-atomic-${process.pid}-${randomUUID()}.tmp`;
  const tempPath = procFdChild(parentHandle, tempName);
  let handle;
  let prepared = false;
  try {
    handle = await open(tempPath, TEMP_OPEN_FLAGS, 0o600);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error("atomic temp path is not a private regular file");
    await handle.writeFile(content);
    if (owner && (opened.uid !== owner.uid || opened.gid !== owner.gid)) {
      // Replacement must not silently change ownership. If the process cannot
      // reproduce the source owner/group, fail before publication.
      await handle.chown(Number(owner.uid), Number(owner.gid));
    }
    await handle.chmod(mode);
    await handle.sync();
    const expected = await handle.stat({ bigint: true });
    prepared = true;
    return { tempPath, handle, expected, content: Buffer.from(content) };
  } finally {
    if (!prepared) {
      let cleanupError = null;
      if (handle) await handle.close().catch((error) => { cleanupError = error; });
      await unlink(tempPath).catch((error) => {
        if (error?.code !== "ENOENT") cleanupError ??= error;
      });
      if (cleanupError) throw cleanupError;
    }
  }
}

async function assertTempUnchanged(temp, operation) {
  let pathStat;
  try {
    pathStat = await lstat(temp.tempPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
    throw error;
  }
  const before = await temp.handle.stat({ bigint: true });
  if (!pathStat.isFile()
      || pathStat.dev !== before.dev
      || pathStat.ino !== before.ino
      || !sameStableStat(temp.expected, before)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
  const content = await readBoundedHandle(temp.handle, MAX_WRITE_BYTES);
  const after = await temp.handle.stat({ bigint: true });
  if (!sameStableStat(before, after) || !content.equals(temp.content)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
}

async function assertTempPathIdentity(temp, operation) {
  let pathStat;
  try {
    pathStat = await lstat(temp.tempPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
    throw error;
  }
  const current = await temp.handle.stat({ bigint: true });
  if (!pathStat.isFile()
      || pathStat.dev !== current.dev
      || pathStat.ino !== current.ino
      || !sameStableStat(temp.expected, current)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
}

async function assertReplacementSourceUnchanged(parentHandle, parentPath, leafName, source, operation) {
  let canonicalParent;
  try {
    canonicalParent = await openAnchoredDirectory(parentPath);
    const [expectedParent, currentParent] = await Promise.all([
      parentHandle.stat({ bigint: true }),
      canonicalParent.stat({ bigint: true }),
    ]);
    if (expectedParent.dev !== currentParent.dev || expectedParent.ino !== currentParent.ino) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }

    let current;
    try {
      current = await readRegularSnapshot(procFdChild(canonicalParent, leafName));
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
          || /file path must (?:not be a symlink|be a regular file)/.test(error?.message ?? "")) {
        throw new Error(`file changed concurrently; ${operation} was not committed`);
      }
      throw error;
    }
    if (!current
        || !sameStableStat(source.stat, current.stat)
        || !source.content.equals(current.content)) {
      throw new Error(`file changed concurrently; ${operation} was not committed`);
    }
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
        || /parent path component/.test(error?.message ?? "")) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
    throw error;
  } finally {
    await canonicalParent?.close().catch(() => {});
  }
}

async function assertPublishedFile(canonicalParent, leafName, temp, operation) {
  const leafPath = procFdChild(canonicalParent, leafName);
  const [published, before] = await Promise.all([
    lstat(leafPath, { bigint: true }),
    temp.handle.stat({ bigint: true }),
  ]);
  if (!published.isFile()
      || published.dev !== before.dev
      || published.ino !== before.ino
      || !sameStableStat(published, before)) {
    throw new Error(`${operation} committed, but the destination changed before verification`);
  }
  const content = await readBoundedHandle(temp.handle, MAX_WRITE_BYTES);
  const after = await temp.handle.stat({ bigint: true });
  if (!sameStableStat(before, after) || !content.equals(temp.content)) {
    throw new Error(`${operation} committed, but the published file changed before verification`);
  }
}

async function assertParentPathUnchanged(parentHandle, parentPath, operation) {
  let checkHandle;
  try {
    checkHandle = await openAnchoredDirectory(parentPath);
    const [expected, current] = await Promise.all([
      parentHandle.stat({ bigint: true }),
      checkHandle.stat({ bigint: true }),
    ]);
    if (expected.dev !== current.dev || expected.ino !== current.ino) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
        || /parent path component/.test(error?.message ?? "")) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
    throw error;
  } finally {
    await checkHandle?.close().catch(() => {});
  }
}

export async function commitAtomicFile({ filePath, content, buildContent, createParents, replaceExisting = false, signal, operation }) {
  throwIfAborted(signal);
  const leafName = path.basename(filePath);
  const parentPath = path.dirname(filePath);
  const parentHandle = await openAnchoredDirectory(parentPath, { create: createParents });
  const leafPath = procFdChild(parentHandle, leafName);
  let temp = null;
  let committed = false;
  let primaryError = null;
  let result;
  try {
    const source = await readRegularSnapshot(leafPath);
    if (replaceExisting && !source) throw new Error("file does not exist");
    if (source && (source.stat.mode & 0o7000n) !== 0n) {
      throw new Error(`existing file has unsupported special mode bits; ${operation} was not committed`);
    }
    if (!replaceExisting && source) {
      throw new Error(`file already exists; ${operation} was not committed`);
    }

    const built = buildContent ? buildContent(source) : { content };
    const finalContent = built.content;
    if (typeof finalContent !== "string" || Buffer.byteLength(finalContent) > MAX_WRITE_BYTES) {
      throw new Error("atomic file content exceeds write limit");
    }

    const mode = source ? Number(source.stat.mode & 0o777n) : 0o666 & ~process.umask();
    const owner = source ? { uid: source.stat.uid, gid: source.stat.gid } : null;
    temp = await createOwnedTemp(parentHandle, finalContent, { mode, owner });
    await new Promise((resolve) => setImmediate(resolve));
    throwIfAborted(signal);
    await assertTempUnchanged(temp, operation);
    if (source) {
      // This is an immediate best-effort precondition check, not kernel CAS:
      // an external writer can still change the pathname after this check and
      // before rename(2). The atomic rename itself never exposes partial bytes.
      await assertReplacementSourceUnchanged(parentHandle, parentPath, leafName, source, operation);
    } else {
      await assertParentPathUnchanged(parentHandle, parentPath, operation);
    }
    await assertTempPathIdentity(temp, operation);
    throwIfAborted(signal);

    if (source) {
      // Rename to the canonical requested pathname rather than a potentially
      // detached preparation-directory descriptor.
      await rename(temp.tempPath, filePath);
      committed = true;
      temp.tempPath = null;
    } else {
      try {
        // link(2) is the kernel no-replace commit primitive. Use the canonical
        // destination pathname at commit time, not the possibly detached parent
        // descriptor used to hold the private source inode.
        await link(temp.tempPath, filePath);
        committed = true;
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error(`file changed concurrently; ${operation} create was not committed`);
        }
        throw error;
      }
      await unlink(temp.tempPath);
      temp.tempPath = null;
    }

    const canonicalParent = await openAnchoredDirectory(parentPath);
    try {
      const [expectedParent, currentParent] = await Promise.all([
        parentHandle.stat({ bigint: true }),
        canonicalParent.stat({ bigint: true }),
      ]);
      await syncDirectory(canonicalParent);
      const parentChanged = expectedParent.dev !== currentParent.dev || expectedParent.ino !== currentParent.ino;
      if (parentChanged) await syncDirectory(parentHandle);
      if (source && parentChanged) {
        throw new Error(`${operation} committed, but the parent directory changed before verification`);
      }
      await assertPublishedFile(canonicalParent, leafName, temp, operation);
    } finally {
      await canonicalParent.close();
    }
    const { content: _content, ...metadata } = built;
    result = { created: !source, committed: true, durability: "confirmed", ...metadata };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  if (temp?.handle) await temp.handle.close().catch((error) => { cleanupError = error; });
  if (temp?.tempPath) await unlink(temp.tempPath).catch((error) => {
    if (error?.code !== "ENOENT") cleanupError ??= error;
  });
  await parentHandle.close().catch((error) => { cleanupError ??= error; });

  if (primaryError) {
    if (committed) throw new CommittedAtomicFileError();
    throw primaryError;
  }
  if (cleanupError) {
    if (committed) throw new CommittedAtomicFileError();
    throw cleanupError;
  }
  return result;
}
