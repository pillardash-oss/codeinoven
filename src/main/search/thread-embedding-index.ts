import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from '../database/database'
import type {
  IntentThreadMatch,
  ThreadEmbeddingRecord,
  ThreadEmbeddingWindow
} from '../../lib/search/types'
import { cosineSimilarity, decodeThreadIndex, encodeThreadIndex } from '../../lib/search/vector'
import { Logger } from '../system/logger'
import { paceIndexing } from './indexing-pacing'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/types/project'
import {
  ThreadSearchSummaries,
  threadWindowCount,
  threadWindowOffset,
  type SearchSummaryThread
} from './thread-search-summary'

/** Process one thread at a time, including its windows and optional summary. */
const INDEX_BATCH_SIZE = 1
/** Page metadata without loading conversations or blocking the main process. */
const CATALOG_PAGE_SIZE = 256
/** Cosine floor below which a semantic hit is treated as noise. */
const MIN_INTENT_SCORE = 0.2
/** Persist the on-disk index every this many embedded threads. */
const PERSIST_EVERY = 8

type CandidateThread = SearchSummaryThread

export interface SweepResult {
  total: number
  indexed: number
  pending: number
}

/** Whether a record still owes windows for the revision it was read from. */
function needsWindows(record: ThreadEmbeddingRecord): boolean {
  // `planned: 0` is a record written before windows existed (one head vector and
  // no plan), so the next sweep re-plans it and fills in the rest.
  return record.planned === 0 || record.windows.length < record.planned
}

/**
 * Embeds several evenly spread windows of each thread and answers intent queries
 * by cosine similarity. A query matches a thread whose content it lands in
 * anywhere, not only its opening messages.
 *
 * The index is derived from the same corpus the full-text index covers: the
 * thread title plus `agent_messages.search_text` for the main conversation, so
 * keyword and semantic search describe one body of content. Its size is bounded
 * by the threads themselves: a thread holds at most `maxWindows` vectors, and the
 * index lives in memory while the app runs and is persisted as one compact blob
 * so it survives restart.
 */
