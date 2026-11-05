import { describe, expect, it } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { DATABASE_SCHEMA_SQL, DATABASE_SCHEMA_VERSION } from '../../../src/main/database/schema'
import { applyDatabaseSchema } from '../../../src/main/database/migrations/schema-upgrade'

/**
 * The version-6 upgrade is additive and backfill-free.
 *
 * A database written before bound assistant tasks has no binding, no run base
 * and no dispatch origin, and it has to keep working exactly as it did: the
 * upgrade adds columns, and every existing row reads back unbound. This test
 * builds a version-5 file by taking the current snapshot and removing the
 * version-6 columns, which is the only shape an older install can have.
 */

const AT_VERSION_FIVE = 5

describe('version 6 schema upgrade', () => {
  it('adds the bound-scope, run-base, dispatch-origin and park-reason columns', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(DATABASE_SCHEMA_SQL)
    db.exec(`
      ALTER TABLE threads DROP COLUMN bound_scope_project_id;
      ALTER TABLE threads DROP COLUMN bound_scope_scope_id;
      ALTER TABLE threads DROP COLUMN bound_scope_home_project_id;
      ALTER TABLE threads DROP COLUMN run_base;
      ALTER TABLE threads DROP COLUMN dispatch_origin;
      ALTER TABLE threads DROP COLUMN park_reason;
    `)
    db.prepare("INSERT OR REPLACE INTO db_meta(key, value) VALUES('schema_version', ?)").run(
      String(AT_VERSION_FIVE)
    )
    db.exec(`
      INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
        VALUES ('project1', 'Project', '', 'local', 'pi', 'default', 1, 1);
      INSERT INTO threads(id, project_id, provider_id, title, created_at, updated_at, last_activity)
        VALUES ('thread1', 'project1', 'pi', 'An old thread', 1, 1, 1);
    `)

    const result = applyDatabaseSchema(db)

    expect(result.appliedVersions).toContain(6)
    expect(DATABASE_SCHEMA_VERSION).toBe(7)
    const row = db
      .prepare(
        `SELECT bound_scope_project_id, bound_scope_scope_id, bound_scope_home_project_id,
                run_base, dispatch_origin, park_reason
           FROM threads WHERE id = 'thread1'`
      )
      .get() as Record<string, unknown>
    // Nothing was backfilled, so an older thread stays unbound and unbased.
    expect(row['bound_scope_project_id']).toBeNull()
    expect(row['bound_scope_scope_id']).toBeNull()
    expect(row['bound_scope_home_project_id']).toBeNull()
    expect(row['run_base']).toBeNull()
    expect(row['dispatch_origin']).toBeNull()
    expect(row['park_reason']).toBeNull()
    db.close()
  })

  it('keeps an upgraded database from re-running the upgrade', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(DATABASE_SCHEMA_SQL)
    db.exec(`
      ALTER TABLE threads DROP COLUMN bound_scope_project_id;
      ALTER TABLE threads DROP COLUMN bound_scope_scope_id;
      ALTER TABLE threads DROP COLUMN bound_scope_home_project_id;
      ALTER TABLE threads DROP COLUMN run_base;
      ALTER TABLE threads DROP COLUMN dispatch_origin;
      ALTER TABLE threads DROP COLUMN park_reason;
    `)
    db.prepare("INSERT OR REPLACE INTO db_meta(key, value) VALUES('schema_version', ?)").run(
      String(AT_VERSION_FIVE)
    )
    const first = applyDatabaseSchema(db)
    const second = applyDatabaseSchema(db)
    // The chain runs every file above the stored version, so a version-5 file
    // also passes through the later data backfills that shipped after it.
    expect(first.appliedVersions).toEqual([6, 7])
    expect(second.appliedVersions).toEqual([])
    db.close()
  })
})
