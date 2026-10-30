import type { Database as DatabaseType } from 'better-sqlite3'

/**
 * One schema migration: a single compatibility step applied to a database
 * written by an older build.
 *
 * Every migration owns its own file under `migrations/schema/`, is named after
 * the change it makes, and is idempotent: a second pass over a database that
 * already carries the change is a no-op. The `id` is what the ordered chain in
 * `migrations/schema-upgrade.ts` refers to and what a failure reports.
 */
export interface SchemaMigration {
  /** Stable identifier, equal to the file's numeric prefix and concern. */
  readonly id: string
  /** One line on the state this migration moves a database out of. */
  readonly summary: string
  /** Apply the step in place. Runs inside the schema-upgrade transaction. */
  apply(connection: DatabaseType): void
}

/** A single statement handed to the maintenance worker as part of a rebuild. */
export interface LedgerStatement {
  sql: string
  params: unknown[]
}

/**
 * The worker-backed connection a ledger migration rebuilds through.
 *
 * A ledger rebuild rewrites a whole table, so it must never run on the main
 * thread: the same statements are sent to the maintenance worker's connection,
 * serialized with every other worker request.
 */
export interface LedgerMigrationHost {
  execute(sql: string, params: unknown[]): Promise<{ ok: boolean; error?: string }>
  transaction(statements: LedgerStatement[]): Promise<{ ok: boolean; error?: string }>
}

/**
 * One ledger migration: a rebuild of the usage ledger that runs after the
 * schema upgrade, on the worker, and is awaited by `Database.init` because the
 * app must not record usage against a table it is still rebuilding.
 */
export interface LedgerMigration {
  readonly id: string
  readonly summary: string
  apply(host: LedgerMigrationHost, connection: DatabaseType): Promise<void>
}
