import type { Database as DatabaseType } from 'better-sqlite3'

/** A single statement handed to the maintenance worker as part of a rebuild. */
export interface LedgerStatement {
  sql: string
  params: unknown[]
}

/**
 * The worker-backed connection a ledger rebuild rows through.
 *
 * A rebuild rewrites a whole table, so it must never run on the main thread:
 * the same statements are sent to the maintenance worker's connection,
 * serialized with every other worker request.
 */
export interface LedgerMigrationHost {
  execute(sql: string, params: unknown[]): Promise<{ ok: boolean; error?: string }>
  transaction(statements: LedgerStatement[]): Promise<{ ok: boolean; error?: string }>
}

/**
 * One schema version, in one file.
 *
 * The file number is the version it produces: `v004.ts` moves a database from
 * version 3 to version 4. `apply` holds every schema step that version needs,
 * and the runner stamps the version only after the whole file succeeded, so a
 * failure leaves the database at the last complete version.
 *
 * Because a version is a file and nothing else, an old version is deleted by
 * deleting one file: once no supported database sits below it, that whole step
 * of history stops shipping. The lowest-numbered file has to stay a catch-all
 * for anything below it, which is why `v002.ts` holds every pre-version-gate
 * step rather than only the ones that changed that day.
 */
export interface DatabaseMigration {
  /** The schema version this migration produces, matching the file name. */
  readonly version: number
  /** One line on what this version does, for logs. */
  readonly summary: string
  /** Every schema step of this version. Runs in one transaction, on the primary connection. */
  apply(connection: DatabaseType): void
  /**
   * Worker-backed steps of this version: table rebuilds that are too heavy to
   * run on the main thread. Runs after the schema transaction committed, so the
   * version is already stamped if one of them fails.
   */
  applyLedger?(host: LedgerMigrationHost, connection: DatabaseType): Promise<void>
}
