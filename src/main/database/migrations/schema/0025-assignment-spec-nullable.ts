import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'

/**
 * Databases created before spec-less Assignments carry
 * `assignment_versions.spec_id TEXT NOT NULL` / `spec_version INTEGER NOT NULL`.
 * SQLite cannot relax a NOT NULL constraint in place, so the table is rebuilt
 * once with the same columns and rows but nullable spec columns. The `data`
 * blob is the authoritative plan, so nothing needs to be recomputed. Idempotent:
 * a table whose `spec_id` is already nullable is left untouched.
 */
export const assignmentSpecNullableMigration: SchemaMigration = {
  id: '0025-assignment-spec-nullable',
  summary: 'assignment versions accept a version that was authored without a spec',
  apply(connection: DatabaseType): void {
    const specIdColumn = (
      connection.prepare('PRAGMA table_info(assignment_versions)').all() as Array<{
        name: string
        notnull: number
      }>
    ).find((column) => column.name === 'spec_id')
    if (!specIdColumn || specIdColumn.notnull === 0) return
    connection.exec(`
      CREATE TABLE assignment_versions_spec_nullable (
        assignment_id        TEXT NOT NULL,
        version              INTEGER NOT NULL,
        project_id           TEXT NOT NULL,
        coordinator_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        spec_id              TEXT,
        spec_version         INTEGER,
        status               TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed','stopped')),
        data                 TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (assignment_id, version)
      );
      INSERT INTO assignment_versions_spec_nullable(
        assignment_id, version, project_id, coordinator_thread_id,
        spec_id, spec_version, status, data, created_at, updated_at
      )
      SELECT
        assignment_id, version, project_id, coordinator_thread_id,
        spec_id, spec_version, status, data, created_at, updated_at
      FROM assignment_versions;
      DROP TABLE assignment_versions;
      ALTER TABLE assignment_versions_spec_nullable RENAME TO assignment_versions;
      CREATE INDEX IF NOT EXISTS idx_assignment_versions_coordinator
        ON assignment_versions(project_id, coordinator_thread_id);
    `)
  }
}
