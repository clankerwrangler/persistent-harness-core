// One page of visible history: the newest rows that fit a count and a byte budget. A row
// too large for an empty page is shortened so the next page can still reach older rows.
export function publicHistoryItem(item) {
  return item.kind === "message" ? { kind: "message", id: item.message.id } : item;
}

function historyProjection(items) {
  return {
    messages: items.filter((item) => item.kind === "message").map((item) => item.message),
    history: items.map(publicHistoryItem),
  };
}

export function boundVisibleHistory(history, { maxMessages = 512, maxBytes = 48 * 1024 } = {}) {
  const source = Array.isArray(history) ? history : [];
  const selected = [];
  let bytes = Buffer.byteLength(JSON.stringify({ messages: [], history: [] }), "utf8");
  let messageCount = 0; let historyCount = 0;
  for (let index = source.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    let item = source[index].kind === "message"
      ? { ...source[index], message: { ...source[index].message } }
      : { ...source[index] };
    const cost = (candidate) => (candidate.kind === "message"
      ? Buffer.byteLength(JSON.stringify(candidate.message), "utf8") + (messageCount ? 1 : 0) : 0)
      + Buffer.byteLength(JSON.stringify(publicHistoryItem(candidate)), "utf8") + (historyCount ? 1 : 0);
    let encodedBytes = cost(item);
    // A large row must not prevent the next page from reaching its predecessors.
    if (bytes + encodedBytes > maxBytes && selected.length === 0
      && (item.kind === "message" || typeof item.body === "string")) {
      const original = String(item.kind === "message" ? item.message.text ?? "" : item.body);
      let low = 0; let high = original.length; let fitted;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const prefix = original.slice(0, middle).replace(/[\uD800-\uDBFF]$/, "");
        const text = middle < original.length ? `${prefix}…` : prefix;
        const candidate = item.kind === "message" ? { ...item, message: { ...item.message, text } } : { ...item, body: text };
        if (bytes + cost(candidate) <= maxBytes) { fitted = candidate; low = middle + 1; }
        else high = middle - 1;
      }
      if (fitted) { item = fitted; encodedBytes = cost(item); }
    }
    if (bytes + encodedBytes > maxBytes) break;
    selected.push(item); bytes += encodedBytes; historyCount += 1;
    if (item.kind === "message") messageCount += 1;
  }
  selected.reverse();
  return { ...historyProjection(selected), truncated: selected.length < source.length };
}

export function boundVisibleMessages(messages, options) {
  const bounded = boundVisibleHistory((Array.isArray(messages) ? messages : []).map((message) => ({ kind: "message", message })), options);
  return { messages: bounded.messages, truncated: bounded.truncated };
}
