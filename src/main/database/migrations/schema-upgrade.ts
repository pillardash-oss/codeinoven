import type { Database as DatabaseType } from 'better-sqlite3'
import { Logger } from '../../system/logger'
import {
  DATABASE_SCHEMA_SQL,
  DATABASE_SCHEMA_SNAPSHOT_INDEXES_SQL,
  DATABASE_SCHEMA_VERSION
} from '../schema'
import type { LedgerMigration, LedgerMigrationHost, SchemaMigration } from './migration'
import { assistantVocabularyMigration } from './schema/0001-assistant-vocabulary'
import { modelRankingTablesMigration } from './schema/0002-model-ranking-tables'
import { modelRankingCostPlausibilityMigration } from './schema/0003-model-ranking-cost-plausibility'
import { modelRankingSnapshotClaimTokenMigration } from './schema/0004-model-ranking-snapshot-claim-token'
import { modelRankingSnapshotAnchorMessageMigration } from './schema/0005-model-ranking-snapshot-anchor-message'
import { modelRankingSnapshotUndoneAtMigration } from './schema/0006-model-ranking-snapshot-undone-at'
import { engineeringLifecycleColumnsMigration } from './schema/0007-engineering-lifecycle-columns'
import { usageEventColumnsMigration } from './schema/0008-usage-event-columns'
import { threadIndependentAuditColumnsMigration } from './schema/0009-thread-independent-audit-columns'
import { threadEngineeringColumnMigration } from './schema/0010-thread-engineering-column'
import { threadAccountColumnMigration } from './schema/0011-thread-account-column'
import { threadDraftColumnsMigration } from './schema/0012-thread-draft-columns'
import { threadBookmarkColumnMigration } from './schema/0013-thread-bookmark-column'
import { threadAssistantColumnsMigration } from './schema/0014-thread-assistant-columns'
import { threadFailureColumnsMigration } from './schema/0015-thread-failure-columns'
import { agentMessageGenerationColumnMigration } from './schema/0016-agent-message-generation-column'
import { agentMessageAccountColumnsMigration } from './schema/0017-agent-message-account-columns'
import { agentMessageOvenColumnMigration } from './schema/0018-agent-message-oven-column'
import { agentMessageOvenLabelColumnMigration } from './schema/0019-agent-message-oven-label-column'
import { agentMessageOvenAppearanceColumnMigration } from './schema/0020-agent-message-oven-appearance-column'
import { agentMessageContextEstimatedColumnMigration } from './schema/0021-agent-message-context-estimated-column'
import { agentMessageNormalizedUsageColumnMigration } from './schema/0022-agent-message-normalized-usage-column'
import { activeTurnOwnerColumnMigration } from './schema/0023-active-turn-owner-column'
import { threadSettingsLegacyEngineeringFlagMigration } from './schema/0024-thread-settings-legacy-engineering-flag'
import { assignmentSpecNullableMigration } from './schema/0025-assignment-spec-nullable'
import { threadPinnedAtMigration } from './schema/0026-thread-pinned-at'
import { assistantPinnedMigration } from './schema/0027-assistant-pinned'
import { assistantAgentsAndPauseMigration } from './schema/0028-assistant-agents-and-pause'
import { assistantIdentityColumnsMigration } from './schema/0029-assistant-identity-columns'
import { repairCollapsedAssistantPersonalityMigration } from './schema/0030-repair-collapsed-assistant-personality'
import { assistantDescriptionMigration } from './schema/0031-assistant-description'
import { assistantReportingMigration } from './schema/0032-assistant-reporting'
import { customSvgIconsMigration } from './schema/0033-custom-svg-icons'
import { projectOvenColumnMigration } from './schema/0034-project-oven-column'
import { stickyNoteImagePathMigration } from './schema/0035-sticky-note-image-path'
import { stickyNoteSortOrderMigration } from './schema/0036-sticky-note-sort-order'
import { customIconLibraryMigration } from './schema/0037-custom-icon-library'
import { assistantScheduleAnchorMigration } from './schema/0038-assistant-schedule-anchor'
import { assistantExecutionMigration } from './schema/0039-assistant-execution'
import { assistantScheduledMigration } from './schema/0040-assistant-scheduled'
import { threadDesignKindMigration } from './schema/0041-thread-design-kind'
import { threadAuthoredWorkKindMigration } from './schema/0042-thread-authored-work-kind'
import { threadAuthoredWorkKindsMigration } from './schema/0043-thread-authored-work-kinds'
import { designRevisionMetadataMigration } from './schema/0044-design-revision-metadata'
import { settledAuditThreadStatusMigration } from './schema/0045-settled-audit-thread-status'
import { unpricedUsageCostsMigration } from './schema/0046-unpriced-usage-costs'
import { independentUsageLedgerMigration } from './ledger/0001-independent-usage-ledger'
import { usageEventFeaturesMigration } from './ledger/0002-usage-event-features'

