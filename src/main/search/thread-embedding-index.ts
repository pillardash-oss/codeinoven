import { subscribeArchiveChanges } from '../database/archive-events'
import { unarchivedThreadSql } from '../../lib/archives'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Database } from '../database/database'
import type {
  IntentThreadMatch,
  ThreadEmbeddingRecord,
  ThreadEmbeddingWindow
} from '../../lib/search/types'
import { encodeThreadIndex } from '../../lib/search/vector'
import { Logger } from '../system/logger'
import { backgroundIo } from '../system/background-io'
import { embeddingBatches } from './thread-index-work'
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
/** Persist the on-disk index every this many embedded threads. */
const PERSIST_EVERY = 8

type CandidateThread = SearchSummaryThread

export interface SweepResult {
  total: number
  indexed: number
  pending: number
}

/**
 * How one thread's windows are embedded. Shared by the corpus sweep and the
 * targeted pass a settled run triggers, so both describe a window identically.
 */
export interface ThreadIndexOptions {
  modelSignature: string
  /** Document prompt the model expects in front of its input. */
  documentPrefix: string
  windowChars: number
  maxWindows: number
  expectedDimensions: number
  signal: AbortSignal
  onOversized?: (thread: SearchSummaryThread) => void
  onThreadProgress?: (thread: SearchSummaryThread, stage: 'embedding', windows: number) => void
}

/** A corpus sweep adds whole-corpus progress and per-thread failure reporting. */
export interface SweepOptions extends ThreadIndexOptions {
  onProgress?: (result: SweepResult) => void
  onError?: (thread: SearchSummaryThread, error: unknown) => void
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
  private readonly parkedIds = new Set<string>()
  private readonly unsubscribeArchives: () => void
  private readonly pendingIds = new Set<string>()
  private removed = new Set<string>()
  private removalTimer: ReturnType<typeof setTimeout> | null = null
  private readonly records = new Map<string, ThreadEmbeddingRecord>()
  private lastPersistedAt = 0
  private persistence: Promise<void> | null = null
  private persistenceDirty = false
  private generation = 0
  private loading: Promise<void> | null = null

  constructor(
    private readonly db: Database,
    private readonly indexPath: string,
    private readonly summaries: ThreadSearchSummaries
  ) {
    this.unsubscribeArchives = subscribeArchiveChanges(() => this.refreshArchiveVisibility())
  }

  get size(): number {
    return this.records.size
  }

  get lastIndexedAt(): number | null {
    return this.lastPersistedAt > 0 ? this.lastPersistedAt : null
  }

  isParked(threadId: string): boolean {
    return this.parkedIds.has(threadId)
  }

  has(threadId: string): boolean {
    return this.records.has(threadId)
  }

  load(): Promise<void> {
    if (this.loading) return this.loading
    const generation = this.generation
    const request = this.loadSnapshot(generation).finally(() => {
      if (this.loading === request) this.loading = null
    })
    this.loading = request
    return request
  }

  private async loadSnapshot(generation: number): Promise<void> {
    try {
      let snapshot: string | undefined
      do {
        const page = await backgroundIo<{
          records: ThreadEmbeddingRecord[]
          snapshot: string | null
          modifiedAt: number
        }>({ kind: 'index-read', path: this.indexPath, snapshot })
        if (generation !== this.generation) return
        for (const record of page.records) this.records.set(record.threadId, record)
        this.lastPersistedAt = page.modifiedAt
        snapshot = page.snapshot ?? undefined
      } while (snapshot)
    } catch {
      if (generation !== this.generation) return
      this.records.clear()
      this.lastPersistedAt = 0
      // A missing, oversized or interrupted cache is rebuilt from conversations.
    }
  }

  async initializeCorpus(): Promise<void> {
    for (const thread of await this.listCandidates()) {
      if (!this.removed.has(thread.id) && !this.candidates.has(thread.id)) this.updateThread(thread)
    }
    await this.refreshArchiveVisibility()
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
    if (this.parkedIds.has(thread.id)) {
      this.pendingIds.delete(thread.id)
      return
    }
    if (!record || record.updatedAt < thread.stamp || needsWindows(record))
      this.pendingIds.add(thread.id)
    else this.pendingIds.delete(thread.id)
  }

