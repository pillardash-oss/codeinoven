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

interface BrowserTabNoteRow {
  tab_id: string
  body: string
  created_at: number
  updated_at: number
}

/**
 * A note attached to one global browser tab. It is the same scratch space a
 * thread note is; only the subject id differs.
 */
export interface BrowserTabNote {
  tabId: string
  body: string
  createdAt: number
  updatedAt: number
}

function rowToBrowserTabNote(row: BrowserTabNoteRow): BrowserTabNote {
  return {
    tabId: row.tab_id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Private, user-only notes. A thread's note lives in `thread_notes` and
 * cascade-deletes with its thread; a global browser tab is not a thread, so its
 * note lives in the sibling `browser_tab_notes` table keyed by the same id the
 * tab carries in the browser strip. Both subjects are served by the one Notes
 * panel and the one `note:*` IPC surface. Notes are never read by the chat
 * engine or any harness.
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

  // ─── Global browser tab notes ────────────────────────────────────────────

  getForBrowserTab(tabId: string): BrowserTabNote | null {
    const row = this.db.get<BrowserTabNoteRow>(
      'SELECT * FROM browser_tab_notes WHERE tab_id = ?',
      tabId
    )
    return row ? rowToBrowserTabNote(row) : null
  }

  /** Insert or replace the note for a browser tab. */
  upsertForBrowserTab(note: BrowserTabNote): void {
    this.db.run(
      `INSERT INTO browser_tab_notes(tab_id, body, created_at, updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(tab_id) DO UPDATE SET
         body=excluded.body,
         updated_at=excluded.updated_at`,
      note.tabId,
      note.body,
      note.createdAt,
      note.updatedAt
    )
  }

  deleteForBrowserTab(tabId: string): void {
    this.db.run('DELETE FROM browser_tab_notes WHERE tab_id = ?', tabId)
  }

  /** Browser tab ids that currently have a note (renderer presence sync). */
  listBrowserTabIds(): string[] {
    const rows = this.db.all<{ tab_id: string }>(
      'SELECT tab_id FROM browser_tab_notes ORDER BY updated_at DESC'
    )
    return rows.map((row) => row.tab_id)
  }
}
