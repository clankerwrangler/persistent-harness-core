// What a submitted input's retry fields ask for, and how long a session action may take.
// The core has no branches, so the supervisor refuses a retry of a response (submit_input).
export const SESSION_ACTION_TIMEOUT_MS = 330_000;

export function retryIntentForRequest(params) {
  if (!params.retryOf) return null;
  return { targetId: params.retryOf,
    mode: params.retryOriginal === true ? "original" : "explicit" };
}
