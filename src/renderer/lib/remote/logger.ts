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
