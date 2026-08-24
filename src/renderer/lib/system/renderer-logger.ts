import type { RendererLogEntry, RendererLogLevel } from '$shared/ipc-contract'
import type { AppBridge } from '../../../preload/index'
import { isRemotePwaRuntime } from '$lib/runtime-context'

declare global {
  interface Window {
    api: AppBridge
  }
}

const MAX_MESSAGE_CHARS = 8000
const MAX_STACK_CHARS = 16000

/**
 * Renderer-side global error capture.
 *
 * The repo forbids `console.*` and the main-process `Logger` is not importable
 * from the renderer, so renderer JS errors used to be invisible on disk. This
 * installs window-level handlers for uncaught exceptions, unhandled promise
 * rejections, and `console.error` output, and forwards them through the
 * `renderer:log` IPC bridge to the main-process durable Logger where they land
 * in `error.log` / `main.jsonl` next to main-process records.
 *
 * The bridge is fire-and-forget: forwarding never throws and never blocks the
 * renderer, so a logging failure can never hide or worsen the original error.
 */

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function send(
  level: RendererLogLevel,
  message: string,
  stack: string | undefined,
  source: RendererLogEntry['source']
): void {
  // The phone PWA talks to the desktop through a capability-scoped RPC bridge;
  // `renderer:log` is an Electron IPC channel, not a remote capability, so it is
  // intentionally skipped there.
  if (typeof window === 'undefined' || isRemotePwaRuntime() || !window.api) return
  const entry: RendererLogEntry = {
    level,
    message: clip(message, MAX_MESSAGE_CHARS),
    ...(stack ? { stack: clip(stack, MAX_STACK_CHARS) } : {}),
    source,
    at: Date.now()
  }
  void window.api.invoke('renderer:log', entry).catch(() => undefined)
}

function describeReason(reason: unknown): { message: string; stack: string | undefined } {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name || 'Unknown error', stack: reason.stack }
  }
  if (typeof reason === 'string') return { message: reason, stack: undefined }
  try {
    return { message: JSON.stringify(reason), stack: undefined }
  } catch {
    return { message: String(reason), stack: undefined }
  }
}

/** Forward an expected renderer failure to the durable main-process logger. */
export function logRendererError(message: string, cause?: unknown): void {
  const detail = cause === undefined ? { message, stack: undefined } : describeReason(cause)
  send('error', message, detail.stack, 'error')
}

/**
 * Install window-level error handlers and `console.error` interception so every
 * renderer JS error is captured and forwarded to the main-process durable log.
 * Idempotent across HMR/reloads.
 */
export function installRendererErrorCapture(): void {
  window.addEventListener('error', (event: ErrorEvent) => {
    const detail = describeReason(event.error)
    send('error', event.message || detail.message, detail.stack, 'error')
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const detail = describeReason(event.reason)
    send('error', detail.message, detail.stack, 'unhandledrejection')
  })

  // eslint-disable-next-line no-console -- intercepting console.error to capture renderer JS console errors for diagnostics
  const originalError = console.error
  if (originalError) {
    window.console.error = (...args: unknown[]): void => {
      originalError.apply(window.console, args)
      const message = args
        .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)))
        .join(' ')
      send('error', message || 'console.error', undefined, 'console')
    }
  }
}
