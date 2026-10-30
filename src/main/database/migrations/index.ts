/**
 * Every schema and ledger migration this build ships, in one import path.
 *
 * `database.ts` reaches the schema through `applyDatabaseSchema` and
 * `runLedgerMigrations` only: no migration lives in the database class, and a
 * new one is a new file under `migrations/schema/` or `migrations/ledger/`
 * plus its entry in the ordered chain in `schema-upgrade.ts`.
 */
export type {
  LedgerMigration,
  LedgerMigrationHost,
  LedgerStatement,
  SchemaMigration
} from './migration'
export {
  DATABASE_LEDGER_MIGRATIONS,
  DATABASE_SCHEMA_MIGRATIONS,
  applyDatabaseSchema,
  runLedgerMigrations
} from './schema-upgrade'
