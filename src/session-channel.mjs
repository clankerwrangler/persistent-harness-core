// The channel between the supervisor and a session process it starts: JSON lines on the
// process's stdin and stdout. Commands go in (`{ id, type, ...fields }`), responses
// (`{ type: "response", id, success, data | error }`) and events come out. This is part of
// the contract between the two halves, with protocol.mjs and framing.mjs; a change that old
// and new halves could misread raises SESSION_CHANNEL_VERSION.
import { JsonLineDecoder } from "./framing.mjs";

export const SESSION_CHANNEL_VERSION = 4;
/** One line can carry a large tool result. */
export const MAX_SESSION_LINE_BYTES = 256 * 1024 * 1024;
/** Environment variable naming the session process's code cache directory, if any. */
export const SESSION_COMPILE_CACHE_ENV = "PI_HARNESS_ACTOR_COMPILE_CACHE";
/** The one-off records reader (bin/session-records.mjs) takes requests of this version: one
 * `{ version, op, ... }` line in, `receipts` questions and answers, one `result` or `error` out. */
export const SESSION_RECORDS_VERSION = 1;

export function sessionLineDecoder() { return new JsonLineDecoder({ maxFrameBytes: MAX_SESSION_LINE_BYTES }); }
