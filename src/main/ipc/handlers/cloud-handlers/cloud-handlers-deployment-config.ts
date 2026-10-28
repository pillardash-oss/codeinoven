import { Logger } from '../../../system/logger'
import { validateEntityId } from '../../ipc-validation'
import { isRecord, requireString } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import {
  validateCloudDeploymentConfig,
  validateCloudDeploymentProviderKind
} from './cloud-handlers-deployment-validation'
import type {
  CloudDeploymentConfig,
  CloudDeploymentContainer,
  CloudDeploymentProviderKind
} from '../../../../lib/types'
import type { IpcHandlerContext } from '../context'

/**
 * Project cloud deployment config reads and writes. The provider token is
 * vaulted by main via `safeStorage` and never crosses the IPC boundary; a
 * project config only records provider/container selection and account
 * association.
 */
export interface CloudDeploymentConfigStore {
  /** Recompute the project's "has deployments" flag from its stored config. */
  syncFlag(projectId: string): Promise<void>
  /** Read the project's config, or the empty version 3 default. */
  loadOrCreate(projectId: string): Promise<CloudDeploymentConfig>
  /** Persist a config after pruning dead account references. */
  persist(projectId: string, config: CloudDeploymentConfig): Promise<CloudDeploymentConfig>
}

export function createCloudDeploymentConfigStore(
  ctx: IpcHandlerContext
): CloudDeploymentConfigStore {
  const { storage, projectManager } = ctx

  const syncCloudDeploymentsFlag = async (projectId: string): Promise<void> => {
    const hasDeployments = await storage.hasCloudDeployments(projectId)
    await projectManager.setHasDeployments(projectId, hasDeployments).catch(() => undefined)
  }

  const loadOrCreateCloudDeploymentConfig = async (
    projectId: string
  ): Promise<CloudDeploymentConfig> => {
    const existing = await storage.getCloudDeploymentConfig(projectId)
    if (existing) return existing
    return {
      version: 3,
      projectId,
      project: { providers: [], containers: [] },
      updatedAt: Date.now()
    }
  }

  /**
   * Drop account references that no longer exist in the global registry.
   *
   * A config written before the pruning existed (or edited outside the app) can
   * still point at a deleted account, which leaves the project resolving
   * through a credential that is gone. Removing the dangling id, and falling
   * back to a surviving attached account (or none), makes the project resolve
   * again; the container mappings are deliberately kept so a reconnect brings
   * the project's containers straight back instead of losing them.
   */
  const pruneDeadAccountReferences = async (
    projectId: string,
    config: CloudDeploymentConfig
  ): Promise<CloudDeploymentConfig> => {
    const associations = config.project.providerAccounts
    if (!associations) return config
    const registry = await storage.getCloudDeploymentAccounts()
    const knownAccountIds = new Set(registry.accounts.map((account) => account.id))
    let changed = false
    const next: CloudDeploymentConfig['project']['providerAccounts'] = {}
    for (const [kind, association] of Object.entries(associations)) {
      if (!association) continue
      const attachedAccountIds = association.attachedAccountIds.filter((id) =>
        knownAccountIds.has(id)
      )
      if (attachedAccountIds.length === association.attachedAccountIds.length) {
        next[kind as CloudDeploymentProviderKind] = association
        continue
      }
      changed = true
      next[kind as CloudDeploymentProviderKind] = {
        attachedAccountIds,
        activeAccountId:
          association.activeAccountId !== null &&
          attachedAccountIds.includes(association.activeAccountId)
            ? association.activeAccountId
            : (attachedAccountIds[0] ?? null)
      }
    }
    if (!changed) return config
    Logger.dev('Pruned deleted cloud deployment account references', {
      projectId,
      updatedAt: config.updatedAt
    })
    return {
      ...config,
      project: { ...config.project, providerAccounts: next }
    }
  }

  /** Persist a project's config after pruning dead account references. */
  const persistCloudDeploymentConfig = async (
    projectId: string,
    config: CloudDeploymentConfig
  ): Promise<CloudDeploymentConfig> => {
    const pruned = await pruneDeadAccountReferences(projectId, config)
    await storage.saveCloudDeploymentConfig(projectId, pruned)
    await syncCloudDeploymentsFlag(projectId)
    return pruned
  }

  return {
    syncFlag: syncCloudDeploymentsFlag,
    loadOrCreate: loadOrCreateCloudDeploymentConfig,
    persist: persistCloudDeploymentConfig
  }
}

export function registerCloudDeploymentConfigHandlers(
  ctx: IpcHandlerContext,
  store: CloudDeploymentConfigStore
): void {
  const { storage } = ctx
  const {
    syncFlag: syncCloudDeploymentsFlag,
    loadOrCreate: loadOrCreateCloudDeploymentConfig,
    persist: persistCloudDeploymentConfig
  } = store

  ipcMain.handle('cloudDeploy:getConfig', async (_, projectId: unknown) =>
    storage.getCloudDeploymentConfig(validateEntityId(projectId, 'Project ID'))
  )

  ipcMain.handle('cloudDeploy:saveConfig', async (_, projectId: unknown, rawConfig: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeConfig = validateCloudDeploymentConfig(rawConfig, safeProjectId)
    // Accounts live in the global registry; saveConfig only persists the
    // project's provider/container selection and account association. It can
    // never create or mutate account/credential state.
    return persistCloudDeploymentConfig(safeProjectId, safeConfig)
  })

  ipcMain.handle('cloudDeploy:clearConfig', async (_, projectId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    await storage.clearCloudDeploymentConfig(safeProjectId)
    await syncCloudDeploymentsFlag(safeProjectId)
  })

  ipcMain.handle(
    'cloudDeploy:updateContainer',
    async (_, projectId: unknown, providerKind: unknown, containerId: unknown, patch: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID', true)
      if (!isRecord(patch)) throw new TypeError('Container update must be an object')

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const index = config.project.containers.findIndex(
        (mapping) => mapping.providerKind === kind && mapping.id === safeContainerId
      )
      if (index === -1) throw new TypeError('Container not found')

      const current = config.project.containers[index]
      const next: CloudDeploymentContainer = { ...current }
      if (patch.label !== undefined) {
        next.label = requireString(patch.label, 'Container label')
      }
      if (patch.id !== undefined) {
        const newId = requireString(patch.id, 'Container ID')
        if (
          config.project.containers.some(
            (mapping) => mapping.id === newId && mapping.id !== current.id
          )
        ) {
          throw new TypeError(`A container with id ${newId} is already configured`)
        }
        next.id = newId
      }
      config.project.containers = [...config.project.containers]
      config.project.containers[index] = next
      config.updatedAt = Date.now()
      return persistCloudDeploymentConfig(safeProjectId, config)
    }
  )

  ipcMain.handle(
    'cloudDeploy:removeContainer',
    async (_, projectId: unknown, providerKind: unknown, containerId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const remaining = config.project.containers.filter(
        (mapping) => !(mapping.providerKind === kind && mapping.id === safeContainerId)
      )
      if (remaining.length === config.project.containers.length) {
        throw new TypeError('Container not found')
      }
      config.project.containers = remaining
      config.updatedAt = Date.now()
      return persistCloudDeploymentConfig(safeProjectId, config)
    }
  )
}
