import { validateEntityId } from '../validation/primitives'
import { requireString } from './shared'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { CioCleanupExclusionToggleInput } from '../../../lib/types/cio-cleanup'
import type { IpcHandlerContext } from './context'

/** Longest exclusion path accepted, matching the file-tree paths it is set from. */
const MAX_EXCLUSION_PATH_LENGTH = 1024

/**
 * CIO Cleanup: the state the surfaces render, the manual run, and the
 * exclusion toggle behind the file tree's context menu.
 *
 * The service is absent only in a bare handler set (tests and tooling), and a
 * missing service reports an empty state rather than an error: the settings
 * page then says nothing ran instead of showing a failure the user cannot act
 * on.
 */
export function registerCioCleanupHandlers(ctx: IpcHandlerContext): void {
  const service = ctx.options.cioCleanup

  ipcMain.handle('cioCleanup:state', async () => {
    if (!service) {
      return { retentionDays: 0, nextRunAt: null, running: false, lastRun: null, exclusions: [] }
    }
    return service.state()
  })

  ipcMain.handle('cioCleanup:run', async () => {
    if (!service) throw new Error('CIO Cleanup is not available')
    return service.runManually()
  })

  ipcMain.handle('cioCleanup:cancel', (_, runId: unknown) => {
    if (!service) throw new Error('CIO Cleanup is not available')
    service.cancel(validateEntityId(runId, 'Cleanup run ID'))
  })

  ipcMain.handle('cioCleanup:toggleExclusion', async (_, input: unknown) => {
    if (!service) throw new Error('CIO Cleanup is not available')
    return service.toggleExclusion(validateExclusionInput(input))
  })
}

function validateExclusionInput(value: unknown): CioCleanupExclusionToggleInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Exclusion input must be an object')
  }
  const record = value as Record<string, unknown>
  const threadId = record['threadId']
  return {
    projectId: validateEntityId(record['projectId'], 'Project ID'),
    scopeBucketId: validateEntityId(record['scopeBucketId'], 'Scope bucket ID'),
    ...(threadId === undefined || threadId === null
      ? {}
      : { threadId: validateEntityId(threadId, 'Thread ID') }),
    path: requireString(record['path'], 'Exclusion path').slice(0, MAX_EXCLUSION_PATH_LENGTH)
  }
}
