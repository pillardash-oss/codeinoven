import { appendFile, mkdir } from 'fs/promises'
import { arch as osArchitecture, platform as osPlatform, release as osRelease } from 'os'
import { join } from 'path'
import { APP_NAME } from '../../lib/brand'
import { DEBUG_LOG_FILE, ERROR_LOG_FILE, MAIN_LOG_FILE, logDayName } from './log-paths'

type LogLevel = 'dev' | 'info' | 'error'

/** The build and host facts stamped onto every durable log record. */
export interface LogEnvironment {
  /** Running app version, prerelease suffix intact (`0.5.70-nightly.15`). */
  appVersion: string
  platform: string
  /** User-facing OS version, e.g. `15.5.0` on macOS, not the Darwin kernel. */
  platformVersion: string
  architecture: string
  electronVersion?: string
}

interface LogRecord {
  /** ISO-8601 instant, in UTC. */
  timestamp: string
  /** The same instant as epoch milliseconds, for correlation outside log tooling. */
  unix: number
  level: LogLevel
  /** App version that produced the line, nightly suffix included. */
  appVersion: string
  /** OS name, version and architecture, e.g. `darwin 15.5.0 (arm64)`. */
  os: string
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
 * folder the machine-readable `main.jsonl` sink keeps every line, and the
 * operator-friendly `debug.log` mirrors the lines an operator acts on (info and
 * error). Development diagnostics stay in the JSONL stream only: they are the
 * majority of a typical day's lines, and a reader answering "what happened"
 * gets nothing from them. Every error also lands in `error.log`, so production
 * issues can be inspected on disk without decoding the JSONL stream.
 *
 * The day is resolved on every write rather than at initialization, so an app
 * left running overnight starts writing to the new day's folder at midnight
 * without a restart.
 */
export class Logger {
  private static remoteOutput = false

  /** Remote RPC stdout contains protocol messages only. */
  static useStandardError(): void {
    Logger.remoteOutput = true
  }

  private static logsDirectory: string | null = null
  private static environment: LogEnvironment = Logger.resolveEnvironment()
  /** Day folder whose session banner was already written for this process. */
  private static bannerDay: string | null = null
  private static activeDay: string | null = null
  private static daySinks: LogDaySinks | null = null
  private static createdDirectories = new Set<string>()
  private static writeQueue: Promise<void> = Promise.resolve()
  private static writing = false
  private static pending: Array<{ sinks: LogDaySinks; path: string; line: string; bytes: number }> =
    []
  private static pendingBytes = 0
  private static dropped = 0

  /**
   * Point the logger at the app's absolute `logs/` directory and record the
   * build it runs from. Anything omitted falls back to this process's own OS
   * facts, so a caller that has no app version yet (a test, a tool) still
   * writes a valid record instead of failing.
   */
  static initialize(logsDirectory: string, environment: Partial<LogEnvironment> = {}): void {
    Logger.logsDirectory = logsDirectory
    Logger.environment = Logger.resolveEnvironment(environment)
    Logger.bannerDay = null
    Logger.activeDay = null
    Logger.daySinks = null
  }

  private static resolveEnvironment(environment: Partial<LogEnvironment> = {}): LogEnvironment {
    return {
      appVersion: environment.appVersion ?? 'unknown',
      platform: environment.platform ?? osPlatform(),
      platformVersion: environment.platformVersion ?? osRelease(),
      architecture: environment.architecture ?? osArchitecture(),
      ...(environment.electronVersion ? { electronVersion: environment.electronVersion } : {})
    }
  }

  /** `darwin 15.5.0 (arm64)` - the OS half of every record. */
  private static osLabel(): string {
    const environment = Logger.environment
    return `${environment.platform} ${environment.platformVersion} (${environment.architecture})`
  }

  /** One line naming the build and host a day folder's lines came from. */
  private static environmentSummary(): string {
    const environment = Logger.environment
    const electron = environment.electronVersion ? ` electron=${environment.electronVersion}` : ''
    return `session start ${APP_NAME} v${environment.appVersion} os=${Logger.osLabel()}${electron} pid=${process.pid}`
  }

  private static humanLine(record: LogRecord): string {
    return `[${record.timestamp}] [unix=${record.unix}] [v${record.appVersion}] [${record.level}] ${record.message}\n`
  }

