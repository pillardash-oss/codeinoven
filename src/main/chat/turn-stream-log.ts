import { open, type FileHandle } from 'node:fs/promises'
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
 * Only the events of one window are retained. The fold (`foldTurnStreamEvents`)
 * keeps only events inside the requested turn and filters parts by their last
 * activity at or after the window's start, so every event streamed before that
 * start is dead weight except one: the newest snapshot of a part the window
 * still touches, which seeds the deltas that continue into it (a steered turn
 * moves the boundary mid-turn and must not erase the trace built up before it).
 * Those seeds are kept, in first-seen order with their last value, and dropped
 * when no live part references them, so the retained set is exactly what
 * `compactTurnStreamEvents` would have produced from the whole log.
 *
 * The window is a closed range when `windowEndTs` is supplied, which is how a
 * turn that a later prompt closed is read back out of the log: from the prompt
 * that opened it up to the prompt that ended it, with nothing after it.
 */

/** Bytes read per chunk. Large enough that a big log is few syscalls, small
 *  enough that one chunk's decode and parse is a few milliseconds. */
const READ_CHUNK_BYTES = 2 * 1024 * 1024
/** Bytes read per chunk when walking a log backwards from its end. The newest
 *  turn is usually a few hundred kilobytes, so one chunk settles it. */
const TAIL_CHUNK_BYTES = 512 * 1024
/** How far past the newest turn's boundary the backward walk keeps reading: a
 *  straggler appended a moment out of timestamp order must still land in the
 *  turn it belongs to. */
const TAIL_LOOKBACK_BYTES = 64 * 1024
const NEWLINE = 0x0a

/**
 * A window onto one append-only log, read a chunk at a time.
 *
 * The main process and the background I/O worker read the same file through
 * different handles (the storage engine's rooted resolve, and a plain absolute
 * path), so the reader takes bytes instead of a storage engine and the heavy
 * walk can run off the main thread without changing its rules.
 */
export interface TurnStreamChunkSource {
  /** Read up to `length` bytes at `fromByte`. Null when the file is gone. */
  readChunk(fromByte: number, length: number): Promise<{ buffer: Buffer; nextByte: number } | null>
}

/** Read a thread's log through the app's rooted storage engine. */
export function storageTurnStreamSource(
  storage: StorageEngine,
  relativePath: string
): TurnStreamChunkSource {
  return {
    async readChunk(fromByte, length) {
      const chunk = await storage.readRawChunk(relativePath, fromByte, length)
      return chunk ? { buffer: chunk.buffer, nextByte: chunk.nextByte } : null
    }
  }
}

