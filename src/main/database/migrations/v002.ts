import type { Database as DatabaseType } from 'better-sqlite3'
import { Logger } from '../../system/logger'
import { DEFAULT_WORK_ROOTS, authoredWorkKindOf } from '../../../lib/design/work-roots'
import {
  orderAuthoredWorkKinds,
  parseAuthoredWorkKinds,
  serializeAuthoredWorkKinds
} from '../../../lib/design/authored-work-kinds'
import { USAGE_EVENT_FEATURES } from '../../../lib/types/usage'
import {
  ASSISTANT_INSTRUCTIONS_HEADING,
  ASSISTANT_PERSONALITY_HEADING,
  assistantPersonalityDocument,
  hasAssistantPersonalitySection,
  hasKnowledgeHeading
} from '../../../lib/assistant-personality'
import {
  DATABASE_SCHEMA_SQL,
  LEGACY_RUBRIC_VERSION,
  MAX_PLAUSIBLE_SHOT_COST_USD,
  MODEL_RANKINGS_COLUMNS_SQL,
  MODEL_RANKING_CALC_VERSION,
  MODEL_RANKING_SNAPSHOT_INDEXES_SQL,
  MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL,
  MODEL_RANKING_INDEXES_SQL,
  USAGE_EVENTS_COLUMNS_SQL,
  USAGE_EVENTS_INDEXES_SQL
} from '../schema'
import type { DatabaseMigration, LedgerMigrationHost } from './migration'
import {
  addColumn,
  parseColumnNames,
  tableColumns,
  tableExists,
  tableSql
} from './migration-helpers'

/**
 * Schema version 2: every compatibility step a database written before the
 * version gate still needs, applied in order.
 *
 * This file is the catch-all of the chain. Any database stamped below version 2
 * (including a file with tables but no `db_meta`, which reads as version 0) is
 * walked through it, and each step is idempotent, so one that already ran is a
 * no-op. Once no supported database sits below version 2 the whole file is dead
 * weight and can be deleted: that is the point of one file per version.
 *
 * Order is part of the contract and is not alphabetical. The vocabulary rename
 * and the ranking fold run before the schema snapshot, because
 * `CREATE TABLE IF NOT EXISTS` would otherwise create tables those steps can no
 * longer rewrite; every column step after it needs the tables it creates.
 *
 * The two ledger rebuilds are this version's worker-backed steps: they rewrite
 * a whole table, so they run on the maintenance worker after the schema
 * transaction instead of inside it.
 */

/**
 * Rename the assistant vocabulary in a database written before it.
 *
 * The feature was called a routine: its rows lived in `routines`, a task
 * carried `threads.routine_id`, and the listing index was
 * `idx_routines_listing`. Those names are user data, so they are renamed in
 * place rather than rebuilt: the table keeps its ids, its rows, and the
 * threads pointing at it. The old index is dropped because the schema
 * recreates it under its new name, and SQLite carries an index through a table
 * rename with its old name still attached.
 *
 * The assistant's written instruction set was its how-to: the `how_to` and
 * `how_to_updated_at` columns became `knowledge` and `knowledge_updated_at`.
 * The rename reached the schema but not the rows an existing database already
 * held, so the columns are renamed here rather than only added: a database
 * that predates the wording keeps its authored knowledge and the timestamp the
 * schedule anchor backfill reads, instead of failing on a column that only the
 * fresh schema carried. A table that already uses the new names is untouched.
 *
 * Runs first, before the schema snapshot is applied: `CREATE TABLE IF NOT
 * EXISTS assistants` would otherwise create an empty table the rename could not
 * replace, and the later migrations (the schedule anchor reads
 * `knowledge_updated_at`) would find the old columns. Idempotent, so a database
 * that has already migrated is untouched.
 */
function applyAssistantVocabulary(connection: DatabaseType): void {
  if (tableExists(connection, 'routines') && !tableExists(connection, 'assistants')) {
    connection.exec('ALTER TABLE routines RENAME TO assistants')
    connection.exec('DROP INDEX IF EXISTS idx_routines_listing')
  }

  const threadColumns = tableColumns(connection, 'threads')
  if (threadColumns.has('routine_id') && !threadColumns.has('assistant_id')) {
    connection.exec('ALTER TABLE threads RENAME COLUMN routine_id TO assistant_id')
  }

  const assistantColumns = tableColumns(connection, 'assistants')
  if (!assistantColumns.has('knowledge')) {
    if (assistantColumns.has('how_to')) {
      connection.exec('ALTER TABLE assistants RENAME COLUMN how_to TO knowledge')
    } else if (assistantColumns.size > 0) {
      connection.exec("ALTER TABLE assistants ADD COLUMN knowledge TEXT NOT NULL DEFAULT ''")
    }
  }
  if (!assistantColumns.has('knowledge_updated_at')) {
    if (assistantColumns.has('how_to_updated_at')) {
      connection.exec(
        'ALTER TABLE assistants RENAME COLUMN how_to_updated_at TO knowledge_updated_at'
      )
    } else if (assistantColumns.size > 0) {
      connection.exec('ALTER TABLE assistants ADD COLUMN knowledge_updated_at INTEGER')
    }
  }
}

/**
 * One-time replacement of the legacy per-turn `turn_feedback` ledger (1-5
 * grades) with the `model_rankings` aggregate + `model_ranking_snapshots`
 * queue. Graded legacy rows are folded into the aggregate with the linear
 * map grade -> (grade - 1) x 2.5 under `rubric_version = 'legacy-1to5-map-v1'`
 * (no duration information existed, so duration sums stay 0), and only then
 * is the legacy table dropped. Idempotent: without a legacy table this is a
 * no-op. The fold-in is a single grouped INSERT ... SELECT, so large ledgers
 * stay one bounded pass rather than per-row inserts.
 */
