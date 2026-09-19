/**
 * OS "Open in CodeInOven" hand-off.
 *
 * Folders and files the user opens from Finder/Explorer, drops on the Dock or
 * taskbar icon, or passes on the command line are queued by the open-with
 * service and drained by the renderer. A launch that carries paths takes the
 * single-instance lock so a second "Open in CodeInOven" reuses the window that
 * already answered one instead of stacking another app instance; an ordinary
 * launch never requests the lock, so multiple windows remain available exactly
 * as before.
 */

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { openWithService, parseOpenedPathArguments } from '../system/open-with-service'

/** The subset of bootstrap state the open-with queue reads. */
export interface OpenWithState {
  mainWindow: BrowserWindow | null
  quitCleanupStarted: boolean
}

/**
 * Register every OS path hand-off channel. Must run before `ready` so macOS
 * Apple Events are not dropped, and exactly once per process.
 */
export function installOpenWithHandling(state: OpenWithState): void {
  const launchedPaths = parseOpenedPathArguments(process.argv)
  const handlesOpenedPaths = launchedPaths.length > 0 && app.requestSingleInstanceLock()
  if (handlesOpenedPaths) {
    app.on('second-instance', (_event, argv) => {
      void relayOpenedPaths(parseOpenedPathArguments(argv))
    })
  } else if (launchedPaths.length > 0) {
    // Another process already owns the open-with lock; Electron forwards this
    // argv to it as `second-instance`. Exit before any window or service starts.
    app.exit(0)
  }
  if (handlesOpenedPaths) void openWithService.ingest(launchedPaths)

  /**
   * macOS delivers "Open with" and Dock drops as an Apple Event rather than an
   * argument. The listener must exist before `ready` so queued events are not
   * dropped, and it must accept the event so the file is not opened by the
   * default handler instead.
   */
  app.on('open-file', (event, path) => {
    event.preventDefault()
    void relayOpenedPaths([path])
  })

  openWithService.onPaths(() => flushOpenedPathsToRenderer(state))
}

/** Queue OS-supplied paths; the ingest listener hands them to the window. */
async function relayOpenedPaths(rawPaths: readonly string[]): Promise<void> {
  if (rawPaths.length === 0) return
  await openWithService.ingest(rawPaths)
}

/**
 * Push queued paths to the renderer. Paths that arrive before the renderer
 * mounted (a launch, or a macOS `open-file` during startup) stay queued: the
 * renderer drains them itself through `openWith:consumePending`, which keeps
 * delivery deterministic without guessing whether its listeners are installed.
 */
export function flushOpenedPathsToRenderer(state: OpenWithState): void {
  if (state.quitCleanupStarted) return
  const window = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null
  if (!window || window.webContents.isLoadingMainFrame()) return
  const paths = openWithService.consumePending()
  if (paths.length === 0) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  sendToRenderer(window.webContents, 'openWith:paths', paths)
}
