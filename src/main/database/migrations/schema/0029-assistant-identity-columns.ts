import type { Database as DatabaseType } from 'better-sqlite3'
import { Logger } from '../../../system/logger'
import {
  assistantPersonalityDocument,
  hasAssistantPersonalitySection
} from '../../../../lib/assistant-personality'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

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
export const assistantIdentityColumnsMigration: SchemaMigration = {
  id: '0029-assistant-identity-columns',
  summary: 'assistants gain a schedule name and their personality folds into knowledge',
  apply(connection: DatabaseType): void {
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
