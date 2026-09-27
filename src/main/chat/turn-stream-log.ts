import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { StorageEngine } from '../storage/storage-engine'
import type { TurnStreamEvent } from './turn-stream'

/**
 * Bounded hydration of a durable per-thread stream log.
 *
 * The log (`threads/<threadId>/stream.jsonl`) is append-only and thread-wide, so
 * a long-lived thread's file reaches hundreds of megabytes. Reading it whole
 * cost the main process a single allocation of the entire file plus its decoded
 * string plus the per-line split array: on the largest real log that was ~1 GB
 * of transient memory and ~3 s of blocked main thread, which is what made
 * opening a thread freeze the whole app on a machine under memory pressure.
 *
 * This walks the log in fixed-size chunks instead. Peak memory stays flat (a
 * chunk plus the events the current turn actually needs) and the event loop is
 * handed back between chunks, so a large log costs latency, never a frozen app.
 *
 * Only the current turn's events are retained. The fold (`foldTurnStreamEvents`)
 * keeps only events of the newest logical turn and filters parts by their last
 * activity at or after the turn boundary, so every event streamed before that
 * boundary is dead weight except one: the newest snapshot of a part the current
 * turn still touches, which seeds the deltas that continue into this turn (a
 * steered turn moves the boundary mid-turn and must not erase the trace built up
 * before it). Those seeds are kept, in first-seen order with their last value,
 * and dropped when no live part references them, so the retained set is exactly
 * what `compactTurnStreamEvents` would have produced from the whole log.
 */

/** Bytes read per chunk. Large enough that a big log is few syscalls, small
 *  enough that one chunk's decode and parse is a few milliseconds. */
const READ_CHUNK_BYTES = 2 * 1024 * 1024

const NEWLINE = 0x0a

export interface TurnStreamLogRead {
  /** Current-turn events plus the pre-boundary snapshots that seed them. */
  events: TurnStreamEvent[]
  /** Newest non-empty turn anchor seen, so the fold can select the last turn. */
  latestTurnId: string
  /** Byte offset to pass to the next incremental tail read. */
  nextByte: number
}

/**
 * Byte offset of a record's timestamp, read without parsing the record.
 *
 * Every persisted record is written with `turnId` immediately followed by `ts`
 * (`persistTurnStreamEvent`), and `delta`   the only field that can carry
 * arbitrary text   is serialized before `turnId`. A quote inside that text is
 * JSON-escaped, so it can never reproduce the `"turnId":"..."` shape this looks
 * for. Returns null when the record does not match, and the caller then falls
 * back to a full parse.
 */
function cheapTs(line: string): number | null {
  const turnMarker = line.indexOf('"turnId":"')
  if (turnMarker === -1) return null
  const tsMarker = line.indexOf('","ts":', turnMarker)
  if (tsMarker === -1) return null
  let index = tsMarker + 7
  let value = 0
  let digits = 0
  while (index < line.length) {
    const code = line.charCodeAt(index)
    if (code < 48 || code > 57) break
    value = value * 10 + (code - 48)
    digits += 1
    index += 1
  }
  return digits > 0 ? value : null
}

function parseEvent(line: string): TurnStreamEvent | null {
  try {
    const parsed = JSON.parse(line) as TurnStreamEvent
    if (parsed.kind === 'part.updated' || parsed.kind === 'part.delta') return parsed
    return null
  } catch {
    // A malformed line must not block rehydration of the rest of the stream.
    return null
  }
}

/**
 * Read a stream log from `fromByte` to `size`, chunk by chunk, retaining only
 * what the current turn's fold needs.
 *
 * `turnStartTs` is the boundary from `ChatEngine.currentTurnStartTs`; when it is
 * undefined (a fresh thread with no user message yet) the whole log belongs to
 * the current turn and nothing is dropped.
 */
export async function readTurnStreamLog(
  storage: StorageEngine,
  relativePath: string,
  fromByte: number,
  size: number,
  turnStartTs: number | undefined
): Promise<TurnStreamLogRead> {
  const events: TurnStreamEvent[] = []
  // Pre-boundary snapshots, in first-seen order with their last value, kept only
  // for the parts the current turn turns out to touch.
  const seedOrder: string[] = []
  const seedSnapshots = new Map<string, TurnStreamEvent>()
  let latestTurnId = ''
  let offset = Math.max(0, Math.min(fromByte, size))
  // Bytes of a line whose terminating newline has not been read yet.
  let carry = Buffer.alloc(0)

  const absorb = (raw: string): void => {
    // Match the loader's tolerance for a stray carriage return or padding.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) return
    const ts = cheapTs(line)
    if (turnStartTs !== undefined && ts !== null && ts < turnStartTs) {
      // Pre-boundary: only a snapshot can still seed the current turn, and only
      // for a part the current turn touches. Everything else is dropped without
      // paying for a full parse of its payload.
      if (!line.includes('"kind":"part.updated"')) return
      const event = parseEvent(line)
      if (!event || event.kind !== 'part.updated') return
      const id = event.part.id
      if (!seedSnapshots.has(id)) seedOrder.push(id)
      seedSnapshots.set(id, event)
      if (event.turnId) latestTurnId = event.turnId
      return
    }
    const event = parseEvent(line)
    if (!event) return
    if (turnStartTs !== undefined && event.ts < turnStartTs) {
      // The cheap timestamp probe did not apply (a record it could not read):
      // fall back to the parsed value, which is authoritative.
      if (event.kind !== 'part.updated') return
      const id = event.part.id
      if (!seedSnapshots.has(id)) seedOrder.push(id)
      seedSnapshots.set(id, event)
      if (event.turnId) latestTurnId = event.turnId
      return
    }
    events.push(event)
    if (event.turnId) latestTurnId = event.turnId
  }

  while (offset < size) {
    const chunk = await storage.readRawChunk(relativePath, offset, READ_CHUNK_BYTES)
    if (!chunk || chunk.bytesRead === 0) break
    offset = chunk.nextByte
    const combined = carry.length === 0 ? chunk.buffer : Buffer.concat([carry, chunk.buffer])
    const lastNewline = combined.lastIndexOf(NEWLINE)
    if (lastNewline === -1) {
      // Not one complete line in this window yet: hold the bytes and grow.
      carry = Buffer.from(combined)
      continue
    }
    // Decode only complete lines; the trailing partial stays in `carry` so it is
    // completed by the next chunk instead of being dropped or cut mid-character.
    const decoded = combined.subarray(0, lastNewline + 1).toString('utf8')
    carry = Buffer.from(combined.subarray(lastNewline + 1))
    for (const line of decoded.split('\n')) absorb(line)
    // Hand the event loop back so opening a large thread can never starve the
    // rest of the app for the duration of the read.
    await yieldToEventLoop()
  }

  if (seedOrder.length === 0) return { events, latestTurnId, nextByte: offset - carry.length }

  // Drop seed snapshots no live part references: a part the current turn never
  // touches needs no baseline.
  const liveParts = new Set<string>()
  for (const event of events) {
    liveParts.add(event.kind === 'part.updated' ? event.part.id : event.partId)
  }
  const retained: TurnStreamEvent[] = []
  for (const id of seedOrder) {
    if (!liveParts.has(id)) continue
    const snapshot = seedSnapshots.get(id)
    if (snapshot) retained.push(snapshot)
  }
  if (retained.length === 0) return { events, latestTurnId, nextByte: offset - carry.length }
  // A seed precedes every in-turn event, which is where `compactTurnStreamEvents`
  // leaves it too, so the fold's first-seen order is unchanged.
  return { events: [...retained, ...events], latestTurnId, nextByte: offset - carry.length }
}