/** Read a thread's log from an absolute path, for the background worker. */
export function fileTurnStreamSource(path: string): TurnStreamChunkSource {
  return {
    async readChunk(fromByte, length) {
      let handle: FileHandle
      try {
        handle = await open(path, 'r')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
      try {
        const { size } = await handle.stat()
        if (length <= 0 || fromByte >= size) {
          return { buffer: Buffer.alloc(0), nextByte: fromByte }
        }
        const requested = Math.min(length, size - fromByte)
        const buffer = Buffer.allocUnsafe(requested)
        let read = 0
        while (read < requested) {
          const chunk = await handle.read(buffer, read, requested - read, fromByte + read)
          if (chunk.bytesRead === 0) break
          read += chunk.bytesRead
        }
        return { buffer: buffer.subarray(0, read), nextByte: fromByte + read }
      } finally {
        await handle.close()
      }
    }
  }
}

export interface TurnStreamLogRead {
  /** The window's events plus the pre-window snapshots that seed them. */
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
 * the window's events plus the snapshots that seed them.
 *
 * `windowStartTs` is the boundary the caller folds from (the start of the turn
 * it wants); when it is undefined (a fresh thread with no user message yet) the
 * whole log belongs to the window and nothing is dropped. `windowEndTs`, when
 * supplied, closes the window: events at or after it belong to the next turn.
 */
export async function readTurnStreamLog(
  source: TurnStreamChunkSource,
  fromByte: number,
  size: number,
  windowStartTs: number | undefined,
  windowEndTs?: number
): Promise<TurnStreamLogRead> {
  const events: TurnStreamEvent[] = []
  // Pre-window snapshots, in first-seen order with their last value, kept only
  // for the parts the window turns out to touch.
  const seedOrder: string[] = []
  const seedSnapshots = new Map<string, TurnStreamEvent>()
  let latestTurnId = ''
  let offset = Math.max(0, Math.min(fromByte, size))
  // Bytes of a line whose terminating newline has not been read yet.
  let carry = Buffer.alloc(0)

  /** Absorb one pre-window line: only a snapshot can still seed the window, and
   *  only for a part the window touches. Everything else is dropped without
   *  paying for a full parse of its payload. */
  const absorbSeed = (line: string): void => {
    if (!line.includes('"kind":"part.updated"')) return
    const event = parseEvent(line)
    if (!event || event.kind !== 'part.updated') return
    const id = event.part.id
    if (!seedSnapshots.has(id)) seedOrder.push(id)
    seedSnapshots.set(id, event)
    if (event.turnId) latestTurnId = event.turnId
  }

  const absorb = (raw: string): void => {
    // Match the loader's tolerance for a stray carriage return or padding.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) return
    const ts = cheapTs(line)
    // Past the window's end the next turn owns the work outright: neither its
    // snapshots nor its deltas may describe this one, so nothing is kept.
    if (windowEndTs !== undefined && ts !== null && ts >= windowEndTs) return
    if (windowStartTs !== undefined && ts !== null && ts < windowStartTs) {
      absorbSeed(line)
      return
    }
    const event = parseEvent(line)
    if (!event) return
    if (windowEndTs !== undefined && event.ts >= windowEndTs) return
    if (windowStartTs !== undefined && event.ts < windowStartTs) {
      // The cheap timestamp probe did not apply (a record it could not read):
      // fall back to the parsed value, which is authoritative.
      absorbSeed(line)
      return
    }
    events.push(event)
    if (event.turnId) latestTurnId = event.turnId
  }

  while (offset < size) {
    const chunk = await source.readChunk(offset, READ_CHUNK_BYTES)
    if (!chunk || chunk.buffer.length === 0) break
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

  // Drop seed snapshots no windowed part references: a part the window never
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
  // A seed precedes every windowed event, which is where
  // `compactTurnStreamEvents` leaves it too, so the fold's first-seen order is
  // unchanged.
  return { events: [...retained, ...events], latestTurnId, nextByte: offset - carry.length }
}

/**
 * Rebuild the newest turn's retained events by walking the log backwards from
 * its end.
 *
 * The forward walk above has to read every byte the log ever held before it
 * reaches the newest turn, and on a long-lived thread that file is hundreds of
 * megabytes: the tail a reader wants sits at the end, behind all of it. Walking
 * backwards stops at the turn boundary instead, so the work is proportional to
 * the turn being shown, never to the thread's whole history. Only that portion
 * is loaded; older entries page in on their own (`beforeId`) as the reader
 * scrolls the trace, and older turns are read only when the transcript is
 * missing them.
 *
 * The retained set is the same one the forward walk produces, minus the
 * pre-boundary snapshots of parts that already carry a snapshot inside the
 * turn: a snapshot is the part's complete state, so only a part continued by
 * deltas with no snapshot after the boundary needs its baseline from before.
 * That is the one case the backwards walk keeps looking for, and it never
 * needs to walk past the file's start for anything else.
 */
export async function readTurnStreamTail(
  source: TurnStreamChunkSource,
  size: number,
  windowStartTs: number | undefined
): Promise<TurnStreamLogRead> {
  if (size <= 0) return { events: [], latestTurnId: '', nextByte: 0 }
  if (windowStartTs === undefined) {
    // No prompt has opened a turn yet, so the whole log belongs to the window.
    // There is no boundary to stop at, and a thread in this state has no trace
    // to speak of; the forward walk stays the honest reader.
    return readTurnStreamLog(source, 0, size, undefined)
  }

  const eventsRev: TurnStreamEvent[] = []
  const seedsRev: TurnStreamEvent[] = []
  const seeded = new Set<string>()
  /** Parts that streamed deltas in this turn but no snapshot, so the fold needs
   *  their newest pre-boundary snapshot to reconstruct their text. */
  const needsSeed = new Set<string>()
  const snapshotted = new Set<string>()
  let latestTurnId = ''
  let cursor = size
  /** Bytes of the previous chunk whose line continues into the next read. */
  let carry = Buffer.alloc(0)
  /** Bytes read below the turn boundary, so the walk can stop once it has the
   *  seeds it needs and has looked just far enough for a straggler. */
  let pastBoundaryBytes = 0

  const collectSeed = (event: TurnStreamEvent): void => {
    if (event.kind !== 'part.updated') return
    const id = event.part.id
    if (!needsSeed.has(id) || seeded.has(id)) return
    seeded.add(id)
    seedsRev.push(event)
  }

  const absorb = (line: string): void => {
    const cheap = cheapTs(line)
    if (cheap !== null && cheap < windowStartTs) {
      pastBoundaryBytes += line.length + 1
      if (needsSeed.size > 0 && line.includes('"kind":"part.updated"')) {
        const event = parseEvent(line)
        if (event) collectSeed(event)
      }
      return
    }
    const event = parseEvent(line)
    if (!event) return
    if (event.ts < windowStartTs) {
      pastBoundaryBytes += line.length + 1
      collectSeed(event)
      return
    }
    const id = event.kind === 'part.updated' ? event.part.id : event.partId
    if (event.kind === 'part.updated') {
      snapshotted.add(id)
      needsSeed.delete(id)
    } else if (!snapshotted.has(id)) {
      needsSeed.add(id)
    }
    eventsRev.push(event)
    // The walk reads newest first, so the first non-empty anchor it meets is
    // the newest one, exactly what the forward walk's last assignment leaves.
    if (event.turnId && !latestTurnId) latestTurnId = event.turnId
  }

  /** Decode complete lines and feed them oldest-last, the order a backward
   *  walk reads them in. */
  const absorbLines = (bytes: Buffer): void => {
    const lines = bytes.toString('utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line) absorb(line)
    }
  }

  while (cursor > 0) {
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const chunk = await source.readChunk(start, cursor - start)
    if (!chunk || chunk.buffer.length === 0) {
      cursor = start
      continue
    }
    // `carry` holds the beginning of a line whose end was in the chunk already
    // read, so the two halves are joined before any line is decoded.
    const combined = carry.length === 0 ? chunk.buffer : Buffer.concat([chunk.buffer, carry])
    if (start > 0) {
      const newline = combined.indexOf(NEWLINE)
      if (newline === -1) {
        carry = Buffer.from(combined)
        cursor = start
        continue
      }
      carry = Buffer.from(combined.subarray(0, newline))
      absorbLines(combined.subarray(newline + 1))
    } else {
      carry = Buffer.alloc(0)
      absorbLines(combined)
    }
    cursor = start
    // A turn that has streamed nothing yet needs no more history read.
    if (pastBoundaryBytes > 0 && eventsRev.length === 0) break
    // Every continued part has its baseline and the walk has looked past the
    // boundary long enough to catch a straggler: the turn is fully rebuilt.
    if (pastBoundaryBytes >= TAIL_LOOKBACK_BYTES && needsSeed.size === 0) break
  }

  const events = eventsRev.reverse()
  const seeds = seedsRev.reverse()
  return {
    events: seeds.length === 0 ? events : [...seeds, ...events],
    latestTurnId,
    nextByte: size
  }
}