/**
 * One position in the legacy upgrade chain: either a single migration, or the
 * canonical schema snapshot.
 *
 * The snapshot is a step of its own because it lands in the middle of the
 * chain: the vocabulary rename and the ranking fold have to happen before it
 * (otherwise `CREATE TABLE IF NOT EXISTS` creates tables those steps can no
 * longer rewrite), and every column step after it needs the tables it creates.
 */
type UpgradeStep =
  | { readonly kind: 'migration'; readonly migration: SchemaMigration }
  | {
      readonly kind: 'snapshot'
    }

/**
 * Every schema step a database written by an older build still needs, in order.
 *
 * Order is part of the contract and is not alphabetical. Each entry owns one
 * file under `migrations/schema/` and is idempotent, so a database whose stored
 * version is behind can be walked through the whole chain without a step
 * having to know whether an earlier one ran.
 */
const UPGRADE_STEPS: readonly UpgradeStep[] = [
  { kind: 'migration', migration: assistantVocabularyMigration },
  { kind: 'migration', migration: modelRankingTablesMigration },
  { kind: 'snapshot' },
  { kind: 'migration', migration: modelRankingCostPlausibilityMigration },
  { kind: 'migration', migration: modelRankingSnapshotClaimTokenMigration },
  { kind: 'migration', migration: modelRankingSnapshotAnchorMessageMigration },
  { kind: 'migration', migration: modelRankingSnapshotUndoneAtMigration },
  { kind: 'migration', migration: engineeringLifecycleColumnsMigration },
  { kind: 'migration', migration: usageEventColumnsMigration },
  { kind: 'migration', migration: threadIndependentAuditColumnsMigration },
  { kind: 'migration', migration: threadEngineeringColumnMigration },
  { kind: 'migration', migration: threadAccountColumnMigration },
  { kind: 'migration', migration: threadDraftColumnsMigration },
  { kind: 'migration', migration: threadBookmarkColumnMigration },
  { kind: 'migration', migration: threadAssistantColumnsMigration },
  { kind: 'migration', migration: threadFailureColumnsMigration },
  { kind: 'migration', migration: agentMessageGenerationColumnMigration },
  { kind: 'migration', migration: agentMessageAccountColumnsMigration },
  { kind: 'migration', migration: agentMessageOvenColumnMigration },
  { kind: 'migration', migration: agentMessageOvenLabelColumnMigration },
  { kind: 'migration', migration: agentMessageOvenAppearanceColumnMigration },
  { kind: 'migration', migration: agentMessageContextEstimatedColumnMigration },
  { kind: 'migration', migration: agentMessageNormalizedUsageColumnMigration },
  { kind: 'migration', migration: activeTurnOwnerColumnMigration },
  { kind: 'migration', migration: threadSettingsLegacyEngineeringFlagMigration },
  { kind: 'migration', migration: assignmentSpecNullableMigration },
  { kind: 'migration', migration: threadPinnedAtMigration },
  { kind: 'migration', migration: assistantPinnedMigration },
  { kind: 'migration', migration: assistantAgentsAndPauseMigration },
  { kind: 'migration', migration: assistantIdentityColumnsMigration },
  { kind: 'migration', migration: repairCollapsedAssistantPersonalityMigration },
  { kind: 'migration', migration: assistantDescriptionMigration },
  { kind: 'migration', migration: assistantReportingMigration },
  { kind: 'migration', migration: customSvgIconsMigration },
  { kind: 'migration', migration: projectOvenColumnMigration },
  { kind: 'migration', migration: stickyNoteImagePathMigration },
  { kind: 'migration', migration: stickyNoteSortOrderMigration },
  { kind: 'migration', migration: customIconLibraryMigration },
  { kind: 'migration', migration: assistantScheduleAnchorMigration },
  { kind: 'migration', migration: assistantExecutionMigration },
  { kind: 'migration', migration: assistantScheduledMigration },
  { kind: 'migration', migration: threadDesignKindMigration },
  { kind: 'migration', migration: threadAuthoredWorkKindMigration },
  { kind: 'migration', migration: threadAuthoredWorkKindsMigration },
  { kind: 'migration', migration: designRevisionMetadataMigration },
  { kind: 'migration', migration: settledAuditThreadStatusMigration },
  { kind: 'migration', migration: unpricedUsageCostsMigration }
]

