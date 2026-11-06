import type { Database } from '../../main/database/database'
import {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  threadMatchesSearchScope,
  threadSearchMessageLimit,
  ThreadRepo,
  type ThreadSearchOptions,
  type ThreadSearchSql
} from '../../main/database/repositories/thread-repo'
import { Logger } from '../../main/system/logger'
import { mergeHybridThreadSearchResults } from '../search/hybrid-merge'
import {
  evidenceAnyFtsQuery,
  queryConceptCoverage,
  queryConcepts,
  requiredEvidenceConcepts
} from '../search/query-evidence'
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
 * How long one keyword read may take before an interactive search answers with
 * what it already has.
 *
 * The palette paints its in-memory rows in the same frame as the keystroke, so
 * this deadline is what stops a busy worker queue (a maintenance pass ahead of
 * the read in its single-flight queue) from delaying the database answer
 * indefinitely. It is deliberately well under the panel's own three-second
 * "still searching" ceiling: the IPC hop and the row build have to fit after it.
 */
const INTERACTIVE_SEARCH_DEADLINE_MS = 1200

/**
 * Tokens of one message the evidence pass reads to judge concept coverage.
 *
 * The displayed snippet stays short, but coverage measured over 64 tokens called
 * a long answer that carried most of the question unmatching, because its
 * concepts sat past the window.
 */
const EVIDENCE_SNIPPET_TOKENS = 400

