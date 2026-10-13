import type { ThreadEmbeddingRecord } from './types'

/**
 * Pure vector math and index codec for intent search. No Node or DOM
 * dependencies so both the main process and tests can use it directly.
 */

/** L2-normalize a vector in place. A zero vector is left untouched. */
export function normalizeInPlace(vector: Float32Array): void {
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) {
    sum += vector[index] * vector[index]
  }
  const norm = Math.sqrt(sum)
  if (norm === 0) return
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm
  }
}

/**
 * Cosine similarity of two equal-length vectors. Callers store normalized
 * vectors, so this reduces to a dot product; the norms are recomputed only as a
 * safety net when a caller passes an unnormalized vector.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

const INDEX_MAGIC = 0x43494f53 // "CIOS"
// Version 3 indexes raw/truncated text first; summaries are optional refinements.
const INDEX_VERSION = 3

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function writeBytes(view: DataView, offset: number, bytes: Uint8Array): number {
  new Uint8Array(view.buffer, view.byteOffset + offset, bytes.length).set(bytes)
  return offset + bytes.length
}

/**
 * Encode the thread index into a compact, versioned binary blob. Storing one
 * record per thread keeps the file small enough to load whole at startup.
 */
export function encodeThreadIndex(records: readonly ThreadEmbeddingRecord[]): Uint8Array {
  let size = 12
  for (const record of records) {
    const idBytes = textEncoder.encode(record.threadId)
    const hashBytes = textEncoder.encode(
      record.sourceHash ? `${record.sourceHash}:${record.contentHash}` : record.contentHash
    )
    size += 4 + idBytes.length + 4 + hashBytes.length + 4 + 8 + record.vector.length * 4
  }
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  let offset = 0
  view.setUint32(offset, INDEX_MAGIC, false)
  offset += 4
  view.setUint32(offset, INDEX_VERSION, false)
  offset += 4
  view.setUint32(offset, records.length, false)
  offset += 4
  for (const record of records) {
    const idBytes = textEncoder.encode(record.threadId)
    const hashBytes = textEncoder.encode(
      record.sourceHash ? `${record.sourceHash}:${record.contentHash}` : record.contentHash
    )
    view.setUint32(offset, idBytes.length, false)
    offset += 4
    offset = writeBytes(view, offset, idBytes)
    view.setUint32(offset, hashBytes.length, false)
    offset += 4
    offset = writeBytes(view, offset, hashBytes)
    view.setUint32(offset, record.dimensions, false)
    offset += 4
    view.setFloat64(offset, record.updatedAt, false)
    offset += 8
    for (let index = 0; index < record.vector.length; index += 1) {
      view.setFloat32(offset, record.vector[index], false)
      offset += 4
    }
  }
  return new Uint8Array(buffer)
}

/** Decode a blob written by {@link encodeThreadIndex}. Returns null when corrupt. */
export function decodeThreadIndex(buffer: Uint8Array): ThreadEmbeddingRecord[] | null {
  if (buffer.byteLength < 12) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.getUint32(0, false) !== INDEX_MAGIC) return null
  if (view.getUint32(4, false) !== INDEX_VERSION) return null
  const count = view.getUint32(8, false)
  let offset = 12
  const records: ThreadEmbeddingRecord[] = []
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 4 > buffer.byteLength) return null
    const idLength = view.getUint32(offset, false)
    offset += 4
    if (offset + idLength > buffer.byteLength) return null
    const threadId = textDecoder.decode(buffer.subarray(offset, offset + idLength))
    offset += idLength
    if (offset + 4 > buffer.byteLength) return null
    const hashLength = view.getUint32(offset, false)
    offset += 4
    if (offset + hashLength > buffer.byteLength) return null
    const storedHash = textDecoder.decode(buffer.subarray(offset, offset + hashLength))
    const [sourceHash, contentHash] = storedHash.includes(':')
      ? storedHash.split(':', 2)
      : [storedHash, storedHash]
    offset += hashLength
    if (offset + 12 > buffer.byteLength) return null
    const dimensions = view.getUint32(offset, false)
    offset += 4
    const updatedAt = view.getFloat64(offset, false)
    offset += 8
    if (offset + dimensions * 4 > buffer.byteLength) return null
    const vector = new Float32Array(dimensions)
    for (let index = 0; index < dimensions; index += 1) {
      vector[index] = view.getFloat32(offset, false)
      offset += 4
    }
    records.push({ threadId, sourceHash, contentHash, dimensions, updatedAt, vector })
  }
  return records
}