/** The schema portion of the chain, for inspection and tests. */
export const DATABASE_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = UPGRADE_STEPS.flatMap(
  (step) => (step.kind === 'migration' ? [step.migration] : [])
)

/**
 * Ledger migrations, in order. They rebuild a whole table, so they run on the
 * maintenance worker after the schema chain rather than inside it.
 */
export const DATABASE_LEDGER_MIGRATIONS: readonly LedgerMigration[] = [
  independentUsageLedgerMigration,
  usageEventFeaturesMigration
]

/**
 * The schema version stored in `db_meta`, or `null` when the file has no
 * schema at all.
 *
 * `null` is the fresh-install signal, so it is distinct from `0`: a database
 * that has `db_meta` but lost its version row is treated as an old database
 * and upgraded, while a file with no tables is created from the snapshot.
 */
function readSchemaVersion(connection: DatabaseType): number | null {
  const hasMetaTable = connection
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'")
    .get() as { present?: number } | undefined
  if (!hasMetaTable) return null
  const row = connection.prepare("SELECT value FROM db_meta WHERE key = 'schema_version'").get() as
    { value?: string } | undefined
  const parsed = Number.parseInt(row?.value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Stamp the schema version this build just guaranteed. */
function writeSchemaVersion(connection: DatabaseType, version: number): void {
  connection
    .prepare("INSERT OR REPLACE INTO db_meta(key, value) VALUES('schema_version', ?)")
    .run(String(version))
}

/**
 * Create or upgrade the schema, and report whether anything ran.
 *
 * The version in `db_meta.schema_version` decides the work:
 *
 * - **No schema at all** (a fresh install): the schema snapshot is a complete
 *   description of the current version, so it is executed once and every legacy
 *   migration step is skipped. A first launch never walks ~40 `ALTER TABLE`
 *   compatibility steps for a database it just created.
 * - **Version below the current one**: the chain above runs in order, then the
 *   new version is stamped.
 * - **Version at or above the current one**: nothing runs. Not the DDL, not a
 *   single `PRAGMA table_info`. This is the steady state for every launch after
 *   the first, and it is what keeps schema work off the boot path entirely.
 */
export function applyDatabaseSchema(connection: DatabaseType): boolean {
  const storedVersion = readSchemaVersion(connection)
  if (storedVersion !== null && storedVersion >= DATABASE_SCHEMA_VERSION) return false

  connection.transaction(() => {
    if (storedVersion === null) {
      connection.exec(DATABASE_SCHEMA_SQL)
      connection.exec(DATABASE_SCHEMA_SNAPSHOT_INDEXES_SQL)
      writeSchemaVersion(connection, DATABASE_SCHEMA_VERSION)
      return
    }
    for (const step of UPGRADE_STEPS) {
      if (step.kind === 'snapshot') {
        connection.exec(DATABASE_SCHEMA_SQL)
        continue
      }
      step.migration.apply(connection)
    }
    writeSchemaVersion(connection, DATABASE_SCHEMA_VERSION)
  })()
  Logger.info('Database schema upgraded', {
    fromVersion: storedVersion ?? 'fresh',
    toVersion: DATABASE_SCHEMA_VERSION
  })
  return true
}

/** Run every ledger migration in order on the worker-backed host. */
export async function runLedgerMigrations(
  host: LedgerMigrationHost,
  connection: DatabaseType
): Promise<void> {
  for (const migration of DATABASE_LEDGER_MIGRATIONS) {
    await migration.apply(host, connection)
  }
}