function applyModelRankingTables(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'turn_feedback')
  if (columns.size === 0) return
  if (!columns.has('grade')) {
    // Databases predating LLM-graded turn feedback carry the useless binary
    // pass/fail ledger (status 'success'/'corrected', regex-driven). The
    // metric was unreliable by construction: nothing is worth translating.
    connection.exec('DROP TABLE turn_feedback')
    return
  }
  // The aggregate must exist before the fold-in; the canonical schema's
  // CREATE IF NOT EXISTS stays a no-op afterwards.
  connection.exec(
    `CREATE TABLE IF NOT EXISTS model_rankings (${MODEL_RANKINGS_COLUMNS_SQL});
     CREATE TABLE IF NOT EXISTS model_ranking_snapshots (${MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL});`
  )
  connection.exec(MODEL_RANKING_INDEXES_SQL)
  connection.exec(MODEL_RANKING_SNAPSHOT_INDEXES_SQL)
  connection.exec(`
    INSERT INTO model_rankings(
      id, harness_id, provider_id, model_id, thinking_level,
      one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
      multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
      rubric_version, calc_version, updated_at
    )
    SELECT
      'legacy-' || MIN(legacy.rowid),
      legacy.harness_id,
      COALESCE(legacy.provider_id, ''),
      legacy.model_id,
      COALESCE(legacy.thinking_level, ''),
      SUM((legacy.grade - 1) * 2.5),
      COUNT(*),
      0,
      COALESCE(SUM(CASE WHEN legacy.cost_status <> 'unavailable' AND legacy.cost_usd IS NOT NULL
                        THEN legacy.cost_usd ELSE 0 END), 0),
      0, 0, 0, 0,
      '${LEGACY_RUBRIC_VERSION}',
      '${MODEL_RANKING_CALC_VERSION}',
      MAX(legacy.created_at)
    FROM turn_feedback AS legacy
    WHERE legacy.status = 'graded'
      AND legacy.grade IS NOT NULL
      AND legacy.harness_id IS NOT NULL
      AND legacy.model_id IS NOT NULL
    GROUP BY legacy.harness_id, COALESCE(legacy.provider_id, ''), legacy.model_id,
             COALESCE(legacy.thinking_level, '')
  `)
  connection.exec('DROP TABLE turn_feedback')
}

/**
 * Discard ranking cost sums that an arithmetic artifact poisoned.
 *
 * The cost columns of `model_rankings` are running sums whose snapshots are
 * hard-deleted the moment they are scored, so one absurd addend can never be
 * subtracted back out: it only ever surfaces as an impossible per-sample
 * average, and it takes the "spent across ranked conversations" figure with it
 * forever. Anything above `MAX_PLAUSIBLE_SHOT_COST_USD` per ranked
 * conversation is therefore dropped to 0, exactly how an unpriced session is
 * already recorded: the priced siblings of those samples under-report by the
 * few cents they actually cost, which is the honest direction for a sum
 * nothing can recompute. Scores, sample counts, and durations are untouched,
 * because those are the ranking's own numbers and they were never corrupt.
 * The 2026-10-10 pi cumulative-cost fix stopped the one producer of such
 * addends, and `ModelRankingRepo` now refuses to fold a new one in at all.
 * Idempotent: a repaired row is already below the ceiling.
 */
function applyModelRankingCostPlausibility(connection: DatabaseType): void {
  if (tableColumns(connection, 'model_rankings').size === 0) return
  const beyondCeiling = (samplesColumn: string, costColumn: string): string =>
    `${samplesColumn} > 0 AND ${costColumn} > ${samplesColumn} * ${MAX_PLAUSIBLE_SHOT_COST_USD}`
  connection.exec(`
    UPDATE model_rankings
    SET one_shot_cost_usd = CASE
          WHEN ${beyondCeiling('one_shot_samples', 'one_shot_cost_usd')} THEN 0
          ELSE one_shot_cost_usd
        END,
        multi_shot_cost_usd = CASE
          WHEN ${beyondCeiling('multi_shot_samples', 'multi_shot_cost_usd')} THEN 0
          ELSE multi_shot_cost_usd
        END
    WHERE (${beyondCeiling('one_shot_samples', 'one_shot_cost_usd')})
       OR (${beyondCeiling('multi_shot_samples', 'multi_shot_cost_usd')})
  `)
}

/**
 * Databases created before claim-token tagging carry a `claim_token`-less
 * snapshot queue. Add the column in place (nullable, no backfill needed:
 * unclaimed rows are NULL by definition). Idempotent and safe to re-run.
 */
function applyModelRankingSnapshotClaimToken(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'model_ranking_snapshots')
  if (columns.size === 0) return
  addColumn(connection, columns, 'model_ranking_snapshots', 'claim_token', 'TEXT')
}

/**
 * Databases created before the anchor tag carry an `anchor_message_id`-less
 * snapshot queue. Add the column in place and point each still-open row at
 * the same visible user message the capture path would resolve today: the
 * thread's most recent user-origin message. Without the backfill a queued row
 * would treat its next turn as a follow-up and keep the pre-fix behaviour for
 * one more exchange. Rows whose thread is gone (or that are already closed)
 * keep a null anchor, which reads as "unknown". Idempotent and safe to
 * re-run.
 */
function applyModelRankingSnapshotAnchorMessage(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'model_ranking_snapshots')
  if (columns.size === 0 || columns.has('anchor_message_id')) return
  addColumn(connection, columns, 'model_ranking_snapshots', 'anchor_message_id', 'TEXT')
  connection
    .prepare(
      `UPDATE model_ranking_snapshots
       SET anchor_message_id = (
         SELECT candidate.id FROM agent_messages candidate
         WHERE candidate.thread_id = model_ranking_snapshots.thread_id
           AND candidate.role = 'user' AND candidate.origin = 'user'
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       )
       WHERE closed_at_ms IS NULL`
    )
    .run()
}

/**
 * Databases created before the undo flag carry a snapshot queue with no
 * `undone_at_ms` column. Add it in place; existing rows read as `null`, which
 * is exactly "not undone". Idempotent and safe to re-run.
 */
function applyModelRankingSnapshotUndoneAt(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'model_ranking_snapshots')
  if (columns.size === 0) return
  addColumn(connection, columns, 'model_ranking_snapshots', 'undone_at_ms', 'INTEGER')
}

