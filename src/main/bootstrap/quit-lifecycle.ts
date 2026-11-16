/**
 * The close-confirmation gate.
 *
 * When the user closes the window (traffic-light button) or quits (Cmd+Q / Dock)
 * while threads are still working, the close is intercepted and the renderer is
 * asked to confirm. `quitConfirmed` records that the user approved the forced
 * close so the subsequent close/quit passes straight through.
 */

import { app, session } from 'electron'
import type { BrowserWindow } from 'electron'
import { Worker } from 'node:worker_threads'
import type { BrowserDownloadManager } from '../browser/browser-service/browser-downloads'
import { getActiveThreadProjects } from '../database/active-thread-report'
import type { Database } from '../database/database'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import type { PtyService } from '../system/pty-service'
import { localAiDownloadsInFlight } from '../local-ai/local-ai-downloads'
import type { CleanShutdownStore } from '../system/clean-shutdown-store'

/** The subset of bootstrap state the quit gate owns and mutates. */
export interface QuitLifecycleState {
  quitCleanupStarted: boolean
  quitConfirmed: boolean
  /**
   * The shutdown pipeline has finished and handed the process to Electron's own
   * teardown. From here nothing may cancel the watchdog that covers it.
   */
  quitTeardownStarted: boolean
  shutdownFailsafe: ReturnType<typeof setTimeout> | null
  /** The process-wide download owner, or null when no window ever attached the
   *  browser. Read for the close prompt's downloads section. */
  browserDownloads: BrowserDownloadManager | null
  /** The terminal owner, read for the Local AI rows still fetching their weights. */
  ptyService: PtyService | null
  /** Proof of a deliberate exit, written by the forced-exit path. */
  cleanShutdownStore: CleanShutdownStore | null
}

/**
 * Commit the default session's pending storage (renderer localStorage and
 * friends) to disk. Chromium only writes it on a graceful shutdown, so every
 * path that can force-exit must flush first or the renderer's last UI-state
 * writes are lost across a restart. Best-effort: a flush failure must never
 * block or crash quit.
 */
export function flushSessionStorage(): void {
  try {
    session.defaultSession.flushStorageData()
  } catch (error) {
    Logger.error('Session storage flush failed during quit:', error)
  }
}

/**
 * Hard failsafe for the quit lifecycle. The close-confirmation flow round-trips
 * through the renderer, so a wedged renderer could otherwise hold quit hostage
 * indefinitely. This timer guarantees the process converges on exit: if the
 * pipeline has not completed within 15 seconds of the user asking to quit, the
 * process force-exits. Re-arming on every before-quit keeps it correct across
 * repeated close attempts.
 */
export function armQuitFailsafe(state: QuitLifecycleState): void {
  // A teardown watchdog already owns the exit: it was armed later, covers more
  // of the lifecycle, and must never be replaced by this shorter one.
  if (state.quitTeardownStarted) return
  clearQuitFailsafeTimer(state)
  state.shutdownFailsafe = setTimeout(() => {
    Logger.error('Quit failsafe fired   forcing exit')
    // The user asked to close and the pipeline could not finish in time: that is
    // still a deliberate exit, so leave the marker before the forced one, or the
    // next launch would report every in-flight turn as a harness crash.
    exitOnPurpose(state)
  }, 15_000)
}

/**
 * Deadline for the teardown that follows the shutdown pipeline.
 *
 * Every disposal step has already run when this is armed, so all that is left is
 * Electron's own termination, which is immediate when it is healthy. A teardown
 * still running after ten seconds is not going to finish, and the report that
 * prompted this guard showed exactly that: the pipeline completed at 12:24:56
 * and the main thread never ran again, parked in the run loop with no CPU use.
 */
export const TEARDOWN_GRACE_MS = 10_000

/**
 * How much longer the out-of-process killer waits than the main-thread timer.
 *
 * The timer is the graceful path, and it needs the main thread to run. The stall
 * this guard exists for is inside Node's own environment teardown, where no
 * timer on that thread can fire at all, so the last resort kills this instance
 * from a worker that does not share the wedged thread.
 */
const TEARDOWN_KILL_SLACK_MS = 1_000

/**
 * Guard Electron's process teardown, the one phase the quit pipeline cannot see.
 *
 * `runShutdownPipeline` ends by calling `app.quit()`, and everything after that
 * point runs inside Electron and Node: window and renderer destruction, session
 * flushing, and finally `Environment::RunCleanup`. A handle that never closes
 * there parks the main thread forever, and no JavaScript remains to recover. So
 * this arms the same deliberate exit the earlier phases use, plus a killer that
 * survives a main thread no timer can reach.
 *
 * Called once, from the end of the shutdown pipeline, and never disarmed: only
 * the process exiting ends it.
 */
