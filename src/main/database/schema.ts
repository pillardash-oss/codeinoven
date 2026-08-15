/**
 * Full DDL schema for CodeInOven's SQLite database.
 *
 * Tables:
 *   projects        — Project entity storage
 *   threads         — Thread entity storage (22+ columns, no JSON blobs)
 *   history_entries — Conversation history per thread, with sequence for truncation
 *   history_fts     — FTS5 virtual table on history_entries.content
 *   project_fts     — FTS5 virtual table on projects.name
 *   agent_messages  — Mirrored agent conversation messages
 *   agent_messages_fts — FTS5 virtual table on agent_messages.search_text
 *   settings        — Global app config (key/value)
 *   db_meta         — Internal database metadata
 */

export const SCHEMA_SQL = `
-- ─── Metadata ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS db_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO db_meta(key, value) VALUES('schema_version', '1');

-- ─── Settings (app config) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- ─── Projects ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT NOT NULL,
  path               TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','ssh')),
  host               TEXT,
  provider_id        TEXT NOT NULL DEFAULT '',
  workflow_id        TEXT NOT NULL DEFAULT 'default',
  thread_limit       INTEGER NOT NULL DEFAULT 70,
  hidden             INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER,
  icon               TEXT,
  color              TEXT,
  icon_type          TEXT,
  change_tracking_mode TEXT NOT NULL DEFAULT 'manual' CHECK(change_tracking_mode IN ('git','manual')),
  has_deployments    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_listing ON projects(pinned DESC, sort_order, updated_at DESC);`

export const PROJECT_FTS_SQL = `
-- ─── Project FTS5 ───────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
  name,
  content='projects',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep project_fts in sync with projects
CREATE TRIGGER IF NOT EXISTS project_fts_insert AFTER INSERT ON projects BEGIN
  INSERT INTO project_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS project_fts_delete AFTER DELETE ON projects BEGIN
  INSERT INTO project_fts(project_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;

DROP TRIGGER IF EXISTS project_fts_update;
CREATE TRIGGER IF NOT EXISTS project_fts_update AFTER UPDATE ON projects
WHEN new.name != old.name BEGIN
  INSERT INTO project_fts(project_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO project_fts(rowid, name) VALUES (new.rowid, new.name);
END;`

export const THREADS_SQL = `
-- ─── Threads ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threads (
  id                   TEXT PRIMARY KEY NOT NULL,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id          TEXT NOT NULL DEFAULT '',
  title                TEXT NOT NULL DEFAULT 'New Thread',
  title_source         TEXT NOT NULL DEFAULT 'default' CHECK(title_source IN ('default','auto','manual')),
  status               TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','planning','awaiting_approval','executing','interrupted','completed','failed')),
  pinned               INTEGER NOT NULL DEFAULT 0,
  pinned_at            INTEGER,
  sort_order           INTEGER,
  scope_sort_order     INTEGER,
  archived             INTEGER NOT NULL DEFAULT 0,
  read                 INTEGER NOT NULL DEFAULT 1,
  branch               TEXT,
  feature_slug         TEXT,
  scope_bucket_id      TEXT DEFAULT 'default',
  settings             TEXT,
  context_usage        TEXT,
  session_id           TEXT,
  dismissed_spec_id    TEXT,
  dismissed_spec_version INTEGER,
  audit_state          TEXT CHECK(audit_state IN ('offered','running','report_ready','reworking')),
  loop_iteration       INTEGER,
  active_audit_id      TEXT,
  active_audit_version INTEGER,
  assignment_id        TEXT,
  assignment_role      TEXT CHECK(assignment_role IN ('coordinator','worker')),
  assignment_task_id   TEXT,
  coordinator_thread_id TEXT,
  achievement_role     TEXT CHECK(achievement_role IN ('coordinator','auditor')),
  auditor_thread_id    TEXT,
  user_input_locked    INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_activity        INTEGER NOT NULL,
  working_directory    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_project_listing
  ON threads(project_id, archived, pinned DESC, pinned_at DESC, sort_order, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_threads_activity_listing
  ON threads(pinned DESC, pinned_at DESC, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_threads_default_listing
  ON threads(pinned DESC, pinned_at DESC, sort_order, last_activity DESC);`

