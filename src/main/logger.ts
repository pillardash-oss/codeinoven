import { appendFile } from 'fs/promises'

type LogLevel = 'dev' | 'info' | 'error'

interface LogRecord {
  timestamp: string
  level: LogLevel
  message: string
}

/**
 * Structured main-process logger.
 * AGENTS.md forbids `console.*` — all logging goes through this class.
 * `Logger.dev` is for development-only diagnostics.
 */
export class Logger {
  private static logPath: string | null = null
  private static writeQueue: Promise<void> = Promise.resolve()

  static initialize(logPath: string): void {
    Logger.logPath = logPath
  }

  private static redact(value: string): string {
    return value
      .replace(
        /\b(authorization)\b(\s*[:=]\s*)(?:Bearer\s+)?([^\s,;]+)/giu,
        '$1$2[REDACTED]'
      )
      .replace(
        /\b(api[_-]?key|token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/giu,
        '$1$2[REDACTED]'
      )
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
  }

  private static format(level: string, args: unknown[]): string {
    const message = args
      .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.stack ?? arg.message : JSON.stringify(arg)))
      .join(' ')
    return `[${level}] ${Logger.redact(message)}`
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
    const line = `${JSON.stringify(record)}\n`
    Logger.writeQueue = Logger.writeQueue
      .then(() => appendFile(Logger.logPath!, line, { encoding: 'utf-8', mode: 0o600 }))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[error] durable log write failed: ${detail}\n`)
      })
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
