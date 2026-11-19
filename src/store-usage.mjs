export class HarnessUsageStore {
  #db;
  #hasSession;
  #usageSummary = null;

  constructor(db, hasSession) {
    this.#db = db;
    this.#hasSession = hasSession;
  }

  recordUsage(sessionId, usage, now = Date.now()) {
    if (!this.#hasSession(sessionId)) throw new Error("session does not exist");
    const result = this.#db.prepare(`INSERT OR IGNORE INTO usage_entries (
      session_id, entry_id, provider, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, total_tokens, cost_total, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, usage.entryId, usage.provider, usage.model, usage.input, usage.output,
        usage.cacheRead, usage.cacheWrite, usage.reasoning, usage.totalTokens, usage.costTotal, now);
    if (result.changes === 1 && this.#usageSummary) this.#addUsage(usage);
    return { recorded: result.changes === 1 };
  }

  recordContextUsage(sessionId, usage, now = Date.now()) {
    if (!this.#hasSession(sessionId)) throw new Error("session does not exist");
    this.#db.prepare(`INSERT INTO session_context_usage(session_id, context_tokens, context_window, percent, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET context_tokens = excluded.context_tokens,
      context_window = excluded.context_window, percent = excluded.percent, updated_at = excluded.updated_at`)
      .run(sessionId, usage.tokens, usage.contextWindow, usage.percent, now);
    return { recorded: true };
  }

  getSessionTelemetry(sessionId) {
    if (!this.#hasSession(sessionId)) throw new Error("session does not exist");
    const total = this.#db.prepare(`SELECT count(*) AS entries, coalesce(sum(input_tokens), 0) AS input_tokens,
      coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
      coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens
      FROM usage_entries WHERE session_id = ?`).get(sessionId);
    const latest = this.#db.prepare(`SELECT provider, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, total_tokens FROM usage_entries
      WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get(sessionId);
    const context = this.#db.prepare("SELECT context_tokens, context_window, percent FROM session_context_usage WHERE session_id = ?").get(sessionId);
    const project = (row) => {
      const input = Number(row.input_tokens), cacheRead = Number(row.cache_read_tokens), cacheWrite = Number(row.cache_write_tokens);
      const denominator = input + cacheRead + cacheWrite;
      return { input, output: Number(row.output_tokens), cacheRead, cacheWrite,
        reasoning: Number(row.reasoning_tokens ?? 0), totalTokens: Number(row.total_tokens),
        cacheHitRatio: denominator > 0 ? cacheRead / denominator : null };
    };
    return {
      session: { entries: Number(total.entries), ...project(total) },
      latestTurn: latest ? { provider: latest.provider, model: latest.model, ...project(latest) } : null,
      context: context ? { tokens: context.context_tokens == null ? null : Number(context.context_tokens),
        contextWindow: Number(context.context_window), percent: context.percent == null ? null : Number(context.percent) } : null,
    };
  }

  getUsageSummary() {
    // Lifetime totals are loaded once and kept current by recordUsage, so status
    // polls do not rescan every usage entry (~0.5 s per poll at 321k entries).
    this.#usageSummary ??= this.#loadUsageSummary();
    const { totals, models } = this.#usageSummary;
    const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const byModel = [...models.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens || order(a.provider, b.provider) || order(a.model, b.model))
      .slice(0, 64).map((row) => ({ ...row }));
    return { ...totals, byModel };
  }

  #loadUsageSummary() {
    const total = this.#db.prepare(`SELECT count(*) AS entries, coalesce(sum(input_tokens), 0) AS input_tokens,
      coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
      coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens, coalesce(sum(cost_total), 0.0) AS cost_total FROM usage_entries`).get();
    const models = new Map();
    for (const row of this.#db.prepare(`SELECT provider, model, count(*) AS entries, sum(total_tokens) AS total_tokens,
      sum(cost_total) AS cost_total FROM usage_entries GROUP BY provider, model`).all()) {
      models.set(JSON.stringify([row.provider, row.model]), { provider: row.provider, model: row.model,
        entries: Number(row.entries), totalTokens: Number(row.total_tokens), costTotal: Number(row.cost_total) });
    }
    return { models, totals: {
      entries: Number(total.entries), inputTokens: Number(total.input_tokens), outputTokens: Number(total.output_tokens),
      cacheReadTokens: Number(total.cache_read_tokens), cacheWriteTokens: Number(total.cache_write_tokens),
      reasoningTokens: Number(total.reasoning_tokens), totalTokens: Number(total.total_tokens),
      costTotal: Number(total.cost_total),
    } };
  }

  #addUsage(usage) {
    const value = (field) => Number(field ?? 0);
    const { totals, models } = this.#usageSummary;
    totals.entries += 1; totals.inputTokens += value(usage.input); totals.outputTokens += value(usage.output);
    totals.cacheReadTokens += value(usage.cacheRead); totals.cacheWriteTokens += value(usage.cacheWrite);
    totals.reasoningTokens += value(usage.reasoning); totals.totalTokens += value(usage.totalTokens);
    totals.costTotal += value(usage.costTotal);
    const key = JSON.stringify([usage.provider, usage.model]);
    const row = models.get(key) ?? { provider: usage.provider, model: usage.model, entries: 0, totalTokens: 0, costTotal: 0 };
    row.entries += 1; row.totalTokens += value(usage.totalTokens); row.costTotal += value(usage.costTotal);
    models.set(key, row);
  }

  getUsageWindow(windowMinutes, observedAt = Date.now()) {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10_080) {
      throw new Error("usage window must be an integer from 1 through 10080 minutes");
    }
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("usage observation time must be a non-negative safe integer");
    const since = observedAt - windowMinutes * 60_000;
    // SQLite integer sum() throws once a valid sequence exceeds int64. total() accumulates
    // non-negative values without that failure; project() then applies one finite JSON-safe
    // precision boundary to every numeric total and reports each field that hit it.
    const totals = `count(*) AS entries, count(DISTINCT session_id) AS sessions,
      total(input_tokens) AS input_tokens, total(output_tokens) AS output_tokens,
      total(cache_read_tokens) AS cache_read_tokens, total(cache_write_tokens) AS cache_write_tokens,
      total(reasoning_tokens) AS reasoning_tokens, total(total_tokens) AS total_tokens,
      total(cost_total) AS estimated_cost`;
    const total = this.#db.prepare(`SELECT ${totals} FROM usage_entries WHERE recorded_at >= ? AND recorded_at <= ?`)
      .get(since, observedAt);
    const rows = this.#db.prepare(`SELECT provider, model, ${totals} FROM usage_entries
      WHERE recorded_at >= ? AND recorded_at <= ? GROUP BY provider, model
      ORDER BY total(total_tokens) DESC, provider, model LIMIT 65`).all(since, observedAt);
    const numericFields = [
      ["entries", "entries"], ["sessions", "sessions"], ["inputTokens", "input_tokens"],
      ["outputTokens", "output_tokens"], ["cacheReadTokens", "cache_read_tokens"],
      ["cacheWriteTokens", "cache_write_tokens"], ["reasoningTokens", "reasoning_tokens"],
      ["totalTokens", "total_tokens"], ["estimatedCost", "estimated_cost"],
    ];
    const project = (row) => {
      const result = {};
      const saturated = {};
      for (const [field, column] of numericFields) {
        const value = Number(row[column]);
        saturated[field] = !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER;
        result[field] = saturated[field] ? Number.MAX_SAFE_INTEGER : value;
      }
      return { ...result, precision: { safeMaximum: Number.MAX_SAFE_INTEGER, saturated } };
    };
    return {
      window: { minutes: windowMinutes, since, observedAt, boundaries: "inclusive" },
      aggregate: project(total),
      byModel: rows.slice(0, 64).map((row) => ({ provider: row.provider, model: row.model, ...project(row) })),
      byModelTruncated: rows.length > 64,
    };
  }

  getOperationalCounts() {
    const sessions = Object.fromEntries(this.#db.prepare("SELECT kind || ':' || activity AS key, count(*) AS count FROM sessions WHERE lifecycle <> 'deleted' GROUP BY kind, activity")
      .all().map((row) => [row.key, Number(row.count)]));
    const actors = Object.fromEntries(this.#db.prepare("SELECT lifecycle AS key, count(*) AS count FROM sessions GROUP BY lifecycle")
      .all().map((row) => [row.key, Number(row.count)]));
    const children = Object.fromEntries(this.#db.prepare(`SELECT s.lifecycle AS key, count(*) AS count FROM children c
      JOIN sessions s ON s.id = c.session_id GROUP BY s.lifecycle`).all().map((row) => [row.key, Number(row.count)]));
    const messages = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM messages GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    const inputs = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM actor_inputs GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    const tasks = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM child_tasks GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    return { sessions, actors, children, messages, inputs, tasks };
  }

  diagnose() {
    const issues = [];
    for (const row of this.#db.prepare("SELECT * FROM sessions WHERE lifecycle <> 'deleted'").all()) {
      if (!row.session_file) issues.push({ code: "missing_session_file", sessionId: row.id });
      if (row.lifecycle === "resident" && row.actor_pid == null) issues.push({ code: "resident_without_pid", sessionId: row.id });
      if (!row.actor_token) issues.push({ code: "missing_actor_token", sessionId: row.id });
    }
    for (const row of this.#db.prepare("PRAGMA foreign_key_check").all()) {
      issues.push({ code: "foreign_key_violation", table: row.table, rowId: row.rowid });
    }
    for (const row of this.#db.prepare(`SELECT m.id, m.target_id FROM messages m JOIN sessions s ON s.id = m.target_id
      WHERE s.lifecycle = 'deleted' AND m.state IN ('accepted', 'queued', 'delivered') LIMIT 256`).all()) {
      issues.push({ code: "message_targets_deleted_session", messageId: row.id, sessionId: row.target_id });
    }
    for (const row of this.#db.prepare(`SELECT m.id, m.sender_id FROM messages m JOIN sessions s ON s.id = m.sender_id
      WHERE s.lifecycle = 'deleted' AND m.state = 'accepted' LIMIT 256`).all()) {
      issues.push({ code: "message_awaits_deleted_sender", messageId: row.id, sessionId: row.sender_id });
    }
    for (const row of this.#db.prepare(`SELECT t.id, t.child_id FROM child_tasks t JOIN sessions s ON s.id = t.child_id
      WHERE s.lifecycle = 'deleted' AND t.state IN ('queued', 'submitted') LIMIT 256`).all()) {
      issues.push({ code: "task_targets_deleted_child", taskId: row.id, sessionId: row.child_id });
    }
    return issues.slice(0, 256);
  }

}
