import type { Database as DatabaseType } from 'better-sqlite3'
import { DEFAULT_WORK_ROOTS, authoredWorkKindOf } from '../../../../lib/design/work-roots'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

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
export const threadDesignKindMigration: SchemaMigration = {
  id: '0041-thread-design-kind',
  summary: 'thread design folders record whether they hold a design or a video',
  apply(connection: DatabaseType): void {
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
}