/**
 * Existing databases predate the multi-select lifecycle columns.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so the columns
 * are added when missing.
 */
function applyEngineeringLifecycleColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'engineering_lifecycle')
  addColumn(
    connection,
    columns,
    'engineering_lifecycle',
    'selected_stages_json',
    "TEXT NOT NULL DEFAULT '[]'"
  )
  addColumn(connection, columns, 'engineering_lifecycle', 'autopilot', 'INTEGER NOT NULL DEFAULT 0')
}

/**
 * Existing databases predate the append-only usage snapshot fields.
 *
 * `tokens_total` and `duration_ms` are added and then backfilled, because a
 * zero in either column reads as a real measurement: the total is the sum of
 * the categories when the provider did not report one, and the duration is the
 * turn's own completion window.
 */
function applyUsageEventColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'usage_events')
  const addedTokensTotal = !columns.has('tokens_total')
  const addedDuration = !columns.has('duration_ms')

  addColumn(connection, columns, 'usage_events', 'account_id', 'TEXT')

  if (addedTokensTotal) {
    connection.exec('ALTER TABLE usage_events ADD COLUMN tokens_total INTEGER')
  }
  if (addedDuration) {
    connection.exec(
      'ALTER TABLE usage_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0)'
    )
  }

  if (addedTokensTotal) {
    connection.exec(`
      UPDATE usage_events
      SET tokens_total = COALESCE(
        raw_total,
        COALESCE(tokens_uncached_input, 0) +
          COALESCE(tokens_cached_input, 0) +
          COALESCE(tokens_cache_write, 0) +
          COALESCE(tokens_output, 0) +
          COALESCE(tokens_reasoning, 0)
      )
      WHERE tokens_total IS NULL
    `)
  }

  if (addedDuration) {
    connection.exec(`
      UPDATE usage_events
      SET duration_ms = MAX(
        0,
        COALESCE(
          (
            SELECT completed_at - created_at
            FROM agent_messages
            WHERE agent_messages.id = usage_events.parent_turn_id
          ),
          0
        )
      )
      WHERE duration_ms = 0
    `)
  }
}

/** Existing databases predate the independent (spec-less) audit thread flags. */
function applyThreadIndependentAuditColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'independent_audit', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(
    connection,
    columns,
    'threads',
    'independent_audit_initialized',
    'INTEGER NOT NULL DEFAULT 0'
  )
}

/**
 * Existing databases predate the durable Engineering marker on a thread. The
 * marker is set the first time a thread engages the Engineering lifecycle and
 * never cleared, so the row can draw its Engineering indicator without a
 * lifecycle round trip. Threads that already engaged engineering are
 * backfilled from the persisted lifecycle (`selection` moved off `none`, or a
 * run was ever started). `SELECT`-based, so it costs one grouped pass and is
 * idempotent on re-run.
 */
function applyThreadEngineeringColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  if (columns.has('engineering')) return
  connection.exec('ALTER TABLE threads ADD COLUMN engineering INTEGER NOT NULL DEFAULT 0')
  connection.exec(
    `UPDATE threads
        SET engineering = 1
      WHERE id IN (
        SELECT thread_id FROM engineering_lifecycle
         WHERE selection != 'none' OR started_at IS NOT NULL
      )`
  )
}

/** Existing databases predate account-scoped native session ownership. */
function applyThreadAccountColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'session_account_id', 'TEXT')
}

/**
 * Existing databases predate persisted draft state: a drafting flag that keeps
 * threads being composed or dictated inside bounded listing slices, plus a
 * dedicated column holding the committed draft content.
 */
function applyThreadDraftColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'drafting', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(connection, columns, 'threads', 'draft_json', 'TEXT')
}

/** Existing databases predate the bookmark marker on a thread row. */
function applyThreadBookmarkColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'bookmarked', 'INTEGER NOT NULL DEFAULT 0')
}

/**
 * Existing databases predate assistant-space task columns: assistant grouping,
 * custom row icon, per-task schedule override, and last-run timestamp.
 */
function applyThreadAssistantColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'assistant_id', 'TEXT')
  addColumn(connection, columns, 'threads', 'assistant_icon_type', 'TEXT')
  addColumn(connection, columns, 'threads', 'assistant_icon', 'TEXT')
  addColumn(connection, columns, 'threads', 'schedule_override', 'TEXT')
  // A task's own schedule switch: 1 schedules it even when its assistant is
  // unscheduled, 0 keeps it off the clock even when its assistant is scheduled,
  // and NULL inherits the assistant. Tasks predating it read back as inheriting.
  addColumn(connection, columns, 'threads', 'scheduled', 'INTEGER')
  addColumn(connection, columns, 'threads', 'last_run_at', 'INTEGER')
  addColumn(connection, columns, 'threads', 'last_dispatched_at', 'INTEGER')
  addColumn(connection, columns, 'threads', 'last_success_at', 'INTEGER')
  addColumn(
    connection,
    columns,
    'threads',
    'assistant_getting_started',
    'INTEGER NOT NULL DEFAULT 0'
  )
  // Each run of a task executes on its own thread; this column links a run
  // back to the task it belongs to. Tasks predating it read back as tasks.
  addColumn(connection, columns, 'threads', 'assistant_task_id', 'TEXT')
  // An assistant's knowledge ("Getting started") thread is pinned for its whole
  // life: pinning is what keeps it out of automatic eviction. It still renders
  // nested inside its assistant (AssistantSidebar keeps a pinned knowledge thread
  // in place), so the pin is retention, not a move to the Pinned section. Rows
  // created before that rule are pinned once here, and the guard makes the
  // statement a no-op on every later boot.
  connection.exec(
    'UPDATE threads SET pinned = 1, pinned_at = COALESCE(pinned_at, updated_at) ' +
      'WHERE assistant_getting_started = 1 AND pinned = 0'
  )
}

