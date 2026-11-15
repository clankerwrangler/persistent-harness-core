// For stand-in sessions: what a real session half sends for a session event, written the way
// tests write them (agent_start, message_update, ..., agent_settled). Its live view makes the
// `live_event` frame (null when nothing of the event is kept); other frames pass as they are.
import { LiveView } from "../../src/live-view.mjs";

const LIVE = new Set(["agent_start", "agent_settled", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end"]);
const views = new WeakMap();

/** `owner` is the stand-in session (its `session` says whether it is a root at depth 0). */
export function liveFrame(owner, frame) {
  if (!LIVE.has(frame?.type)) return frame;
  let view = views.get(owner);
  if (!view) { view = new LiveView({ presentation: owner.session?.kind === "root" && owner.session?.depth === 0 }); views.set(owner, view); }
  return view.accept(frame);
}
