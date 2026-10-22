import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { validateEntityId } from '../ipc/ipc-validation'
import { CustomVendorService } from './custom-vendor-service'
import type { StorageEngine } from '../storage/storage-engine'

/**
 * Custom vendor artwork is read by every `VendorIcon` the first frame mounts, so
 * these channels belong to the pre-navigation surface rather than the post-paint
 * feature graph: a handler registered only once the feature boot reaches its
 * deferred provider block loses that race, and the renderer reports
 * `No handler registered for 'customVendors:listIcons'`.
 *
 * Only the provider-existence check for a save needs the base-URL provider
 * store, so it is imported on demand instead of dragging that module into
 * startup.
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
