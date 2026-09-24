/**
 * The on-disk layout of CodeInOven's durable logs.
 *
 * Every sink the app appends to lives in a per-day folder under the config
 * root's `logs/` directory, named for the local calendar day it was written on:
 *
 *     logs/2026-09-24/main.jsonl
 *     logs/2026-09-24/debug.log
 *     logs/2026-09-24/error.log
 *     logs/2026-09-24/driver-events.jsonl
 *
 * A day folder is the unit of debugging: one incident reads one folder instead
 * of one ever-growing file, and a large log tree can be pruned a day at a time.
 * The day is the *local* calendar day on purpose, because "today" for the
 * operator reading the folder is their own day, not UTC. Individual records
 * still carry their own ISO (UTC) timestamp.
 *
 * Writers build their path through `dailyLogRelativePath` on every append   not
 * once at startup   so the rollover happens without restarting the app.
 * Readers that may meet a log tree written before this split still understand a
 * flat `logs/<file>` path through `parseLogFilePath`.
 */

/** Root-relative directory every durable log file lives under. */
export const LOGS_DIRECTORY = 'logs'

/** Machine-readable mirror of every log line (see `Logger`). */
export const MAIN_LOG_FILE = 'main.jsonl'
/** Operator-readable mirror of every log line, in the same folder. */
export const DEBUG_LOG_FILE = 'debug.log'
/** Operator-readable mirror of error lines only. */
export const ERROR_LOG_FILE = 'error.log'
/** Driver stream events (created, completed, permission asked/replied, ...). */
export const DRIVER_EVENTS_LOG_FILE = 'driver-events.jsonl'
/** Every permission decision the user or policy made. */
export const PERMISSION_EVENTS_LOG_FILE = 'permission-events.jsonl'
/** Terminal spawn/exit provenance. */
export const PTY_EVENTS_LOG_FILE = 'pty-events.jsonl'
/** `@cio-utility` turn audit. */
export const UTILITY_EVENTS_LOG_FILE = 'utility-events.jsonl'
/** TypeSafe auxiliary-judgment decisions. */
export const TYPESAFE_DECISIONS_LOG_FILE = 'typesafe-decisions.jsonl'

const LOG_DAY_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const LOG_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** `2026-09-24` - the local calendar day a log file belongs to. */
export function logDayName(at: Date = new Date()): string {
  const year = at.getFullYear().toString().padStart(4, '0')
  const month = (at.getMonth() + 1).toString().padStart(2, '0')
  const day = at.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Is this exactly a `YYYY-MM-DD` day folder name? */
export function isLogDayName(value: string): boolean {
  return LOG_DAY_NAME_PATTERN.test(value)
}

/** `logs/2026-09-24/main.jsonl` - where one sink writes right now. */
export function dailyLogRelativePath(fileName: string, at: Date = new Date()): string {
  return logRelativePathInDay(logDayName(at), fileName)
}

/** `logs/2026-09-24/main.jsonl` for an explicitly named day. */
export function logRelativePathInDay(day: string, fileName: string): string {
  if (!isLogDayName(day)) throw new Error(`Log day folder must be YYYY-MM-DD: "${day}"`)
  return `${LOGS_DIRECTORY}/${day}/${assertLogFileName(fileName)}`
}

/**
 * The pre-split location of a sink, flat directly under `logs/`. Still read so a
 * log tree written by an older build stays debuggable; never written to.
 */
export function flatLogRelativePath(fileName: string): string {
  return `${LOGS_DIRECTORY}/${assertLogFileName(fileName)}`
}

/** One day folder plus a file name inside it. */
export interface ParsedLogPath {
  /** Day folder name, or null when the caller named no day (meaning today). */
  day: string | null
  /** Single file name inside the day folder, e.g. `main.jsonl`. */
  fileName: string
}

/**
 * Parse a caller-supplied log path into its day folder and file name.
 *
 * Accepts `main.jsonl`, `logs/main.jsonl`, `2026-09-24/main.jsonl`, and
 * `logs/2026-09-24/main.jsonl`. Anything carrying traversal, an absolute path,
 * a malformed day, or extra segments returns null so the caller can reject it.
 */
export function parseLogFilePath(raw: string): ParsedLogPath | null {
  const segments = raw
    .trim()
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
  if (segments[0] === LOGS_DIRECTORY) segments.shift()

  if (segments.length === 1) {
    const fileName = normalizeLogFileName(segments[0])
    return fileName ? { day: null, fileName } : null
  }
  if (segments.length === 2) {
    const day = segments[0]
    const fileName = normalizeLogFileName(segments[1])
    if (!isLogDayName(day) || !fileName) return null
    return { day, fileName }
  }
  return null
}

function assertLogFileName(fileName: string): string {
  const normalized = normalizeLogFileName(fileName)
  if (!normalized) throw new Error(`Log file name is not path-safe: "${fileName}"`)
  return normalized
}

function normalizeLogFileName(fileName: string): string | null {
  if (!LOG_FILE_NAME_PATTERN.test(fileName) || fileName.includes('..')) return null
  return fileName
}
