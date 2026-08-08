/**
 * Close-overlay coordination for the Cmd/Ctrl+W "close the active surface"
 * shortcut.
 *
 * Reusable overlay components (`Modal`, `DockableModal`) register their close
 * behavior on a LIFO stack while open, so the shortcut closes exactly the
 * topmost registered overlay. Genuine modal dialogs — bits-ui Dialog/AlertDialog,
 * which listen for Escape on `document` — are closed through a non-bubbling
 * synthetic Escape on `document`. Non-bubbling events keep window-level
 * listeners (e.g. the chat composer's double-Escape stop) inert, so the
 * shortcut can never abort a running turn.
 *
 * Only `aria-modal="true"` dialogs are considered: hover-only popovers and
 * pickers that merely carry `role="dialog"` (e.g. the context-usage popover)
 * are permanently in the DOM and must never be mistaken for an open modal, or
 * the shortcut would be swallowed and never close the active thread.
 */

type CloseHandler = () => void

const closeHandlers: CloseHandler[] = []

/** Register an overlay's close behavior. Returns an unsubscribe function. */
export function registerOverlayClose(handler: CloseHandler): () => void {
  closeHandlers.push(handler)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    const index = closeHandlers.indexOf(handler)
    if (index !== -1) closeHandlers.splice(index, 1)
  }
}

/** Invoke the topmost registered overlay's close behavior. */
export function requestCloseTopOverlay(): boolean {
  const handler = closeHandlers[closeHandlers.length - 1]
  if (!handler) return false
  handler()
  return true
}

const DIALOG_SELECTOR = '[aria-modal="true"], [role="alertdialog"]'

function isVisible(element: Element): boolean {
  if (element instanceof HTMLElement) {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
  }
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** The topmost visible dialog currently rendered, if any. */
export function findTopVisibleDialog(): Element | null {
  const dialogs = Array.from(document.querySelectorAll(DIALOG_SELECTOR))
  for (let index = dialogs.length - 1; index >= 0; index--) {
    if (isVisible(dialogs[index])) return dialogs[index]
  }
  return null
}

/**
 * Close the topmost visible dialog, if any. Dispatches a non-bubbling Escape on
 * `document` for bits-ui Dialog/AlertDialog EscapeLayers and on the dialog
 * element itself for element-level Escape handlers. Returns whether an overlay
 * was found (regardless of whether it actually closed).
 */
export function closeTopVisibleDialog(): boolean {
  const overlay = findTopVisibleDialog()
  if (!overlay) return false
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: false, cancelable: true })
  )
  overlay.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: false, cancelable: true })
  )
  return true
}