/**
 * Existing databases predate durable unattended-failure evidence: without
 * these columns a run that failed while no window was open reads back as a
 * bare `failed` status with no explanation. `last_outcome` is nullable so a
 * row that never settled carries no outcome, and the CHECK keeps the domain
 * closed on old rows (SQLite skips the check for NULL). Fresh databases
 * already carry all three, and the guarded `ALTER TABLE` is idempotent.
 */
function applyThreadFailureColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  addColumn(connection, columns, 'threads', 'last_error', 'TEXT')
  addColumn(connection, columns, 'threads', 'last_error_at', 'INTEGER')
  addColumn(
    connection,
    columns,
    'threads',
    'last_outcome',
    "TEXT CHECK(last_outcome IN ('completed','failed','parked'))"
  )
}

/**
 * Existing databases predate the per-message generation duration used by
 * tokens-per-second rates. Nullable: messages persisted before the column have
 * no generation window recorded and fall back to wall-clock rates.
 */
function applyAgentMessageGenerationColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'generation_ms', 'INTEGER')
}

/** Existing message mirrors predate account-container attribution. */
function applyAgentMessageAccountColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'account_id', 'TEXT')
  addColumn(connection, columns, 'agent_messages', 'account_label', 'TEXT')
}

/** Existing transcript mirrors predate per-turn Oven attribution. */
function applyAgentMessageOvenColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'oven_id', 'TEXT')
}

/** Existing transcript mirrors predate the display label of the Oven that served them. */
function applyAgentMessageOvenLabelColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'oven_label', 'TEXT')
}

/** Existing transcript mirrors predate the per-Oven appearance stored beside a turn. */
function applyAgentMessageOvenAppearanceColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'oven_appearance_json', 'TEXT')
}

/**
 * Existing message mirrors predate estimated-occupancy provenance; without the
 * flag a reloaded estimate masquerades as a provider-reported reading.
 */
function applyAgentMessageContextEstimatedColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'context_estimated', 'INTEGER')
}

/**
 * Message mirrors predate the canonical usage payload. Without the column a
 * reloaded message loses the provider's own categories and raw evidence, so
 * sub-agent turns (and any reconciliation after a restart) would have to be
 * recorded from the aggregate alone.
 */
function applyAgentMessageNormalizedUsageColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'agent_messages')
  addColumn(connection, columns, 'agent_messages', 'normalized_usage_json', 'TEXT')
}

/** Existing databases predate the in-flight turn owner recorded for cross-instance recovery. */
function applyActiveTurnOwnerColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'active_turns')
  if (columns.size === 0) return
  addColumn(connection, columns, 'active_turns', 'owner_pid', 'INTEGER')
}

/**
 * Rows persisted before the legacy `engineeringMode` settings flag was
 * scrubbed still carry it inside their settings JSON. Rewrite affected rows
 * without the flag: the Engineering lifecycle selection is the single source
 * of truth now. Idempotent and safe to re-run. Malformed rows are left
 * untouched; the read-path sanitizer in the thread repository still guards
 * them.
 */
function applyThreadSettingsLegacyEngineeringFlag(connection: DatabaseType): void {
  const rows = connection
    .prepare('SELECT id, settings FROM threads WHERE settings LIKE \'%"engineeringMode"%\'')
    .all() as Array<{ id: string; settings: string }>
  if (rows.length === 0) return
  const update = connection.prepare('UPDATE threads SET settings = ? WHERE id = ?')
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.settings) as Record<string, unknown>
      if (!('engineeringMode' in parsed)) continue
      const { engineeringMode: _legacyEngineeringMode, ...rest } = parsed
      update.run(JSON.stringify(rest), row.id)
    } catch {
      // A malformed settings blob must never abort startup.
    }
  }
}

/**
 * Databases created before spec-less Assignments carry
 * `assignment_versions.spec_id TEXT NOT NULL` / `spec_version INTEGER NOT NULL`.
 * SQLite cannot relax a NOT NULL constraint in place, so the table is rebuilt
 * once with the same columns and rows but nullable spec columns. The `data`
 * blob is the authoritative plan, so nothing needs to be recomputed. Idempotent:
 * a table whose `spec_id` is already nullable is left untouched.
 */
function applyAssignmentSpecNullable(connection: DatabaseType): void {
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

/**
 * Historical rows reached `pinned = 1` with a NULL `pinned_at`: the thread
 * upsert pins through a conflict path that never refreshes the pin timestamp,
 * and Assignment activation used to pin its coordinator without one. A NULL
 * pin time sorts last in the Pinned slice, so backfill it from the row's last
 * write. Idempotent: the predicate stops matching once every pinned row has a
 * timestamp. Databases without the column are left untouched.
 */
function applyThreadPinnedAt(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  if (!columns.has('pinned_at')) return
  connection
    .prepare(
      `UPDATE threads
          SET pinned_at = COALESCE(updated_at, last_activity, created_at)
        WHERE pinned = 1 AND pinned_at IS NULL`
    )
    .run()
}

/**
 * Add the assistant pin columns to databases created before assistants could be
 * pinned, then backfill a pin timestamp for any pinned row (matching the
 * thread pin behaviour). Fresh databases already carry both columns, and the
 * guarded `ALTER TABLE` makes this idempotent.
 */
function applyAssistantPinned(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(connection, columns, 'assistants', 'pinned_at', 'INTEGER')
  connection
    .prepare(
      `UPDATE assistants
          SET pinned_at = COALESCE(updated_at, created_at)
        WHERE pinned = 1 AND pinned_at IS NULL`
    )
    .run()
}

/**
 * Add the assistant model-set and pause columns to databases created before an
 * assistant could carry a primary/fallback model set or be paused. Fresh
 * databases already carry both, and the guarded `ALTER TABLE` is idempotent.
 */
function applyAssistantAgentsAndPause(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'agents', 'TEXT')
  addColumn(connection, columns, 'assistants', 'paused', 'INTEGER NOT NULL DEFAULT 0')
}

