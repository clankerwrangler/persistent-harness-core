// What Python recovery reads from tool results. Both the session's recovery check and the
// supervisor's cleanup of old tool output use this, so it lives apart from the recovery code,
// which only sessions load.
export const SELECT = Object.freeze({
  where: { role: "toolResult", toolName: "ipython" },
  fields: ["role", "toolCallId", "toolName", "isError"],
  details: [...["namespaceCheckpoint", "namespaceCheckpointAttempt"].flatMap((field) =>
    ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"].map((key) => `${field}.${key}`)),
    "namespaceCheckpointState", "nativeAsyncRecovery", "executionId", "executionOk", "ok"],
});

/** The top-level tool-result detail fields recovery reads: the daily cleanup keeps these
 * when it deletes old tool output, so recovery sees old calls as before, not expired. */
export const RECOVERY_DETAIL_FIELDS = Object.freeze([...new Set(SELECT.details.map((field) => field.split(".")[0]))]);
