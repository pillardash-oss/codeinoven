import type { ThreadEmbeddingRecord, ThreadEmbeddingWindow } from './types'

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
// Version 4 indexes several evenly spread windows per thread (see
// ThreadEmbeddingRecord); version 3 held one head vector and is still read so an
// upgrade keeps answering from the existing index instead of blanking it.
const INDEX_VERSION = 4
const HEAD_ONLY_INDEX_VERSION = 3

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
    size += 4 + idBytes.length + 4 + 4 + 8 + 4
    for (const window of record.windows) {
      size += 4 + textEncoder.encode(window.contentHash).length + 4 + window.vector.length * 4
    }
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
    view.setUint32(offset, idBytes.length, false)
    offset += 4
    offset = writeBytes(view, offset, idBytes)
    view.setUint32(offset, record.planned, false)
    offset += 4
    view.setUint32(offset, record.width, false)
    offset += 4
    view.setFloat64(offset, record.updatedAt, false)
    offset += 8
    view.setUint32(offset, record.windows.length, false)
    offset += 4
    for (const window of record.windows) {
      const hashBytes = textEncoder.encode(window.contentHash)
      view.setUint32(offset, hashBytes.length, false)
      offset += 4
      offset = writeBytes(view, offset, hashBytes)
      view.setUint32(offset, window.vector.length, false)
      offset += 4
      for (let index = 0; index < window.vector.length; index += 1) {
        view.setFloat32(offset, window.vector[index], false)
        offset += 4
      }
    }
  }
  return new Uint8Array(buffer)
}

/** Decode a blob written by {@link encodeThreadIndex}. Returns null when corrupt. */
export function decodeThreadIndex(buffer: Uint8Array): ThreadEmbeddingRecord[] | null {
  if (buffer.byteLength < 12) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (view.getUint32(0, false) !== INDEX_MAGIC) return null
  const version = view.getUint32(4, false)
  if (version !== INDEX_VERSION && version !== HEAD_ONLY_INDEX_VERSION) return null
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
    if (version === HEAD_ONLY_INDEX_VERSION) {
      const headOnly = readHeadOnlyRecord(view, buffer, offset, threadId)
      if (!headOnly) return null
      records.push(headOnly.record)
      offset = headOnly.offset
      continue
    }
    if (offset + 20 > buffer.byteLength) return null
    const planned = view.getUint32(offset, false)
    offset += 4
    const width = view.getUint32(offset, false)
    offset += 4
    const updatedAt = view.getFloat64(offset, false)
    offset += 8
    const windowCount = view.getUint32(offset, false)
    offset += 4
    const windows: ThreadEmbeddingWindow[] = []
    let dimensions = 0
    for (let index = 0; index < windowCount; index += 1) {
      const decoded = readWindow(view, buffer, offset)
      if (!decoded) return null
      windows.push(decoded.window)
      offset = decoded.offset
      dimensions = decoded.window.vector.length
    }
    records.push({ threadId, planned, width, updatedAt, dimensions, windows })
  }
  return records
}

interface DecodedWindow {
  window: ThreadEmbeddingWindow
  offset: number
}

function readWindow(view: DataView, buffer: Uint8Array, start: number): DecodedWindow | null {
  let offset = start
  if (offset + 4 > buffer.byteLength) return null
  const hashLength = view.getUint32(offset, false)
  offset += 4
  if (offset + hashLength > buffer.byteLength) return null
  const contentHash = textDecoder.decode(buffer.subarray(offset, offset + hashLength))
  offset += hashLength
  if (offset + 4 > buffer.byteLength) return null
  const dimensions = view.getUint32(offset, false)
  offset += 4
  if (dimensions === 0 || offset + dimensions * 4 > buffer.byteLength) return null
  const vector = new Float32Array(dimensions)
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = view.getFloat32(offset, false)
    offset += 4
  }
  return { window: { vector, contentHash }, offset }
}

/**
 * Read one version-3 record: a single head vector described by a hash that
 * encoded the raw and summary fingerprints as `source:content`.
 */
function readHeadOnlyRecord(
  view: DataView,
  buffer: Uint8Array,
  start: number,
  threadId: string
): { record: ThreadEmbeddingRecord; offset: number } | null {
  let offset = start
  if (offset + 4 > buffer.byteLength) return null
  const hashLength = view.getUint32(offset, false)
  offset += 4
  if (offset + hashLength > buffer.byteLength) return null
  const storedHash = textDecoder.decode(buffer.subarray(offset, offset + hashLength))
  offset += hashLength
  if (offset + 12 > buffer.byteLength) return null
  const dimensions = view.getUint32(offset, false)
  offset += 4
  const updatedAt = view.getFloat64(offset, false)
  offset += 8
  if (dimensions === 0 || offset + dimensions * 4 > buffer.byteLength) return null
  const vector = new Float32Array(dimensions)
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = view.getFloat32(offset, false)
    offset += 4
  }
  return {
    record: {
      threadId,
      dimensions,
      updatedAt,
      windows: [{ vector, contentHash: storedHash }],
      // The version-3 layout recorded no plan: the next sweep re-plans it and
      // tops the record up with the windows the thread now needs.
      planned: 0,
      width: 0
    },
    offset
  }
}