/** The indexed excerpt a candidate row carries, for coverage scoring. */
function snippetTextOf(row: unknown): string {
  if (typeof row !== 'object' || row === null) return ''
  const snippet = (row as { snippet_text?: unknown }).snippet_text
  return typeof snippet === 'string' ? snippet : ''
}

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
      const merged = await this.mergedWithIntent(raw, options, keyword, limit, provider)
      if (merged) onIntentReady(merged)
    } catch (error: unknown) {
      Logger.dev('Intent search enrichment failed; keeping keyword results.', error)
    }
  }

  /**
   * Search that waits for the semantic half.
   *
   * An agent gathering context has nothing on screen yet, so it can afford to
   * wait for the embedding model where the spotlight cannot: this resolves with
   * the merged hybrid ranking instead of handing it to a callback. The wait is
   * bounded, because a cold local model can take tens of seconds and a tool call
   * must not hang on it; a timeout, an unready model and a failure all fall back
   * to the keyword answer, flagged as such.
   */
  async searchWithIntent(
    query: string,
    options: ThreadSearchOptions = {},
    timeoutMs = 12_000
  ): Promise<{ results: ThreadSearchResult[]; semantic: boolean }> {
    const raw = query.trim()
    if (!raw) return { results: [], semantic: false }
    const { results: keyword, limit } = await this.keywordSearch(raw, options)
    const provider = this.intentProvider
    // The evidence pass is the part that does not need a model: it re-reads the
    // index with the query's concepts OR-ed together and keeps the passages that
    // carry most of them. Running it without a provider is what stops a
    // sentence-shaped question from being answered with "no threads found" on a
    // machine where the embedding model is off or unready.
    if (!provider) {
      const evidence = await this.conversationEvidence(raw, options, limit)
      return { results: mergeHybridThreadSearchResults(keyword, evidence, limit), semantic: false }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
    })
    try {
      const merged = await Promise.race([
        this.mergedWithIntent(raw, options, keyword, limit, provider).catch((error: unknown) => {
          Logger.dev('Semantic thread search failed; keeping keyword results.', error)
          return null
        }),
        timedOut
      ])
      if (merged) return { results: merged, semantic: true }
      return { results: keyword, semantic: false }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The keyword rows merged with the semantic half, or null when the semantic
   * half found nothing to add.
   *
   * All-term conversation evidence outranks similarity to only one concept, and
   * exact keyword evidence stays ahead of typo-tolerant evidence.
   */
  private async mergedWithIntent(
    raw: string,
    options: ThreadSearchOptions,
    keyword: readonly ThreadSearchResult[],
    limit: number,
    provider: IntentSearchProvider
  ): Promise<ThreadSearchResult[] | null> {
    const [matches, evidence] = await Promise.all([
      provider(raw, options),
      this.conversationEvidence(raw, options, limit)
    ])
    const grounded = [...keyword.filter((result) => result.kind === 'message'), ...evidence]
    if (matches.length === 0) {
      return evidence.length > 0 ? mergeHybridThreadSearchResults(keyword, grounded, limit) : null
    }
    const threads = await this.threadRepo.listByIdsViaWorker(matches.map((match) => match.threadId))
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    const intent: ThreadSearchResult[] = []
    for (const match of matches) {
      const thread = byId.get(match.threadId)
      if (!thread) continue
      if (!threadMatchesSearchScope(thread, options)) continue
      intent.push({ thread, kind: 'intent', score: match.score })
    }
    if (intent.length === 0 && evidence.length === 0) return null
    return mergeHybridThreadSearchResults(keyword, [...grounded, ...intent], limit)
  }

  private async conversationEvidence(
    raw: string,
    options: ThreadSearchOptions,
    limit: number
  ): Promise<ThreadSearchResult[]> {
    const query = evidenceAnyFtsQuery(raw)
    if (!query) return []
    const required = requiredEvidenceConcepts(queryConcepts(raw).length)
    const built = buildThreadSearchSql(
      raw,
      options,
      this.db.isSearchMetaReady(),
      query,
      EVIDENCE_SNIPPET_TOKENS
    )
    if (!built.fts) return []
    // The same bounded FTS read the keyword pass runs, with the worker and the
    // primary connection as its two homes: this is a ranking read, not a
    // transcript scan, so it follows `keywordSearch`'s degradation instead of
    // answering "no threads found" on an instance whose worker is down.
    const candidates = await this.db.queryViaWorker(
      built.fts.sql,
      built.fts.params,
      threadSearchMessageLimit(limit) * 2
    )
    if (!candidates.ok) return []
    const scored = candidates.rows
      .map((row) => ({
        row,
        coverage: queryConceptCoverage(raw, snippetTextOf(row))
      }))
      .filter((candidate) => candidate.coverage >= required)
      .sort((left, right) => right.coverage - left.coverage)
    return mergeThreadSearchResults(
      [],
      scored.map((candidate) => candidate.row),
      raw,
      limit
    )
  }

  private async keywordSearch(
    raw: string,
    options: ThreadSearchOptions
  ): Promise<{ results: ThreadSearchResult[]; limit: number }> {
    const useSearchMeta = this.db.isSearchMetaReady()
    const built = buildThreadSearchSql(raw, options, useSearchMeta)
    // Both halves are read at once and both are bounded: a title row that is
    // ready must never wait for the message ranking behind it in the worker
    // queue, and neither may hold the answer past the interactive deadline.
    const first = await this.readKeywordHalves(built, raw, INTERACTIVE_SEARCH_DEADLINE_MS)
    if (first.complete) return { results: first.results, limit: built.limit }
    if (first.allFailed) {
      if (first.timedOut) {
        // Both halves ran out of time. A deadline stops the wait, never the
        // answer: the two reads are already queued on the worker, so they are
        // re-issued without a deadline and the rows arrive instead of an empty
        // list that reads to the user as "nothing matches". Nothing here runs on
        // the main thread, and the palette's own watchdog has already stopped
        // claiming to be busy.
        const late = await this.readKeywordHalves(built, raw)
        return { results: late.results, limit: built.limit }
      }
      return { results: this.threadRepo.search(raw, options, useSearchMeta), limit: built.limit }
    }
    // One half answered and the other did not. Use the answer in hand instead
    // of throwing the reply away for a slower, complete one.
    return { results: first.results, limit: built.limit }
  }

  /**
   * Read both keyword halves and report how much of the answer is usable.
   *
   * `deadlineMs` bounds the wait only; the same reads are issued again without
   * one when the whole answer timed out, which is what keeps a busy worker from
   * turning a real match into an empty result.
   */
  private async readKeywordHalves(
    built: ThreadSearchSql,
    raw: string,
    deadlineMs?: number
  ): Promise<{
    results: ThreadSearchResult[]
    complete: boolean
    allFailed: boolean
    timedOut: boolean
  }> {
    const options = deadlineMs === undefined ? {} : { deadlineMs }
    const [title, message] = await Promise.all([
      this.db.queryViaWorker(built.title.sql, built.title.params, built.limit, options),
      built.fts
        ? this.db.queryViaWorker(
            built.fts.sql,
            built.fts.params,
            threadSearchMessageLimit(built.limit),
            options
          )
        : Promise.resolve(null)
    ])
    const results = mergeThreadSearchResults(
      title.ok ? (title.rows ?? []) : [],
      message?.ok ? (message.rows ?? []) : [],
      raw,
      built.limit
    )
    const messageOk = built.fts ? Boolean(message?.ok) : true
    return {
      results,
      complete: title.ok && messageOk,
      allFailed: !title.ok && !messageOk,
      timedOut: Boolean(title.timedOut || message?.timedOut)
    }
  }
}
