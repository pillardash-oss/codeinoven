import type { WebContents } from 'electron'
import type { HistoryDirection } from './browser-history-gesture'

/**
 * The one place a page's history is walked.
 *
 * A gesture, a mouse side button and the browser's own Back control all end up
 * here, so the detail that makes traversal usable is stated once: native
 * traversal can hand the keyboard back to the app renderer, so a page that had
 * it keeps it, which is what lets the next gesture reach that page too.
 *
 * Returns whether a page entry was actually available in that direction. A
 * caller that owns the input still consumes it at a history end.
 */
export function navigatePageHistory(contents: WebContents, direction: HistoryDirection): boolean {
  if (contents.isDestroyed()) return false
  const history = contents.navigationHistory
  const canNavigate = direction === 'back' ? history.canGoBack() : history.canGoForward()
  if (!canNavigate) return false
  const wasFocused = contents.isFocused()
  if (direction === 'back') history.goBack()
  else history.goForward()
  if (wasFocused && !contents.isDestroyed()) contents.focus()
  return true
}
