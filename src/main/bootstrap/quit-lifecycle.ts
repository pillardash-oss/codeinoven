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
import type { CloseConfirmationProject } from '../../lib/ipc-contract'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'

/** The subset of bootstrap state the quit gate owns and mutates. */
export interface QuitLifecycleState {
  quitCleanupStarted: boolean
  quitConfirmed: boolean
  shutdownFailsafe: ReturnType<typeof setTimeout> | null
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
  if (state.shutdownFailsafe) clearTimeout(state.shutdownFailsafe)
  state.shutdownFailsafe = setTimeout(() => {
    Logger.error('Quit failsafe fired   forcing exit')
    flushSessionStorage()
    app.exit(0)
  }, 15_000)
}

/** Projects that still have threads being worked on, most active first. */
export function getActiveThreadProjects(database: Database): CloseConfirmationProject[] {
  try {
    const threadRepo = new ThreadRepo(database)
    const projectRepo = new ProjectRepo(database)
    const active = threadRepo.listActive()
    if (active.length === 0) return []
    const byProject = new Map<string, CloseConfirmationProject>()
    for (const thread of active) {
      let entry = byProject.get(thread.projectId)
      if (!entry) {
        const project = projectRepo.get(thread.projectId)
        entry = {
          projectId: thread.projectId,
          projectName: project?.name ?? thread.projectId,
          threadCount: 0,
          threads: []
        }
        byProject.set(thread.projectId, entry)
      }
      entry.threadCount++
      entry.threads.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status
      })
    }
    return [...byProject.values()].sort((a, b) => b.threadCount - a.threadCount)
  } catch (error) {
    Logger.error('Could not query active threads for close confirmation', error)
    return []
  }
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
}

/**
 * Decide whether a close/quit can proceed. With nothing working (or no window
 * to ask) the quit continues immediately; otherwise the renderer is prompted
 * and the quit pauses until `app:confirmClose` (or `app:parkWindow`) arrives.
 *
 * The renderer is always asked   it owns the unsaved-file editor state, which
 * also gates the close. It replies through `app:confirmClose` immediately when
 * nothing is pending, or shows the confirmation modal otherwise.
 */
export function requestCloseConfirmation(deps: CloseConfirmationDeps): void {
  const { state, window, park = false } = deps
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
  // owns the unsaved-file gate, which it computes locally.
  const working =
    park || instanceRegistry.hasOtherLiveInstance() ? [] : getActiveThreadProjects(deps.database)
  sendToRenderer(window.webContents, 'window:confirmClose', {
    projects: working,
    files: [],
    ...(park ? { park: true } : {})
  })
}
