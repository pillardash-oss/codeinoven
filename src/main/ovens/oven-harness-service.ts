import type { OvenHarnessInventoryItem } from '../../lib/ovens'
import { Logger } from '../system/logger'

export class OvenHarnessService {
  async getInventory(ovenId: string): Promise<OvenHarnessInventoryItem[]> {
    Logger.info('Getting harness inventory', { ovenId })
    return []
  }

  async updateHarness(ovenId: string, harnessId: string): Promise<OvenHarnessInventoryItem> {
    Logger.info('Updating harness', { ovenId, harnessId })
    return {
      harnessId,
      command: harnessId,
      executablePath: null,
      installedVersion: null,
      health: 'unknown',
      updateAvailable: false,
      checkedAt: Date.now()
    }
  }

  async uninstallHarness(ovenId: string, harnessId: string): Promise<OvenHarnessInventoryItem> {
    Logger.info('Uninstalling harness', { ovenId, harnessId })
    return {
      harnessId,
      command: harnessId,
      executablePath: null,
      installedVersion: null,
      health: 'missing',
      updateAvailable: false,
      checkedAt: Date.now()
    }
  }
}