  /**
   * Announce the build once per day folder, before its first line. A day folder
   * can be written by several launches (and by a nightly next to a stable
   * build), so every folder opens with the version and OS its lines came from.
   */
  private static writeEnvironmentBanner(sinks: LogDaySinks): void {
    if (Logger.bannerDay === sinks.directory) return
    Logger.bannerDay = sinks.directory
    const now = new Date()
    const record: LogRecord = {
      timestamp: now.toISOString(),
      unix: now.getTime(),
      level: 'info',
      appVersion: Logger.environment.appVersion,
      os: Logger.osLabel(),
      message: Logger.environmentSummary()
    }
    Logger.enqueue(sinks, sinks.jsonl, `${JSON.stringify(record)}\n`)
    Logger.enqueue(sinks, sinks.debug, Logger.humanLine(record))
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
    let remaining = 256
    let remainingCharacters = 64 * 1024
    const seen = new WeakSet<object>()
    const bounded = (value: unknown, depth = 0): unknown => {
      if (--remaining < 0 || depth > 4) return '[truncated]'
      if (typeof value === 'string') {
        const text = value.slice(0, Math.max(0, Math.min(8192, remainingCharacters)))
        remainingCharacters -= text.length
        return text
      }
      if (value instanceof Date)
        return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date'
      if (value instanceof Error) return bounded(value.stack ?? value.message, depth + 1)
      if (ArrayBuffer.isView(value)) return `[${value.constructor.name}: ${value.byteLength} bytes]`
      if (typeof value === 'bigint') return String(value)
      if (!value || typeof value !== 'object') return value
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      if (Array.isArray(value)) return value.slice(0, 32).map((entry) => bounded(entry, depth + 1))
      const result: Record<string, unknown> = Object.create(null)
      let count = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (++count > 32 || remaining <= 0) break
        try {
          result[key.slice(0, 256)] = bounded((value as Record<string, unknown>)[key], depth + 1)
        } catch {
          result[key.slice(0, 256)] = '[unavailable]'
        }
      }
      return result
    }
    const message = args
      .slice(0, 16)
      .map((arg) => {
        const value = bounded(arg)
        return typeof value === 'string' ? value : JSON.stringify(value)
      })
      .join(' ')
      .slice(0, 64 * 1024)
    return `[${level}] ${Logger.redact(message)}`
  }

  private static enqueue(sinks: LogDaySinks, path: string, line: string): void {
    const bytes = Buffer.byteLength(line)
    if (Logger.pending.length >= 1024 || Logger.pendingBytes + bytes > 4 * 1024 * 1024) {
      Logger.dropped += 1
      return
    }
    Logger.pending.push({ sinks, path, line, bytes })
    Logger.pendingBytes += bytes
    if (Logger.writing) return
    Logger.writing = true
    Logger.writeQueue = (async () => {
      try {
        while (Logger.pending.length) {
          const batch = Logger.pending.splice(0, 32)
          const files = new Map<string, { sinks: LogDaySinks; lines: string[] }>()
          for (const entry of batch) {
            Logger.pendingBytes -= entry.bytes
            const file = files.get(entry.path) ?? { sinks: entry.sinks, lines: [] }
            file.lines.push(entry.line)
            files.set(entry.path, file)
          }
          for (const [file, entry] of files) {
            try {
              await Logger.ensureDayDirectory(entry.sinks.directory)
              await appendFile(file, entry.lines.join(''), { encoding: 'utf-8', mode: 0o600 })
            } catch (error: unknown) {
              Logger.createdDirectories.delete(entry.sinks.directory)
              const detail = error instanceof Error ? error.message : String(error)
              if (process.stderr.writableLength < 1024 * 1024)
                process.stderr.write(`[error] durable log write failed: ${detail}\n`)
            }
          }
          if (Logger.dropped) {
            const dropped = Logger.dropped
            Logger.dropped = 0
            Logger.error(`Log writer saturated; omitted ${dropped} sink lines`)
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      } finally {
        Logger.writing = false
      }
    })()
  }

  private static write(level: LogLevel, args: unknown[]): void {
    const formatted = Logger.format(level, args)
    const stream = level === 'error' || Logger.remoteOutput ? process.stderr : process.stdout
    if (stream.writableLength < 1024 * 1024) stream.write(`${formatted}\n`)

    const sinks = Logger.resolveDaySinks()
    if (!sinks) return
    const now = new Date()
    const record: LogRecord = {
      timestamp: now.toISOString(),
      unix: now.getTime(),
      level,
      appVersion: Logger.environment.appVersion,
      os: Logger.osLabel(),
      message: formatted.slice(level.length + 3)
    }
    Logger.writeEnvironmentBanner(sinks)
    Logger.enqueue(sinks, sinks.jsonl, `${JSON.stringify(record)}\n`)
    // `main.jsonl` is the complete record; the human mirror is what an operator
    // reads to answer "what happened", and a dev diagnostic is not that. It was
    // also the larger half of the mirror (20 of 32 lines on a real launch), so
    // dropping it there halves the file without losing a single byte of evidence:
    // the line is still in the JSONL stream, right where a developer greps it.
    if (level !== 'dev') {
      const humanLine = Logger.humanLine(record)
      Logger.enqueue(sinks, sinks.debug, humanLine)
      if (level === 'error') Logger.enqueue(sinks, sinks.error, humanLine)
    }
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
