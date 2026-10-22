import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { IntentThreadMatch, ThreadEmbeddingRecord } from '../../lib/search/types'
import { cosineSimilarity, decodeThreadIndex, encodeThreadIndex } from '../../lib/search/vector'

/** Bound both messages and transient encoding allocations. */
export function* embeddingBatches(
  records: Iterable<ThreadEmbeddingRecord>
): Generator<ThreadEmbeddingRecord[]> {
  let batch: ThreadEmbeddingRecord[] = []
  let bytes = 0
  for (const record of records) {
    const size = record.windows.reduce((total, window) => total + window.vector.byteLength, 0)
    if (batch.length && (batch.length >= 64 || bytes + size > 256 * 1024)) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(record)
    bytes += size
  }
  if (batch.length) yield batch
}

// Only the worker uses this snapshot. Pages transfer vector buffers to the
// caller, and completion or the worker's idle teardown releases the remainder.
let loading:
  { id: string; pages: Generator<ThreadEmbeddingRecord[]>; modifiedAt: number } | undefined

export async function readIndexPage(
  path: string,
  snapshot?: string
): Promise<{
  records: ThreadEmbeddingRecord[]
  snapshot: string | null
  modifiedAt: number
}> {
  if (!snapshot) {
    const metadata = await stat(path)
    // This is a rebuildable cache, not conversation storage. Refuse oversized
    // cache input before allocating it on a low-memory machine.
    if (metadata.size > 64 * 1024 * 1024) throw new Error('Search index cache exceeds 64 MiB')
    const records = decodeThreadIndex(await readFile(path))
    if (!records) throw new Error('Search index cache is unreadable')
    loading = { id: randomUUID(), pages: embeddingBatches(records), modifiedAt: metadata.mtimeMs }
  }
  if (!loading || (snapshot && loading.id !== snapshot))
    throw new Error('Search index load expired')
  const current = loading
  const page = current.pages.next()
  if (page.done) loading = undefined
  return {
    records: page.value ?? [],
    snapshot: page.done ? null : current.id,
    modifiedAt: current.modifiedAt
  }
}

export function encodeIndexPage(records: ThreadEmbeddingRecord[]): Uint8Array {
  return encodeThreadIndex(records).slice(12)
}

export function rankIndexPage(
  records: ThreadEmbeddingRecord[],
  query: Float32Array,
  limit: number
): IntentThreadMatch[] {
  const matches: IntentThreadMatch[] = []
  for (const record of records) {
    if (record.dimensions !== query.length) continue
    let score = 0
    for (const window of record.windows) {
      if (window.vector.length === query.length)
        score = Math.max(score, cosineSimilarity(query, window.vector))
    }
    if (score < 0.2) continue
    matches.push({ threadId: record.threadId, score })
  }
  matches.sort((left, right) => right.score - left.score)
  return matches.slice(0, limit)
}
