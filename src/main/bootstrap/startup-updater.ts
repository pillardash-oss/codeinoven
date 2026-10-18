import type { BootstrapState } from './bootstrap-state'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'

const starting = new WeakMap<BootstrapState, Promise<void>>()

/** Updates must not depend on SQLite, renderer hydration or optional engines. */
export function startStartupUpdater(state: BootstrapState, storage: StorageEngine): Promise<void> {
  const existing = starting.get(state)
  if (existing) return existing
  const pending = (async () => {
    if (!state.updaterService) {
      const { UpdaterService } = await import('../notifications/updater-service')
      state.updaterService = new UpdaterService(storage)
      let quitWasConfirmed = false
      state.updaterService.attachUpdateQuitHooks({
        begin: () => {
          quitWasConfirmed = state.quitConfirmed
          state.quitForUpdate = true
          // A missing renderer cannot answer a close request. Healthy windows
          // still get their normal unsaved-file confirmation before shutdown.
          const window = state.mainWindow
          if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            state.startupRecovery
          )
            state.quitConfirmed = true
        },
        end: () => {
          state.quitForUpdate = false
          if (!state.quitCleanupStarted) state.quitConfirmed = quitWasConfirmed
        }
      })
      // Downloads/checks work during initialization; installation waits until
      // activity tracking is ready, or recovery explicitly releases the gate.
      state.updaterService.addActivitySource({
        activeSessionCount: () =>
          state.featuresReady || state.startupRecovery || state.startupServicesFailed ? 0 : 1
      })
    }
    state.updaterService.start()
    // Tray integration is optional and must not hold the independent updater.
    try {
      state.backgroundLifecycle?.setUpdater({
        updateInBackground: async () => {
          await state.updaterService?.updateInBackground()
        },
        status: () => state.updaterService?.status ?? { canAutoUpdate: false, state: 'idle' },
        onStatusChange: (callback) =>
          state.updaterService?.onStatusChange(callback) ?? (() => undefined)
      })
    } catch (error: unknown) {
      Logger.error('Update tray integration failed; independent updates continue', error)
    }
    const { registerUpdaterHandlers } = await import('../ipc/handlers/updater-handlers')
    registerUpdaterHandlers({ updaterService: state.updaterService })
  })().catch((error: unknown) => {
    starting.delete(state)
    Logger.error('Independent updater startup failed; recovery can retry or open downloads', error)
    throw error
  })
  starting.set(state, pending)
  return pending
}
