import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { broadcastNoteChanged } from '../../chat/thread-events'
import { parseThreadContextUsage } from '../../database/repositories/thread-repo'
import {
  validateBoundedString,
  validateBoolean,
  validateEntityId,
  validateScopeSlice,
  validateSortOrder,
  validateThreadSettings,
  validateThreadStatus
} from '../ipc-validation'
import { requireString, requireVersion, validateStringArray } from './shared'
import type { IpcHandlerContext } from './context'

/** Upper bound on one persisted composer draft payload. */
const MAX_DRAFT_JSON_LENGTH = 256 * 1024

export function registerNotesHandlers(ctx: IpcHandlerContext): void {
  const { threadCreation, threadManager, specEngine, repositoryService, noteRepo } = ctx

  const NOTE_BODY_MAX = 100_000

  ipcMain.handle('note:save', async (_, projectId: unknown, threadId: unknown, body: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const validBody = validateBoundedString(body, 'Note body', 0, NOTE_BODY_MAX)
    const thread = await threadManager.getThread(validProjectId, validThreadId)
    if (!thread) throw new Error('Thread not found')
    const previous = noteRepo.get(validThreadId)
    const now = Date.now()
    const note = {
      threadId: validThreadId,
      body: validBody,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    noteRepo.upsert(note)
    broadcastNoteChanged(validProjectId, validThreadId, true)
    return note
  })
  ipcMain.handle('note:delete', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const thread = await threadManager.getThread(validProjectId, validThreadId)
    if (!thread) throw new Error('Thread not found')
    noteRepo.delete(validThreadId)
    broadcastNoteChanged(validProjectId, validThreadId, false)
  })
  ipcMain.handle('note:list', () => noteRepo.listThreadIds())
  ipcMain.handle(
    'thread:dismissSpecReview',
    async (_, projectId: unknown, threadId: unknown, specId: unknown, specVersion: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validSpecId = validateEntityId(specId, 'Specification ID')
      const validSpecVersion = requireVersion(specVersion)
      const workflow = await specEngine.getWorkflowState(validProjectId, validThreadId)
      if (
        workflow?.activeSpecId !== validSpecId ||
        workflow.activeSpecVersion !== validSpecVersion
      ) {
        throw new Error('Only the active specification can be dismissed')
      }
      return threadManager.dismissSpecReview(
        validProjectId,
        validThreadId,
        validSpecId,
        validSpecVersion
      )
    }
  )
  ipcMain.handle('thread:setStatus', (_, projectId: unknown, threadId: unknown, status: unknown) =>
    threadManager.setStatus(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateThreadStatus(status)
    )
  )
  ipcMain.handle('thread:setPinned', (_, projectId: unknown, threadId: unknown, pinned: unknown) =>
    threadManager.setPinned(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateBoolean(pinned, 'Pinned')
    )
  )
  ipcMain.handle(
    'thread:setContextUsage',
    async (_, projectId: unknown, threadId: unknown, usage: unknown) => {
      const parsed = parseThreadContextUsage(usage)
      if (!parsed) throw new TypeError('Thread context usage is malformed')
      await threadManager.setContextUsage(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        parsed
      )
    }
  )
  ipcMain.handle('thread:harnessUsage', async (_, projectId: unknown, threadId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    return threadManager.harnessUsageFor(safeProjectId, safeThreadId)
  })
  ipcMain.handle('thread:efficiencyKpis', async (_, projectId: unknown, threadId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    return threadManager.efficiencyKpisFor(safeProjectId, safeThreadId)
  })
  ipcMain.handle('thread:markRead', async (_, projectId: string, threadId: string) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    return threadManager.markRead(projectId, safeThreadId)
  })
  ipcMain.handle(
    'thread:draftActivity',
    (_, projectId: string, threadId: string, drafting: boolean) => {
      // Composer activity no longer anchors any grading deadline: ranking
      // conversations close on thread deletion or the inactivity deadline.
      validateEntityId(projectId, 'Project ID')
      validateEntityId(threadId, 'Thread ID')
      validateBoolean(drafting, 'Drafting')
    }
  )
  ipcMain.handle(
    'thread:setDraftState',
    async (_, projectId: string, threadId: string, drafting: boolean, draftJson: string | null) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      validateBoolean(drafting, 'Drafting')
      if (draftJson !== null) {
        if (typeof draftJson !== 'string') {
          throw new TypeError('Draft JSON must be a string or null')
        }
        if (draftJson.length > MAX_DRAFT_JSON_LENGTH) {
          throw new TypeError('Draft JSON exceeds the persistence limit')
        }
      }
      await threadManager.setDraftState(safeProjectId, safeThreadId, drafting, draftJson)
    }
  )
  ipcMain.handle('thread:listDrafting', async () => threadManager.listDraftingThreads())
  ipcMain.handle('thread:reorder', (_, projectId: unknown, orderedIds: unknown) =>
    threadManager.reorderThreads(
      validateEntityId(projectId, 'Project ID'),
      validateStringArray(orderedIds, 'Ordered IDs')
    )
  )
  ipcMain.handle(
    'thread:setSortOrder',
    (_, projectId: unknown, threadId: unknown, sortOrder: unknown) =>
      threadManager.setSortOrder(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateSortOrder(sortOrder)
      )
  )
  ipcMain.handle('thread:reorderPinned', (_, projectId: unknown, orderedPinnedIds: unknown) =>
    threadManager.reorderPinnedThreads(
      validateEntityId(projectId, 'Project ID'),
      validateStringArray(orderedPinnedIds, 'Ordered pinned IDs')
    )
  )
  ipcMain.handle('thread:reorderPinnedGlobal', (_, orderedPinnedIds: unknown) =>
    threadManager.reorderPinnedThreadsGlobal(
      validateStringArray(orderedPinnedIds, 'Ordered pinned IDs')
    )
  )
  ipcMain.handle(
    'thread:reorderScope',
    (_, projectId: unknown, bucketId: unknown, slice: unknown, orderedIds: unknown) =>
      threadManager.reorderScopeThreads(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(bucketId, 'Scope bucket ID'),
        validateScopeSlice(slice),
        validateStringArray(orderedIds, 'Ordered scope thread IDs')
      )
  )
  ipcMain.handle(
    'thread:updateSettings',
    async (_, projectId: unknown, threadId: unknown, settings: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSettings = validateThreadSettings(settings)
      await threadCreation.awaitReady(safeThreadId)
      return threadManager.updateSettings(safeProjectId, safeThreadId, safeSettings)
    }
  )
  ipcMain.handle(
    'thread:setIndependentAudit',
    async (_, projectId: unknown, threadId: unknown, enabled: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      if (typeof enabled !== 'boolean') {
        throw new Error('Independent audit toggle must be a boolean')
      }
      await threadCreation.awaitReady(safeThreadId)
      return threadManager.setIndependentAudit(safeProjectId, safeThreadId, enabled)
    }
  )
  ipcMain.handle(
    'thread:fork',
    async (
      _,
      projectId: unknown,
      threadId: unknown,
      title: unknown,
      checkpointId?: unknown,
      messageId?: unknown,
      targetProjectId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeTitle = requireString(title, 'Fork title')
      const safeCheckpointId =
        checkpointId === undefined
          ? undefined
          : validateEntityId(checkpointId, 'Checkpoint ID', 256)
      const safeMessageId =
        messageId === undefined ? undefined : validateBoundedString(messageId, 'Message ID', 1, 256)
      const safeTargetProjectId =
        targetProjectId === undefined
          ? undefined
          : validateEntityId(targetProjectId, 'Target project ID')
      const forked = await threadManager.forkThread(
        safeProjectId,
        safeThreadId,
        safeTitle,
        safeCheckpointId,
        safeMessageId,
        safeTargetProjectId
      )
      if (forked.workingDirectory) {
        const branch = await repositoryService.getCurrentBranch(forked.workingDirectory)
        if (branch) {
          await threadManager.setBranch(forked.projectId, forked.id, branch)
          forked.branch = branch
        }
      }
      return forked
    }
  )
}