export function armTeardownWatchdog(state: QuitLifecycleState): void {
  if (state.quitTeardownStarted) return
  state.quitTeardownStarted = true
  clearQuitFailsafeTimer(state)
  state.shutdownFailsafe = setTimeout(() => {
    Logger.error('Process teardown did not finish in time   forcing exit')
    exitOnPurpose(state)
  }, TEARDOWN_GRACE_MS)
  try {
    const watchdog = new Worker(
      `const { workerData } = require('node:worker_threads')
       setTimeout(() => process.kill(workerData.pid, 'SIGKILL'), workerData.deadline)`,
      {
        eval: true,
        workerData: {
          pid: process.pid,
          deadline: TEARDOWN_GRACE_MS + TEARDOWN_KILL_SLACK_MS
        }
      }
    )
    watchdog.on('error', (error) => Logger.error('Teardown watchdog failed', error))
    // Never keep the process alive for a watchdog: a clean exit takes it along.
    watchdog.unref()
  } catch (error) {
    Logger.error('Could not start the teardown watchdog', error)
  }
}

/** Leave the proof of a deliberate exit, then terminate the process. */
function exitOnPurpose(state: QuitLifecycleState): void {
  flushSessionStorage()
  try {
    state.cleanShutdownStore?.recordSync()
  } catch (error) {
    Logger.error('Clean-shutdown marker write failed during a forced exit:', error)
  }
  app.exit(0)
}

function clearQuitFailsafeTimer(state: QuitLifecycleState): void {
  if (!state.shutdownFailsafe) return
  clearTimeout(state.shutdownFailsafe)
  state.shutdownFailsafe = null
}

/**
 * Cancel the armed failsafe because the close it was guarding was abandoned:
 * the user dismissed the confirmation, or a save it asked for failed and the app
 * deliberately stays open. Without this the armed timer force-exits an app the
 * user chose to keep working in fifteen seconds after they said "not now".
 *
 * Once the teardown watchdog owns the exit there is nothing left to cancel: the
 * pipeline finished, every disposal step already ran, and a caller clearing the
 * timer here is what left a stalled exit with no deadline at all.
 */
export function disarmQuitFailsafe(state: QuitLifecycleState): void {
  if (state.quitTeardownStarted) return
  clearQuitFailsafeTimer(state)
}

export interface CloseConfirmationDeps {
  state: QuitLifecycleState
  database: Database
  window: BrowserWindow | null
  /**
   * Park the window (destroy it, keep the backend alive) instead of quitting.
   * The renderer still answers the unsaved-file question, then calls
   * `app:parkWindow` rather than `app:confirmClose`.
   */
  park?: boolean
  /**
   * The quit an update install is driving, not the user.
   *
   * The install already resolved the two gates this prompt would list: it only
   * dispatches with no working sessions, and a running download is either waited
   * for or deliberately overridden by the user. Asking again would put a second
   * prompt in front of an install the user just approved, and dismissing it
   * would strand both the install and the download. So the prompt degrades to the
   * one gate main cannot see: unsaved files, which the renderer answers itself.
   */
  install?: boolean
}

/**
 * Decide whether a close/quit can proceed. With nothing working (or no window
 * to ask) the quit continues immediately; otherwise the renderer is prompted
 * and the quit pauses until `app:confirmClose` (or `app:parkWindow`) arrives.
 *
 * The renderer is always asked   it owns the unsaved-file editor state, which
 * also gates the close. It replies through `app:confirmClose` immediately when
 * nothing is pending, or shows the confirmation modal otherwise. A park is the
 * one close it never replies to on its own: parking keeps the runs alive but
 * takes the window, the app's browser, its previews and its terminals with it,
 * so the prompt is shown even with nothing pending.
 */
export function requestCloseConfirmation(deps: CloseConfirmationDeps): void {
  const { state, window, park = false, install = false } = deps
  if (state.quitCleanupStarted || state.quitConfirmed) return
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    // No window to ask. A park with nothing to park is a no-op; a real quit
    // proceeds immediately.
    if (park) return
    state.quitConfirmed = true
    app.quit()
    return
  }
  // In background mode the working-thread half of the prompt disappears: closing
  // does not stop the runs, so there is nothing to warn about. The renderer still
  // owns the unsaved-file gate, which it computes locally. An update install is
  // the same shape for both halves: it never dispatches over working sessions,
  // and it owns what happens to a download.
  const working =
    install || park || instanceRegistry.hasOtherLiveInstance()
      ? []
      : getActiveThreadProjects(deps.database)
  // Downloads follow the opposite rule. A park keeps the backend alive, so a
  // download keeps running and the section stays empty; a quit stops what it
  // holds open, whichever instance is quitting, because the manager and the
  // Chromium sessions it downloads through belong to this process.
  const downloads = install || park ? [] : (state.browserDownloads?.inFlight() ?? [])
  // A model still arriving is the same shape as a download: a park keeps the
  // backend and its PTYs alive, so it costs nothing and stays out of the prompt.
  const localAiDownloads =
    install || park || !state.ptyService
      ? []
      : localAiDownloadsInFlight(state.ptyService.runningCommands())
  sendToRenderer(window.webContents, 'window:confirmClose', {
    projects: working,
    files: [],
    downloads,
    localAiDownloads,
    ...(park ? { park: true } : {})
  })
}
