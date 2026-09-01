import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { Logger } from '../system/logger'
import type { RendererLogEntry, RendererLogLevel, RendererLogSource } from '../../lib/ipc-contract'

const MAX_MESSAGE_CHARS = 8000
const MAX_STACK_CHARS = 16000

/**
 * Renderer-to-main durable logging bridge.
 *
 * The renderer runs in its own process and cannot import the main-process
 * `Logger`; JS errors that happen there (uncaught exceptions, unhandled
 * rejections, console errors) used to be invisible on disk. This handler
 * receives a tightly-shaped `RendererLogEntry` from the renderer, bounds and
 * redacts it, and routes it through the existing durable `Logger` so client
 * errors land in `error.log` / `main.jsonl` alongside main-process records.
 *
 * The handler is registered before BrowserWindow navigation (hydration IPC) so
 * the bridge works from the very first renderer statement and is fire-and-forget:
 * it never throws and never blocks the renderer.
 */
function sanitize(raw: unknown): RendererLogEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const rawLevel = record.level
  if (rawLevel !== 'dev' && rawLevel !== 'info' && rawLevel !== 'error') return null
  const level: RendererLogLevel = rawLevel
  if (typeof record.message !== 'string') return null
  const message = record.message.slice(0, MAX_MESSAGE_CHARS)
  if (!message) return null
  const stack =
    typeof record.stack === 'string' && record.stack
      ? record.stack.slice(0, MAX_STACK_CHARS)
      : undefined
  let source: RendererLogSource = 'error'
  if (
    record.source === 'unhandledrejection' ||
    record.source === 'console' ||
    record.source === 'watchdog'
  ) {
    source = record.source
  }
  return { level, message, source, stack, at: Date.now() }
}

export function registerRendererLogIpcHandler(): void {
  ipcMain.handle('renderer:log', (_event, raw: unknown) => {
    const entry = sanitize(raw)
    if (!entry) return
    const prefix = `[renderer:${entry.source}]`
    if (entry.stack) {
      Logger.error(prefix, entry.message, { stack: entry.stack })
      return
    }
    if (entry.level === 'info') Logger.info(prefix, entry.message)
    else if (entry.level === 'dev') Logger.dev(prefix, entry.message)
    else Logger.error(prefix, entry.message)
  })
}
