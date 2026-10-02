import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { GLOBAL_BROWSER_PROJECT_ID, isBrowserTabId } from '../../../lib/ipc/browser'
import { broadcastNoteChanged } from '../../chat/thread-events'
import { parseThreadContextUsage } from '../../database/repositories/thread-repo'
import { messageId } from '../../../lib/id'
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
  const STICKY_NOTE_TITLE_MAX = 120
  const STICKY_NOTE_ICON_MAX = 80
  const STICKY_NOTE_SVG_MAX = 40_000

  function validateStickyNoteAppearance(value: unknown) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Sticky note appearance is invalid')
    }
    const record = value as Record<string, unknown>
    const title = validateBoundedString(
      record['title'],
      'Sticky note title',
      1,
      STICKY_NOTE_TITLE_MAX
    ).trim()
    if (title === '') throw new TypeError('Sticky note title cannot be empty')
    const color = validateBoundedString(record['color'], 'Sticky note colour', 7, 7)
    if (!/^#[\da-f]{6}$/iu.test(color)) throw new TypeError('Sticky note colour is invalid')
    const iconType =
      record['iconType'] === null
        ? null
        : validateBoundedString(record['iconType'], 'Sticky note icon', 1, STICKY_NOTE_ICON_MAX)
    if (iconType !== null && !/^[a-z\d-]+$/iu.test(iconType)) {
      throw new TypeError('Sticky note icon is invalid')
    }
    const customSvg =
      record['customSvg'] === null
        ? null
        : validateBoundedString(record['customSvg'], 'Sticky note SVG', 1, STICKY_NOTE_SVG_MAX)
    return { title, iconType, customSvg, color }
  }

  /**
   * Resolve a note's subject. Every project keys a note by a real thread, and
   * the reserved global browser project keys it by a browser tab instead. The
   * renderer passes the tab id in the same `threadId` position, which is what
   * lets one Notes panel and one `note:*` surface serve both subjects.
   */
  function validateNoteSubject(
    projectId: unknown,
    subjectId: unknown
  ): { projectId: string; subjectId: string; browserTab: boolean } {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    if (validProjectId === GLOBAL_BROWSER_PROJECT_ID) {
      if (!isBrowserTabId(subjectId)) throw new TypeError('Browser tab ID is invalid')
      return { projectId: validProjectId, subjectId, browserTab: true }
    }
    return {
      projectId: validProjectId,
      subjectId: validateEntityId(subjectId, 'Thread ID'),
      browserTab: false
    }
  }

  ipcMain.handle('note:save', async (_, projectId: unknown, threadId: unknown, body: unknown) => {
    const subject = validateNoteSubject(projectId, threadId)
    const validBody = validateBoundedString(body, 'Note body', 0, NOTE_BODY_MAX)
    const now = Date.now()
    if (subject.browserTab) {
      const previous = noteRepo.getForBrowserTab(subject.subjectId)
      const note = {
        tabId: subject.subjectId,
        body: validBody,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      }
      noteRepo.upsertForBrowserTab(note)
      broadcastNoteChanged(subject.projectId, subject.subjectId, true)
      // Reported in the shape the one Notes panel already reads.
      return {
        threadId: note.tabId,
        body: note.body,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      }
    }
    const thread = await threadManager.getThread(subject.projectId, subject.subjectId)
    if (!thread) throw new Error('Thread not found')
    const previous = noteRepo.get(subject.subjectId)
    const note = {
      threadId: subject.subjectId,
      body: validBody,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    noteRepo.upsert(note)
    broadcastNoteChanged(subject.projectId, subject.subjectId, true)
    return note
  })
  ipcMain.handle('note:delete', async (_, projectId: unknown, threadId: unknown) => {
    const subject = validateNoteSubject(projectId, threadId)
    if (subject.browserTab) {
      noteRepo.deleteForBrowserTab(subject.subjectId)
      broadcastNoteChanged(subject.projectId, subject.subjectId, false)
      return
    }
    const thread = await threadManager.getThread(subject.projectId, subject.subjectId)
    if (!thread) throw new Error('Thread not found')
    noteRepo.delete(subject.subjectId)
    broadcastNoteChanged(subject.projectId, subject.subjectId, false)
  })
  ipcMain.handle('note:list', () => noteRepo.listThreadIds().concat(noteRepo.listBrowserTabIds()))
  ipcMain.handle('sticky-note:list', () => noteRepo.listStickyNotesViaWorker())
  ipcMain.handle('sticky-note:get', (_, rawId: unknown) =>
    noteRepo.getStickyNoteViaWorker(validateEntityId(rawId, 'Sticky note ID'))
  )
  ipcMain.handle('sticky-note:create', (_, rawAppearance: unknown) => {
    const appearance = validateStickyNoteAppearance(rawAppearance)
    const now = Date.now()
    const note = {
      id: messageId(),
      ...appearance,
      body: '',
      createdAt: now,
      updatedAt: now
    }
    noteRepo.createStickyNote(note)
    return note
  })
  ipcMain.handle('sticky-note:update', (_, rawId: unknown, rawAppearance: unknown) => {
    const id = validateEntityId(rawId, 'Sticky note ID')
    const appearance = validateStickyNoteAppearance(rawAppearance)
    noteRepo.updateStickyNoteAppearance(id, appearance, Date.now())
  })
  ipcMain.handle('sticky-note:save', (_, rawId: unknown, rawBody: unknown) => {
    const id = validateEntityId(rawId, 'Sticky note ID')
    const body = validateBoundedString(rawBody, 'Sticky note body', 0, NOTE_BODY_MAX)
    noteRepo.saveStickyNoteBody(id, body, Date.now())
  })
  ipcMain.handle('sticky-note:delete', (_, rawId: unknown) =>
    noteRepo.deleteStickyNote(validateEntityId(rawId, 'Sticky note ID'))
  )
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
