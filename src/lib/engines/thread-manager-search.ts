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
 * How long a search waits for semantic matches before it answers with the
 * keyword results it already has.
 *
 * A resident embedding runtime answers a query in tens of milliseconds
 * (measured: 45 ms for a whole hybrid search, end to end), so the budget is not
 * a latency allowance for the normal case. It bounds the two cases that are not
 * normal: a query landing behind an indexing sweep's batch (a thread is up to
 * six windows of work) and a runtime that is still booting its model (measured:
 * 22 s). Neither may hold an interactive search open, so intent ranking joins
 * the answer only when it is ready in time and is otherwise dropped.
 */
export const INTENT_SEARCH_BUDGET_MS = 1_500

/**
 * Resolve with `work`'s value when it lands inside `budgetMs`, and with null
 * when it does not.
 *
 * The loser of the race stays observed either way: `Promise.race` holds both
 * inputs, so a late rejection can never surface as an unhandled rejection. The
 * work itself is not cancelled - a boot that missed its budget keeps warming the
 * runtime for the next query.
 */
export async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

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
      const matches = await this.intentMatchesWithinBudget(raw, options)
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

  /**
   * Semantic matches that arrived in time to join the answer, or none.
   *
   * The provider is asked only after the keyword answer is in hand, and it is
   * raced against {@link INTENT_SEARCH_BUDGET_MS}: the keyword results are the
   * search, semantic ranking is an enhancement, and an enhancement never delays
   * the answer or leaves the caller waiting on a local model. A provider that
   * fails or misses the deadline is logged and dropped.
   */
  private async intentMatchesWithinBudget(
    raw: string,
    options: ThreadSearchOptions
  ): Promise<IntentThreadMatch[]> {
    const provider = this.intentProvider
    if (!provider) return []
    const pending = provider(raw, options).catch((error) => {
      Logger.dev('Intent search failed; returning keyword results.', error)
      return [] as IntentThreadMatch[]
    })
    const matches = await withinBudget(pending, INTENT_SEARCH_BUDGET_MS)
    if (matches === null) {
      Logger.dev('Intent search missed its budget; returning keyword results.', {
        budgetMs: INTENT_SEARCH_BUDGET_MS
      })
      return []
    }
    return matches
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
