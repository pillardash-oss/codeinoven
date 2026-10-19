import type { BootstrapState } from './bootstrap-state'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { app } from 'electron'
import os from 'node:os'
import { cleanUpdaterCache } from '../notifications/updater-cache-cleanup'
import { getAppCacheDir, resolveUpdaterCacheLocation } from '../notifications/updater-download'
import { purgeAbandonedInstallStaging } from '../notifications/updater-install-recovery'

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
    // Sweep before checks/downloads can acquire a cache file. Newer pending
    // updates survive startup so interrupted downloads remain resumable.
    const cache = resolveUpdaterCacheLocation()
    if (cache && state.updaterService.status.canAutoUpdate) {
      await cleanUpdaterCache(cache.cacheDir, { installedVersion: app.getVersion() })
      if (process.platform === 'win32')
        await purgeAbandonedInstallStaging({
          platform: process.platform,
          tmpDir: os.tmpdir(),
          cacheHome: getAppCacheDir(process.platform, os.homedir()),
          updaterCacheDir: cache.cacheDir,
          bundleId: null,
          appName: app.getName().toLowerCase()
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
