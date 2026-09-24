import { open, readdir, stat, type FileHandle } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot } from '../../lib/utils'
import { LOGS_DIRECTORY, isLogDayName } from './log-paths'

/**
 * Reading side of the day-partitioned log tree (`src/main/system/log-paths.ts`).
 *
 * Two rules keep a debug read cheap on a log tree that can reach hundreds of
 * megabytes: a read never parses more than the newest bytes of a file, and a
 * day listing is bounded. Both the exported failure report and the read-only
 * `@cio-utility` diagnostics go through here, so they see the same day folders
 * and the same tail limit.
 */

/** Newest bytes of any log file a reader is willing to parse. */
export const MAX_LOG_READ_BYTES = 1_000_000

/** How many day folders a listing reports, newest first. */
export const MAX_LOG_DAY_LISTING = 30

/** Newest bytes of one log file plus that file's total size. */
export interface LogFileTail {
  content: string
  bytes: number
}

/** Newest-first day folders under `logs/`, bounded to `limit`. */
export async function listLogDayFolders(limit = MAX_LOG_DAY_LISTING): Promise<string[]> {
  try {
    const entries = await readdir(join(getConfigRoot(), LOGS_DIRECTORY), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && isLogDayName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(0, limit))
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
}

/** What sits at this config-root-relative log path, if anything. */
export type LogPathKind = 'file' | 'directory' | null

export async function logPathKind(relativePath: string): Promise<LogPathKind> {
  try {
    const info = await stat(resolveLogPath(relativePath))
    if (info.isFile()) return 'file'
    return info.isDirectory() ? 'directory' : null
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

/**
 * Read the newest `maxBytes` of one log file, cut to a whole line so a partial
 * append (and a partial multibyte character) never reaches the parser. Returns
 * null when the file does not exist.
 */
export async function readLogFileTail(
  relativePath: string,
  maxBytes = MAX_LOG_READ_BYTES
): Promise<LogFileTail | null> {
  let handle: FileHandle
  try {
    handle = await open(resolveLogPath(relativePath), 'r')
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - Math.max(0, maxBytes))
    const length = size - start
    if (length === 0) return { content: '', bytes: size }
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const chunk = await handle.read(buffer, read, length - read, start + read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    let region = buffer.subarray(0, read)
    if (start > 0) {
      // The cut can land inside a line and inside a character; start after the
      // first newline so the first parsed line is whole.
      const firstNewline = region.indexOf(0x0a)
      if (firstNewline === -1) return { content: '', bytes: size }
      region = region.subarray(firstNewline + 1)
    }
    return { content: region.toString('utf8'), bytes: size }
  } finally {
    await handle.close()
  }
}

function resolveLogPath(relativePath: string): string {
  return join(getConfigRoot(), relativePath)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
