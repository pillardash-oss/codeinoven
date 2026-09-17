import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

export function registerUpdaterHandlers(ctx: IpcHandlerContext): void {
  const { updaterService } = ctx

  if (updaterService) {
    ipcMain.handle('updater:check', (_, explicit?: unknown) =>
      updaterService.checkForUpdates(explicit === true)
    )

    ipcMain.handle('updater:getStatus', () => updaterService.status)

    ipcMain.handle('updater:getChangelog', () => updaterService.fetchChangelog())

    ipcMain.handle('updater:download', () => updaterService.downloadUpdate())

    ipcMain.handle('updater:install', () => updaterService.quitAndInstall())
  }
}