  /** Keep existing vectors while taking parked work off the indexing queue. */
  async refreshArchiveVisibility(): Promise<void> {
    const ids = [...this.candidates.keys()]
    for (let offset = 0; offset < ids.length; offset += 128) {
      const batch = ids.slice(offset, offset + 128)
      const result = await this.db.queryViaWorker(
        `SELECT id FROM threads WHERE id IN (${batch.map(() => '?').join(',')}) AND ${unarchivedThreadSql()}`,
        batch,
        batch.length,
        { allowPrimaryFallback: false }
      )
      if (!result.ok) throw new Error('Could not read archive visibility for indexing')
      const visible = new Set(result.rows.map((row) => String(row.id)))
      for (const id of batch) {
        if (visible.has(id)) {
          this.parkedIds.delete(id)
          const candidate = this.candidates.get(id)
          if (candidate) this.updateThread(candidate)
        } else {
          this.parkedIds.add(id)
          this.pendingIds.delete(id)
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  get pending(): number {
    return this.pendingIds.size
  }

  async dispose(): Promise<void> {
    this.generation += 1
    this.loading = null
    this.unsubscribeArchives()
    if (this.removalTimer) clearTimeout(this.removalTimer)
    this.removalTimer = null
    await this.persist()
  }

  async reset(): Promise<void> {
    this.generation += 1
    this.loading = null
    await this.persistence?.catch(() => undefined)
    this.records.clear()
    for (const id of this.candidates.keys()) if (!this.parkedIds.has(id)) this.pendingIds.add(id)
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
    options: SweepOptions
  ): Promise<SweepResult> {
    const candidates = [...this.candidates.values()].filter(
      (candidate) => !this.parkedIds.has(candidate.id)
    )
    if (candidates.length === 0) {
      await this.pruneMissing(new Set(this.candidates.keys()))
      await this.summaries.prune([...this.candidates.values()])
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
      await this.summaries.prune([...this.candidates.values()])
      return { total, indexed, pending: pending - indexed }
    } finally {
      // Preserve completed threads even if a later provider request fails.
      await this.persist()
    }
  }

  /**
   * Index one thread now, reusing every window whose text did not change, and
   * persist the result.
   *
   * A run that just settled is the thread its user is most likely to search next,
   * so it goes into the index ahead of the sweep rather than behind it: a first
   * full pass over a large corpus can run for hours, and the periodic pass adds up
   * to five more minutes on top. The targeted pass runs beside a sweep the way the
   * runtime serializes its own embedding queue, so a fresh conversation is
   * searchable as soon as its windows are embedded.
   *
   * Returns whether a record was written. A thread no longer in the corpus is
   * `false` without doing any work.
   */
  async indexNow(
    threadId: string,
    embed: (texts: readonly string[]) => Promise<Float32Array[]>,
    options: ThreadIndexOptions
  ): Promise<boolean> {
    const candidate = this.candidates.get(threadId)
    if (!candidate || this.parkedIds.has(threadId)) return false
    try {
      await this.indexThread(candidate, embed, options)
      return true
    } finally {
      await this.persist()
    }
  }

  /** Rank indexed threads by the best cosine similarity across their windows. */
  async search(queryVector: Float32Array, limit: number): Promise<IntentThreadMatch[]> {
    const generation = this.generation
    let matches: IntentThreadMatch[] = []
    for (const records of embeddingBatches(this.records.values())) {
      const visible = records.filter((record) => !this.parkedIds.has(record.threadId))
      const ranked = await backgroundIo<IntentThreadMatch[]>({
        kind: 'index-rank',
        records: visible,
        query: queryVector,
        limit
      })
      if (generation !== this.generation) return []
      matches.push(...ranked)
      matches.sort((left, right) => right.score - left.score)
      matches = matches.slice(0, limit)
    }
    return matches.filter(
      (match) => !this.parkedIds.has(match.threadId) && this.records.has(match.threadId)
    )
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
    if (this.parkedIds.has(thread.id)) return false
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
    options: ThreadIndexOptions
  ): Promise<boolean> {
    const eligible = await this.db.queryViaWorker(
      `SELECT id FROM threads WHERE id = ? AND ${unarchivedThreadSql()}`,
      [candidate.id],
      1,
      { allowPrimaryFallback: false }
    )
    if (!eligible.ok) throw new Error('Could not read archive visibility for indexing')
    if (eligible.rows.length === 0) {
      this.parkedIds.add(candidate.id)
      this.pendingIds.delete(candidate.id)
      return false
    }
    const plan = await this.summaries.plan(candidate, options.signal)
    if (plan.total === 0) {
      // Nothing to describe yet: a thread whose conversation has no indexed text
      // is not searchable by meaning, and a vector of the empty document would
      // only add noise to every result. Membership is re-established by the next
      // corpus update, which is the moment the thread gains a message.
      this.records.delete(candidate.id)
      this.pendingIds.delete(candidate.id)
      this.candidates.delete(candidate.id)
      return false
    }
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
    if (this.parkedIds.has(candidate.id)) return false
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
        `SELECT t.id, t.project_id, t.title,
            MAX(COALESCE(t.last_activity, 0), COALESCE(t.updated_at, 0)) AS stamp
          FROM threads t WHERE t.project_id != ? AND t.id > ?
            AND EXISTS (
              SELECT 1 FROM agent_messages m
               WHERE m.thread_id = t.id AND m.visibility = 'conversation'
                 AND m.session_id IS NULL AND m.search_text != ''
            )
          ORDER BY t.id LIMIT ?`,
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
    this.persistenceDirty = true
    this.persistence ??= (async () => {
      try {
        while (this.persistenceDirty) {
          this.persistenceDirty = false
          await this.writeSnapshot()
        }
      } finally {
        this.persistence = null
      }
    })()
    return this.persistence
  }

  private async writeSnapshot(): Promise<void> {
    const records = [...this.records.values()]
    const header = encodeThreadIndex([])
    new DataView(header.buffer).setUint32(8, records.length, false)
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.indexPath), { recursive: true })
      const file = await open(temporary, 'w', 0o600)
      try {
        await file.writeFile(header)
        let bytes = header.length
        for (const batch of embeddingBatches(records)) {
          const encoded = await backgroundIo<Uint8Array>({ kind: 'index-encode', records: batch })
          bytes += encoded.byteLength
          if (bytes > 64 * 1024 * 1024) throw new Error('Search index cache exceeds 64 MiB')
          await file.writeFile(encoded)
        }
      } finally {
        await file.close()
      }
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
