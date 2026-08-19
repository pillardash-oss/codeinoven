import { appendFile } from 'fs/promises'
import { dirname, join } from 'path'

type LogLevel = 'dev' | 'info' | 'error'

interface LogRecord {
  timestamp: string
  level: LogLevel
  message: string
}

/**
 * Structured main-process logger.
 * The application Agent behavior contract forbids `console.*` — all logging goes through this class.
 * `Logger.dev` is for development-only diagnostics.
 *
 * Besides the machine-readable `main.jsonl` sink, every log line is mirrored into
 * an operator-friendly `debug.log` in the same `logs/` directory, and every error
 * also lands in `error.log`, so production issues can be inspected on disk without
 * decoding the JSONL stream.
 */
export class Logger {
  private static logPath: string | null = null
  private static debugLogPath: string | null = null
  private static errorLogPath: string | null = null
  private static writeQueue: Promise<void> = Promise.resolve()

  static initialize(logPath: string): void {
    Logger.logPath = logPath
    const directory = dirname(logPath)
    Logger.debugLogPath = join(directory, 'debug.log')
    Logger.errorLogPath = join(directory, 'error.log')
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

  private static enqueue(path: string | null, line: string): void {
    if (!path) return
    Logger.writeQueue = Logger.writeQueue
      .then(() => appendFile(path, line, { encoding: 'utf-8', mode: 0o600 }))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[error] durable log write failed: ${detail}\n`)
      })
  }

  private static write(level: LogLevel, args: unknown[]): void {
    const formatted = Logger.format(level, args)
    const stream = level === 'error' ? process.stderr : process.stdout
    stream.write(`${formatted}\n`)

    if (!Logger.logPath) return
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message: formatted.slice(level.length + 3)
    }
    Logger.enqueue(Logger.logPath, `${JSON.stringify(record)}\n`)
    const humanLine = `[${record.timestamp}] [${record.level}] ${record.message}\n`
    Logger.enqueue(Logger.debugLogPath, humanLine)
    if (level === 'error') Logger.enqueue(Logger.errorLogPath, humanLine)
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
