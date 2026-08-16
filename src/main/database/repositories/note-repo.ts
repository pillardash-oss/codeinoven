import type { Database } from '../database'
import type { ThreadNote } from '../../../lib/types'

interface ThreadNoteRow {
  thread_id: string
  body: string
  created_at: number
  updated_at: number
}

function rowToNote(row: ThreadNoteRow): ThreadNote {
  return {
    threadId: row.thread_id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Private, user-only notes attached to threads. Rows cascade-delete with their
 * thread (ON DELETE CASCADE), so thread deletion always removes the note.
 * Notes are never read by the chat engine or any harness.
 */
export class NoteRepo {
  constructor(private db: Database) {}

  get(threadId: string): ThreadNote | null {
    const row = this.db.get<ThreadNoteRow>(
      'SELECT * FROM thread_notes WHERE thread_id = ?',
      threadId
    )
    return row ? rowToNote(row) : null
  }

  /** Insert or replace the note for a thread. */
  upsert(note: ThreadNote): void {
    this.db.run(
      `INSERT INTO thread_notes(thread_id, body, created_at, updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(thread_id) DO UPDATE SET
         body=excluded.body,
         updated_at=excluded.updated_at`,
      note.threadId,
      note.body,
      note.createdAt,
      note.updatedAt
    )
  }

  delete(threadId: string): void {
    this.db.run('DELETE FROM thread_notes WHERE thread_id = ?', threadId)
  }

  /** Thread ids that currently have a note (renderer presence sync). */
  listThreadIds(): string[] {
    const rows = this.db.all<{ thread_id: string }>(
      'SELECT thread_id FROM thread_notes ORDER BY updated_at DESC'
    )
    return rows.map((row) => row.thread_id)
  }
}
