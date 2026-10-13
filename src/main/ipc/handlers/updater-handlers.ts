import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

const registered = new WeakSet<NonNullable<IpcHandlerContext['updaterService']>>()

export function registerUpdaterHandlers(ctx: Pick<IpcHandlerContext, 'updaterService'>): void {
  const { updaterService } = ctx

  if (updaterService && !registered.has(updaterService)) {
    ipcMain.handle('updater:check', (_, explicit?: unknown) =>
      updaterService.checkForUpdates(explicit === true)
    )

    ipcMain.handle('updater:getStatus', () => updaterService.status)

    ipcMain.handle('updater:getChangelog', () => updaterService.fetchChangelog())

    ipcMain.handle('updater:download', () => updaterService.downloadUpdate())

    ipcMain.handle('updater:install', () => updaterService.quitAndInstall())

    ipcMain.handle('updater:blockers', () => updaterService.blockers())

    ipcMain.handle('updater:forceInstall', () => updaterService.forceInstall())
    registered.add(updaterService)
  }
}