export class ThreadEmbeddingIndex {
  readonly candidates = new Map<string, CandidateThread>()
  private readonly pendingIds = new Set<string>()
  private removed = new Set<string>()
  private removalTimer: ReturnType<typeof setTimeout> | null = null
  private readonly records = new Map<string, ThreadEmbeddingRecord>()
  private lastPersistedAt = 0
  private persistence: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: Database,
    private readonly indexPath: string,
    private readonly summaries: ThreadSearchSummaries
  ) {}

  get size(): number {
    return this.records.size
  }

  get lastIndexedAt(): number | null {
    return this.lastPersistedAt > 0 ? this.lastPersistedAt : null
  }

  has(threadId: string): boolean {
    return this.records.has(threadId)
  }

  async load(): Promise<void> {
    try {
      const buffer = await readFile(this.indexPath)
      const decoded = decodeThreadIndex(new Uint8Array(buffer))
      if (!decoded) {
        Logger.dev('Thread embedding index was unreadable; it will be rebuilt.')
        return
      }
      for (const record of decoded) this.records.set(record.threadId, record)
      this.lastPersistedAt = (await stat(this.indexPath)).mtimeMs
    } catch {
      // No index yet, or it was removed. Nothing to restore.
    }
  }

  async initializeCorpus(): Promise<void> {
    for (const thread of await this.listCandidates()) {
      if (!this.removed.has(thread.id) && !this.candidates.has(thread.id)) this.updateThread(thread)
    }
    await this.pruneMissing(new Set(this.candidates.keys()))
    await this.persist()
  }

  removeThread(id: string): void {
    this.candidates.delete(id)
    this.pendingIds.delete(id)
    this.removed.add(id)
    if (!this.records.delete(id)) return
    if (this.removalTimer) clearTimeout(this.removalTimer)
    this.removalTimer = setTimeout(() => {
      this.removalTimer = null
      void this.persist()
    }, 250)
    this.removalTimer.unref()
  }

  updateThread(thread: CandidateThread): void {
    this.removed.delete(thread.id)
    this.candidates.set(thread.id, thread)
    const record = this.records.get(thread.id)
    if (!record || record.updatedAt < thread.stamp || needsWindows(record))
      this.pendingIds.add(thread.id)
    else this.pendingIds.delete(thread.id)
  }

  get pending(): number {
    return this.pendingIds.size
  }

  async dispose(): Promise<void> {
    if (this.removalTimer) clearTimeout(this.removalTimer)
    this.removalTimer = null
    await this.persist()
  }

  async reset(): Promise<void> {
    await this.persistence.catch(() => undefined)
    this.records.clear()
    for (const id of this.candidates.keys()) this.pendingIds.add(id)
    this.lastPersistedAt = 0
    await rm(this.indexPath, { force: true }).catch(() => undefined)
  }

  /**
   * Embed every thread that changed, or still owes windows, since it was last
   * indexed, in bounded batches that yield to the event loop between requests.
   * Returns how many threads the corpus holds and how many were pending when it
   * started.
   */
  async sweep(
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: {
      modelSignature: string
      documentPrefix: string
      windowChars: number
      maxWindows: number
      expectedDimensions: number
      signal: AbortSignal
      onOversized?: (thread: SearchSummaryThread) => void
      onProgress?: (result: SweepResult) => void
      onError?: (thread: SearchSummaryThread, error: unknown) => void
      onThreadProgress?: (thread: SearchSummaryThread, stage: 'embedding', windows: number) => void
    }
  ): Promise<SweepResult> {
    const candidates = [...this.candidates.values()]
    if (candidates.length === 0) {
      await this.pruneMissing(new Set())
      await this.summaries.prune([])
      await this.persist()
      return { total: 0, indexed: 0, pending: 0 }
    }
    const stale = candidates
      .filter((candidate) => {
        const record = this.records.get(candidate.id)
        return !record || record.updatedAt < candidate.stamp || needsWindows(record)
      })
      // Most recently active first: the threads a user is working in and is most
      // likely to search for are the first to carry a complete set of windows.
      .sort((left, right) => right.stamp - left.stamp)
    const total = candidates.length
    const pending = stale.length
    let indexed = 0
    let sinceLastPersist = 0
    options.onProgress?.({ total, indexed, pending })
    try {
      for (let offset = 0; offset < stale.length; offset += INDEX_BATCH_SIZE) {
        options.signal.throwIfAborted()
        const startedAt = performance.now()
        const batch = stale.slice(offset, offset + INDEX_BATCH_SIZE)
        let embedded = false
        try {
          embedded = await this.indexThread(batch[0], embed, options)
          indexed += batch.length
        } catch (error) {
          if (options.signal.aborted) throw error
          options.onError?.(batch[0], error)
        }
        options.onProgress?.({ total, indexed, pending: pending - indexed })
        sinceLastPersist += batch.length
        if (sinceLastPersist >= PERSIST_EVERY) {
          sinceLastPersist = 0
          await this.persist()
        }
        if (embedded && offset + INDEX_BATCH_SIZE < stale.length)
          await paceIndexing(startedAt, options.signal)
        else await new Promise<void>((resolve) => setImmediate(resolve))
      }
      await this.pruneMissing(new Set(this.candidates.keys()))
      await this.summaries.prune(candidates)
      return { total, indexed, pending: pending - indexed }
    } finally {
      // Preserve completed threads even if a later provider request fails.
      await this.persist()
    }
  }

  /** Rank indexed threads by the best cosine similarity across their windows. */
  search(queryVector: Float32Array, limit: number): IntentThreadMatch[] {
    const matches: IntentThreadMatch[] = []
    for (const record of this.records.values()) {
      if (record.dimensions !== queryVector.length) continue
      let best = 0
      for (const window of record.windows) {
        if (window.vector.length !== queryVector.length) continue
        const score = cosineSimilarity(queryVector, window.vector)
        if (score > best) best = score
      }
      if (best < MIN_INTENT_SCORE) continue
      matches.push({ threadId: record.threadId, score: best })
    }
    matches.sort((left, right) => right.score - left.score)
    return matches.slice(0, limit)
  }

  /**
   * Add the optional whole-thread summary as one more vector a thread is scored
   * by. It describes the thread globally, which the windows cannot, so it
   * complements them instead of replacing the content they already located.
   */
  async applySummary(
    thread: SearchSummaryThread,
    vector: Float32Array,
    summary: string,
    modelSignature: string
  ): Promise<boolean> {
    const record = this.records.get(thread.id)
    if (!record || record.updatedAt !== thread.stamp || vector.length !== record.dimensions)
      return false
    const contentHash = contentHashOf(modelSignature, summary)
    if (record.windows.some((window) => window.contentHash === contentHash)) return false
    this.records.set(thread.id, {
      ...record,
      windows: [...record.windows, { vector, contentHash }]
    })
    await this.persist()
    return true
  }

  /**
   * Index one thread: plan its coverage windows, embed the ones whose text is
   * new, and reuse the rest. Returns whether the model was asked for anything,
   * so the sweep only paces itself after real work.
   */
  private async indexThread(
    candidate: CandidateThread,
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: {
      modelSignature: string
      documentPrefix: string
      windowChars: number
      maxWindows: number
      expectedDimensions: number
      signal: AbortSignal
      onOversized?: (thread: SearchSummaryThread) => void
      onThreadProgress?: (thread: SearchSummaryThread, stage: 'embedding', windows: number) => void
    }
  ): Promise<boolean> {
    const plan = await this.summaries.plan(candidate, options.signal)
    const count = threadWindowCount(plan.total, options.windowChars, options.maxWindows)
    const existing = this.records.get(candidate.id)
    const windows: (ThreadEmbeddingWindow | undefined)[] = new Array(count)
    const pending: { index: number; document: string }[] = []
    for (let index = 0; index < count; index += 1) {
      options.signal.throwIfAborted()
      const offset = threadWindowOffset(index, count, plan.total, options.windowChars)
      const text = await this.summaries.window(plan, offset, options.windowChars, options.signal)
      // Windows carry the model's document prompt but not the thread title: the
      // title is one signal, and repeating it in every window would pull all of
      // them toward it instead of toward the conversation each one covers.
      const document = composeDocument(options.documentPrefix, '', text)
      const contentHash = contentHashOf(options.modelSignature, document)
      const previous = existing?.windows.find((window) => window.contentHash === contentHash)
      if (previous) windows[index] = previous
      else pending.push({ index, document })
    }
    if (pending.length > 0) {
      options.onThreadProgress?.(candidate, 'embedding', pending.length)
      const vectors = await embed(pending.map((entry) => entry.document))
      for (let position = 0; position < pending.length; position += 1) {
        const vector = vectors[position]
        if (!vector || vector.length !== options.expectedDimensions) {
          throw new Error('The embedding model returned an unexpected vector dimension.')
        }
        const entry = pending[position]
        windows[entry.index] = {
          vector,
          contentHash: contentHashOf(options.modelSignature, entry.document)
        }
      }
    }
    if (this.removed.has(candidate.id) || !this.candidates.has(candidate.id))
      return pending.length > 0
    const complete = windows.filter((window): window is ThreadEmbeddingWindow => Boolean(window))
    if (complete.length === 0) return pending.length > 0
    this.records.set(candidate.id, {
      threadId: candidate.id,
      dimensions: complete[0].vector.length,
      updatedAt: candidate.stamp,
      windows: complete,
      planned: count,
      width: options.windowChars
    })
    if ((this.candidates.get(candidate.id)?.stamp ?? Infinity) <= candidate.stamp)
      this.pendingIds.delete(candidate.id)
    // The windows could not describe everything this thread holds, so the
    // provider-backed summary is worth one bounded request.
    if (plan.total > count * options.windowChars) options.onOversized?.(candidate)
    return pending.length > 0
  }

  private async pruneMissing(present: ReadonlySet<string>): Promise<void> {
    for (const threadId of [...this.records.keys()]) {
      if (!present.has(threadId)) this.records.delete(threadId)
    }
  }

  private async listCandidates(): Promise<CandidateThread[]> {
    const rows: Record<string, unknown>[] = []
    let cursor = ''
    while (true) {
      const result = await this.db.queryViaWorker(
        `SELECT id, project_id, title,
            MAX(COALESCE(last_activity, 0), COALESCE(updated_at, 0)) AS stamp
          FROM threads WHERE drafting = 0 AND project_id != ? AND id > ?
          ORDER BY id LIMIT ?`,
        [GLOBAL_BROWSER_PROJECT_ID, cursor, CATALOG_PAGE_SIZE],
        CATALOG_PAGE_SIZE
      )
      if (!result.ok) throw new Error('The threads could not be read for search indexing.')
      rows.push(...result.rows)
      if (result.rows.length < CATALOG_PAGE_SIZE) break
      cursor = String(result.rows[result.rows.length - 1]['id'])
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const candidates: CandidateThread[] = []
    for (const row of rows) {
      const id = row['id']
      if (typeof id !== 'string' || id.length === 0) continue
      candidates.push({
        id,
        projectId: typeof row['project_id'] === 'string' ? row['project_id'] : '',
        title: typeof row['title'] === 'string' ? row['title'] : '',
        stamp: typeof row['stamp'] === 'number' ? row['stamp'] : 0
      })
    }
    return candidates
  }

  private persist(): Promise<void> {
    this.persistence = this.persistence.catch(() => undefined).then(() => this.writeSnapshot())
    return this.persistence
  }

  private async writeSnapshot(): Promise<void> {
    const records = [...this.records.values()]
    const encoded = encodeThreadIndex(records)
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.indexPath), { recursive: true })
      await writeFile(temporary, encoded, { mode: 0o600 })
      await rename(temporary, this.indexPath)
      this.lastPersistedAt = Date.now()
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      Logger.error('Failed to persist the thread embedding index:', error)
    }
  }
}

/** The exact text an embedding model sees for one thread window. */
export function composeDocument(prefix: string, title: string, body: string): string {
  const head = title.trim()
  const trimmedBody = body
  const joined = [head, trimmedBody].filter((part) => part.length > 0).join('\n')
  return `${prefix}${joined}`
}

function contentHashOf(modelSignature: string, text: string): string {
  return createHash('sha1').update(modelSignature).update('\u0000').update(text).digest('hex')
}
