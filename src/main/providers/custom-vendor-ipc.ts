import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { validateEntityId } from '../ipc/ipc-validation'
import { CustomVendorService } from './custom-vendor-service'
import type { StorageEngine } from '../storage/storage-engine'

/**
 * Register the saved custom vendor artwork channels.
 *
 * Both channels are feature channels: the renderer's `invoke` helper holds every
 * non-hydration call until main announces `app:featuresReady`, so this must be
 * registered *before* that signal, not from a deferred provider block after it.
 * Registration itself costs nothing; the artwork directory is only read when a
 * mounted vendor icon actually asks for it, so readiness never delays startup.
 */
export function registerCustomVendorIpc(storage: StorageEngine): void {
  const icons = new CustomVendorService(storage)
  ipcMain.handle('customVendors:listIcons', () => icons.list())
  ipcMain.handle('customVendors:saveIcon', async (_, rawId: unknown, image: unknown) => {
    const id = validateEntityId(rawId, 'Custom vendor provider ID', 256)
    const { BaseUrlProviderService } = await import('./base-url-provider-service')
    const providers = await new BaseUrlProviderService(storage).listProviders()
    if (!providers.some((provider) => provider.id === id)) {
      throw new Error('Custom vendor provider not found')
    }
    const icon = await icons.save(id, image)
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window.webContents, 'customVendors:iconChanged', { providerId: id, icon })
    }
    return icon
  })
}
