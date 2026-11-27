import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { StringDecoder } from "node:string_decoder";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { preferAsOomVictim } from "./oom-victim.mjs";

export const MAX_SEARCH_FILES = 10_000;
export const MAX_SEARCH_SOURCE_BYTES = 1024 * 1024;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_SHELL_CAPTURE_BYTES = 64 * 1024;
const SHELL_TRUNCATION_MARKER = `
... output truncated at ${MAX_SHELL_CAPTURE_BYTES}-byte capture limit ...
`;
export const MAX_GREP_FILES = 10_000;
export const MAX_GREP_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_GREP_LINE_BYTES = 8 * 1024;
export const MAX_GREP_OUTPUT_BYTES = 64 * 1024;
export const MAX_GREP_RUNTIME_MS = 2_000;

export function requireRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value;
}

export function requireString(value, context, { allowEmpty = false, maxBytes = 1024 * 1024 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value) || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${context} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  }
  return value;
}

export function boundedInteger(value, context, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${context} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function resolvePath(cwd, requested) {
  const value = requireString(requested, "path", { maxBytes: 4096 });
  return path.resolve(cwd, value);
}

export async function walk(root, visit, { limit = MAX_SEARCH_FILES } = {}) {
  let visited = 0;
  async function recurse(current) {
    if (visited >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= limit) return;
      const fullPath = path.join(current, entry.name);
      visited += 1;
      await visit(fullPath, entry);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await recurse(fullPath);
    }
  }
  await recurse(root);
  return visited;
}

export function simpleDiff(filePath, oldText, newText) {
  const oldLines = oldText.split("\n").map((line) => `-${line}`);
  const newLines = newText.split("\n").map((line) => `+${line}`);
  const diff = [`--- ${filePath}`, `+++ ${filePath}`, ...oldLines, ...newLines].join("\n");
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return diff;
  return `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n... diff truncated ...`;
}

export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = "";
  let used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

export async function runGrep(payload, { cwd, signal } = {}) {
  const value = requireRecord(payload, "files.grep payload");
  const root = resolvePath(cwd, value.path);
  const pattern = requireString(value.pattern, "pattern", { maxBytes: 4096 });
  const limit = boundedInteger(value.limit, "limit", 1, 1000, 200);
  const worker = new Worker(new URL("./grep-worker.mjs", import.meta.url), {
    workerData: {
      root,
      pattern,
      limit,
      maxVisitedEntries: MAX_SEARCH_FILES,
      maxFiles: MAX_GREP_FILES,
      maxFileBytes: MAX_SEARCH_SOURCE_BYTES,
      maxTotalBytes: MAX_GREP_TOTAL_BYTES,
      maxLineBytes: MAX_GREP_LINE_BYTES,
      maxOutputBytes: MAX_GREP_OUTPUT_BYTES,
    },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const failAfterTermination = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(worker.terminate()).then(
        () => reject(error),
        () => reject(error),
      );
    };
    const abort = () => {
      const error = new Error("grep cancelled");
      error.name = "AbortError";
      failAfterTermination(error);
    };
    const timer = setTimeout(() => {
      failAfterTermination(new Error(`regular expression search exceeded ${MAX_GREP_RUNTIME_MS} ms deadline`));
    }, MAX_GREP_RUNTIME_MS);

    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error ?? "grep worker failed"));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`grep worker exited before returning a result (code ${code})`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const SHELL_SUBREAPER = String.raw`
use strict;
use warnings;
require "syscall.ph";
use POSIX qw(:sys_wait_h);

# Linux PR_SET_CHILD_SUBREAPER. Orphaned grandchildren (including setsid
# escapees) are reparented here instead of escaping to PID 1.
syscall(&SYS_prctl, 36, 1, 0, 0, 0) == 0 or die "prctl(PR_SET_CHILD_SUBREAPER): $!\n";
my $terminate = 0;
$SIG{TERM} = sub { $terminate = 1; };
$SIG{INT} = sub { $terminate = 1; };
my $main = fork();
defined $main or die "fork: $!\n";
if ($main == 0) {
  exec @ARGV;
  die "exec: $!\n";
}

sub descendants {
  my @queue = ($$);
  my @found;
  my %seen;
  while (@queue) {
    my $pid = shift @queue;
    next if $seen{$pid}++;
    my $file = "/proc/$pid/task/$pid/children";
    next unless open(my $fh, "<", $file);
    local $/;
    my $line = <$fh> // "";
    close($fh);
    for my $child (grep { /^\d+$/ } split(/\s+/, $line)) {
      push @found, 0 + $child;
      push @queue, 0 + $child;
    }
  }
  return @found;
}

sub signal_descendants {
  my ($signal) = @_;
  my @pids = descendants();
  kill $signal, reverse @pids if @pids;
}

my $main_status;
my $terminating = 0;
while (!defined($main_status)) {
  my $pid = waitpid(-1, WNOHANG);
  if ($pid > 0) {
    $main_status = $? if $pid == $main;
    next;
  }
  if ($terminate && !$terminating) {
    $terminating = 1;
    signal_descendants("TERM");
  }
  select(undef, undef, undef, 0.01);
  if ($terminating) {
    signal_descendants("KILL");
  }
}

# A shell may exit while a detached/background descendant remains. As the
# subreaper we retain ancestry and kill/reap everything before returning.
for (1 .. 30) {
  my @remaining = descendants();
  last unless @remaining;
  kill "TERM", reverse @remaining if $_ == 1;
  kill "KILL", reverse @remaining if $_ > 1;
  while (waitpid(-1, WNOHANG) > 0) {}
  select(undef, undef, undef, 0.01);
}
signal_descendants("KILL");
while (waitpid(-1, WNOHANG) > 0) {}
if (WIFEXITED($main_status)) { exit WEXITSTATUS($main_status); }
exit(128 + WTERMSIG($main_status));
`;