export const HISTORY_SQL = `
-- ─── History Entries ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS history_entries (
  id         TEXT PRIMARY KEY NOT NULL,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content    TEXT NOT NULL,
  metadata   TEXT,
  "sequence" INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_thread_id ON history_entries(thread_id);
CREATE INDEX IF NOT EXISTS idx_history_sequence ON history_entries(thread_id, "sequence");`

export const HISTORY_FTS_SQL = `
-- ─── History FTS5 ───────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  content,
  content='history_entries',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep history_fts in sync with history_entries
CREATE TRIGGER IF NOT EXISTS history_fts_insert AFTER INSERT ON history_entries BEGIN
  INSERT INTO history_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS history_fts_delete AFTER DELETE ON history_entries BEGIN
  INSERT INTO history_fts(history_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

DROP TRIGGER IF EXISTS history_fts_update;
CREATE TRIGGER IF NOT EXISTS history_fts_update AFTER UPDATE ON history_entries
WHEN new.content != old.content BEGIN
  INSERT INTO history_fts(history_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO history_fts(rowid, content) VALUES (new.rowid, new.content);
END;`

export const AGENT_MESSAGES_SQL = `
-- ─── Agent Messages ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  id              TEXT PRIMARY KEY NOT NULL,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  session_id      TEXT,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
  origin          TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('user','assistant','harness','orchestrator','subagent','compaction','provider','legacy')),
  visibility      TEXT NOT NULL DEFAULT 'conversation' CHECK(visibility IN ('conversation','working_trace','subagent_trace','hidden')),
  parts           TEXT NOT NULL DEFAULT '[]',
  search_text     TEXT NOT NULL DEFAULT '',
  content_hash    TEXT,
  transport_parts TEXT,
  transport_origin TEXT CHECK(transport_origin IS NULL OR transport_origin IN ('user','assistant','harness','orchestrator','subagent','compaction','provider','legacy')),
  model_id        TEXT,
  provider_id     TEXT,
  harness_id      TEXT,
  thinking_level  TEXT,
  references_json TEXT,
  project_references_json TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  cost            REAL,
  tokens_json     TEXT,
  tokens_total    INTEGER,
  rate_limits_json TEXT,
  usage_credits_json TEXT,
  context_window  INTEGER,
  context_used    INTEGER,
  error           TEXT,
  structured_output TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_timeline
  ON agent_messages(thread_id, session_id, created_at, id);

-- Analytics range scans (Profile): role/harness_id are low-cardinality
-- filters over a created_at window, so leading with created_at bounds the scan.
CREATE INDEX IF NOT EXISTS idx_agent_messages_analytics
  ON agent_messages(created_at, role, harness_id);`

/**
 * One-time migration for databases created before `tokens_total` existed.
 * SQLite cannot ADD a STORED generated column via ALTER TABLE, so the column
 * is added as a plain nullable integer and backfilled in small chunks on the
 * maintenance worker after startup (see Database.applySchema).
 */
export const AGENT_MESSAGES_TOKENS_TOTAL_MIGRATION_SQL = `
ALTER TABLE agent_messages ADD COLUMN tokens_total INTEGER;`

/**
 * One-time migration for databases created before `thinking_level` existed on
 * `agent_messages`. Historical rows keep `NULL` ("unknown") until their thread
 * is next hydrated, when the chat engine stamps the thread's current level.
 */
export const AGENT_MESSAGES_THINKING_LEVEL_MIGRATION_SQL = `
ALTER TABLE agent_messages ADD COLUMN thinking_level TEXT;`

/**
 * One-time migration for databases created before `thinking_level` existed on
 * `usage_events`. Existing rows keep `NULL` ("unknown").
 */
export const USAGE_EVENTS_THINKING_LEVEL_MIGRATION_SQL = `
ALTER TABLE usage_events ADD COLUMN thinking_level TEXT;`

