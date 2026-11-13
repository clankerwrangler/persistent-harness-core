// Message time stamps. The agent has no clock of its own, so each incoming message
// carries the local time it arrived at; tool results get one only after a long quiet
// stretch. The worker adds the stamp to the message it sends to the core, as a marked
// text block: it is part of the saved context, and displays leave it out.
export const TOOL_RESULT_STAMP_GAP_MS = 15 * 60 * 1000;
export const HARNESS_TIME_BLOCK = "time";
const formats = new Map();

export function formatMessageTime(timestamp, timeZone) {
  const key = timeZone ?? "";
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }));
  return `[${formats.get(key).format(new Date(timestamp))}]`;
}

// timeZone defaults to the process zone (TZ or /etc/localtime).
export function messageTimeBlock(timestamp, { timeZone = process.env.PI_HARNESS_USER_TIMEZONE || undefined } = {}) {
  return { type: "text", text: formatMessageTime(timestamp, timeZone), harness: HARNESS_TIME_BLOCK };
}

/** Which messages get a time: every incoming message, and a tool result after a quiet stretch. */
export class MessageClock {
  constructor({ last, now = Date.now, timeZone } = {}) {
    Object.assign(this, { last, now, timeZone });
  }
  #block(time) { this.last = time; return messageTimeBlock(time, this.timeZone === undefined ? {} : { timeZone: this.timeZone }); }
  /** The stamp for an incoming message (it leads the message). */
  incoming() { return this.#block(this.now()); }
  /** The stamp for a tool result (it follows the output), or none. */
  toolResult() {
    const time = this.now();
    if (this.last === undefined) { this.last = time; return undefined; }
    return time - this.last >= TOOL_RESULT_STAMP_GAP_MS ? this.#block(time) : undefined;
  }
}
