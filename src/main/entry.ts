import { app, dialog, shell } from 'electron'
import { Logger } from './system/logger'
import { setMainBundleDirectory } from './bootstrap/bundle-directory'
import { installWindowsRenderingDefaults } from './system/windows-rendering'

setMainBundleDirectory(import.meta.url)

// Chromium reads these switches once, when the renderer starts, so they have to
// be in place before the ready event. Doing it here, ahead of the application
// module, keeps them applied even when that module fails to load.
installWindowsRenderingDefaults()

// Await module evaluation before Electron's ready event so privileged schemes
// and sandbox setup still run on time. Import failures remain catchable even
// when a native dependency fails before index.ts can register its ready hook.
try {
  await import('./index')
} catch (error: unknown) {
  Logger.error('Application module could not load; starting independent recovery', error)
  void app
    .whenReady()
    .then(async () => {
      try {
        const [{ createBootstrapState }, { StorageEngine }, { handleFatalStartup }] =
          await Promise.all([
            import('./bootstrap/bootstrap-state'),
            import('./storage/storage-engine'),
            import('./bootstrap/fatal-startup')
          ])
        const state = createBootstrapState()
        app.on('before-quit', () => {
          state.quitCleanupStarted = true
          state.updaterService?.stop()
        })
        await handleFatalStartup(error, { state, storage: new StorageEngine() })
      } catch (recoveryError: unknown) {
        Logger.error('Automatic recovery could not load; offering manual download', recoveryError)
        // This last route imports no application service and reads no app data.
        const { response } = await dialog.showMessageBox({
          type: 'error',
          title: 'Application recovery',
          message: 'The application could not load. Download a replacement to recover.',
          buttons: ['Open download page', 'Quit'],
          cancelId: 1,
          defaultId: 0,
          noLink: true
        })
        if (response === 0) await shell.openExternal('https://codeinoven.com/downloads')
        app.quit()
      }
    })
    .catch((recoveryError: unknown) => Logger.error('Native recovery failed', recoveryError))
}
