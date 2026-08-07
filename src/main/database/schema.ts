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

CREATE TRIGGER IF NOT EXISTS project_fts_update AFTER UPDATE ON projects BEGIN
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

CREATE TRIGGER IF NOT EXISTS history_fts_update AFTER UPDATE ON history_entries BEGIN
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

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_update AFTER UPDATE ON agent_messages BEGIN
  INSERT INTO agent_messages_fts(agent_messages_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
  INSERT INTO agent_messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;`

export const MISC_TABLES_SQL = `
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
  status               TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed')),
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
  status                TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed')),
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
);`
