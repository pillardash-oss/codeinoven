import type { Database as DatabaseType } from 'better-sqlite3'
import {
  orderAuthoredWorkKinds,
  parseAuthoredWorkKinds,
  serializeAuthoredWorkKinds
} from '../../../lib/design/authored-work-kinds'
import { isAgentScratchDirectory } from '../../../lib/design/work-roots'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 8: a video delivered into scratch space is not an editing session.
 *
 * The video capability used to record a session the moment an agent picked it up,
 * and again for every preview, whatever folder the film was in. Every throwaway
 * clip the app hands a conversation is built in `.cio/work/<feature>/recap/` and
 * delivered inline as an artifact, so those threads were left holding a video
 * board and a video marker over a film nobody was ever going to open in the
 * editor. The behaviour is fixed where the mistakes were made, but the rows they
 * wrote are still on disk, and a session is only a session if the board can offer
 * the user something to edit.
 *
 * So this removes exactly that: the recorded folder when it sits in the app's
 * scratch tree, the thread's current session when that was the folder, and the
 * video marker while the thread holds no other video folder to offer. A thread
 * that also made a real composition keeps everything it has.
 *
 * Idempotent: the second run finds no scratch video rows and writes nothing. It
 * reads one grouped query for the project's video folders, then one row per
 * affected thread, so it costs nothing on a large library.
 */
export const versionEightMigration: DatabaseMigration = {
  version: 8,
  summary: 'video sessions recorded for scratch deliveries are cleared',
  apply(connection: DatabaseType): void {
    const recorded = connection
      .prepare('SELECT thread_id, directory FROM thread_designs WHERE kind = ?')
      .all('video') as Array<{ thread_id: string; directory: string }>
    const strayThreadIds = new Set(
      recorded.filter((row) => isAgentScratchDirectory(row.directory)).map((row) => row.thread_id)
    )
    if (strayThreadIds.size === 0) return

    // Every video folder a thread has ever been credited with, so a thread that
    // also cut a real composition keeps its video marker even though the folder it
    // happened to be recording now is scratch.
    const credited = connection
      .prepare(
        `SELECT o.thread_id AS thread_id, f.directory AS directory
           FROM design_origins o
           JOIN authored_work_folders f
             ON f.project_id = o.project_id AND f.directory = o.directory
          WHERE f.kind = ?`
      )
      .all('video') as Array<{ thread_id: string; directory: string }>
    const authoredThreadIds = new Set(
      credited.filter((row) => !isAgentScratchDirectory(row.directory)).map((row) => row.thread_id)
    )

    const removeFolder = connection.prepare('DELETE FROM thread_designs WHERE thread_id = ?')
    const readThread = connection.prepare(
      'SELECT authored_work_kind, authored_work_kinds FROM threads WHERE id = ?'
    )
    const updateThread = connection.prepare(
      'UPDATE threads SET authored_work_kind = ?, authored_work_kinds = ? WHERE id = ?'
    )
    for (const threadId of strayThreadIds) {
      removeFolder.run(threadId)
      const row = readThread.get(threadId) as
        { authored_work_kind: string | null; authored_work_kinds: string | null } | undefined
      if (!row) continue
      const keepsVideo = authoredThreadIds.has(threadId)
      const kinds = parseAuthoredWorkKinds(row.authored_work_kinds).filter(
        (kind) => kind !== 'video' || keepsVideo
      )
      const current =
        row.authored_work_kind === 'video' && !keepsVideo ? null : row.authored_work_kind
      updateThread.run(current, serializeAuthoredWorkKinds(orderAuthoredWorkKinds(kinds)), threadId)
    }
  }
}
