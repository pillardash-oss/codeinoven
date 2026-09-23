/**
 * Ordered disposal executed once the quit lifecycle begins.
 *
 * 1. Renderer notification + 500ms grace period
 * 2. PTY sessions destroyed
 * 3. Notification service stopped
 * 4. Chat engine / driver processes disposed
 * 5. Log buffer flushed
 * 6. app.quit()   re-enters before-quit, but the guard skips cleanup
 *    and Electron proceeds to close windows → will-quit → exit.
 */

import { app } from 'electron'
import type { Database } from '../database/database'
import { flushDraftWrites } from '../chat/draft-commit-gate'
import { setNotificationService, setPowerWakeService } from '../chat/thread-events'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import type { WindowStateService } from '../system/window-state'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { BootstrapState } from './bootstrap-state'

export interface ShutdownContext {
  state: BootstrapState
  windowStateService: WindowStateService
  database: Database
}

export async function runShutdownPipeline(context: ShutdownContext): Promise<void> {
  const { state, database } = context
  // Give the renderer a moment to process window:beforeQuit.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  try {
    state.updaterService?.stop()
  } catch (error) {
    Logger.error('Updater service cleanup failed during shutdown:', error)
  }

  try {
    state.skillUpdateService?.stop()
  } catch (error) {
    Logger.error('Skill update service cleanup failed during shutdown:', error)
  }

  try {
    state.ptyService?.destroyAll()
  } catch (error) {
    Logger.error('PTY cleanup failed during shutdown:', error)
  }

  try {
    state.notificationService?.stop()
  } catch (error) {
    Logger.error('Notification service cleanup failed during shutdown:', error)
  }
  setNotificationService(null)
  setPowerWakeService(null)
  try {
    state.powerWakeService?.stop()
  } catch (error) {
    Logger.error('Power-wake cleanup failed during shutdown:', error)
  }

  try {
    state.retryScheduler?.dispose()
  } catch (error) {
    Logger.error('Retry scheduler cleanup failed during shutdown:', error)
  }

  try {
    state.heartbeatScheduler?.dispose()
  } catch (error) {
    Logger.error('Heartbeat scheduler cleanup failed during shutdown:', error)
  }

  try {
    state.routineScheduler?.dispose()
  } catch (error) {
    Logger.error('Routine scheduler cleanup failed during shutdown:', error)
  }

  try {
    state.modelPricingService?.stop()
  } catch (error) {
    Logger.error('Model pricing cleanup failed during shutdown:', error)
  }

  try {
    state.browserService?.dispose()
    state.browserService = null
  } catch (error) {
    Logger.error('Browser service cleanup failed during shutdown:', error)
  }

  try {
    await state.gatewaySupervisor?.dispose()
  } catch (error) {
    Logger.error('Gateway supervisor cleanup failed during shutdown:', error)
  }

  try {
    await state.computerUsePipService?.dispose()
  } catch (error) {
    Logger.error('Computer-use PiP service cleanup failed during shutdown:', error)
  }

  try {
    ipcMain.removeHandler('prototypePreview:getOrigin')
    state.chatEngine?.setPrototypePreviewRegistrar(null)
    await state.prototypePreviewService?.dispose()
    state.prototypePreviewService = null
  } catch (error) {
    Logger.error('Prototype preview service cleanup failed during shutdown:', error)
  }

  try {
    await state.directoryPreviewService?.dispose()
    state.directoryPreviewService = null
  } catch (error) {
    Logger.error('Directory preview service cleanup failed during shutdown:', error)
  }

  try {
    state.unregisterSpeechIpc?.()
    state.unregisterSpeechIpc = null
    await state.speechService?.dispose()
    state.speechService = null
  } catch (error) {
    Logger.error('Speech service cleanup failed during shutdown:', error)
  }

  // A take-over pass must never start while the process is shutting down.
  state.stopInstanceTakeOverListener?.()
  state.stopInstanceTakeOverListener = null

  state.foreignRuns?.dispose()
  state.foreignRuns = null

  state.threadTransfer?.dispose()
  state.threadTransfer = null

  // Persist the final window geometry so the next launch restores size, position,
  // and maximized state exactly as the user left them.
  try {
    await context.windowStateService.persistNow(state.mainWindow)
  } catch (error) {
    Logger.error('Window state flush failed during shutdown:', error)
  }

  // When another live instance can continue the project's threads, this
  // instance exits without disposing the chat engine   disposal kills every
  // agent-owned harness process, which would destroy threads the surviving
  // instance is still working on. The threads' durable state lives in the
  // shared DB, so the other instance resumes them seamlessly.
  if (!instanceRegistry.hasOtherLiveInstance()) {
    try {
      await state.chatEngine?.dispose()
    } catch (error) {
      Logger.error('Chat engine disposal failed during shutdown:', error)
    }
  }

  try {
    await Logger.flush()
  } catch {
    // Logger may already be flushed; nothing more can be written.
  }

  try {
    // Flush any in-flight thread draft commits BEFORE the database closes so a
    // debounced draft write delivered during the quit grace period can never
    // land on an already-closed database.
    await flushDraftWrites()
    // Await the graceful database close (typed worker shutdown acknowledged +
    // primary connection closed) so app.quit() never races the storage teardown.
    await database.close()
  } catch (error) {
    Logger.error('Database close failed during shutdown:', error)
  }

  instanceRegistry.stop()

  app.quit()
}