function processDescendants(rootPid) {
  const queue = [rootPid];
  const seen = new Set();
  const descendants = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    let content;
    try {
      content = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      continue;
    }
    for (const value of content.trim().split(/\s+/)) {
      if (!/^\d+$/.test(value)) continue;
      const child = Number(value);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function killProcessTree(rootPid) {
  const descendants = processDescendants(rootPid);
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  try { process.kill(rootPid, "SIGKILL"); } catch {}
}

export async function runShell(payload, { cwd, scratch, signal, onProgress = () => {} }) {
  const value = requireRecord(payload, "shell.run payload");
  const command = requireString(value.command, "command", { maxBytes: 64 * 1024 });
  const commandCwd = value.cwd === null || value.cwd === undefined ? cwd : resolvePath(cwd, value.cwd);
  const timeoutSeconds = typeof value.timeout === "number" ? value.timeout : 120;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
    throw new Error("timeout must be greater than 0 and at most 600 seconds");
  }
  if (signal?.aborted) {
    const error = new Error("shell command cancelled before spawn");
    error.name = "AbortError";
    throw error;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/perl", ["-e", SHELL_SUBREAPER, "--", "/bin/bash", "-lc", command], {
      cwd: commandCwd,
      env: { ...process.env, ...(scratch ? { HARNESS_ROOT_SESSION_ID: scratch.rootSessionId,
        HARNESS_SCRATCH_DIRECTORY: scratch.directory } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    preferAsOomVictim(child.pid);
    const startedAt = Date.now();
    const markerBytes = Buffer.byteLength(SHELL_TRUNCATION_MARKER);
    const dataBudget = MAX_SHELL_CAPTURE_BYTES - markerBytes;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let progressBytes = 0;
    let emittedDataBytes = 0;
    let truncated = false;
    let markerEmitted = false;
    let terminationReason = null;
    let forceTimer;
    let settled = false;
    let progressError = null;

    const terminate = () => {
      try { child.kill("SIGTERM"); } catch {}
      if (!forceTimer) {
        forceTimer = setTimeout(() => killProcessTree(child.pid), 1_500);
        forceTimer.unref();
      }
    };
    const emit = (stream, text) => {
      if (!text || progressError) return;
      if (stream === "stderr") stderr += text;
      else stdout += text;
      progressBytes += Buffer.byteLength(text);
      try {
        onProgress(stream, text);
      } catch (error) {
        progressError = error instanceof Error ? error : new Error(String(error));
        terminationReason ??= "progress";
        terminate();
      }
    };
    const emitMarker = (stream) => {
      if (markerEmitted || progressError) return;
      markerEmitted = true;
      truncated = true;
      emit(stream, SHELL_TRUNCATION_MARKER);
    };
    const captureText = (stream, text) => {
      if (!text || markerEmitted || progressError) return;
      const available = dataBudget - emittedDataBytes;
      const bounded = truncateUtf8(text, available);
      const boundedBytes = Buffer.byteLength(bounded);
      if (boundedBytes > 0) {
        emittedDataBytes += boundedBytes;
        emit(stream, bounded);
      }
      if (boundedBytes < Buffer.byteLength(text)) emitMarker(stream);
    };
    const capture = (stream, chunk) => {
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + chunk.length);
      captureText(stream, decoders[stream].write(chunk));
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.stdout.once("end", () => captureText("stdout", decoders.stdout.end()));
    child.stderr.once("end", () => captureText("stderr", decoders.stderr.end()));

    const chooseTermination = (reason) => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      terminate();
    };
    const abort = () => chooseTermination("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => chooseTermination("timeout"), timeoutSeconds * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (progressError) {
        reject(progressError);
        return;
      }
      resolve({
        command,
        cwd: commandCwd,
        stdout,
        stderr,
        exitCode: code,
        signal: exitSignal,
        cancelled: terminationReason === "cancelled",
        timedOut: terminationReason === "timeout",
        truncated,
        totalBytes,
        capturedBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
        progressBytes,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
