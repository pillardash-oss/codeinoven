import { unarchivedThreadSql } from '../../lib/archives'
import type { Database } from './database'

/** Filter bounded ledger snapshots without deleting their durable history. */
export async function filterArchivedThreadRecords<T extends { assistantId?: string }>(
  database: Database,
  records: readonly T[],
  threadIdsFor: (record: T) => readonly string[]
): Promise<T[]> {
  const visible: T[] = []
  for (let offset = 0; offset < records.length; offset += 64) {
    const batch = records.slice(offset, offset + 64)
    const ids = [...new Set(batch.flatMap(threadIdsFor))]
    const assistantIds = [
      ...new Set(batch.flatMap((record) => (record.assistantId ? [record.assistantId] : [])))
    ]
    const placeholders = ids.map(() => '?').join(',') || 'NULL'
    const assistantPlaceholders = assistantIds.map(() => '?').join(',') || 'NULL'
    const result = await database.queryViaWorker(
      `SELECT 'thread' AS kind, id FROM threads
         WHERE id IN (${placeholders}) AND NOT (${unarchivedThreadSql()})
       UNION SELECT kind, entity_id AS id FROM archives
         WHERE (kind = 'thread' AND entity_id IN (${placeholders}))
            OR (kind = 'assistant' AND entity_id IN (${assistantPlaceholders}))`,
      [...ids, ...ids, ...assistantIds],
      ids.length + assistantIds.length,
      { allowPrimaryFallback: false }
    )
    if (!result.ok) throw new Error('Could not read archive visibility')
    const hiddenThreads = new Set(
      result.rows.filter((row) => row.kind === 'thread').map((row) => String(row.id))
    )
    const hiddenAssistants = new Set(
      result.rows.filter((row) => row.kind === 'assistant').map((row) => String(row.id))
    )
    visible.push(
      ...batch.filter(
        (record) =>
          !(record.assistantId && hiddenAssistants.has(record.assistantId)) &&
          !threadIdsFor(record).some((id) => hiddenThreads.has(id))
      )
    )
  }
  return visible
}
