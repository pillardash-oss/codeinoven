import type { WebContents } from 'electron'
import { clipboard } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { sendToRenderer } from './renderer-delivery'
import { validateBoolean, validateEntityId } from './ipc-validation'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { GatewaySupervisorService } from '../gateway/gateway-supervisor-service'
import { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'

/**
 * Register the validated gateway renderer boundary and forward supervisor
 * state changes to the renderer.
 */
export function registerGatewayIpc(
  storage: StorageEngine,
  getWebContents: () => WebContents | null | undefined,
  providers = new BaseUrlProviderService(storage),
  supervisor = new GatewaySupervisorService(storage, providers, new SecretVault(storage))
): GatewaySupervisorService {
  supervisor.onStateChange((status) => {
    sendToRenderer(getWebContents(), 'gateway:state', status)
  })

  ipcMain.handle('gateway:list', () => supervisor.listStatus())

  ipcMain.handle(
    'gateway:setEnabled',
    (_, rawPluginId: unknown, rawEnabled: unknown) =>
      supervisor.setEnabled(validateEntityId(rawPluginId, 'Gateway plugin ID'), validateBoolean(rawEnabled, 'Enabled'))
  )

  ipcMain.handle('gateway:start', (_, rawPluginId: unknown) =>
    supervisor.start(validateEntityId(rawPluginId, 'Gateway plugin ID'))
  )

  ipcMain.handle('gateway:stop', (_, rawPluginId: unknown) =>
    supervisor.stop(validateEntityId(rawPluginId, 'Gateway plugin ID'))
  )

  ipcMain.handle('gateway:uninstall', (_, rawPluginId: unknown) =>
    supervisor.uninstall(validateEntityId(rawPluginId, 'Gateway plugin ID'))
  )

  ipcMain.handle('gateway:update', (_, rawPluginId: unknown) =>
    supervisor.update(validateEntityId(rawPluginId, 'Gateway plugin ID'))
  )

  ipcMain.handle('gateway:refreshCatalog', (_, rawPluginId: unknown) =>
    supervisor.refreshCatalog(validateEntityId(rawPluginId, 'Gateway plugin ID'))
  )

  ipcMain.handle('gateway:copyDashboardPassword', async (_, rawPluginId: unknown) => {
    const password = await supervisor.dashboardPassword(
      validateEntityId(rawPluginId, 'Gateway plugin ID')
    )
    clipboard.writeText(password)
  })

  return supervisor
}
