import { getConfigRoot } from '../../../lib/utils'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { requireString } from './shared'
import type { StorageAreaId, StorageClearTarget } from '../../../lib/types'
import type { StorageManagerService } from '../../storage-manager/storage-manager-service'
import type { IpcHandlerContext } from './context'

/** The areas the user is allowed to clear. `database` is compacted, never deleted. */
const CLEARABLE_TARGETS: ReadonlySet<StorageClearTarget> = new Set<StorageClearTarget>([
  'models',
  'recordings',
  'caches',
  'logs'
])

/** Every area a reveal may name, plus the data root itself. */
const REVEALABLE_AREAS: ReadonlySet<StorageAreaId | 'root'> = new Set<StorageAreaId | 'root'>([
  'root',
  'database',
  'models',
  'recordings',
  'caches',
  'logs',
  'workspaces',
  'projects',
  'app-data'
])

/**
 * The Storage manager: one measurement, the destructive clears, the folder
 * reveal, and the database compaction.
 *
 * Nothing here runs at startup. The service module is imported on the first
 * request and the service itself is built then, so the feature costs nothing
 * until a window actually opens the surface. Measuring and deleting happen on
 * a worker thread the service owns, never on the main process.
 *
 * A clear is refused rather than reported as done when the service cannot be
 * built, because a clear that silently removed nothing would read as a
 * successful one.
 */
export function registerStorageManagerHandlers(ctx: IpcHandlerContext): void {
  let servicePromise: Promise<StorageManagerService> | null = null

  const service = (): Promise<StorageManagerService> => {
    servicePromise ??= import('../../storage-manager/storage-manager-service').then(
      ({ StorageManagerService: Service }) =>
        new Service({ configRoot: getConfigRoot, database: ctx.database })
    )
    return servicePromise
  }

  ipcMain.handle('storageManager:usage', async (_, force: unknown) => {
    const manager = await service()
    return manager.usage(force === true)
  })

  ipcMain.handle('storageManager:clear', async (_, target: unknown) => {
    const manager = await service()
    return manager.clear(validateClearTarget(target))
  })

  ipcMain.handle('storageManager:vacuum', async () => {
    const manager = await service()
    return manager.vacuum()
  })

  ipcMain.handle('storageManager:reveal', async (_, area: unknown) => {
    const manager = await service()
    return manager.reveal(validateRevealArea(area))
  })
}

function validateClearTarget(value: unknown): StorageClearTarget {
  const target = requireString(value, 'Storage area')
  if (!CLEARABLE_TARGETS.has(target as StorageClearTarget)) {
    throw new TypeError(`Storage area cannot be cleared: ${target}`)
  }
  return target as StorageClearTarget
}

function validateRevealArea(value: unknown): StorageAreaId | 'root' {
  const area = requireString(value, 'Storage area')
  if (!REVEALABLE_AREAS.has(area as StorageAreaId | 'root')) {
    throw new TypeError(`Unknown storage area: ${area}`)
  }
  return area as StorageAreaId | 'root'
}
