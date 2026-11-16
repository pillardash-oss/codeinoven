import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { requireString } from './shared'
import type { StorageClearTarget } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

/** The areas the user is allowed to clear. `database` is compacted, never deleted. */
const CLEARABLE_TARGETS: ReadonlySet<StorageClearTarget> = new Set<StorageClearTarget>([
  'models',
  'recordings',
  'caches',
  'logs'
])

/**
 * The Storage manager: one measurement, the destructive clears, and the
 * database compaction.
 *
 * The service is absent only in a bare handler set (tests and tooling), so a
 * missing one reports an empty measurement instead of an error the user cannot
 * act on. A clear without the service is refused, because a clear that silently
 * did nothing would read as a successful one.
 */
export function registerStorageManagerHandlers(ctx: IpcHandlerContext): void {
  const service = ctx.options.storageManager

  ipcMain.handle('storageManager:usage', async (_, force: unknown) => {
    if (!service) {
      return { totalBytes: 0, reclaimableBytes: 0, areas: [], measuredAt: Date.now() }
    }
    return service.usage(force === true)
  })

  ipcMain.handle('storageManager:clear', async (_, target: unknown) => {
    if (!service) throw new Error('The Storage manager is not available')
    return service.clear(validateClearTarget(target))
  })

  ipcMain.handle('storageManager:vacuum', async () => {
    if (!service) throw new Error('The Storage manager is not available')
    return service.vacuum()
  })
}

function validateClearTarget(value: unknown): StorageClearTarget {
  const target = requireString(value, 'Storage area')
  if (!CLEARABLE_TARGETS.has(target as StorageClearTarget)) {
    throw new TypeError(`Storage area cannot be cleared: ${target}`)
  }
  return target as StorageClearTarget
}
