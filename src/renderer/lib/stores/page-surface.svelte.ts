/**
 * Which full-page surface currently covers the workspace shell.
 *
 * The workspace shell — including the open thread, its chat composer, and any
 * dictation recording on it — stays mounted but CSS-hidden while a full-page
 * surface is active: a Settings page or the Scope view. Window-level key
 * listeners owned by that hidden shell (the composer's Escape-armed stop, the
 * speech controller's Escape-stops-recording) must stay inert while such a
 * page is on top: the topmost surface owns Escape, and Escape pressed there
 * means "close this page", never "stop the run" or "stop the recording".
 *
 * Derived straight from the recovery store's active view, so it can never
 * drift from the navigation state. Runtimes without a covering page (e.g. the
 * mobile PWA shell never lands on a Settings page or Scope) keep their
 * existing behavior.
 */

import { isSettingsView, rendererRecovery } from './renderer-recovery.svelte'

const workspaceCovered = $derived(
  rendererRecovery.activeView === 'scope' || isSettingsView(rendererRecovery.activeView)
)

/** True while a full-page surface (a Settings page or the Scope view) covers the workspace shell. */
export function isWorkspaceCovered(): boolean {
  return workspaceCovered
}
