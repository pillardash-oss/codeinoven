/**
 * The versioned migration chain, in one import path.
 *
 * One file per schema version under this folder (`v002.ts`, `v003.ts`, ...),
 * plus this runner. `database.ts` reaches the chain through
 * `applyDatabaseSchema` and `runLedgerMigrations` only: no migration lives in
 * the database class, and keeping a version current means bumping
 * `DATABASE_SCHEMA_VERSION` in `schema.ts` and adding the next numbered file.
 *
 * Deleting history is deleting a file: once no supported database sits below a
 * version, its file stops shipping and the oldest remaining file becomes the
 * catch-all for anything older. That is the whole point of numbering the files
 * by version instead of by change.
 */
export type { DatabaseMigration, LedgerMigrationHost, LedgerStatement } from './migration'
export {
  DATABASE_MIGRATIONS,
  applyDatabaseSchema,
  runLedgerMigrations,
  type SchemaUpgradeResult
} from './schema-upgrade'
