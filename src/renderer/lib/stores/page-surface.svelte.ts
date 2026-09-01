/**
 * Which surface currently owns the Escape key.
 *
 * The workspace shell — including the open thread, its chat composer, and any
 * dictation recording on it — stays mounted but CSS-hidden while a full-page
 * surface is active: a Settings page or the Scope view. Window-level key
 * listeners owned by that hidden shell (the composer's Escape-armed stop, the
 * speech controller's Escape-stops-recording) must stay inert while such a
 * page is on top: the topmost surface owns Escape, and Escape pressed there
 * means "close this page", never "stop the run" or "stop the recording".
 *
 * The same applies to every overlay above the shell — modals, sheets, and
 * palette dialogs (the command palette and the settings spotlight): Escape
 * pressed while one is open must close only that topmost overlay, never arm
 * the composer's stop or kill a recording behind it.
 *
 * Derived straight from the recovery store's active view, so it can never
 * drift from the navigation state.
 */

import { isOverlayOpen } from '../overlay-close.svelte'
import { isSettingsView, rendererRecovery } from './renderer-recovery.svelte'

const workspaceCovered = $derived(
  rendererRecovery.activeView === 'scope' || isSettingsView(rendererRecovery.activeView)
)

/** True while a full-page surface (a Settings page or the Scope view) covers the workspace shell. */
export function isWorkspaceCovered(): boolean {
  return workspaceCovered
}

/**
 * True while some surface owns the Escape key, so late window-level listeners
 * (composer stop, recording stop, settings-page back) must stay inert:
 * - the event was already consumed by an overlay that handled it — bits-ui
 *   dialogs preventDefault the real keydown when their EscapeLayer closes
 *   them, and they do so on `document`, before window listeners run;
 * - a full-page Settings/Scope page covers the workspace shell;
 * - an overlay (modal, sheet, palette dialog) is open. Overlay unmount and
 *   unregistration flush in a microtask after the keydown finishes
 *   dispatching, so `isOverlayOpen()` still sees the overlay during the very
 *   event that closes it.
 */
export function isEscapeClaimed(event?: KeyboardEvent): boolean {
  if (event?.defaultPrevented) return true
  return workspaceCovered || isOverlayOpen()
}
