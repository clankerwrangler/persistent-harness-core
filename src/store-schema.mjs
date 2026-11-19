import { actorInputDigest } from "./protocol.mjs";

export const SCHEMA_VERSION = 2;

export const CURRENT_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    session_file TEXT,
    cwd TEXT NOT NULL,
    repository_root TEXT,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'child')),
    family_id TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    depth INTEGER NOT NULL CHECK (depth >= 0),
    activity TEXT NOT NULL CHECK (activity IN ('working', 'delegating', 'idle', 'inactive')),
    streaming INTEGER NOT NULL DEFAULT 0 CHECK (streaming IN (0, 1)),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('starting', 'resident', 'passivated', 'stopped', 'error', 'deleted')),
    actor_token TEXT NOT NULL,
    actor_generation INTEGER NOT NULL CHECK (actor_generation >= 1),
    actor_pid INTEGER,
    actor_identity_json TEXT,
    launch_json TEXT,
    scratch_json TEXT,
    quiet_since INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    started_at INTEGER,
    stopped_at INTEGER,
    deleted_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX root_name ON sessions(display_name) WHERE kind = 'root' AND lifecycle <> 'deleted';
  CREATE UNIQUE INDEX child_name_per_parent ON sessions(parent_session_id, display_name) WHERE kind = 'child' AND lifecycle <> 'deleted';
  CREATE INDEX sessions_family ON sessions(family_id, kind, created_at);
  CREATE INDEX sessions_parent ON sessions(parent_session_id, lifecycle, id);
  CREATE INDEX sessions_lifecycle ON sessions(lifecycle, quiet_since, created_at, id);
  CREATE INDEX sessions_pending_scratch ON sessions(lifecycle, id) WHERE kind = 'root' AND lifecycle = 'deleted' AND CASE WHEN json_valid(scratch_json) THEN json_extract(scratch_json, '$.state') END = 'deleting';
  CREATE TABLE children (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE child_tasks (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL REFERENCES children(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('initial')),
    prompt TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    history_peer_name TEXT NOT NULL,
    history_entry_id TEXT
  ) STRICT;
  CREATE INDEX child_tasks_pending ON child_tasks(child_id, created_at, id) WHERE state IN ('queued', 'submitted');
  CREATE INDEX child_tasks_history_pending ON child_tasks(child_id, created_at, id) WHERE history_entry_id IS NULL;
  CREATE UNIQUE INDEX child_tasks_history_entries ON child_tasks(history_entry_id) WHERE history_entry_id IS NOT NULL;
  CREATE TABLE actor_inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]',
    location_json TEXT,
    digest TEXT NOT NULL,
    behavior TEXT NOT NULL CHECK (behavior IN ('auto', 'steer', 'follow_up')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted')),
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_generation INTEGER,
    wake_error_generation INTEGER
  ) STRICT;
  CREATE INDEX actor_inputs_pending ON actor_inputs(session_id, created_at, id);
  CREATE TABLE actor_input_receipts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL UNIQUE,
    source TEXT CHECK (source IN ('user', 'cron', 'background')),
    origin_json TEXT,
    client_message_id TEXT,
    delivered_at INTEGER,
    delivered_entry_id TEXT,
    handled_at INTEGER,
    retry_intent_json TEXT
  ) STRICT;
  CREATE INDEX actor_input_receipts_session ON actor_input_receipts(session_id, created_at, id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES sessions(id),
    target_id TEXT NOT NULL REFERENCES sessions(id),
    relationship TEXT NOT NULL CHECK (relationship IN ('parent', 'child', 'sibling')),
    delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('auto', 'follow_up')),
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'delivered', 'acknowledged', 'rejected')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    accepted_at INTEGER NOT NULL,
    queued_at INTEGER,
    delivered_at INTEGER,
    acknowledged_at INTEGER,
    last_error TEXT,
    sender_entry_id TEXT,
    child_exit_generation INTEGER
  ) STRICT;
  CREATE INDEX pending_messages_target ON messages(target_id, accepted_at, id) WHERE state IN ('queued', 'delivered');
  CREATE UNIQUE INDEX message_sender_entries ON messages(sender_id, sender_entry_id) WHERE sender_entry_id IS NOT NULL;
  CREATE INDEX pending_child_exit_messages ON messages(id) WHERE child_exit_generation IS NOT NULL AND state IN ('queued', 'delivered');
  CREATE TABLE session_skill_grants (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    manifest_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE usage_entries (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
    cost_total REAL NOT NULL CHECK (cost_total >= 0),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id)
  ) STRICT;
  CREATE INDEX usage_entries_recorded ON usage_entries(recorded_at, session_id, entry_id);
  CREATE TABLE session_context_usage (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    context_tokens INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
    context_window INTEGER NOT NULL CHECK (context_window > 0),
    percent REAL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 10000)),
    updated_at INTEGER NOT NULL
  ) STRICT;