/**
 * Add the schedule-name column, and retire the personality column, on databases
 * created before how an assistant behaves became a section of its knowledge.
 *
 * The personality its owner wrote used to be a column of its own that rode every
 * turn ahead of the knowledge. It now lives inside the knowledge as the
 * `Personality` section, where the user edits it beside every other section, so a
 * stored personality is folded in first and the empty column is dropped. Fresh
 * databases never carry it, and every step is guarded, so this is idempotent.
 */
function applyAssistantIdentityColumns(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  if (columns.size > 0) {
    addColumn(connection, columns, 'assistants', 'schedule_name', 'TEXT')
  }
  if (!columns.has('personality')) return
  foldPersonalityIntoKnowledge(connection)
  try {
    connection.exec('ALTER TABLE assistants DROP COLUMN personality')
  } catch (error) {
    // A SQLite build without DROP COLUMN leaves the retired column in place. It
    // is never read or written again, so the only cost is an unused field.
    Logger.dev('Could not drop the retired assistant personality column:', error)
  }
}

/**
 * Move every stored assistant personality into its knowledge as the
 * `Personality` section, at the top, where the panel already shows the first
 * section. A knowledge that already carries one is left untouched, so re-running
 * this never duplicates it.
 *
 * The document keeps every word it had: `assistantPersonalityDocument` adds the
 * `Instructions` boundary when the knowledge does not open with a heading of its
 * own, because a markdown heading would otherwise own the whole document.
 */
function foldPersonalityIntoKnowledge(connection: DatabaseType): void {
  const rows = connection
    .prepare(
      `SELECT id, personality, knowledge FROM assistants
        WHERE personality IS NOT NULL AND trim(personality) <> ''`
    )
    .all() as Array<{ id: string; personality: string; knowledge: string | null }>
  if (rows.length === 0) return
  const update = connection.prepare('UPDATE assistants SET knowledge = ? WHERE id = ?')
  for (const row of rows) {
    const knowledge = row.knowledge ?? ''
    if (hasAssistantPersonalitySection(knowledge)) continue
    update.run(assistantPersonalityDocument(row.personality, knowledge), row.id)
  }
}

/**
 * Repair a knowledge that an earlier build of the personality fold damaged.
 *
 * The first version of the fold put the personality heading directly above the
 * document, so on a knowledge with no headings of its own the heading owned
 * every line under it: the user's whole instruction set showed up as one
 * section called `Personality`. This splits such a document back at the blank
 * line the fold itself inserted, restoring the personality as the first section
 * and the rest as `Instructions`.
 *
 * It only ever touches that exact shape (a document whose only heading is the
 * leading personality one), so it is idempotent and cannot touch a knowledge
 * that has since been repaired or authored properly.
 */
function applyRepairCollapsedAssistantPersonality(connection: DatabaseType): void {
  const heading = `${ASSISTANT_PERSONALITY_HEADING}\n`
  const rows = connection
    .prepare(`SELECT id, knowledge FROM assistants WHERE knowledge LIKE ?`)
    .all(`${ASSISTANT_PERSONALITY_HEADING}%`) as Array<{ id: string; knowledge: string }>
  if (rows.length === 0) return
  const update = connection.prepare('UPDATE assistants SET knowledge = ? WHERE id = ?')
  for (const row of rows) {
    const knowledge = row.knowledge ?? ''
    if (!knowledge.startsWith(heading)) continue
    const body = knowledge.slice(heading.length)
    // A document with any heading of its own closed the personality block
    // already, so there is nothing to repair.
    if (hasKnowledgeHeading(body)) continue
    const seam = body.search(/\n[ \t]*\n/)
    if (seam === -1) continue
    const personality = body.slice(0, seam).trim()
    const rest = body.slice(seam).trim()
    if (!personality || !rest) continue
    update.run(
      `${ASSISTANT_PERSONALITY_HEADING}\n${personality}\n\n${ASSISTANT_INSTRUCTIONS_HEADING}\n${rest}`,
      row.id
    )
  }
}

/**
 * Add the assistant description column to databases created before an assistant
 * could carry the user's own note about what it is for. Fresh databases
 * already carry it, and the guarded `ALTER TABLE` is idempotent.
 */
function applyAssistantDescription(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'description', 'TEXT')
}

/**
 * Add the assistant reporting columns to databases created before an assistant
 * could record where its output goes and how urgent it is. Fresh databases
 * already carry both, and the guarded `ALTER TABLE` is idempotent.
 */
function applyAssistantReporting(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'delivery', 'TEXT')
  addColumn(connection, columns, 'assistants', 'priority', 'TEXT')
}

/** Databases created before projects and assistants could carry a custom SVG icon. */
function applyCustomSvgIcons(connection: DatabaseType): void {
  for (const table of ['projects', 'assistants'] as const) {
    const columns = tableColumns(connection, table)
    addColumn(connection, columns, table, 'custom_svg', 'TEXT')
  }
}

/**
 * A project created for a remote Oven records that Oven's registry id, so its
 * chats can seed their own Oven binding. Databases from before Oven projects
 * have no such column and read back as unbound, which is the local default.
 */
function applyProjectOvenColumn(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'projects')
  if (columns.size === 0) return
  addColumn(connection, columns, 'projects', 'oven_id', 'TEXT')
}

/** Databases created before sticky notes could hold an image below their text. */
function applyStickyNoteImagePath(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'sticky_notes')
  if (columns.size === 0) return
  addColumn(connection, columns, 'sticky_notes', 'image_path', 'TEXT')
}

/**
 * Add the tab-strip order the sticky notes rail reorders by. Databases that
 * predate it read as all-zero, which sorts by `created_at` exactly as before;
 * the backfill seeds each row from that same order so the first drag starts
 * from what the user already sees. Idempotent: the predicate stops matching
 * once the column exists.
 *
 * The index is created here rather than in the schema block: a database that
 * predates the column would fail to create it before this migration added it,
 * so the schema runs first and the index must follow the column.
 */
