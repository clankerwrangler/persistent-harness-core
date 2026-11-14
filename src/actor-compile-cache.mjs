import { lstatSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { SESSION_COMPILE_CACHE_ENV } from "./session-channel.mjs";

const operatorConfigured = () => process.env.NODE_DISABLE_COMPILE_CACHE === "1"
  || process.env.NODE_COMPILE_CACHE !== undefined;
const privateDirectory = (info) => info.isDirectory() && typeof process.geteuid === "function"
  && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700;

/** Called before the session process's dynamic imports; does not enable caching in tool children. */
export function enableActorCompileCache() {
  if (operatorConfigured()) return;
  const directory = process.env[SESSION_COMPILE_CACHE_ENV];
  if (!directory) return;
  try {
    if (privateDirectory(lstatSync(directory))) enableCompileCache(directory);
  } catch { /* Unsafe or unavailable paths are cache misses, not startup failures. */ }
}