`;


export function migrateHarnessDatabase(db) {
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
    throw new Error(`unreleased database schema ${version} is unsupported; recreate the harness database`);
  }
  if (version === 0) {
    db.exec(`BEGIN IMMEDIATE; ${CURRENT_SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    return;
  }
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name));
  const inputTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actor_inputs'").get();
  if (!sessionColumns.has("actor_token") || !sessionColumns.has("actor_generation") || !inputTable) {
    throw new Error("unreleased split-architecture database is unsupported; preserve session files, then recreate harness.sqlite");
  }
  if (!sessionColumns.has("scratch_json")) db.exec("ALTER TABLE sessions ADD COLUMN scratch_json TEXT");
  // Full parent edges serve active counts and deletion through tombstones.
  db.exec("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id, lifecycle, id)");
  if (sessionColumns.has("kind") && sessionColumns.has("lifecycle")) {
    db.exec(`CREATE INDEX IF NOT EXISTS sessions_pending_scratch ON sessions(lifecycle, id)
      WHERE kind = 'root' AND lifecycle = 'deleted'
        AND CASE WHEN json_valid(scratch_json) THEN json_extract(scratch_json, '$.state') END = 'deleting'`);
  }
  let inputColumns = new Set(db.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name));
  if (!inputColumns.has("wake_error_generation")) db.exec("ALTER TABLE actor_inputs ADD COLUMN wake_error_generation INTEGER");
  if (!inputColumns.has("location_json")) db.exec("ALTER TABLE actor_inputs ADD COLUMN location_json TEXT");
  if (!inputColumns.has("images_json")) db.exec("ALTER TABLE actor_inputs ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'");
  inputColumns = new Set(db.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name));
  if (!inputColumns.has("digest")) db.exec("ALTER TABLE actor_inputs ADD COLUMN digest TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS actor_input_receipts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT; CREATE INDEX IF NOT EXISTS actor_input_receipts_session ON actor_input_receipts(session_id, created_at, id);`);
  const updateDigest = db.prepare("UPDATE actor_inputs SET digest = ? WHERE id = ?");
  const insertReceipt = db.prepare("INSERT OR IGNORE INTO actor_input_receipts(id, session_id, digest, created_at) VALUES (?, ?, ?, ?)");
  for (const row of db.prepare("SELECT * FROM actor_inputs WHERE digest IS NULL").all()) {
    const digest = actorInputDigest(row.body, row.images_json, row.behavior); updateDigest.run(digest, row.id);
  }
  for (const row of db.prepare("SELECT * FROM actor_inputs WHERE id NOT IN (SELECT id FROM actor_input_receipts)").all()) {
    insertReceipt.run(row.id, row.session_id, row.digest, row.created_at);
  }
  // Preserve legacy receipt order without guessing provenance or delivery times.
  const receiptColumns = new Set(db.prepare("PRAGMA table_info(actor_input_receipts)").all().map((row) => row.name));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, type] of [["sequence", "INTEGER"], ["source", "TEXT"], ["origin_json", "TEXT"],
      ["client_message_id", "TEXT"], ["delivered_at", "INTEGER"], ["delivered_entry_id", "TEXT"], ["handled_at", "INTEGER"], ["retry_intent_json", "TEXT"]]) {
      if (!receiptColumns.has(name)) db.exec(`ALTER TABLE actor_input_receipts ADD COLUMN ${name} ${type}`);
    }
    db.exec("UPDATE actor_input_receipts SET sequence = rowid WHERE sequence IS NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS actor_input_receipts_sequence ON actor_input_receipts(sequence)");
    if (!sessionColumns.has("last_activity_at")) db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER");
    if (sessionColumns.has("created_at")) db.exec("UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const messageColumns = new Set(db.prepare("PRAGMA table_info(messages)").all().map((row) => row.name));
  if (!messageColumns.has("sender_entry_id")) db.exec("ALTER TABLE messages ADD COLUMN sender_entry_id TEXT");
  if (!messageColumns.has("child_exit_generation")) db.exec("ALTER TABLE messages ADD COLUMN child_exit_generation INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS pending_child_exit_messages ON messages(id) WHERE child_exit_generation IS NOT NULL AND state IN ('queued', 'delivered')");
  db.exec("CREATE INDEX IF NOT EXISTS waiting_messages_target ON messages(target_id, accepted_at, id) WHERE state IN ('accepted', 'queued', 'delivered')");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS message_sender_entries ON messages(sender_id, sender_entry_id) WHERE sender_entry_id IS NOT NULL");
  db.exec(`CREATE TABLE IF NOT EXISTS session_context_usage (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    context_tokens INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
    context_window INTEGER NOT NULL CHECK (context_window > 0),
    percent REAL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 10000)),
    updated_at INTEGER NOT NULL
  ) STRICT`);
  if (version === 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const childTaskTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'child_tasks'").get();
      if (childTaskTable) {
        const childTaskColumns = new Set(db.prepare("PRAGMA table_info(child_tasks)").all().map((row) => row.name));
        if (!childTaskColumns.has("history_peer_name")) db.exec("ALTER TABLE child_tasks ADD COLUMN history_peer_name TEXT");
        if (!childTaskColumns.has("history_entry_id")) db.exec("ALTER TABLE child_tasks ADD COLUMN history_entry_id TEXT");
        // Legacy tasks predate child-creation history. Mark them with unique internal
        // receipts so migration never creates retroactive end-of-transcript rows.
        db.exec(`UPDATE child_tasks SET history_peer_name = coalesce(history_peer_name,
          (SELECT display_name FROM sessions WHERE sessions.id = child_tasks.child_id), 'legacy-child')
          WHERE history_peer_name IS NULL`);
        db.exec("UPDATE child_tasks SET history_entry_id = 'legacy-child-history:' || id WHERE history_entry_id IS NULL");
        db.exec("CREATE INDEX IF NOT EXISTS child_tasks_history_pending ON child_tasks(child_id, created_at, id) WHERE history_entry_id IS NULL");
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS child_tasks_history_entries ON child_tasks(history_entry_id) WHERE history_entry_id IS NOT NULL");
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
