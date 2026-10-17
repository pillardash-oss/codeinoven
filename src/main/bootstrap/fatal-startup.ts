import { app, dialog, shell } from 'electron'
import { APP_NAME } from '../../lib/brand'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { startupTelemetry } from '../system/startup-telemetry'
import type { BootstrapState } from './bootstrap-state'
import { closeSplash } from './splash-window'
import { startStartupUpdater } from './startup-updater'
import { signalNativeSplashReady } from '../system/native-splash-handoff'
import { queueAppRelaunch } from '../system/app-relaunch'

export interface FatalStartupContext {
  state: BootstrapState
  database?: Database
  storage: StorageEngine
}

const recovering = new WeakSet<BootstrapState>()
const DOWNLOAD_PAGE = 'https://codeinoven.com/downloads'
const DOWNLOAD_ACTION = 'Open download page'
const RESTART_ACTION = 'Restart'
const QUIT_ACTION = 'Quit'

/** Keep recovery independent of the database, app configuration and renderer. */
export async function handleFatalStartup(
  error: unknown,
  context: FatalStartupContext
): Promise<void> {
  const { state, storage } = context
  if (recovering.has(state)) return
  recovering.add(state)
  state.startupRecovery = true
  Logger.error(`${APP_NAME} workspace startup failed; updates remain available`, error)
  try {
    signalNativeSplashReady()
    closeSplash()
    startupTelemetry.stopEventLoopMonitor()
    startupTelemetry.report('startup recovery')
  } catch (diagnosticError) {
    Logger.error('Startup recovery diagnostics failed', diagnosticError)
  }
  void Logger.flush().catch(() => {})
  await startStartupUpdater(state, storage).catch(() => {})

  // Native asynchronous dialogs need no preload, renderer bundle, CSS, SQLite
  // or parsed settings. Each action returns here, including network failures.
  while (!state.quitCleanupStarted) {
    const status = state.updaterService?.status
    const canAutoUpdate = status?.canAutoUpdate === true
    const action = !canAutoUpdate
      ? DOWNLOAD_ACTION
      : status?.state === 'downloaded'
        ? 'Install update'
        : status?.state === 'available'
          ? 'Download update'
          : 'Check for updates'
    // The dedicated download button only exists while the primary action does
    // something else; adding it unconditionally would show the dialog twice
    // whenever the primary action already opens the download page.
    const buttons = canAutoUpdate
      ? [action, DOWNLOAD_ACTION, RESTART_ACTION, QUIT_ACTION]
      : [action, RESTART_ACTION, QUIT_ACTION]
    const downloadIndex = buttons.indexOf(DOWNLOAD_ACTION)
    const restartIndex = buttons.indexOf(RESTART_ACTION)
    const quitIndex = buttons.indexOf(QUIT_ACTION)
    try {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: `${APP_NAME} recovery`,
        message: 'The workspace could not open. You can still update the application.',
        detail: `${error instanceof Error ? error.message : String(error)}\n\nUpdate status: ${status?.state ?? 'unavailable'}${status?.availableVersion ? ` (${status.availableVersion})` : ''}${status?.errorMessage ? `\n${status.errorMessage}` : ''}`,
        buttons,
        defaultId: 0,
        cancelId: quitIndex,
        noLink: true
      })
      if (canAutoUpdate && response === downloadIndex) {
        await shell.openExternal(DOWNLOAD_PAGE)
      } else if (response === restartIndex) {
        queueAppRelaunch()
        app.quit()
        return
      } else if (response === quitIndex) {
        app.quit()
        return
      } else if (!canAutoUpdate) {
        await shell.openExternal(DOWNLOAD_PAGE)
      } else {
        await startStartupUpdater(state, storage)
        const updater = state.updaterService
        if (!updater?.status.canAutoUpdate) await shell.openExternal(DOWNLOAD_PAGE)
        else if (updater?.status.state === 'downloaded') updater.quitAndInstall()
        else if (updater?.status.state === 'available') await updater.downloadUpdate()
        else await updater?.checkForUpdates(true)
      }
    } catch (recoveryError) {
      Logger.error('Recovery action failed; keeping update recovery available', recoveryError)
      // Yield before retrying, including when the native dialog itself fails.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    }
  }
}