/**
 * One-time migration for databases created before `thinking_level` existed on
 * `harness_usage`. The column mirrors `model_id`: the last observed level for
 * the (project, thread, harness, provider) key.
 */
export const HARNESS_USAGE_THINKING_LEVEL_MIGRATION_SQL = `
ALTER TABLE harness_usage ADD COLUMN thinking_level TEXT;`

/**
 * Column definitions shared by the canonical `harness_usage_models` table, the
 * migration staging table, and the interrupted-rebuild recovery (which
 * normalizes a bare staging copy back to this constrained shape). thinking_level
 * is NOT NULL with an empty-string "unknown" sentinel because SQLite treats
 * NULLs as distinct inside a composite PRIMARY KEY — NULL levels would fragment
 * one model's usage into a row per message instead of accumulating it.
 */
export const HARNESS_USAGE_MODELS_COLUMNS_SQL = `
  thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  harness_id           TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  thinking_level       TEXT NOT NULL DEFAULT '',
  message_count        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  tokens_in            INTEGER NOT NULL DEFAULT 0,
  tokens_out           INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write   INTEGER NOT NULL DEFAULT 0,
  tokens_total         INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER NOT NULL DEFAULT 0,
  first_used_at        INTEGER NOT NULL,
  last_used_at         INTEGER NOT NULL,
  PRIMARY KEY (thread_id, harness_id, provider_id, model_id, thinking_level)`

/** Columns the app reads off `harness_usage_models`; used to validate staged data. */
export const HARNESS_USAGE_MODELS_EXPECTED_COLUMNS = [
  'thread_id',
  'harness_id',
  'provider_id',
  'model_id',
  'thinking_level',
  'message_count',
  'cost_usd',
  'tokens_in',
  'tokens_out',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_total',
  'duration_ms',
  'first_used_at',
  'last_used_at'
] as const

/**
 * Column definitions shared by the canonical `turn_feedback` table, the
 * migration staging table, and the interrupted-rebuild recovery. thread_id
 * deliberately does NOT cascade-delete: resolved outcomes are the long-term
 * analytics record for "best model by feedback", so rows keep their own
 * attribution when the owning thread is deleted.
 */
export const TURN_FEEDBACK_COLUMNS_SQL = `
  id             TEXT PRIMARY KEY NOT NULL,
  thread_id      TEXT REFERENCES threads(id) ON DELETE SET NULL,
  parent_turn_id TEXT NOT NULL UNIQUE,
  session_id     TEXT,
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  status         TEXT NOT NULL CHECK(status IN ('pending','success','corrected')),
  signal         TEXT CHECK(signal IN ('continued','switched','cleaned_up','corrective_feedback')),
  score          REAL NOT NULL DEFAULT 0,
  feature        TEXT CHECK(feature IN ('main','audit','assignment')),
  task_slug      TEXT,
  harness_id     TEXT,
  provider_id    TEXT,
  model_id       TEXT,
  thinking_level TEXT`

/** Columns the app reads off `turn_feedback`; used to validate staged data. */
export const TURN_FEEDBACK_EXPECTED_COLUMNS = [
  'id',
  'thread_id',
  'parent_turn_id',
  'session_id',
  'created_at',
  'resolved_at',
  'status',
  'signal',
  'score',
  'feature',
  'task_slug',
  'harness_id',
  'provider_id',
  'model_id',
  'thinking_level'
] as const

/**
 * Rebuilt `harness_usage_models` shape shared by both thinking-level
 * migrations. SQLite cannot change a PRIMARY KEY in place, so the table is
 * always rebuilt rather than altered. The temp table is dropped first so a
 * partially-failed earlier run (which can leave `harness_usage_models_v2`
 * behind) never blocks database initialization on retry.
 */
const HARNESS_USAGE_MODELS_V2_DDL = `
DROP TABLE IF EXISTS harness_usage_models_v2;
CREATE TABLE harness_usage_models_v2 (${HARNESS_USAGE_MODELS_COLUMNS_SQL});`

