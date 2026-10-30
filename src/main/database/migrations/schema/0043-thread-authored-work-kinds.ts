import type { Database as DatabaseType } from 'better-sqlite3'
import {
  orderAuthoredWorkKinds,
  parseAuthoredWorkKinds,
  serializeAuthoredWorkKinds
} from '../../../../lib/design/authored-work-kinds'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

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
export const threadAuthoredWorkKindsMigration: SchemaMigration = {
  id: '0043-thread-authored-work-kinds',
  summary: 'threads record every authored-work kind they have produced, not only the current one',
  apply(connection: DatabaseType): void {
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
}
