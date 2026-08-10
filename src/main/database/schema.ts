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
 *   db_meta         — Internal metadata (migration version, etc.)
 */

export const SCHEMA_SQL = `
-- ─── Metadata ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS db_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

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
);`

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

CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_last_activity ON threads(last_activity);
CREATE INDEX IF NOT EXISTS idx_threads_pinned ON threads(pinned);`

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
  references_json TEXT,
  project_references_json TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  cost            REAL,
  tokens_json     TEXT,
  rate_limits_json TEXT,
  usage_credits_json TEXT,
  context_window  INTEGER,
  context_used    INTEGER,
  error           TEXT,
  structured_output TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_id ON agent_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id ON agent_messages(session_id);`

export const AGENT_MESSAGES_FTS_SQL = `
-- ─── Agent Messages FTS5 ────────────────────────────────────────────────
-- External-content FTS index over agent_messages.search_text (plain text
-- extracted from conversation parts in the main process). Only conversation
-- rows (session_id IS NULL, visibility='conversation') are surfaced by the
-- search query so user messages and the agent's final output match threads.
-- The sync triggers live in AGENT_MESSAGES_FTS_TRIGGERS_SQL so a legacy
-- database can backfill + rebuild before the triggers exist.
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
);` + REMOTE_DEVICE_SQL

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
);

-- Archive is not a product state. Remove legacy retained copies; bounded
-- maintenance permanently deletes expired rows instead.
DROP TABLE IF EXISTS retention_archive;`

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
  ON harness_usage(project_id, thread_id);

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

-- Per-model cost breakdown for each (thread, harness, provider). One row per
-- model a harness used on a thread, with cumulative cost/tokens/duration so the
-- battery popover (and a future usage settings page) can show what each model
-- consumed. Rows cascade-delete with their thread.
CREATE TABLE IF NOT EXISTS harness_usage_models (
  thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  harness_id           TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  model_id             TEXT NOT NULL,
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
  PRIMARY KEY (thread_id, harness_id, provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_usage_models_thread
  ON harness_usage_models(thread_id);

CREATE INDEX IF NOT EXISTS idx_harness_usage_models_harness
  ON harness_usage_models(harness_id);`
