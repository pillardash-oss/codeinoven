import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from '../database/database'
import type { IntentThreadMatch, ThreadEmbeddingRecord } from '../../lib/search/types'
import { cosineSimilarity, decodeThreadIndex, encodeThreadIndex } from '../../lib/search/vector'
import { Logger } from '../system/logger'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/types/project'
import { ThreadSearchSummaries, type SearchSummaryThread } from './thread-search-summary'

/** Process one thread at a time, including provider summaries and embeddings. */
const INDEX_BATCH_SIZE = 1
/** Hard ceiling on threads considered by one sweep. */
const MAX_THREADS = 20_000
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

  async reset(): Promise<void> {
    await this.persistence.catch(() => undefined)
    this.records.clear()
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
    const candidates = await this.listCandidates()
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
        const batch = stale.slice(offset, offset + INDEX_BATCH_SIZE)
        try {
          await this.indexBatch(batch, embed, options)
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
        // Yield so a long backfill never monopolizes the event loop.
        await new Promise((resolve) => setImmediate(resolve))
      }
      await this.pruneMissing(new Set(candidates.map((candidate) => candidate.id)))
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
  ): Promise<void> {
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
      this.records.set(candidate.id, {
        threadId: candidate.id,
        contentHash: contentHashOf(options.modelSignature, texts[index]),
        dimensions: vector.length,
        updatedAt: candidate.stamp,
        vector
      })
      if (oversized[index])
        options.onOversized?.(candidate, contentHashOf(options.modelSignature, texts[index]))
    }
  }

  private async pruneMissing(present: ReadonlySet<string>): Promise<void> {
    for (const threadId of [...this.records.keys()]) {
      if (!present.has(threadId)) this.records.delete(threadId)
    }
  }

  private async listCandidates(): Promise<CandidateThread[]> {
    const result = await this.db.queryViaWorker(
      `SELECT id, project_id, title,
          MAX(COALESCE(last_activity, 0), COALESCE(updated_at, 0)) AS stamp
        FROM threads
        WHERE drafting = 0 AND project_id != ?
        ORDER BY last_activity DESC
        LIMIT ?`,
      [GLOBAL_BROWSER_PROJECT_ID, MAX_THREADS],
      MAX_THREADS
    )
    if (!result.ok) throw new Error('The threads could not be read for search indexing.')
    const candidates: CandidateThread[] = []
    for (const row of result.rows) {
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
