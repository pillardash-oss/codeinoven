import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from '../database/database'
import type { IntentThreadMatch, ThreadEmbeddingRecord } from '../../lib/search/types'
import { cosineSimilarity, decodeThreadIndex, encodeThreadIndex } from '../../lib/search/vector'
import { Logger } from '../system/logger'
import { paceIndexing } from './indexing-pacing'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/types/project'
import { ThreadSearchSummaries, type SearchSummaryThread } from './thread-search-summary'

/** Process one thread at a time, including provider summaries and embeddings. */
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

/**
 * Embeds raw thread text first, then optionally refines oversized documents
 * with a cached summary. Queries compare the vectors by cosine similarity.
 *
 * The index is derived from the same corpus the full-text index covers: the
 * thread title plus `agent_messages.search_text` for the main conversation, so
 * keyword and semantic search describe one body of content. It lives entirely
 * in memory while the app runs (a few thousand 768-dimension vectors is small)
 * and is persisted as one compact blob so it survives restart.
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
    if (!record || record.updatedAt < thread.stamp) this.pendingIds.add(thread.id)
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
   * Embed every thread whose content changed since it was last indexed, in
   * bounded batches that yield to the event loop between requests. Returns how
   * many threads the corpus holds and how many were pending when it started.
   */
  async sweep(
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: {
      modelSignature: string
      documentPrefix: string
      expectedDimensions: number
      signal: AbortSignal
      fitsContext: (text: string) => Promise<boolean>
      documentChars?: number
      onOversized?: (thread: SearchSummaryThread, contentHash: string) => void
      onProgress?: (result: SweepResult) => void
      onError?: (thread: SearchSummaryThread, error: unknown) => void
      onThreadProgress?: (
        thread: SearchSummaryThread,
        stage: 'summarizing' | 'embedding',
        chunks: number
      ) => void
    }
  ): Promise<SweepResult> {
    const candidates = [...this.candidates.values()]
    if (candidates.length === 0) {
      await this.pruneMissing(new Set())
      await this.summaries.prune([])
      await this.persist()
      return { total: 0, indexed: 0, pending: 0 }
    }
    const stale = candidates.filter((candidate) => {
      const record = this.records.get(candidate.id)
      return !record || record.updatedAt < candidate.stamp
    })
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
          embedded = await this.indexBatch(batch, embed, options)
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

  /** Rank indexed threads by cosine similarity to the query vector. */
  search(queryVector: Float32Array, limit: number): IntentThreadMatch[] {
    const matches: IntentThreadMatch[] = []
    for (const record of this.records.values()) {
      if (record.dimensions !== queryVector.length) continue
      const score = cosineSimilarity(queryVector, record.vector)
      if (score < MIN_INTENT_SCORE) continue
      matches.push({ threadId: record.threadId, score })
    }
    matches.sort((left, right) => right.score - left.score)
    return matches.slice(0, limit)
  }

  /** Replace only the exact raw revision that queued this optional summary. */
  async applySummary(
    thread: SearchSummaryThread,
    expectedHash: string,
    vector: Float32Array,
    summary: string,
    modelSignature: string
  ): Promise<boolean> {
    const record = this.records.get(thread.id)
    if (
      !record ||
      record.updatedAt !== thread.stamp ||
      record.contentHash !== expectedHash ||
      vector.length !== record.dimensions
    )
      return false
    this.records.set(thread.id, {
      ...record,
      vector,
      contentHash: contentHashOf(modelSignature, summary)
    })
    await this.persist()
    return true
  }

  private async indexBatch(
    batch: readonly CandidateThread[],
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: {
      modelSignature: string
      documentPrefix: string
      expectedDimensions: number
      signal: AbortSignal
      fitsContext: (text: string) => Promise<boolean>
      documentChars?: number
      onOversized?: (thread: SearchSummaryThread, contentHash: string) => void
      onThreadProgress?: (
        thread: SearchSummaryThread,
        stage: 'summarizing' | 'embedding',
        chunks: number
      ) => void
    }
  ): Promise<boolean> {
    const texts: string[] = []
    const oversized: boolean[] = []
    for (const candidate of batch) {
      options.onThreadProgress?.(candidate, 'embedding', 0)
      const content = await this.summaries.document(
        candidate,
        options.signal,
        options.documentChars
      )
      const text = composeDocument(options.documentPrefix, candidate.title, content)
      const sourceHash = contentHashOf(options.modelSignature, text)
      const existing = this.records.get(candidate.id)
      if (existing && (existing.sourceHash ?? existing.contentHash) === sourceHash) {
        existing.updatedAt = candidate.stamp
        existing.sourceHash = sourceHash
        if ((this.candidates.get(candidate.id)?.stamp ?? Infinity) <= candidate.stamp)
          this.pendingIds.delete(candidate.id)
        return false
      }
      oversized.push(!(await options.fitsContext(text)))
      texts.push(text)
    }
    const vectors = await embed(texts)
    for (let index = 0; index < batch.length; index += 1) {
      const vector = vectors[index]
      if (!vector || vector.length !== options.expectedDimensions) {
        throw new Error('The embedding model returned an unexpected vector dimension.')
      }
      const candidate = batch[index]
      if (this.removed.has(candidate.id) || !this.candidates.has(candidate.id)) continue
      this.records.set(candidate.id, {
        threadId: candidate.id,
        contentHash: contentHashOf(options.modelSignature, texts[index]),
        sourceHash: contentHashOf(options.modelSignature, texts[index]),
        dimensions: vector.length,
        updatedAt: candidate.stamp,
        vector
      })
      if ((this.candidates.get(candidate.id)?.stamp ?? Infinity) <= candidate.stamp)
        this.pendingIds.delete(candidate.id)
      if (oversized[index])
        options.onOversized?.(candidate, contentHashOf(options.modelSignature, texts[index]))
    }
    return true
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

/** The exact text an embedding model sees for one thread. */
export function composeDocument(prefix: string, title: string, body: string): string {
  const head = title.trim()
  const trimmedBody = body
  const joined = [head, trimmedBody].filter((part) => part.length > 0).join('\n')
  return `${prefix}${joined}`
}

function contentHashOf(modelSignature: string, text: string): string {
  return createHash('sha1').update(modelSignature).update('\u0000').update(text).digest('hex')
}
