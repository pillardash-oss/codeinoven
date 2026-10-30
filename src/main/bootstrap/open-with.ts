/**
 * OS "Open in CodeInOven" hand-off, and the one-instance-per-data-root rule.
 *
 * Folders and files the user opens from Finder/Explorer, drops on the Dock or
 * taskbar icon, or passes on the command line are queued by the open-with
 * service and drained by the renderer. A second launch never boots beside the
 * running instance: it takes the single-instance lock, hands its paths over as
 * `second-instance`, and exits. The lock is keyed by the Electron userData path,
 * so an instance with its own data root (a probe, a worktree pointed at its own
 * root) still runs beside this one.
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
  // One instance per data root, always.
  //
  // A second boot beside a live one doubles everything the running instance is
  // already doing: harness children, WAL writers, file watchers, sweeps. Every
  // launch that measured 13-20 s in the durable startup log was exactly that
  // overlap (each logged `Automatic resume deferred to another live CodeInOven
  // instance` for the previous pid, with 2-17 orphaned harness processes left
  // behind), while two launches on the same code with nothing else running
  // painted in 744 ms and 822 ms.
  const ownsInstance = app.requestSingleInstanceLock()
  if (!ownsInstance) {
    // Electron already forwarded this argv to the running instance as
    // `second-instance`. Exit before any window or service starts.
    app.exit(0)
    return
  }
  app.on('second-instance', (_event, argv) => {
    // The lock is what makes a second launch reach this instance at all, so the
    // window that is already open has to be the thing the user ends up looking
    // at, with the paths they tried to open handed to it.
    focusRunningWindow(state)
    void relayOpenedPaths(parseOpenedPathArguments(argv))
  })
  if (launchedPaths.length > 0) void openWithService.ingest(launchedPaths)

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

/** Bring the window that already answered a second launch back to the front. */
function focusRunningWindow(state: OpenWithState): void {
  if (state.quitCleanupStarted) return
  const window = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null
  if (!window) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
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
