import type { Database as DatabaseType } from 'better-sqlite3'
import { Logger } from '../../system/logger'
import {
  DATABASE_SCHEMA_SQL,
  DATABASE_SCHEMA_SNAPSHOT_INDEXES_SQL,
  DATABASE_SCHEMA_VERSION
} from '../schema'
import type { DatabaseMigration, LedgerMigrationHost } from './migration'
import { versionTwoMigration } from './v002'
import { versionThreeMigration } from './v003'
import { versionFourMigration } from './v004'

/**
 * Every migration this build ships, one file per schema version, ascending.
 *
 * A migration only runs when the database's stored version is below its own, so
 * a database that is already current runs none of them, and a database two
 * versions behind runs exactly the two files above it. `v002.ts` is the
 * catch-all for everything written before the version gate, which is why no
 * `v001.ts` exists: version 1 was stamped by the old schema snapshot itself,
 * and a database carrying it needs the whole version-2 chain.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  versionTwoMigration,
  versionThreeMigration,
  versionFourMigration
]

/**
 * The highest version any file produces. It has to equal the version of the
 * schema snapshot, because the snapshot is what a fresh install gets instead of
 * the chain: a bump without a file would stamp a version nothing can produce,
 * and a file without a bump would never run for a fresh database. Failing here
 * keeps the two halves from drifting apart silently.
 */
const LATEST_MIGRATION_VERSION = DATABASE_MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0
)
if (LATEST_MIGRATION_VERSION !== DATABASE_SCHEMA_VERSION) {
  throw new Error(
    `Schema version drift: migrations reach v${LATEST_MIGRATION_VERSION} but ` +
      `DATABASE_SCHEMA_VERSION is ${DATABASE_SCHEMA_VERSION}. Add the missing ` +
      `migrations/v${String(DATABASE_SCHEMA_VERSION).padStart(3, '0')}.ts or fix the constant.`
  )
}

/** What one schema-apply call did, so the caller knows what still has to run. */
export interface SchemaUpgradeResult {
  /** Versions applied by this call, ascending. Empty when the file was current. */
  appliedVersions: number[]
  /** Migrations whose worker-backed ledger rebuild has to run after this call. */
  ledgerMigrations: DatabaseMigration[]
}

/**
 * The schema version stored in `db_meta`, or `null` when the file is a fresh
 * install.
 *
 * Three answers, and they are deliberately distinct:
 *
 * - `null`: no tables at all, so `DATABASE_SCHEMA_SQL` creates the whole schema
 *   once and no migration ever runs on a first launch.
 * - `0`: the file has tables but no version stamp (written before the gate, or
 *   its row was lost), so the catch-all migration runs.
 * - a number: the version that file was stamped at.
 */
function readSchemaVersion(connection: DatabaseType): number | null {
  const hasMetaTable = connection
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'")
    .get() as { present?: number } | undefined
  if (!hasMetaTable) {
    const existing = connection
      .prepare(
        "SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { total?: number } | undefined
    return (existing?.total ?? 0) > 0 ? 0 : null
  }
  const row = connection.prepare("SELECT value FROM db_meta WHERE key = 'schema_version'").get() as
    { value?: string } | undefined
  const parsed = Number.parseInt(row?.value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Stamp the schema version a migration just guaranteed. */
function writeSchemaVersion(connection: DatabaseType, version: number): void {
  connection
    .prepare("INSERT OR REPLACE INTO db_meta(key, value) VALUES('schema_version', ?)")
    .run(String(version))
}

/**
 * Create or upgrade the schema, and report what still has to run.
 *
 * A fresh install executes the snapshot once, which already describes the
 * current version, and stamps it: it never walks a chain of `ALTER TABLE` steps
 * for a database it just created. Any other database runs the files whose
 * version is above its own, in order, each in its own transaction and each
 * stamped as it completes. A database at or above the current version does
 * nothing at all, not even a `PRAGMA table_info`.
 */
export function applyDatabaseSchema(connection: DatabaseType): SchemaUpgradeResult {
  const storedVersion = readSchemaVersion(connection)

  if (storedVersion === null) {
    connection.transaction(() => {
      connection.exec(DATABASE_SCHEMA_SQL)
      connection.exec(DATABASE_SCHEMA_SNAPSHOT_INDEXES_SQL)
      writeSchemaVersion(connection, DATABASE_SCHEMA_VERSION)
    })()
    Logger.info('Database schema created', { version: DATABASE_SCHEMA_VERSION })
    // The snapshot is current by construction, but its worker-backed steps still
    // run so a fresh file and a migrated one are the same file feature for
    // feature, including the ledger's own indexes.
    return { appliedVersions: [], ledgerMigrations: withLedgerSteps(DATABASE_MIGRATIONS) }
  }

  if (storedVersion >= DATABASE_SCHEMA_VERSION) return { appliedVersions: [], ledgerMigrations: [] }

  const pending = DATABASE_MIGRATIONS.filter((migration) => migration.version > storedVersion)
  const appliedVersions: number[] = []
  for (const migration of pending) {
    connection.transaction(() => migration.apply(connection))()
    writeSchemaVersion(connection, migration.version)
    appliedVersions.push(migration.version)
    Logger.info('Database schema migrated', {
      version: migration.version,
      summary: migration.summary
    })
  }
  Logger.info('Database schema upgraded', {
    fromVersion: storedVersion,
    toVersion: DATABASE_SCHEMA_VERSION
  })
  return { appliedVersions, ledgerMigrations: withLedgerSteps(pending) }
}

/** Run the worker-backed steps of the migrations an upgrade just applied. */
export async function runLedgerMigrations(
  migrations: readonly DatabaseMigration[],
  host: LedgerMigrationHost,
  connection: DatabaseType
): Promise<void> {
  for (const migration of migrations) {
    if (!migration.applyLedger) continue
    await migration.applyLedger(host, connection)
  }
}

function withLedgerSteps(migrations: readonly DatabaseMigration[]): DatabaseMigration[] {
  return migrations.filter((migration) => migration.applyLedger !== undefined)
}
