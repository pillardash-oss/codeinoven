import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { CioCleanupProgress, CioCleanupState } from '../../lib/types/cio-cleanup'

/**
 * Push one live stage of a manual CIO Cleanup run to every window.
 *
 * Only a run the user started reports here. The daily sweep stays silent by
 * design: it publishes state, never progress, so a background pass can never
 * open a dockable panel nobody asked for.
 */
export function broadcastCioCleanupProgress(progress: CioCleanupProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'cioCleanup:progress', progress)
  }
}

/**
 * Tell every window the cleanup state moved: a run started or finished, the
 * retention setting changed, or a path was excluded. The settings page and the
 * file tree's context menu both read from this, so a scheduled run that shows
 * no panel still updates what they display.
 */
export function broadcastCioCleanupState(state: CioCleanupState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'cioCleanup:stateChanged', state)
  }
}
