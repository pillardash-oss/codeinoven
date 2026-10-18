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
import { evidenceFtsQuery, hasQueryEvidence } from '../search/query-evidence'
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
 * extracts excerpts around the indexed matches; until the
 * mirror has been backfilled the legacy join is used (correct, just slower).
 *
 * Semantic (intent) ranking is opt-in per search. The keyword answer is always
 * the one that resolves; a search that asked for intent gets its merged hybrid
 * ranking pushed through a callback once the local model has answered, so an
 * interactive surface never waits on a model load to show rows.
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

  /**
   * Keyword-only search: the answer every panel's own search button shows.
   *
   * Family-scoped when `options.family` is set; project-scoped when
   * `options.projectId` is set. The embedding model is never consulted here -
   * semantic ranking belongs to the spotlight's thread search, which asks for it
   * explicitly through {@link searchWithDeferredIntent}.
   */
  async search(query: string, options: ThreadSearchOptions = {}): Promise<ThreadSearchResult[]> {
    const raw = query.trim()
    if (!raw) return []
    const { results } = await this.keywordSearch(raw, options)
    return results
  }

  /**
   * Spotlight search: answer with keyword rows now, hand the merged hybrid
   * ranking to `onIntentReady` when the semantic step lands.
   *
   * The spotlight is the only surface that ranks by meaning, and the only one
   * that can afford to wait for it: its rows are already on screen, so the
   * semantic answer replaces them instead of delaying them. The model may need
   * tens of seconds to boot when nothing has warmed it (measured: 22 s); that
   * boot runs here, off the interactive path, and the callback fires only once
   * the semantic matches are merged.
   */
  async searchWithDeferredIntent(
    query: string,
    options: ThreadSearchOptions,
    onIntentReady: (results: ThreadSearchResult[]) => void
  ): Promise<ThreadSearchResult[]> {
    const raw = query.trim()
    if (!raw) return []
    const { results: keyword, limit } = await this.keywordSearch(raw, options)
    const provider = this.intentProvider
    if (!provider) return keyword
    void this.enrichWithIntent(raw, options, keyword, limit, provider, onIntentReady)
    return keyword
  }

  /**
   * Resolve the semantic half and hand the merged ranking to the caller.
   *
   * Semantic search is an enhancement: a failure is logged and dropped, never
   * allowed to break the keyword answer or surface as an unhandled rejection.
   * When the provider finds nothing, no callback fires - the keyword rows the
   * caller is already showing are the whole answer.
   */
  private async enrichWithIntent(
    raw: string,
    options: ThreadSearchOptions,
    keyword: readonly ThreadSearchResult[],
    limit: number,
    provider: IntentSearchProvider,
    onIntentReady: (results: ThreadSearchResult[]) => void
  ): Promise<void> {
    try {
      const [matches, evidence] = await Promise.all([
        provider(raw, options),
        this.conversationEvidence(raw, options, limit)
      ])
      // All-term conversation evidence outranks similarity to only one concept.
      // Keep exact keyword evidence ahead of typo-tolerant evidence.
      const grounded = [...keyword.filter((result) => result.kind === 'message'), ...evidence]
      if (matches.length === 0) {
        if (evidence.length > 0) {
          onIntentReady(mergeHybridThreadSearchResults(keyword, grounded, limit))
        }
        return
      }
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
      if (intent.length === 0 && evidence.length === 0) return
      onIntentReady(mergeHybridThreadSearchResults(keyword, [...grounded, ...intent], limit))
    } catch (error) {
      Logger.dev('Intent search enrichment failed; keeping keyword results.', error)
    }
  }

  private async conversationEvidence(
    raw: string,
    options: ThreadSearchOptions,
    limit: number
  ): Promise<ThreadSearchResult[]> {
    const query = evidenceFtsQuery(raw)
    if (!query) return []
    const built = buildThreadSearchSql(raw, options, this.db.isSearchMetaReady(), query)
    if (!built.fts) return []
    // Never scan transcripts or fall back to the main connection for this pass.
    const candidates = await this.db.queryViaWorker(
      built.fts.sql,
      built.fts.params,
      threadSearchMessageLimit(limit),
      { allowPrimaryFallback: false }
    )
    if (!candidates.ok) return []
    const verified = candidates.rows.filter(
      (row) => typeof row.snippet_text === 'string' && hasQueryEvidence(raw, row.snippet_text)
    )
    return mergeThreadSearchResults([], verified, raw, limit)
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
