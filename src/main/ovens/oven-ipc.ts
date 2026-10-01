import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { OvenRegistry } from './oven-registry'
import { OvenService } from './oven-service'
import { ovenId, validateSaveOven } from './oven-validation'
import type { StorageEngine } from '../storage/storage-engine'
import type { SecretVault } from '../storage/secret-vault'

export function registerOvenIpc(storage: StorageEngine, vault: SecretVault): OvenService {
  const registry = new OvenRegistry(storage, vault)
  const service = new OvenService(registry)
  ipcMain.handle('oven:state', () => registry.state())
  ipcMain.handle('oven:save', (_event, raw: unknown) => registry.save(validateSaveOven(raw)))
  ipcMain.handle('oven:remove', (_event, raw: unknown) => registry.remove(ovenId(raw)))
  ipcMain.handle('oven:setDefault', (_event, raw: unknown) => registry.setDefault(ovenId(raw)))
  ipcMain.handle('oven:install', (_event, raw: unknown) => service.install(ovenId(raw)))
  ipcMain.handle('oven:probe', (_event, raw: unknown) => service.probe(ovenId(raw)))
  ipcMain.handle('oven:runs', (_event, raw: unknown) => service.runs(ovenId(raw)))
  return service
}
