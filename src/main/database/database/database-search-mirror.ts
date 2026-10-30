import { Logger } from '../../system/logger'
import type { DatabaseWorker } from '../database-worker'

/** `db_meta` key: '1' once the narrow search mirror is fully backfilled. */
const SEARCH_META_READY_KEY = 'agent_message_search_meta_ready'
/** `db_meta` key: highest agent_messages rowid already mirrored by the backfill. */
const SEARCH_META_CURSOR_KEY = 'agent_message_search_meta_cursor'
/** Rows mirrored per serialized worker batch while backfilling. */
const SEARCH_META_BATCH_ROWS = 2000

/** What the mirror needs from the database it belongs to. */
export interface SearchMirrorHost {
  isOpen(): boolean
  getWorker(): DatabaseWorker | null
  /** Read a value from `db_meta` through the worker. */
  readMeta(key: string): Promise<string | null>
  /** Write a value to `db_meta` on the primary connection. */
  writeMeta(key: string, value: string): void
}

/**
 * The narrow `agent_message_search_meta` mirror and its resumable backfill.
 *
 * The mirror is what makes thread search fast: without it the FTS query has to
 * read `agent_messages` once per match (random rowid order, hundreds of
 * megabytes) just to apply its visibility filter and rank by recency.
 *
 * Backfilling runs on the worker's connection as a sequence of small serialized
 * batches, each its own request, so an interactive query slots in between
 * batches instead of waiting for the whole rebuild. Progress is resumable
 * through `db_meta`; the ready flag is written only once the whole table has
 * been mirrored, because new messages keep the mirror current through the
 * schema triggers from then on.
 */
export class AgentMessageSearchMirror {
  private readonly host: SearchMirrorHost
  private ready = false

  constructor(host: SearchMirrorHost) {
    this.host = host
  }

  /** Whether thread search may rank against the narrow search mirror. */
  isReady(): boolean {
    return this.ready
  }

  /** Bring the mirror up to date. Never blocks startup; failures are logged. */
  async backfill(): Promise<void> {
    const worker = this.host.getWorker()
    if (!worker?.isRunning()) return
    if ((await this.host.readMeta(SEARCH_META_READY_KEY)) !== null) {
      this.ready = true
      return
    }
    try {
      let cursor = Number((await this.host.readMeta(SEARCH_META_CURSOR_KEY)) ?? 0)
      for (;;) {
        if (!worker.isRunning() || !this.host.isOpen()) return
        const batch = await worker.query(
          'SELECT rowid AS rowid FROM agent_messages WHERE rowid > ? ORDER BY rowid LIMIT ?',
          [cursor, SEARCH_META_BATCH_ROWS],
          SEARCH_META_BATCH_ROWS
        )
        if (!batch.ok) {
          Logger.error('Search mirror backfill read failed', batch.error)
          return
        }
        const rows = batch.rows ?? []
        if (rows.length === 0) break
        // Mirror exactly the range the batch read, so a concurrent delete inside
        // the batch can never leave a rowid gap the next cursor would skip.
        const lastRowid = Number(rows[rows.length - 1]?.rowid ?? cursor)
        const inserted = await worker.execute(
          `INSERT OR IGNORE INTO agent_message_search_meta(
             rowid, thread_id, role, visibility, session_id, created_at
           )
           SELECT rowid, thread_id, role, visibility, session_id, created_at
           FROM agent_messages WHERE rowid > ? AND rowid <= ?`,
          [cursor, lastRowid]
        )
        if (!inserted.ok) {
          Logger.error('Search mirror backfill write failed', inserted.error)
          return
        }
        cursor = lastRowid
        this.host.writeMeta(SEARCH_META_CURSOR_KEY, String(cursor))
      }
      this.host.writeMeta(SEARCH_META_READY_KEY, '1')
      this.ready = true
      Logger.info('Agent message search mirror ready', { throughRowid: cursor })
    } catch (error) {
      // Search keeps working through the legacy query; it is only slower.
      Logger.error('Search mirror backfill failed', error)
    }
  }
}
