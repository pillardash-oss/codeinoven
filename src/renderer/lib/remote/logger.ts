/**
 * Renderer-safe logging for the remote-connection modules.
 *
 * The repo forbids `console.*` and the main-process `Logger` class is not
 * importable from the renderer, so remote modules log through this injectable
 * interface. The default is a no-op logger; a deployment wires `setRemoteLogger`
 * to a real sink (e.g. an IPC bridge to the main-process Logger). Secrets are
 * redacted before any sink sees them.
 */

export interface RemoteLogger {
  dev(message: string): void
  info(message: string): void
  error(message: string): void
}

const nullLogger: RemoteLogger = {
  dev: () => undefined,
  info: () => undefined,
  error: () => undefined
}

let activeLogger: RemoteLogger = nullLogger

/** Replace the active logger sink. Used by tests and the app entrypoint. */
export function setRemoteLogger(logger: RemoteLogger): void {
  activeLogger = logger
}

/** Mask known secret patterns so tokens never reach a log sink. */
export function redactLog(message: string): string {
  return message
    .replace(/\b(auth[^:=\s]*)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key)\b(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[REDACTED]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
}

export const remoteLog = {
  dev(message: string): void {
    activeLogger.dev(redactLog(message))
  },
  info(message: string): void {
    activeLogger.info(redactLog(message))
  },
  error(message: string): void {
    activeLogger.error(redactLog(message))
  }
}

export interface RemoteLogEntry {
  level: 'dev' | 'info' | 'error'
  message: string
  at: number
}

const MAX_LOG_ENTRIES = 60
let recentEntries: RemoteLogEntry[] = []

/** The most recently recorded remote-connection log entries (newest last). */
export function recentRemoteLogs(): readonly RemoteLogEntry[] {
  return recentEntries
}

/**
 * An in-memory ring-buffer sink so remote diagnostics are retained (and
 * inspectable in the Remote view) instead of silently dropped. Wire it at the
 * app entrypoint with `setRemoteLogger(createRingBufferLogger())`.
 */
export function createRingBufferLogger(limit = MAX_LOG_ENTRIES): RemoteLogger {
  return {
    dev(message: string): void {
      record(message, 'dev', limit)
    },
    info(message: string): void {
      record(message, 'info', limit)
    },
    error(message: string): void {
      record(message, 'error', limit)
    }
  }
}

function record(message: string, level: RemoteLogEntry['level'], limit: number): void {
  recentEntries = [...recentEntries, { level, message, at: Date.now() }]
  if (recentEntries.length > limit) {
    recentEntries = recentEntries.slice(recentEntries.length - limit)
  }
}
