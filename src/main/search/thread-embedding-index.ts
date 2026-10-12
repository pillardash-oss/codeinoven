import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from '../database/database'
import type { IntentThreadMatch, ThreadEmbeddingRecord } from '../../lib/search/types'
import { cosineSimilarity, decodeThreadIndex, encodeThreadIndex } from '../../lib/search/vector'
import { Logger } from '../system/logger'

/** How many threads are embedded per model request. */
const INDEX_BATCH_SIZE = 8
/** Hard ceiling on threads considered by one sweep. */
const MAX_THREADS = 20_000
/** Ceiling on message rows read per batch. */
const MESSAGES_PER_BATCH = 4_000
/** Characters of conversation text kept per thread before embedding. */
const MAX_DOCUMENT_CHARS = 8_000
/** Characters kept from each message chunk. */
const MAX_MESSAGE_CHARS = 2_000
/** Cosine floor below which a semantic hit is treated as noise. */
const MIN_INTENT_SCORE = 0.2
/** Persist the on-disk index every this many embedded threads. */
const PERSIST_EVERY = 64

interface CandidateThread {
  id: string
  title: string
  stamp: number
}

export interface SweepResult {
  total: number
  indexed: number
  pending: number
}

/**
 * Embeds a thread's title and conversation into one vector and answers intent
 * queries by cosine similarity.
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

  constructor(
    private readonly db: Database,
    private readonly indexPath: string
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
    } catch {
      // No index yet, or it was removed. Nothing to restore.
    }
  }

  async reset(): Promise<void> {
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
    }
  ): Promise<SweepResult> {
    const candidates = await this.listCandidates()
    if (candidates.length === 0) {
      if (this.records.size > 0) await this.persist()
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
    for (let offset = 0; offset < stale.length; offset += INDEX_BATCH_SIZE) {
      if (options.signal.aborted) break
      const batch = stale.slice(offset, offset + INDEX_BATCH_SIZE)
      await this.indexBatch(batch, embed, options)
      indexed += batch.length
      sinceLastPersist += batch.length
      if (sinceLastPersist >= PERSIST_EVERY) {
        sinceLastPersist = 0
        await this.persist()
      }
      // Yield so a long backfill never monopolizes the event loop.
      await new Promise((resolve) => setImmediate(resolve))
    }
    await this.pruneMissing(new Set(candidates.map((candidate) => candidate.id)))
    await this.persist()
    return { total, indexed, pending }
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

  private async indexBatch(
    batch: readonly CandidateThread[],
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: {
      modelSignature: string
      documentPrefix: string
      expectedDimensions: number
    }
  ): Promise<void> {
    const bodies = await this.loadConversationBodies(batch.map((candidate) => candidate.id))
    const texts = batch.map((candidate) =>
      composeDocument(options.documentPrefix, candidate.title, bodies.get(candidate.id) ?? '')
    )
    const vectors = await embed(texts)
    for (let index = 0; index < batch.length; index += 1) {
      const vector = vectors[index]
      if (!vector || vector.length !== options.expectedDimensions) continue
      const candidate = batch[index]
      this.records.set(candidate.id, {
        threadId: candidate.id,
        contentHash: contentHashOf(options.modelSignature, texts[index]),
        dimensions: vector.length,
        updatedAt: candidate.stamp,
        vector
      })
    }
  }

  private async pruneMissing(present: ReadonlySet<string>): Promise<void> {
    for (const threadId of [...this.records.keys()]) {
      if (!present.has(threadId)) this.records.delete(threadId)
    }
  }

  private async listCandidates(): Promise<CandidateThread[]> {
    const result = await this.db.queryViaWorker(
      `SELECT id, title,
          MAX(COALESCE(last_activity, 0), COALESCE(updated_at, 0)) AS stamp
        FROM threads
        WHERE drafting = 0
        ORDER BY last_activity DESC
        LIMIT ?`,
      [MAX_THREADS],
      MAX_THREADS
    )
    if (!result.ok) return []
    const candidates: CandidateThread[] = []
    for (const row of result.rows) {
      const id = row['id']
      if (typeof id !== 'string' || id.length === 0) continue
      candidates.push({
        id,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        stamp: typeof row['stamp'] === 'number' ? row['stamp'] : 0
      })
    }
    return candidates
  }

  private async loadConversationBodies(threadIds: readonly string[]): Promise<Map<string, string>> {
    const bodies = new Map<string, string>()
    if (threadIds.length === 0) return bodies
    const placeholders = threadIds.map(() => '?').join(',')
    const result = await this.db.queryViaWorker(
      `SELECT thread_id, SUBSTR(search_text, 1, ?) AS chunk
        FROM agent_messages
        WHERE visibility = 'conversation' AND session_id IS NULL
          AND thread_id IN (${placeholders})
        ORDER BY thread_id ASC, created_at ASC`,
      [MAX_MESSAGE_CHARS, ...threadIds],
      MESSAGES_PER_BATCH
    )
    if (!result.ok) return bodies
    for (const row of result.rows) {
      const threadId = row['thread_id']
      const chunk = row['chunk']
      if (typeof threadId !== 'string' || typeof chunk !== 'string' || chunk.length === 0) continue
      const existing = bodies.get(threadId) ?? ''
      if (existing.length >= MAX_DOCUMENT_CHARS) continue
      bodies.set(threadId, `${existing}${existing ? '\n' : ''}${chunk}`)
    }
    return bodies
  }

  private async persist(): Promise<void> {
    const records = [...this.records.values()]
    const encoded = encodeThreadIndex(records)
    const temporary = `${this.indexPath}.tmp`
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
  const trimmedBody = body.slice(0, MAX_DOCUMENT_CHARS)
  const joined = [head, trimmedBody].filter((part) => part.length > 0).join('\n')
  return `${prefix}${joined}`
}

function contentHashOf(modelSignature: string, text: string): string {
  return createHash('sha1').update(modelSignature).update('\u0000').update(text).digest('hex')
}
