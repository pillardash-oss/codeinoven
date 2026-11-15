import {
  dialog,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'

/** The window whose renderer is replaced, read at click time. */
export interface WorkspaceRestartTarget {
  /** The workspace window, or null while the app is parked without one. */
  window: () => BrowserWindow | null
  /** Create the window, or show and focus the existing one. */
  openWindow: () => void
}

/**
 * Renderers this module ended on purpose. The window's `render-process-gone`
 * handler consumes the entry, which is how a requested stop is told apart from a
 * crash that belongs to the recovery dialog.
 */
const requestedRestarts = new WeakSet<WebContents>()
let restartPending = false

/**
 * Replace only the workspace renderer. Everything in the main process keeps
 * running, so a frozen page never costs the work behind it; `force-restart`
 * remains the item that takes both ends down.
 */
export function restartWorkspaceMenuItem(restart: () => void): MenuItemConstructorOptions {
  return {
    label: 'Restart workspace',
    click: () => restart()
  }
}

/** True once, for a renderer that was ended by `requestWorkspaceRestart`. */
export function consumeWorkspaceRestartRequest(contents: WebContents): boolean {
  return requestedRestarts.delete(contents)
}

function liveWindow(target: WorkspaceRestartTarget): BrowserWindow | null {
  const window = target.window()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
  return window
}

/** End the renderer and let the window load a fresh one. */
function replaceRenderer(target: WorkspaceRestartTarget): void {
  const window = liveWindow(target)
  if (!window) {
    target.openWindow()
    return
  }
  const contents = window.webContents
  Logger.info('Restarting the workspace renderer on request')
  if (contents.isCrashed()) {
    contents.reload()
  } else {
    // A hung renderer cannot be reloaded: the navigation would reuse the same
    // stuck process. Ending the process is what frees the window, and the
    // window's own `render-process-gone` handler loads the page again.
    requestedRestarts.add(contents)
    contents.forcefullyCrashRenderer()
  }
  target.openWindow()
}

export async function requestWorkspaceRestart(target: WorkspaceRestartTarget): Promise<void> {
  if (restartPending) return
  // A parked app has no renderer to replace: opening the window builds a fresh one.
  if (!liveWindow(target)) {
    target.openWindow()
    return
  }
  restartPending = true
  try {
    // The dialog is native and unparented, so it answers while the page cannot.
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Restart workspace',
      message: `Restart the ${APP_NAME} workspace?`,
      detail:
        'Only the window is rebuilt. Running tasks keep going. Text you have not sent or saved in the window may be lost.',
      buttons: ['Cancel', 'Restart workspace'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    })
    if (response === 1) replaceRenderer(target)
  } catch (error) {
    Logger.error('Could not restart the workspace renderer', error)
  } finally {
    restartPending = false
  }
}

/** The open "not responding" dialog, so a page that recovers can close it. */
let openOffer: AbortController | null = null

/**
 * The page stopped responding: offer the restart at once instead of leaving the
 * user to find it. Waiting changes nothing, and the menu item stays available.
 */
export async function offerWorkspaceRestart(target: WorkspaceRestartTarget): Promise<void> {
  if (restartPending || !liveWindow(target)) return
  restartPending = true
  const offer = new AbortController()
  openOffer = offer
  const icon = process.platform === 'darwin' ? 'menu bar icon' : 'tray icon'
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Workspace not responding',
      message: `The ${APP_NAME} workspace is not responding`,
      detail: `Running tasks are not affected and keep going. You can wait for the window to recover, or restart it now. Restart workspace is also available from the ${APP_NAME} ${icon} at any time. Text you have not sent or saved in the window may be lost on restart.`,
      buttons: ['Wait', 'Restart workspace'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      signal: offer.signal
    })
    if (response === 1 && !offer.signal.aborted) replaceRenderer(target)
  } catch (error) {
    Logger.error('Could not offer a workspace restart', error)
  } finally {
    if (openOffer === offer) openOffer = null
    restartPending = false
  }
}

/** The page answered again, or its renderer is gone: the offer no longer applies. */
export function withdrawWorkspaceRestartOffer(): void {
  openOffer?.abort()
  openOffer = null
}
