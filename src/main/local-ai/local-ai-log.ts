/**
 * The log file a llama.cpp row writes while it runs.
 *
 * A server can outlive the app instance that launched it, and with it the PTY
 * pipe that used to carry its output. Asking llama.cpp to write the same log to
 * a file (`--log-file`) leaves something to read afterwards: the card can show
 * the log of a server it adopted, and the last run of a server that is stopped.
 */
import { createReadStream, watch, type FSWatcher } from 'fs'
import { mkdir, open, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getConfigRoot } from '../../lib/utils'
import { terminalLines } from '../../lib/terminal-lines'

/** Row ids come from the saved config, so a log file name is never path-shaped. */
const SAFE_LOG_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/u
/** Enough for a full card, without reading a multi-megabyte file into memory. */
const TAIL_BYTES = 256 * 1024
const MAX_TAIL_LINES = 400

/** Absolute path of a row's log, with its directory created on first use. */
export async function localAiLogPath(entryId: string): Promise<string> {
  if (!SAFE_LOG_ID.test(entryId)) throw new Error('Unknown local AI server id')
  const path = join(getConfigRoot(), 'local-ai', 'logs', `${entryId}.log`)
  await mkdir(dirname(path), { recursive: true })
  return path
}

/** The last lines of a row's log, empty when the row never wrote one. */
export async function tailLocalAiLog(entryId: string): Promise<string[]> {
  const path = await localAiLogPath(entryId)
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return []
  }
  const start = Math.max(0, size - TAIL_BYTES)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start })
    stream.on('data', (chunk) => chunks.push(chunk as Buffer))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  const text = Buffer.concat(chunks).toString('utf8')
  // A progress bar redraws one line with carriage returns, so the tail is folded
  // the way a terminal drew it instead of returned as hundreds of redraws.
  const folded = terminalLines(text)
  const lines = folded.pending.length > 0 ? [...folded.lines, folded.pending] : folded.lines
  // A tail that starts mid-line drops that first partial line.
  if (start > 0) lines.shift()
  return lines.slice(-MAX_TAIL_LINES)
}

export interface LocalAiLogFollower {
  /** Stop watching; safe to call twice. */
  stop: () => void
}

/**
 * Watch a row's log from its current end and hand every appended chunk to
 * `onChunk`. The watcher is one event source, never a timer, and stops as soon
 * as the card stops asking for it.
 */
export async function followLocalAiLog(
  entryId: string,
  onChunk: (chunk: string) => void
): Promise<LocalAiLogFollower> {
  const path = await localAiLogPath(entryId)
  let offset = 0
  try {
    offset = (await stat(path)).size
  } catch {
    offset = 0
  }
  let reading = false
  let stopped = false
  let pendingRead: Promise<void> = Promise.resolve()

  const readAppended = async (): Promise<void> => {
    if (reading) return
    reading = true
    try {
      let size = 0
      try {
        size = (await stat(path)).size
      } catch {
        return
      }
      // A restart truncates the file: read it from the top again.
      if (size < offset) offset = 0
      if (size === offset) return
      const from = offset
      offset = size
      const handle = await open(path, 'r')
      try {
        const length = size - from
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, from)
        const text = buffer.toString('utf8')
        if (!stopped && text.length > 0) onChunk(text)
      } finally {
        await handle.close()
      }
    } catch {
      // A log that cannot be read right now is not a reason to fail the card.
    } finally {
      reading = false
    }
  }

  // The directory is watched, never the file: llama.cpp creates and truncates
  // its log on start, and a watch on the file itself would not survive that.
  const directory = dirname(path)
  const name = basename(path)
  let watcher: FSWatcher
  try {
    watcher = watch(directory, { persistent: false })
  } catch {
    return { stop: () => undefined }
  }
  watcher.on('change', (_event, changed) => {
    if (typeof changed === 'string' && changed !== name) return
    pendingRead = pendingRead.then(() => readAppended())
  })
  watcher.on('error', () => undefined)

  return {
    stop: () => {
      stopped = true
      void watcher.close()
    }
  }
}
