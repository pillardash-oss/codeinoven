/**
 * Renderer error classification shared by the main-process log bridge and the
 * renderer's own error surfaces.
 *
 * Some messages reach `window.onerror` without describing an app failure:
 * they are the engine reporting its own bookkeeping. Chromium raises
 * "ResizeObserver loop completed with undelivered notifications" whenever an
 * observer's callback schedules more layout than a single frame allows. It
 * fires from ordinary panel layout, an app cannot act on it, and it accounted
 * for 881 records across 10 day folders by 2026-11-02.
 *
 * Keeping the patterns in one module means the durable log and the in-app
 * Errors panel agree: the log records these at `dev` so a layout loop someone
 * is actually chasing stays visible, and the panel never lists them as an app
 * error the user is asked to read.
 */
const BENIGN_RENDERER_ERROR_PATTERNS = [
  /^ResizeObserver loop (?:completed|limit exceeded)/u
] as const

/** True for engine bookkeeping messages that are not app failures. */
export function isBenignRendererErrorMessage(message: string): boolean {
  const normalized = message.trim()
  if (!normalized) return false
  return BENIGN_RENDERER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
}
