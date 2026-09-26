import type { Database } from '../../main/database/database'
import {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  threadSearchMessageLimit,
  ThreadRepo
} from '../../main/database/repositories/thread-repo'
import type { ThreadSearchResult } from '../types'

/**
 * Full-text search across thread titles and conversation content (user
 * messages + agent final output). The FTS queries run on the worker's
 * connection (serialized) with a primary-connection fallback.
 *
 * When the narrow search mirror is ready the message query ranks against it and
 * only touches `agent_messages` for the rows that return a snippet; until the
 * mirror has been backfilled the legacy join is used (correct, just slower).
 */
export class ThreadSearchService {
  constructor(
    private readonly db: Database,
    private readonly threadRepo: ThreadRepo
  ) {}

  /** Project-scoped when `options.projectId` is set. */
  async search(
    query: string,
    options: { projectId?: string; limit?: number } = {}
  ): Promise<ThreadSearchResult[]> {
    const raw = query.trim()
    if (!raw) return []
    const useSearchMeta = this.db.isSearchMetaReady()
    const built = buildThreadSearchSql(raw, options, useSearchMeta)
    const title = await this.db.queryViaWorker(built.title.sql, built.title.params, built.limit)
    if (!title.ok) return this.threadRepo.search(query, options, useSearchMeta)
    if (!built.fts) {
      return mergeThreadSearchResults(title.rows, [], raw, built.limit)
    }
    const message = await this.db.queryViaWorker(
      built.fts.sql,
      built.fts.params,
      threadSearchMessageLimit(built.limit)
    )
    if (!message.ok) return this.threadRepo.search(query, options, useSearchMeta)
    return mergeThreadSearchResults(title.rows, message.rows, raw, built.limit)
  }
}
