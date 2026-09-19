import { validateAppConfigPatch } from './config-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

export function registerEditorsHandlers(ctx: IpcHandlerContext): void {
  const { storage, editorService } = ctx

  editorService.warmUp()
  ipcMain.handle('editors:detect', () => editorService.detect())
  ipcMain.handle('editors:getPreferred', async () => (await storage.getConfig()).preferredEditor)
  ipcMain.handle('editors:setPreferred', async (_, editorId: unknown) => {
    const patch = validateAppConfigPatch({ preferredEditor: editorId })
    const config = { ...(await storage.getConfig()), ...patch }
    await storage.saveConfig(config)
  })
}