const HARNESS_USAGE_MODELS_REBUILD_EPILOGUE = `
DROP TABLE harness_usage_models;
ALTER TABLE harness_usage_models_v2 RENAME TO harness_usage_models;
CREATE INDEX IF NOT EXISTS idx_harness_usage_models_thread
  ON harness_usage_models(thread_id);
CREATE INDEX IF NOT EXISTS idx_harness_usage_models_harness
  ON harness_usage_models(harness_id);`

/**
 * One-time migration for databases created before `thinking_level` existed at
 * all: the legacy table has no such column, so the copy uses a literal ''.
 */
export const HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL = `
${HARNESS_USAGE_MODELS_V2_DDL}
INSERT INTO harness_usage_models_v2(
  thread_id, harness_id, provider_id, model_id, thinking_level,
  message_count, cost_usd, tokens_in, tokens_out, tokens_reasoning,
  tokens_cache_read, tokens_cache_write, tokens_total, duration_ms,
  first_used_at, last_used_at
) SELECT
  thread_id, harness_id, provider_id, model_id, '',
  SUM(message_count), SUM(cost_usd), SUM(tokens_in), SUM(tokens_out), SUM(tokens_reasoning),
  SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_total), SUM(duration_ms),
  MIN(first_used_at), MAX(last_used_at)
FROM harness_usage_models
GROUP BY thread_id, harness_id, provider_id, model_id;
${HARNESS_USAGE_MODELS_REBUILD_EPILOGUE}`

/**
 * One-time migration for databases created with the nullable
 * `thinking_level` variant this feature first shipped with: the column exists,
 * so the copy normalizes NULLs to '' and merges any duplicate NULL rows.
 */
export const HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL = `
${HARNESS_USAGE_MODELS_V2_DDL}
INSERT INTO harness_usage_models_v2(
  thread_id, harness_id, provider_id, model_id, thinking_level,
  message_count, cost_usd, tokens_in, tokens_out, tokens_reasoning,
  tokens_cache_read, tokens_cache_write, tokens_total, duration_ms,
  first_used_at, last_used_at
) SELECT
  thread_id, harness_id, provider_id, model_id, COALESCE(thinking_level, ''),
  SUM(message_count), SUM(cost_usd), SUM(tokens_in), SUM(tokens_out), SUM(tokens_reasoning),
  SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_total), SUM(duration_ms),
  MIN(first_used_at), MAX(last_used_at)
FROM harness_usage_models
GROUP BY thread_id, harness_id, provider_id, model_id, COALESCE(thinking_level, '');
${HARNESS_USAGE_MODELS_REBUILD_EPILOGUE}`

/**
 * One-time migration for databases created while `turn_feedback.thread_id`
 * still cascade-deleted with its thread, which silently discarded every
 * resolved outcome — including the cleaned_up passes that must feed the
 * "best model by feedback" analytics. Rebuilds the table with `ON DELETE
 * SET NULL` and preserves all existing rows.
 */
export const TURN_FEEDBACK_SET_NULL_MIGRATION_SQL = `
DROP TABLE IF EXISTS turn_feedback_v2;
CREATE TABLE turn_feedback_v2 (${TURN_FEEDBACK_COLUMNS_SQL});
INSERT INTO turn_feedback_v2(
  id, thread_id, parent_turn_id, session_id, created_at, resolved_at,
  status, signal, score, feature, task_slug,
  harness_id, provider_id, model_id, thinking_level
) SELECT
  id, thread_id, parent_turn_id, session_id, created_at, resolved_at,
  status, signal, score, feature, task_slug,
  harness_id, provider_id, model_id, thinking_level
FROM turn_feedback;
DROP TABLE turn_feedback;
ALTER TABLE turn_feedback_v2 RENAME TO turn_feedback;
CREATE INDEX IF NOT EXISTS idx_turn_feedback_thread
  ON turn_feedback(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_feedback_pending
  ON turn_feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_feedback_attribution
  ON turn_feedback(harness_id, provider_id, model_id, thinking_level, feature);`

export const ATTACHMENT_GRANTS_SQL = `
-- ─── Durable attachment grants ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachment_grants (
  message_id      TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  canonical_path  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, canonical_path)
);

CREATE INDEX IF NOT EXISTS idx_attachment_grants_canonical_path
  ON attachment_grants(canonical_path);`