function applyStickyNoteSortOrder(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'sticky_notes')
  if (columns.size > 0 && !columns.has('sort_order')) {
    connection.exec('ALTER TABLE sticky_notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    connection.exec(`
      UPDATE sticky_notes SET sort_order = (
        SELECT COUNT(*) FROM sticky_notes AS earlier
        WHERE earlier.created_at < sticky_notes.created_at
           OR (earlier.created_at = sticky_notes.created_at AND earlier.rowid < sticky_notes.rowid)
      )
    `)
  }
  connection.exec('CREATE INDEX IF NOT EXISTS idx_sticky_notes_sort ON sticky_notes(sort_order)')
}

/** Remove the obsolete required name column while preserving saved SVGs. */
function applyCustomIconLibrary(connection: DatabaseType): void {
  const columns = connection.prepare('PRAGMA table_info(custom_icons)').all() as Array<{
    name: string
    notnull: number
  }>
  if (!columns.some((column) => column.name === 'name' && column.notnull === 1)) return

  connection.exec(`
    CREATE TABLE custom_icons_without_name (
      id TEXT PRIMARY KEY NOT NULL,
      svg TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO custom_icons_without_name(id, svg, created_at)
      SELECT id, svg, created_at FROM custom_icons;
    DROP TABLE custom_icons;
    ALTER TABLE custom_icons_without_name RENAME TO custom_icons;
  `)
}

/**
 * Add the assistant schedule-anchor column to databases created before the
 * scheduler could tell a real missed fire from a slot that predates the
 * schedule. Fresh databases already carry it, and the guarded `ALTER TABLE`
 * is idempotent.
 *
 * The backfill stamps each scheduled assistant from its knowledge write time,
 * which is when the authoring flow set the schedule alongside the knowledge,
 * falling back to the assistant's creation. Without it an existing schedule
 * would look active since the epoch, and a slot that came due before the
 * assistant existed would read as missed.
 */
function applyAssistantScheduleAnchor(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'schedule_updated_at', 'INTEGER')
  connection
    .prepare(
      `UPDATE assistants
          SET schedule_updated_at = COALESCE(knowledge_updated_at, created_at)
        WHERE schedule IS NOT NULL AND schedule_updated_at IS NULL`
    )
    .run()
}

/**
 * Add the assistant execution-target column to databases created before an
 * assistant could name an Oven its runs execute on. Fresh databases already
 * carry it, and the guarded `ALTER TABLE` is idempotent. An existing assistant
 * keeps the column NULL, which means this computer.
 */
function applyAssistantExecution(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'execution', 'TEXT')
}

/**
 * Add the assistant schedule-enable column to databases created before an
 * assistant could be unscheduled. On by default, so every existing assistant
 * keeps firing. Fresh databases already carry it, and the guarded
 * `ALTER TABLE` is idempotent.
 */
function applyAssistantScheduled(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'assistants')
  addColumn(connection, columns, 'assistants', 'scheduled', 'INTEGER NOT NULL DEFAULT 1')
}

/**
 * Record the kind of authored work on each thread's folder row.
 *
 * The row used to store only a path, and the kind was recovered by reading that
 * path's root, so a thread lost its marker whenever its folder stopped sitting
 * under a known root: renamed, deleted, or written somewhere the app does not
 * document. The kind is a column now, written at preview time, and this pass
 * classifies the rows that predate it so an upgraded database arrives with the
 * knowledge a fresh one records. One bounded pass over one row per thread, and
 * only on the pass that adds the column, so it costs nothing afterwards.
 *
 * The added column carries the default but not the fresh schema's `CHECK`, which
 * SQLite cannot attach to an existing table; the reader treats anything that is
 * not `video` as a design, so the constraint is a documentation of intent here.
 */
function applyThreadDesignKind(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'thread_designs')
  if (columns.has('kind')) return
  connection.exec("ALTER TABLE thread_designs ADD COLUMN kind TEXT NOT NULL DEFAULT 'design'")
  const rows = connection
    .prepare('SELECT thread_id, directory FROM thread_designs')
    .all() as Array<{ thread_id: string; directory: string }>
  const update = connection.prepare('UPDATE thread_designs SET kind = ? WHERE thread_id = ?')
  for (const row of rows) {
    // The column default already says design, so only a composition needs a write.
    // The defaults are the roots these rows were written under: the setting
    // that moves them came later, so a stored root cannot be what classified
    // a row that predates it.
    if (authoredWorkKindOf(row.directory, DEFAULT_WORK_ROOTS) !== 'video') continue
    update.run('video', row.thread_id)
  }
}

/**
 * Record the authored-work session on the thread itself.
 *
 * The sidebar used to answer "is this a design or a video thread" by scanning
 * every listed thread's persisted messages for the session tag, a `parts LIKE`
 * that read the whole column on every render. The thread already carries the
 * answer the moment it enters a session, so the kind lives here and the row
 * draws it directly. Threads that predate the column are classified from the
 * durable folder record; a thread that only ever typed the tag self-heals on
 * its next turn, when the chat engine persists the kind it derives.
 *
 * The added column carries no `CHECK`: SQLite cannot attach one through
 * `ALTER TABLE ADD COLUMN`, so the reader enforces the domain and the fresh
 * schema's constraint documents the intent.
 */
function applyThreadAuthoredWorkKind(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  if (columns.has('authored_work_kind')) return
  connection.exec('ALTER TABLE threads ADD COLUMN authored_work_kind TEXT')
  connection.exec(
    `UPDATE threads
        SET authored_work_kind = (SELECT kind FROM thread_designs WHERE thread_id = threads.id)
      WHERE EXISTS (SELECT 1 FROM thread_designs WHERE thread_id = threads.id)`
  )
}

/**
 * Add the durable set of authored-work kinds beside the current session kind.
 *
 * `authored_work_kind` answers "which session is this thread in now". The row's
 * marker has to answer "what work has this thread done", because a thread that
 * designed something and later cut a video about it has done both and a single
 * column can only name one. Without this backfill every thread alive before the
 * column existed would show one marker, and the thread the set exists to
 * describe, one that started as a design and has since moved to a video
 * session, would lose its design marker on upgrade.
 *
 * Two sources, because neither alone is the whole set. The session kind is what
 * the thread was already showing. The creator records are what it did earlier:
 * `design_origins` names the thread that first previewed a folder and
 * `authored_work_folders` gives that folder's kind, so the join recovers a
 * design the thread has since navigated away from. Both reads are one grouped
 * statement for the whole table rather than a query per thread.
 */
function applyThreadAuthoredWorkKinds(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'threads')
  if (columns.has('authored_work_kinds')) return
  connection.exec('ALTER TABLE threads ADD COLUMN authored_work_kinds TEXT')
  const rows = connection
    .prepare('SELECT id, authored_work_kind, authored_work_kinds FROM threads')
    .all() as Array<{
    id: string
    authored_work_kind: string | null
    authored_work_kinds: string | null
  }>
  if (rows.length === 0) return
  const created = connection
    .prepare(
      `SELECT o.thread_id AS thread_id, f.kind AS kind
         FROM design_origins o
         JOIN authored_work_folders f
           ON f.project_id = o.project_id AND f.directory = o.directory
        GROUP BY o.thread_id, f.kind`
    )
    .all() as Array<{ thread_id: string; kind: string }>
  const createdByThread = new Map<string, string[]>()
  for (const row of created) {
    const kinds = createdByThread.get(row.thread_id)
    if (kinds) kinds.push(row.kind)
    else createdByThread.set(row.thread_id, [row.kind])
  }
  const update = connection.prepare('UPDATE threads SET authored_work_kinds = ? WHERE id = ?')
  for (const row of rows) {
    // Both spellings feed the same normalizer, so an unknown or corrupt value
    // reads as "nothing recorded" instead of failing a startup migration.
    const kinds = serializeAuthoredWorkKinds(
      orderAuthoredWorkKinds([
        ...parseAuthoredWorkKinds(row.authored_work_kinds),
        row.authored_work_kind,
        ...(createdByThread.get(row.id) ?? [])
      ])
    )
    if (kinds === null || kinds === row.authored_work_kinds) continue
    update.run(kinds, row.id)
  }
}

/**
 * Keep changed screens and named checkpoint steps beside revision metadata.
 *
 * These columns arrived after the revisions table. Existing rows keep their
 * content and timeline position, while unlabeled revisions use their usual cause.
 */
function applyDesignRevisionMetadata(connection: DatabaseType): void {
  const columns = tableColumns(connection, 'design_revisions')
  if (columns.size === 0) return
  for (const column of ['changed_paths', 'label', 'checkpoint_entry']) {
    addColumn(connection, columns, 'design_revisions', column, 'TEXT')
  }
}

/**
 * Land threads a settled audit left parked on `spec`.
 *
 * An audit parks its thread on `spec` while the report waits on the user, and
 * settling the report used to clear the audit state without moving the status:
 * the thread kept reading "Spec ready" with nothing left to review, holding a
 * review count on its project strip forever. `completed` is what a settled
 * audit means, so the thread is done.
 *
 * Only a row whose `spec` can have come from an audit is touched: an
 * independent-audit thread (locked out of the specification flows for its
 * lifetime) and an Achievement coordinator that owns a durable auditor. A
 * thread parked on a specification that is still waiting for approval keeps
 * its status, and so does an audit `offered`, which is still an open question
 * for the user. Idempotent: a database with nothing left to settle is
 * untouched.
 */
function applySettledAuditThreadStatus(connection: DatabaseType): void {
  connection.exec(
    `UPDATE threads
        SET status = 'completed',
            scope_sort_order = NULL,
            sort_order = NULL
      WHERE status = 'spec'
        AND audit_state IS NULL
        AND (
          independent_audit = 1
          OR (achievement_role = 'coordinator' AND auditor_thread_id IS NOT NULL)
        )`
  )
}

/** Index the analytics reads use once the ledger carries its own project identity. */
const PROJECT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_usage_events_project
      ON usage_events(project_id, created_at, id)`

/**
 * Detach the usage ledger from mutable conversation rows. Older schemas used
 * cascading foreign keys to threads and messages, which erased analytics
 * whenever retention evicted a thread. Rebuild once, snapshot project
 * identity, and retain the text identifiers without lifecycle constraints.
 */
async function applyIndependentUsageLedger(
  host: LedgerMigrationHost,
  connection: DatabaseType
): Promise<void> {
  const columns = tableColumns(connection, 'usage_events')
  const foreignKeys = connection.prepare('PRAGMA foreign_key_list(usage_events)').all()
  const independent =
    columns.has('project_id') && columns.has('project_name') && foreignKeys.length === 0

  if (independent) {
    const result = await host.execute(PROJECT_INDEX_SQL, [])
    if (!result.ok) throw new Error(result.error ?? 'Could not index the usage ledger')
    return
  }

  const projectId = columns.has('project_id')
    ? 'COALESCE(legacy.project_id, threads.project_id)'
    : 'threads.project_id'
  const projectName = columns.has('project_name')
    ? 'COALESCE(legacy.project_name, projects.name)'
    : 'projects.name'

  const statements = [
    {
      sql: 'ALTER TABLE usage_events RENAME TO usage_events_legacy',
      params: []
    },
    {
      sql: `CREATE TABLE usage_events (${USAGE_EVENTS_COLUMNS_SQL})`,
      params: []
    },
    {
      sql: `INSERT INTO usage_events(
        id, thread_id, parent_turn_id, project_id, project_name,
        feature_call_id, attempt, feature,
        harness_id, account_id, provider_id, model_id, thinking_level, utility_id,
        raw_provider_usage_json,
        tokens_uncached_input, tokens_cached_input, tokens_cache_write,
        tokens_output, tokens_reasoning, tokens_total, raw_total, total_semantics,
        cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
        success, retry_cause, duration_ms, created_at
      )
      SELECT
        legacy.id, legacy.thread_id, legacy.parent_turn_id, ${projectId}, ${projectName},
        legacy.feature_call_id, legacy.attempt, legacy.feature,
        legacy.harness_id, legacy.account_id, legacy.provider_id, legacy.model_id, legacy.thinking_level,
        legacy.utility_id, legacy.raw_provider_usage_json,
        legacy.tokens_uncached_input, legacy.tokens_cached_input, legacy.tokens_cache_write,
        legacy.tokens_output, legacy.tokens_reasoning, legacy.tokens_total,
        legacy.raw_total, legacy.total_semantics,
        legacy.cost_usd, legacy.cost_status, legacy.pricing_provenance_json,
        legacy.tool_fee_usd, legacy.success, legacy.retry_cause,
        legacy.duration_ms, legacy.created_at
      FROM usage_events_legacy AS legacy
      LEFT JOIN threads ON threads.id = legacy.thread_id
      LEFT JOIN projects ON projects.id = threads.project_id
      `,
      params: []
    },
    { sql: 'DROP TABLE usage_events_legacy', params: [] },
    ...USAGE_EVENTS_INDEXES_SQL.split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => ({ sql, params: [] })),
    { sql: PROJECT_INDEX_SQL, params: [] }
  ]
  const result = await host.transaction(statements)
  if (!result.ok) throw new Error(result.error ?? 'Could not migrate the usage ledger')
}

/**
 * Rebuild the usage ledger when its CHECK constraint predates a feature value
 * CodeInOven now records (sub-agent and ephemeral work). The CHECK is part of
 * the table SQL, so SQLite rejects a new value inside an old constraint; the
 * ledger write catches and dev-logs that rejection, which would silently drop
 * the row. Detecting the missing value in the stored SQL and rebuilding the
 * table keeps every recorded turn admissible.
 */
async function applyUsageEventFeatures(
  host: LedgerMigrationHost,
  connection: DatabaseType
): Promise<void> {
  const stored = tableSql(connection, 'usage_events')
  if (!stored) return
  const missing = USAGE_EVENT_FEATURES.filter((feature) => !stored.includes(`'${feature}'`))
  if (missing.length === 0) return

  const legacyColumns = tableColumns(connection, 'usage_events')
  const targetColumns = parseColumnNames(USAGE_EVENTS_COLUMNS_SQL)
  const carried = targetColumns.filter((column) => legacyColumns.has(column) && column !== 'id')
  const columnList = ['id', ...carried].join(', ')
  const projectIndex = `CREATE INDEX IF NOT EXISTS idx_usage_events_project
    ON usage_events(project_id, created_at, id)`
  const result = await host.transaction([
    { sql: 'ALTER TABLE usage_events RENAME TO usage_events_feature_legacy', params: [] },
    { sql: `CREATE TABLE usage_events (${USAGE_EVENTS_COLUMNS_SQL})`, params: [] },
    {
      sql: `INSERT INTO usage_events(${columnList})
      SELECT ${columnList}
      FROM usage_events_feature_legacy`,
      params: []
    },
    { sql: 'DROP TABLE usage_events_feature_legacy', params: [] },
    ...USAGE_EVENTS_INDEXES_SQL.split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => ({ sql, params: [] })),
    { sql: projectIndex, params: [] }
  ])
  if (!result.ok) {
    throw new Error(result.error ?? 'Could not migrate the usage event feature values')
  }
  Logger.info('Usage ledger rebuilt for new feature values', {
    features: missing.join(',')
  })
}

/** Schema version 2. */
export const versionTwoMigration: DatabaseMigration = {
  version: 2,
  summary: 'every compatibility step a database written before the version gate still needs',
  apply(connection: DatabaseType): void {
    applyAssistantVocabulary(connection)
    applyModelRankingTables(connection)
    // The snapshot lands here on purpose: see the file comment above.
    connection.exec(DATABASE_SCHEMA_SQL)
    applyModelRankingCostPlausibility(connection)
    applyModelRankingSnapshotClaimToken(connection)
    applyModelRankingSnapshotAnchorMessage(connection)
    applyModelRankingSnapshotUndoneAt(connection)
    applyEngineeringLifecycleColumns(connection)
    applyUsageEventColumns(connection)
    applyThreadIndependentAuditColumns(connection)
    applyThreadEngineeringColumn(connection)
    applyThreadAccountColumn(connection)
    applyThreadDraftColumns(connection)
    applyThreadBookmarkColumn(connection)
    applyThreadAssistantColumns(connection)
    applyThreadFailureColumns(connection)
    applyAgentMessageGenerationColumn(connection)
    applyAgentMessageAccountColumns(connection)
    applyAgentMessageOvenColumn(connection)
    applyAgentMessageOvenLabelColumn(connection)
    applyAgentMessageOvenAppearanceColumn(connection)
    applyAgentMessageContextEstimatedColumn(connection)
    applyAgentMessageNormalizedUsageColumn(connection)
    applyActiveTurnOwnerColumn(connection)
    applyThreadSettingsLegacyEngineeringFlag(connection)
    applyAssignmentSpecNullable(connection)
    applyThreadPinnedAt(connection)
    applyAssistantPinned(connection)
    applyAssistantAgentsAndPause(connection)
    applyAssistantIdentityColumns(connection)
    applyRepairCollapsedAssistantPersonality(connection)
    applyAssistantDescription(connection)
    applyAssistantReporting(connection)
    applyCustomSvgIcons(connection)
    applyProjectOvenColumn(connection)
    applyStickyNoteImagePath(connection)
    applyStickyNoteSortOrder(connection)
    applyCustomIconLibrary(connection)
    applyAssistantScheduleAnchor(connection)
    applyAssistantExecution(connection)
    applyAssistantScheduled(connection)
    applyThreadDesignKind(connection)
    applyThreadAuthoredWorkKind(connection)
    applyThreadAuthoredWorkKinds(connection)
    applyDesignRevisionMetadata(connection)
    applySettledAuditThreadStatus(connection)
  },
  async applyLedger(host: LedgerMigrationHost, connection: DatabaseType): Promise<void> {
    await applyIndependentUsageLedger(host, connection)
    await applyUsageEventFeatures(host, connection)
  }
}
