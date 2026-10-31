import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 4: the dispatch ledger behind the orchestrator board.
 *
 * A workstation-control turn starts real threads in other projects, and the
 * board that lists them has to survive a restart, so each dispatch is written
 * down here at the moment it is accepted. The step is one `CREATE TABLE IF NOT
 * EXISTS` pair, which makes it safe to re-run: a database that already created
 * the table keeps it exactly as it is.
 */
export const versionFourMigration: DatabaseMigration = {
  version: 4,
  summary: 'the orchestration dispatch ledger is created',
  apply(connection: DatabaseType): void {
    connection.exec(`
CREATE TABLE IF NOT EXISTS orchestration_dispatches (
  child_project_id     TEXT NOT NULL,
  child_thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  initiator_project_id TEXT NOT NULL,
  initiator_thread_id  TEXT NOT NULL,
  title                TEXT NOT NULL,
  oven_id              TEXT NOT NULL,
  oven_name            TEXT NOT NULL,
  harness_id           TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  thinking_level       TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (child_project_id, child_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_orchestration_dispatches_initiator
  ON orchestration_dispatches(initiator_project_id, initiator_thread_id);
`)
  }
}