export const AGENT_MESSAGES_FTS_SQL = `
-- ─── Agent Messages FTS5 ────────────────────────────────────────────────
-- External-content FTS index over agent_messages.search_text (plain text
-- extracted from conversation parts in the main process). Only conversation
-- rows (session_id IS NULL, visibility='conversation') are surfaced by the
-- search query so user messages and the agent's final output match threads.
-- The sync triggers live in AGENT_MESSAGES_FTS_TRIGGERS_SQL so schema creation
-- stays ordered: table first, triggers second.
CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
  search_text,
  content='agent_messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);`

export const AGENT_MESSAGES_FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS agent_messages_fts_insert AFTER INSERT ON agent_messages BEGIN
  INSERT INTO agent_messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_delete AFTER DELETE ON agent_messages BEGIN
  INSERT INTO agent_messages_fts(agent_messages_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
END;

DROP TRIGGER IF EXISTS agent_messages_fts_update;
CREATE TRIGGER IF NOT EXISTS agent_messages_fts_update AFTER UPDATE ON agent_messages
WHEN new.search_text != old.search_text BEGIN
  INSERT INTO agent_messages_fts(agent_messages_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
  INSERT INTO agent_messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;`

/**
 * Remote device identity tables (A-04), applied idempotently alongside the
 * misc tables by `Database.init()` via `MISC_TABLES_SQL`. Kept as a named
 * export so the focused tests can create them without importing the full
 * database module.
 */
export const REMOTE_DEVICE_SQL = `
-- ─── Remote device identity (A-04) ──────────────────────────────────────
-- Per-enrolled-device scoped credentials. Only public keys and fingerprints
-- are stored — never a device private key, a bearer secret, or the raw
-- shared pairing value. Revocation writes a tombstone so a copied offline
-- credential can never reconnect.
CREATE TABLE IF NOT EXISTS remote_devices (
  device_id                TEXT PRIMARY KEY NOT NULL,
  name                     TEXT NOT NULL DEFAULT 'Phone',
  signing_public_jwk       TEXT NOT NULL,
  agreement_public_jwk     TEXT NOT NULL,
  public_key_fingerprint   TEXT NOT NULL,
  scopes                   TEXT NOT NULL,
  all_projects             INTEGER NOT NULL DEFAULT 1,
  project_ids              TEXT NOT NULL DEFAULT '[]',
  auth_version             INTEGER NOT NULL DEFAULT 1,
  credential_issued_at     INTEGER NOT NULL,
  credential_expires_at    INTEGER NOT NULL,
  created_at               INTEGER NOT NULL,
  last_used_at             INTEGER,
  expires_at               INTEGER NOT NULL,
  rotated_at               INTEGER,
  revoked_at               INTEGER,
  revoked_reason           TEXT,
  last_transport           TEXT NOT NULL DEFAULT 'lan'
);

CREATE INDEX IF NOT EXISTS idx_remote_devices_revoked ON remote_devices(revoked_at);

-- Immutable revocation tombstones retained for at least the longer of one year
-- or the revoked credential's original expiry plus seven days.
CREATE TABLE IF NOT EXISTS remote_device_tombstones (
  device_id                TEXT PRIMARY KEY NOT NULL,
  public_key_fingerprint   TEXT NOT NULL,
  last_auth_version        INTEGER NOT NULL,
  revoked_at               INTEGER NOT NULL
);

-- Bounded, append-only security audit log. Never contains secrets, raw
-- request arguments, prompt/file contents, or key material.
CREATE TABLE IF NOT EXISTS remote_audit_events (
  id                       TEXT PRIMARY KEY NOT NULL,
  timestamp                INTEGER NOT NULL,
  device_id                TEXT,
  device_name              TEXT,
  fingerprint_prefix       TEXT,
  transport                TEXT,
  session_id               TEXT,
  request_id               TEXT,
  channel                  TEXT,
  project_id               TEXT,
  resource_id              TEXT,
  required_scope           TEXT,
  decision                 TEXT NOT NULL,
  reason_code              TEXT,
  step_up_approval_id      TEXT,
  auth_version             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_remote_audit_timestamp ON remote_audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_remote_audit_device ON remote_audit_events(device_id);

-- Short-lived single-use pairing bootstraps. Only a SHA-256 hash of the raw
-- value is stored; the raw value lives in the QR URL fragment and is erased
-- on consume/rotation.
CREATE TABLE IF NOT EXISTS remote_pairing_bootstraps (
  bootstrap_id             TEXT PRIMARY KEY NOT NULL,
  hash                     TEXT NOT NULL,
  issued_at                INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_remote_bootstraps_state ON remote_pairing_bootstraps(state);`

export const MISC_TABLES_SQL =
  `
-- ─── Brainstorm Workflow ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brainstorm_workflow (
  project_id                   TEXT NOT NULL,
  thread_id                    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  entry_choice                 TEXT CHECK(entry_choice IN ('brainstorm','spec')),
  stage                        TEXT NOT NULL CHECK(stage IN ('choice_pending','drafting','finalized','skipped')),
  active_brainstorm_id         TEXT,
  active_brainstorm_version    INTEGER,
  finalized_brainstorm_version INTEGER,
  finalized_input_hash         TEXT,
  updated_at                   INTEGER NOT NULL,
  PRIMARY KEY (project_id, thread_id)
);

CREATE TABLE IF NOT EXISTS brainstorm_versions (
  brainstorm_id TEXT NOT NULL,
  version       INTEGER NOT NULL,
  project_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK(status IN ('draft','finalized','superseded')),
  data          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (brainstorm_id, version)
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_versions_thread
  ON brainstorm_versions(project_id, thread_id);

-- ─── Spec Workflow ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spec_workflow (
  project_id           TEXT NOT NULL,
  thread_id            TEXT NOT NULL,
  stage                TEXT NOT NULL CHECK(stage IN ('spec_drafting','spec_review','spec_approved')),
  active_spec_id       TEXT,
  active_spec_version  INTEGER,
  approved_spec_version INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (project_id, thread_id)
);

-- ─── Spec Versions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spec_versions (
  spec_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (spec_id, version)
);

CREATE INDEX IF NOT EXISTS idx_spec_versions_thread
  ON spec_versions(project_id, thread_id);

-- ─── Scope Boards ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scope_boards (
  project_id TEXT PRIMARY KEY NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─── Plans ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  thread_id   TEXT PRIMARY KEY NOT NULL,
  content     TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  approved_at INTEGER
);

-- ─── Checklists ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checklists (
  thread_id  TEXT PRIMARY KEY NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ─── Audit Reports ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_reports (
  report_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  spec_id    TEXT,
  spec_version INTEGER,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, version)
);

CREATE INDEX IF NOT EXISTS idx_audit_reports_thread
  ON audit_reports(project_id, thread_id, version DESC);

-- ─── Turn Checkpoints ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS turn_checkpoints (
  turn_id    TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_thread ON turn_checkpoints(project_id, thread_id);

-- ─── Active Turns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_turns (
  project_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  turn_id    TEXT,
  PRIMARY KEY (project_id, thread_id)
);

-- ─── Assignment Plans ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignment_versions (
  assignment_id        TEXT NOT NULL,
  version              INTEGER NOT NULL,
  project_id           TEXT NOT NULL,
  coordinator_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  spec_id              TEXT NOT NULL,
  spec_version         INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed','stopped')),
  data                 TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, version)
);

CREATE INDEX IF NOT EXISTS idx_assignment_versions_coordinator
  ON assignment_versions(project_id, coordinator_thread_id);

CREATE TABLE IF NOT EXISTS assignment_workflow (
  project_id            TEXT NOT NULL,
  coordinator_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  assignment_id         TEXT NOT NULL,
  active_version        INTEGER NOT NULL,
  approved_version      INTEGER,
  status                TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed','stopped')),
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (project_id, coordinator_thread_id)
);

CREATE TABLE IF NOT EXISTS assignment_operations (
  operation_id  TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  result        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assignment_operations_assignment
  ON assignment_operations(assignment_id);

CREATE TABLE IF NOT EXISTS assignment_coordinator_snapshots (
  assignment_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, snapshot_hash)
);

-- Durable capability tokens for the in-process Assignment API. Tokens and the
-- bound port survive app restarts so in-flight worker/coordinator harness
-- sessions that rehydrate keep a valid base URL + bearer token instead of being
-- orphaned the moment the main process restarts.
CREATE TABLE IF NOT EXISTS assignment_api_capabilities (
  token         TEXT PRIMARY KEY NOT NULL,
  role          TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  task_id       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assignment_capabilities_assignment
  ON assignment_api_capabilities(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_capabilities_thread
  ON assignment_api_capabilities(thread_id);` + REMOTE_DEVICE_SQL

export const PERSISTENCE_SQL = `
-- ─── Provider sync cursors ────────────────────────────────────────────────
-- Per (thread, harness session) transcript watermark so provider transcript
-- synchronization appends only new deltas instead of rewriting the full
-- mirrored history on every idle sync. Keyed on the thread's current harness
-- session; changing sessions starts a fresh cursor.
CREATE TABLE IF NOT EXISTS provider_sync_cursors (
  thread_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT NOT NULL DEFAULT '',
  synced_at       INTEGER NOT NULL,
  PRIMARY KEY (thread_id, session_id)
);

-- ─── Maintenance bookkeeping ───────────────────────────────────────────────
-- Last-run timestamps and health probes written by the maintenance worker.
CREATE TABLE IF NOT EXISTS maintenance_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);`

export const HARNESS_USAGE_SQL = `
-- ─── Harness Usage Analytics ────────────────────────────────────────────
-- Cumulative per-harness analytics for a thread's session. Rows are upserted
-- by reconciling against agent_messages whenever a thread's messages change,
-- so the table always mirrors persisted usage without double counting.
CREATE TABLE IF NOT EXISTS harness_usage (
  project_id           TEXT NOT NULL,
  thread_id            TEXT NOT NULL,
  harness_id           TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  model_id             TEXT,
  thinking_level       TEXT,
  message_count        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  tokens_in            INTEGER NOT NULL DEFAULT 0,
  tokens_out           INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write   INTEGER NOT NULL DEFAULT 0,
  tokens_total         INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER NOT NULL DEFAULT 0,
  first_used_at        INTEGER NOT NULL,
  last_used_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, thread_id, harness_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_usage_thread
  ON harness_usage(thread_id, last_used_at DESC, harness_id);

CREATE INDEX IF NOT EXISTS idx_harness_usage_harness
  ON harness_usage(harness_id);

-- Idempotency ledger: which agent_messages have already been accumulated into
-- harness_usage. Rows cascade-delete with their thread, so per-thread usage is
-- never double counted even across retries, compaction, or restart.
CREATE TABLE IF NOT EXISTS harness_usage_messages (
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_usage_messages_thread
  ON harness_usage_messages(thread_id);

-- Per-model cost breakdown for each (thread, harness, provider, thinking level).
-- One row per model+thinking-level a harness used on a thread, with cumulative
-- cost/tokens/duration so the battery popover (and the usage settings page) can
-- show what each model consumed at each reasoning effort. Rows cascade-delete
-- with their thread.
CREATE TABLE IF NOT EXISTS harness_usage_models (${HARNESS_USAGE_MODELS_COLUMNS_SQL});

CREATE INDEX IF NOT EXISTS idx_harness_usage_models_thread
  ON harness_usage_models(thread_id);

CREATE INDEX IF NOT EXISTS idx_harness_usage_models_harness
  ON harness_usage_models(harness_id);

-- Event-level source of truth for model and utility usage. Every nullable token
-- category means "not reported" rather than zero. The caller-provided
-- feature_call_id separates distinct calls of the same feature, while attempt
-- keeps legitimate retries distinct and makes replayed writes idempotent.
CREATE TABLE IF NOT EXISTS usage_events (
  id                    TEXT PRIMARY KEY NOT NULL,
  thread_id             TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_turn_id        TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  feature_call_id       TEXT NOT NULL,
  attempt               INTEGER NOT NULL CHECK(attempt >= 1),
  feature               TEXT NOT NULL CHECK(feature IN ('main','title','memory','image_descriptor','computer_use','web','audit','assignment')),
  harness_id            TEXT,
  provider_id           TEXT,
  model_id              TEXT,
  thinking_level        TEXT,
  utility_id            TEXT,
  raw_provider_usage_json TEXT NOT NULL DEFAULT '{}',
  tokens_uncached_input INTEGER CHECK(tokens_uncached_input IS NULL OR tokens_uncached_input >= 0),
  tokens_cached_input   INTEGER CHECK(tokens_cached_input IS NULL OR tokens_cached_input >= 0),
  tokens_cache_write    INTEGER CHECK(tokens_cache_write IS NULL OR tokens_cache_write >= 0),
  tokens_output         INTEGER CHECK(tokens_output IS NULL OR tokens_output >= 0),
  tokens_reasoning      INTEGER CHECK(tokens_reasoning IS NULL OR tokens_reasoning >= 0),
  raw_total             INTEGER CHECK(raw_total IS NULL OR raw_total >= 0),
  total_semantics       TEXT NOT NULL CHECK(total_semantics IN ('includes_cache','excludes_cache','categories_may_overlap','provider_defined','unavailable')),
  cost_usd              REAL,
  cost_status           TEXT NOT NULL CHECK(cost_status IN ('known','estimated','unavailable')),
  pricing_provenance_json TEXT,
  tool_fee_usd          REAL CHECK(tool_fee_usd IS NULL OR tool_fee_usd >= 0),
  success               INTEGER NOT NULL CHECK(success IN (0, 1)),
  retry_cause           TEXT,
  created_at            INTEGER NOT NULL,
  CHECK(
    (cost_status = 'unavailable' AND cost_usd IS NULL AND pricing_provenance_json IS NULL)
    OR
    (cost_status IN ('known','estimated') AND cost_usd IS NOT NULL AND cost_usd >= 0 AND pricing_provenance_json IS NOT NULL)
  ),
  UNIQUE (parent_turn_id, feature, feature_call_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_thread
  ON usage_events(thread_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_usage_events_parent_turn
  ON usage_events(parent_turn_id, feature, created_at);

-- Profile utility-usage and efficiency-KPI scans filter feature + created_at.
CREATE INDEX IF NOT EXISTS idx_usage_events_feature_timestamp
  ON usage_events(feature, created_at);

-- ─── Turn outcome feedback (session scoring) ─────────────────────────────
-- One row per completed user turn, opened "pending" when a successful turn
-- finishes and resolved when the user signals the outcome: they continued
-- positively, corrected the answer, switched away to another thread, or left
-- the thread idle until cleanup. Scores (0/1) feed the "best model by
-- feedback" profile section, keyed by harness/provider/model/thinking level
-- and the task kind (main/audit/assignment).
CREATE TABLE IF NOT EXISTS turn_feedback (${TURN_FEEDBACK_COLUMNS_SQL});

CREATE INDEX IF NOT EXISTS idx_turn_feedback_thread
  ON turn_feedback(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_turn_feedback_pending
  ON turn_feedback(status, created_at);

CREATE INDEX IF NOT EXISTS idx_turn_feedback_attribution
  ON turn_feedback(harness_id, provider_id, model_id, thinking_level, feature);`

/** Canonical fresh-install schema. There are no historical migrations. */
export const DATABASE_SCHEMA_SQL = [
  SCHEMA_SQL,
  PROJECT_FTS_SQL,
  THREADS_SQL,
  HISTORY_SQL,
  HISTORY_FTS_SQL,
  AGENT_MESSAGES_SQL,
  ATTACHMENT_GRANTS_SQL,
  AGENT_MESSAGES_FTS_SQL,
  AGENT_MESSAGES_FTS_TRIGGERS_SQL,
  MISC_TABLES_SQL,
  PERSISTENCE_SQL,
  HARNESS_USAGE_SQL
].join('\n')
