import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 14: the thread's context checkpoints.
 *
 * One row per harness session that ended at a checkpoint — the app-owned
 * replacement for harness compaction. The row keeps the session id, the boundary
 * message, and the context the closed session had consumed, so the next session
 * can name the windows before it and the app can show what happened without
 * reading a harness transcript.
 *
 * `threads.session_id` keeps pointing at the running session; this table only
 * ever describes sessions that have closed.
 *
 * Idempotent: `IF NOT EXISTS`, so a rerun writes nothing.
 */
export const versionFourteenMigration: DatabaseMigration = {
  version: 14,
  summary: 'record thread context checkpoints',
  apply(connection: DatabaseType): void {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS thread_checkpoints (
        id                   TEXT PRIMARY KEY NOT NULL,
        thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sequence             INTEGER NOT NULL,
        kind                 TEXT NOT NULL,
        harness_id           TEXT NOT NULL,
        provider_id          TEXT,
        model_id             TEXT,
        account_id           TEXT,
        session_id           TEXT NOT NULL,
        next_session_id      TEXT,
        project_path         TEXT NOT NULL DEFAULT '',
        boundary_message_id  TEXT,
        boundary_created_at  INTEGER,
        tokens_before        INTEGER,
        context_window       INTEGER,
        parent_thread_id     TEXT,
        label                TEXT,
        created_at           INTEGER NOT NULL,
        closed_at            INTEGER,
        UNIQUE (thread_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_checkpoints_thread
        ON thread_checkpoints(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_thread_checkpoints_session
        ON thread_checkpoints(session_id);
    `)
  }
}
