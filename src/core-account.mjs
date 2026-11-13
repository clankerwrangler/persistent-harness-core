// A provider account as the core holds it: remaining usage and signing in. The core keeps
// the credentials, so these ask the core (its command line) and never read its files. They
// use the same core and credentials file as sessions (see coreArgs).
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { coreArgs, coreBinary } from "./core-session.mjs";

const USAGE_TIMEOUT_MS = 20_000;

/** The credentials file the sessions' core uses, as core flags. */
export function coreAuthArgs(env = process.env) {
  let args;
  try { args = coreArgs(env); } catch { return []; }
  const index = args.indexOf("--auth");
  return index >= 0 && typeof args[index + 1] === "string" ? ["--auth", args[index + 1]] : [];
}

function unavailable(provider) { return { provider, model: null, status: "unavailable", remaining: null }; }

/** A provider's remaining usage: `{provider, model, status, remaining}` (status `ready`,
 * `unavailable`, `sign_in_required` or `unsupported`). Never throws. */
export function coreUsage(provider, { env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(coreBinary(env), ["usage", provider, ...coreAuthArgs(env)], { env, timeout: USAGE_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) return resolve(unavailable(provider));
        try {
          const value = JSON.parse(stdout);
          resolve(value && typeof value === "object" && value.provider === provider && typeof value.status === "string" ? value : unavailable(provider));
        } catch { resolve(unavailable(provider)); }
      });
  });
}

/**
 * Signs in to `provider` with a device code: `onStep({ url, code, expiresIn })` when the
 * code is ready. Resolves when the core has saved the sign-in; rejects with the core's
 * message otherwise. Aborting `signal` stops the sign-in.
 */
export function coreSignIn(provider, { onStep = () => {}, signal, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const child = spawn(coreBinary(env), ["login", provider, "device", "--json", ...coreAuthArgs(env)],
      { env, stdio: ["ignore", "pipe", "ignore"] });
    let outcome;
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let step;
      try { step = JSON.parse(line); } catch { return; }
      if (step?.step === "device_code" && typeof step.url === "string" && typeof step.code === "string") {
        onStep({ url: step.url, code: step.code, expiresIn: Number(step.expiresIn) });
      } else if ("done" in (step ?? {})) outcome = { done: true };
      else if (typeof step?.error === "string") outcome = { error: step.error };
    });
    child.on("error", (error) => { signal?.removeEventListener("abort", stop); reject(error); });
    child.on("close", () => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (outcome?.done) resolve();
      else reject(new Error(outcome?.error ?? "sign-in did not finish"));
    });
  });
}
