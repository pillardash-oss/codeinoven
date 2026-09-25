import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { DEBUG_LOG_FILE, ERROR_LOG_FILE, MAIN_LOG_FILE, logDayName } from './log-paths'

type LogLevel = 'dev' | 'info' | 'error'

interface LogRecord {
  timestamp: string
  level: LogLevel
  message: string
}

/** The three sinks one day folder holds, resolved together on rollover. */
interface LogDaySinks {
  directory: string
  jsonl: string
  debug: string
  error: string
}

/**
 * Structured main-process logger.
 * The application Agent behavior contract forbids `console.*`   all logging goes through this class.
 * `Logger.dev` is for development-only diagnostics.
 *
 * Every sink lives in the folder of the day it was written on, so one day of
 * debugging reads `logs/2026-09-24/` instead of one ever-growing file (the
 * layout itself is documented in `src/main/system/log-paths.ts`). Inside that
 * folder the machine-readable `main.jsonl` sink keeps every line, an
 * operator-friendly `debug.log` mirrors them, and every error also lands in
 * `error.log`, so production issues can be inspected on disk without decoding
 * the JSONL stream.
 *
 * The day is resolved on every write rather than at initialization, so an app
 * left running overnight starts writing to the new day's folder at midnight
 * without a restart.
 */
export class Logger {
  private static logsDirectory: string | null = null
  private static activeDay: string | null = null
  private static daySinks: LogDaySinks | null = null
  private static createdDirectories = new Set<string>()
  private static writeQueue: Promise<void> = Promise.resolve()

  /** Point the logger at the app's absolute `logs/` directory. */
  static initialize(logsDirectory: string): void {
    Logger.logsDirectory = logsDirectory
    Logger.activeDay = null
    Logger.daySinks = null
  }

  /** The sinks of the current day, re-resolved when the day changes. */
  private static resolveDaySinks(): LogDaySinks | null {
    const root = Logger.logsDirectory
    if (!root) return null
    const day = logDayName()
    if (day === Logger.activeDay && Logger.daySinks) return Logger.daySinks
    const directory = join(root, day)
    Logger.activeDay = day
    Logger.daySinks = {
      directory,
      jsonl: join(directory, MAIN_LOG_FILE),
      debug: join(directory, DEBUG_LOG_FILE),
      error: join(directory, ERROR_LOG_FILE)
    }
    return Logger.daySinks
  }

  /**
   * Create the day folder once. A new day creates exactly one directory, and a
   * failed attempt is not remembered so the next line retries instead of
   * silently dropping the rest of the day.
   */
  private static ensureDayDirectory(directory: string): Promise<void> {
    if (Logger.createdDirectories.has(directory)) return Promise.resolve()
    return mkdir(directory, { recursive: true }).then(() => {
      Logger.createdDirectories.add(directory)
    })
  }

  private static redact(value: string): string {
    return value
      .replace(/\b(authorization)\b(\s*[:=]\s*)(?:Bearer\s+)?([^\s,;]+)/giu, '$1$2[REDACTED]')
      .replace(/\b(api[_-]?key|token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/giu, '$1$2[REDACTED]')
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
  }

  private static format(level: string, args: unknown[]): string {
    const message = args
      .map((arg) =>
        typeof arg === 'string'
          ? arg
          : arg instanceof Error
            ? (arg.stack ?? arg.message)
            : JSON.stringify(arg)
      )
      .join(' ')
    return `[${level}] ${Logger.redact(message)}`
  }

  private static enqueue(sinks: LogDaySinks, path: string, line: string): void {
    Logger.writeQueue = Logger.writeQueue
      .then(() => Logger.ensureDayDirectory(sinks.directory))
      .then(() => appendFile(path, line, { encoding: 'utf-8', mode: 0o600 }))
      .catch((error: unknown) => {
        // A day folder can vanish under a running app (the user cleaning up the
        // data root, a test deleting its temp root). Forget the "already
        // created" cache so the next line recreates the folder instead of
        // failing for the rest of the day.
        Logger.createdDirectories.delete(sinks.directory)
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[error] durable log write failed: ${detail}\n`)
      })
  }

  private static write(level: LogLevel, args: unknown[]): void {
    const formatted = Logger.format(level, args)
    const stream = level === 'error' ? process.stderr : process.stdout
    stream.write(`${formatted}\n`)

    const sinks = Logger.resolveDaySinks()
    if (!sinks) return
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message: formatted.slice(level.length + 3)
    }
    Logger.enqueue(sinks, sinks.jsonl, `${JSON.stringify(record)}\n`)
    const humanLine = `[${record.timestamp}] [${record.level}] ${record.message}\n`
    Logger.enqueue(sinks, sinks.debug, humanLine)
    if (level === 'error') Logger.enqueue(sinks, sinks.error, humanLine)
  }

  /** Development-only log line. */
  static dev(...args: unknown[]): void {
    Logger.write('dev', args)
  }

  /** Informational log line. */
  static info(...args: unknown[]): void {
    Logger.write('info', args)
  }

  /** Error log line (written to stderr). */
  static error(...args: unknown[]): void {
    Logger.write('error', args)
  }

  static async flush(): Promise<void> {
    await Logger.writeQueue
  }
}
