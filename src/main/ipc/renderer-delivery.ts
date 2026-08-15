import type { WebContents } from 'electron'
import { Logger } from '../system/logger'

type RendererTarget = Pick<WebContents, 'send'> &
  Partial<Pick<WebContents, 'isCrashed' | 'isDestroyed' | 'isLoadingMainFrame' | 'mainFrame'>>

const DISPOSED_FRAME_PATTERNS = [
  'render frame was disposed',
  'webframemain could be accessed',
  'object has been destroyed',
  'webcontents was destroyed'
] as const

function isExpectedLifecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return DISPOSED_FRAME_PATTERNS.some((pattern) => normalized.includes(pattern))
}

/**
 * Deliver one main-to-renderer event without racing frame reload/destruction.
 *
 * `WebContents.isDestroyed()` is insufficient: Electron can retain the
 * WebContents while its WebFrameMain is replaced during reload/navigation.
 * The readiness checks avoid known unavailable states; the catch closes the
 * unavoidable check/send race. Payloads are never logged.
 */
export function sendToRenderer(
  target: RendererTarget | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!target) return false
  try {
    if (
      target.isDestroyed?.() ||
      target.isCrashed?.() ||
      target.isLoadingMainFrame?.() ||
      target.mainFrame?.detached
    ) {
      return false
    }
    target.send(channel, ...args)
    return true
  } catch (error) {
    if (!isExpectedLifecycleError(error)) {
      Logger.error('Renderer IPC delivery failed', {
        channel,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return false
  }
}
