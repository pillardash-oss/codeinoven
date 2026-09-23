import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { sendToRenderer } from './renderer-delivery'
import { validateBoundedString } from './ipc-validation'
import type { TypesafeDecisionService } from '../typesafe/typesafe-decision-service'

/** Longest key the renderer may submit; the vault holds whatever it accepts. */
const KEY_MAXIMUM_LENGTH = 4_096

/**
 * Register the renderer boundary for the TypeSafe (Jev) capability.
 *
 * Three of the four channels never carry a secret back, and the fourth takes
 * one as transient input only, so the renderer can display the capability
 * without ever holding the key.
 */
export function registerTypesafeIpc(typesafe: TypesafeDecisionService): void {
  ipcMain.handle('typesafe:getStatus', () => typesafe.getStatus())

  ipcMain.handle('typesafe:setKey', async (_, value: unknown) => {
    const key = validateBoundedString(value, 'TypeSafe API key', 1, KEY_MAXIMUM_LENGTH)
    const status = await typesafe.setKey(key)
    broadcastStatus(status)
    return status
  })

  ipcMain.handle('typesafe:clearKey', async () => {
    const status = await typesafe.clearKey()
    broadcastStatus(status)
    return status
  })

  ipcMain.handle('typesafe:check', async () => {
    const result = await typesafe.check()
    broadcastStatus(await typesafe.getStatus())
    return result
  })
}

/** Push the capability's state to every window, the way other status cards do. */
function broadcastStatus(status: Awaited<ReturnType<TypesafeDecisionService['getStatus']>>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'typesafe:status', status)
  }
}
