import type { Database } from '../../main/database/database'
import {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  threadMatchesSearchScope,
  threadSearchMessageLimit,
  ThreadRepo,
  type ThreadSearchOptions
} from '../../main/database/repositories/thread-repo'
import { Logger } from '../../main/system/logger'
import { mergeHybridThreadSearchResults } from '../search/hybrid-merge'
import type { IntentThreadMatch } from '../search/types'
import type { ThreadSearchResult } from '../types'

/**
 * Supplies semantic thread matches for a query. Returns thread ids plus cosine
 * similarity; hydration and scope filtering happen here. An empty list means
 * intent search is off, unready, or found nothing, and the caller keeps the
 * keyword results unchanged.
 */
export type IntentSearchProvider = (
  query: string,
  options: ThreadSearchOptions
) => Promise<IntentThreadMatch[]>

/**
 * Search across thread titles and conversation content (user messages + agent
 * final output). The FTS queries run on the worker's connection (serialized)
 * with a primary-connection fallback.
 *
 * When the narrow search mirror is ready the message query ranks against it and
 * only touches `agent_messages` for the rows that return a snippet; until the
 * mirror has been backfilled the legacy join is used (correct, just slower).
 *
 * When an intent provider is attached (and intent search is enabled), the
 * keyword results are merged with semantic matches into one hybrid ranking.
 */
export class ThreadSearchService {
  private intentProvider: IntentSearchProvider | null = null

  constructor(
    private readonly db: Database,
    private readonly threadRepo: ThreadRepo
  ) {}

  /** Attach or clear the semantic provider. Set once during service wiring. */
  setIntentProvider(provider: IntentSearchProvider | null): void {
    this.intentProvider = provider
  }

  /** Family-scoped when `options.family` is set; project-scoped when
   *  `options.projectId` is set. */
  async search(query: string, options: ThreadSearchOptions = {}): Promise<ThreadSearchResult[]> {
    const raw = query.trim()
    if (!raw) return []
    const { results: keyword, limit } = await this.keywordSearch(raw, options)
    if (!this.intentProvider) return keyword
    try {
      const matches = await this.intentProvider(raw, options)
      if (matches.length === 0) return keyword
      const threads = await this.threadRepo.listByIdsViaWorker(
        matches.map((match) => match.threadId)
      )
      const byId = new Map(threads.map((thread) => [thread.id, thread]))
      const intent: ThreadSearchResult[] = []
      for (const match of matches) {
        const thread = byId.get(match.threadId)
        if (!thread) continue
        if (!threadMatchesSearchScope(thread, options)) continue
        intent.push({ thread, kind: 'intent', score: match.score })
      }
      if (intent.length === 0) return keyword
      return mergeHybridThreadSearchResults(keyword, intent, limit)
    } catch (error) {
      // Semantic search is an enhancement; a failure must never break keyword
      // search, only silently fall back to it.
      Logger.dev('Intent search enrichment failed; returning keyword results.', error)
      return keyword
    }
  }

  private async keywordSearch(
    raw: string,
    options: ThreadSearchOptions
  ): Promise<{ results: ThreadSearchResult[]; limit: number }> {
    const useSearchMeta = this.db.isSearchMetaReady()
    const built = buildThreadSearchSql(raw, options, useSearchMeta)
    const title = await this.db.queryViaWorker(built.title.sql, built.title.params, built.limit)
    if (!title.ok) {
      return { results: this.threadRepo.search(raw, options, useSearchMeta), limit: built.limit }
    }
    if (!built.fts) {
      return {
        results: mergeThreadSearchResults(title.rows, [], raw, built.limit),
        limit: built.limit
      }
    }
    const message = await this.db.queryViaWorker(
      built.fts.sql,
      built.fts.params,
      threadSearchMessageLimit(built.limit)
    )
    if (!message.ok) {
      return { results: this.threadRepo.search(raw, options, useSearchMeta), limit: built.limit }
    }
    return {
      results: mergeThreadSearchResults(title.rows, message.rows, raw, built.limit),
      limit: built.limit
    }
  }
}
