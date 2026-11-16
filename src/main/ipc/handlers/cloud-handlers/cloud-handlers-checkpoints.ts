import { Logger } from '../../../system/logger'
import { validateEntityId } from '../../ipc-validation'
import { requireString, validateStringArray } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import type { IpcHandlerContext } from '../context'

/** Thread checkpoints: listing, diffs, rollback and redo. */
export function registerCheckpointHandlers(ctx: IpcHandlerContext): void {
  const { chatEngine, checkpointManager } = ctx

  ipcMain.handle('checkpoint:list', async (_, projectId: unknown, threadId: unknown) => {
    const project = validateEntityId(projectId, 'Project ID')
    const thread = validateEntityId(threadId, 'Thread ID')
    // Opening or refreshing a thread is the one moment a stuck turn is provable:
    // a checkpoint still `active` with no ledger row can never be finalized, and
    // leaving it there hides the turn's file card and keeps a sibling instance
    // reading the thread as work in progress. Settle it before listing so the
    // card the reader is owed appears in the same pass.
    await checkpointManager.settleOrphanedThreadCheckpoints(project, thread).catch((error) => {
      Logger.error('Orphaned checkpoint settlement failed (non-fatal):', error)
    })
    return checkpointManager.listSummaries(project, thread)
  })
  ipcMain.handle('checkpoint:activeSummary', async (_, projectId: string, threadId: string) => {
    if (!chatEngine?.activeTurnChangeSummary) return null
    return chatEngine.activeTurnChangeSummary(projectId, threadId)
  })
  ipcMain.handle('checkpoint:latestSummary', (_, projectId: string, threadId: string) =>
    checkpointManager.latestSummary(projectId, threadId)
  )
  ipcMain.handle(
    'checkpoint:liveDiff',
    (_, projectId: unknown, threadId: unknown, checkpointId: unknown, path: unknown) =>
      checkpointManager.getLiveFileDiff(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(checkpointId, 'Checkpoint ID'),
        requireString(path, 'Checkpoint path')
      )
  )
  ipcMain.handle(
    'checkpoint:diff',
    (_, projectId: unknown, threadId: unknown, checkpointId: unknown, path: unknown) =>
      checkpointManager.getFileDiff(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(checkpointId, 'Checkpoint ID'),
        requireString(path, 'Checkpoint path')
      )
  )
  ipcMain.handle(
    'checkpoint:rollback',
    async (_, projectId: string, threadId: string, checkpointId: string) => {
      await checkpointManager.rollback(projectId, threadId, checkpointId)
      return checkpointManager.listSummaries(projectId, threadId)
    }
  )
  ipcMain.handle(
    'checkpoint:rollbackPaths',
    async (_, projectId: unknown, threadId: unknown, checkpointId: unknown, paths: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      await checkpointManager.rollbackPaths(
        safeProjectId,
        safeThreadId,
        validateEntityId(checkpointId, 'Checkpoint ID'),
        validateStringArray(paths, 'Checkpoint paths')
      )
      return checkpointManager.listSummaries(safeProjectId, safeThreadId)
    }
  )
  ipcMain.handle(
    'checkpoint:redoPaths',
    async (_, projectId: unknown, threadId: unknown, checkpointId: unknown, paths: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      await checkpointManager.redoPaths(
        safeProjectId,
        safeThreadId,
        validateEntityId(checkpointId, 'Checkpoint ID'),
        validateStringArray(paths, 'Checkpoint paths')
      )
      return checkpointManager.listSummaries(safeProjectId, safeThreadId)
    }
  )
}
