import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference
} from '$shared/types'
import {
  MAX_DRAFT_LENGTH,
  MAX_RECOVERY_DRAFTS,
  browserRecoveryStorage,
  emptyRendererRecoverySnapshot,
  isRecoveryIdentifier,
  loadRendererRecoveryState,
  persistRendererRecoveryState,
  recoveryDraftKey,
  removeRendererRecoveryState,
  type ComposerDraftEntry,
  type MainView,
  type QueuedMessageEntry,
  type RecoveryStorage,
  type RendererRecoverySnapshot,
  type SelectedThreadReference
} from './renderer-recovery'

export type {
  ComposerDraftEntry,
  MainView,
  QueuedMessageEntry,
  RecoveryStorage,
  RendererRecoverySnapshot,
  SelectedThreadReference,
  SettingsSection
} from './renderer-recovery'
export {
  isSettingsSection,
  isSettingsView,
  settingsSectionForView,
  settingsViewForSection
} from './renderer-recovery'

/**
 * Restart-safe renderer navigation and composer state.
 *
 * Mutations persist synchronously and tolerate blocked/quota-limited storage.
 * Consumers should restore IDs against main-process data before selecting them.
 */
export class RendererRecoveryStore {
  activeView = $state<MainView>('projects')
  selectedProjectId = $state<string | null>(null)
  selectedThread = $state<SelectedThreadReference | null>(null)
  collapsedFolders = $state<string[]>([])
  favoriteModels = $state<string[]>([])
  recentModels = $state<string[]>([])
  auditModelKey = $state<string | undefined>(undefined)
  private composerDrafts = $state<Record<string, ComposerDraftEntry>>({})
  private queuedMessages = $state<Record<string, QueuedMessageEntry>>({})

  constructor(private readonly storage: RecoveryStorage | undefined = browserRecoveryStorage()) {
    const saved = loadRendererRecoveryState(this.storage)
    this.activeView = saved.activeView
    this.selectedProjectId = saved.selectedProjectId
    this.selectedThread = saved.selectedThread
    this.collapsedFolders = saved.collapsedFolders
    this.favoriteModels = saved.favoriteModels
    this.recentModels = saved.recentModels
    this.auditModelKey = saved.auditModelKey
    this.composerDrafts = saved.composerDrafts
    this.queuedMessages = saved.queuedMessages
  }

  private entryFor(projectId: string, threadId: string): ComposerDraftEntry {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId))
      return { text: '', attachments: [], projectReferences: [], taskReferences: [] }
    return (
      this.composerDrafts[recoveryDraftKey(projectId, threadId)] ?? {
        text: '',
        attachments: [],
        projectReferences: [],
        taskReferences: []
      }
    )
  }

  snapshot(): RendererRecoverySnapshot {
    return {
      version: 1,
      activeView: this.activeView,
      selectedProjectId: this.selectedProjectId,
      selectedThread: this.selectedThread ? { ...this.selectedThread } : null,
      composerDrafts: { ...this.composerDrafts },
      queuedMessages: { ...this.queuedMessages },
      collapsedFolders: [...this.collapsedFolders],
      favoriteModels: [...this.favoriteModels],
      recentModels: [...this.recentModels],
      auditModelKey: this.auditModelKey
    }
  }

  toggleCollapsedFolder(projectId: string): void {
    const idx = this.collapsedFolders.indexOf(projectId)
    if (idx === -1) {
      this.collapsedFolders = [...this.collapsedFolders, projectId]
    } else {
      this.collapsedFolders = this.collapsedFolders.filter((id) => id !== projectId)
    }
    this.persist()
  }

  isFolderCollapsed(projectId: string): boolean {
    return this.collapsedFolders.includes(projectId)
  }

  setActiveView(view: MainView): void {
    this.activeView = view
    this.persist()
  }

  setSelectedProject(projectId: string | null): void {
    if (projectId !== null && !isRecoveryIdentifier(projectId)) return
    this.selectedProjectId = projectId
    if (this.selectedThread?.projectId !== projectId) this.selectedThread = null
    this.persist()
  }

  setSelectedThread(projectId: string, threadId: string): void {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId)) return
    this.selectedProjectId = projectId
    this.selectedThread = { projectId, threadId }
    this.persist()
  }

  clearSelectedThread(): void {
    this.selectedThread = null
    this.persist()
  }

  draftFor(projectId: string, threadId: string): string {
    return this.entryFor(projectId, threadId).text
  }

  /** Whether the thread has any unsent composer content (text, attachments, or references). */
  hasDraftContent(projectId: string, threadId: string): boolean {
    const entry = this.entryFor(projectId, threadId)
    return (
      entry.text.length > 0 ||
      entry.attachments.length > 0 ||
      entry.projectReferences.length > 0 ||
      entry.taskReferences.length > 0 ||
      this.queuedMessageFor(projectId, threadId) !== null
    )
  }

  attachmentsFor(projectId: string, threadId: string): PromptAttachment[] {
    return this.entryFor(projectId, threadId).attachments
  }

  projectReferencesFor(projectId: string, threadId: string): PromptProjectReference[] {
    return this.entryFor(projectId, threadId).projectReferences
  }

  taskReferencesFor(projectId: string, threadId: string): PromptAssignmentTaskReference[] {
    return this.entryFor(projectId, threadId).taskReferences
  }

  setDraft(
    projectId: string,
    threadId: string,
    draft: string,
    attachments?: PromptAttachment[],
    projectReferences?: PromptProjectReference[],
    taskReferences?: PromptAssignmentTaskReference[]
  ): void {
    if (
      !isRecoveryIdentifier(projectId) ||
      !isRecoveryIdentifier(threadId) ||
      typeof draft !== 'string' ||
      draft.length > MAX_DRAFT_LENGTH
    ) {
      return
    }

    const key = recoveryDraftKey(projectId, threadId)
    const current = this.composerDrafts[key] ?? {
      text: '',
      attachments: [],
      projectReferences: [],
      taskReferences: []
    }
    const nextAttachments = attachments ?? current.attachments
    const nextProjectReferences = projectReferences ?? current.projectReferences
    const nextTaskReferences = taskReferences ?? current.taskReferences
    // No-op writes must not reassign state — callers may run inside effects.
    if (
      current.text === draft &&
      current.attachments === nextAttachments &&
      current.projectReferences === nextProjectReferences &&
      current.taskReferences === nextTaskReferences
    )
      return

    const next = { ...this.composerDrafts }
    if (
      draft.length === 0 &&
      nextAttachments.length === 0 &&
      nextProjectReferences.length === 0 &&
      nextTaskReferences.length === 0
    ) {
      delete next[key]
    } else {
      if (!(key in next) && Object.keys(next).length >= MAX_RECOVERY_DRAFTS) {
        const oldestKey = Object.keys(next)[0]
        if (oldestKey) delete next[oldestKey]
      }
      next[key] = {
        text: draft,
        attachments: nextAttachments,
        projectReferences: nextProjectReferences,
        taskReferences: nextTaskReferences
      }
    }
    this.composerDrafts = next
    this.persist()
  }

  clearDraft(projectId: string, threadId: string): void {
    this.setDraft(projectId, threadId, '', [], [], [])
  }

  /** The persisted queued message for a thread, if any. */
  queuedMessageFor(projectId: string, threadId: string): QueuedMessageEntry | null {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId)) return null
    return this.queuedMessages[recoveryDraftKey(projectId, threadId)] ?? null
  }

  /** Persist a message queued while the agent was busy. */
  setQueuedMessage(projectId: string, threadId: string, entry: QueuedMessageEntry): void {
    if (
      !isRecoveryIdentifier(projectId) ||
      !isRecoveryIdentifier(threadId) ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0 ||
      entry.text.length > MAX_DRAFT_LENGTH
    ) {
      return
    }

    const key = recoveryDraftKey(projectId, threadId)
    if (this.queuedMessages[key] === entry) return

    const next = { ...this.queuedMessages }
    if (!(key in next) && Object.keys(next).length >= MAX_RECOVERY_DRAFTS) {
      const oldestKey = Object.keys(next)[0]
      if (oldestKey) delete next[oldestKey]
    }
    next[key] = {
      text: entry.text,
      attachments: entry.attachments,
      promptContext: entry.promptContext,
      promptReferences: entry.promptReferences,
      projectReferences: entry.projectReferences,
      presentation: entry.presentation,
      taskReferences: entry.taskReferences
    }
    this.queuedMessages = next
    this.persist()
  }

  /** Drop the persisted queued message once it is consumed or discarded. */
  clearQueuedMessage(projectId: string, threadId: string): void {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId)) return
    const key = recoveryDraftKey(projectId, threadId)
    if (!(key in this.queuedMessages)) return
    const next = { ...this.queuedMessages }
    delete next[key]
    this.queuedMessages = next
    this.persist()
  }

  reset(): void {
    const initial = emptyRendererRecoverySnapshot()
    this.activeView = initial.activeView
    this.selectedProjectId = initial.selectedProjectId
    this.selectedThread = initial.selectedThread
    this.composerDrafts = initial.composerDrafts
    this.queuedMessages = initial.queuedMessages
    removeRendererRecoveryState(this.storage)
  }

  toggleFavorite(modelKey: string): void {
    const idx = this.favoriteModels.indexOf(modelKey)
    if (idx === -1) {
      this.favoriteModels = [...this.favoriteModels, modelKey]
    } else {
      this.favoriteModels = this.favoriteModels.filter((k) => k !== modelKey)
    }
    this.persist()
  }

  isFavorite(modelKey: string): boolean {
    return this.favoriteModels.includes(modelKey)
  }

  /**
   * Move a favorite to a new position relative to another favorite. The array
   * is stored oldest-first; the picker displays it reversed, so callers should
   * pass the position in storage order (the picker flips before forwarding).
   */
  reorderFavorite(draggedKey: string, targetKey: string, position: 'before' | 'after'): void {
    if (draggedKey === targetKey) return
    const favorites = [...this.favoriteModels]
    const draggedIndex = favorites.indexOf(draggedKey)
    if (draggedIndex === -1) return
    favorites.splice(draggedIndex, 1)
    const targetIndex = favorites.indexOf(targetKey)
    if (targetIndex === -1) return
    favorites.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, draggedKey)
    this.favoriteModels = favorites
    this.persist()
  }

  addRecentModel(modelKey: string): void {
    this.recentModels = [modelKey, ...this.recentModels.filter((k) => k !== modelKey)].slice(0, 10)
    this.persist()
  }

  setAuditModel(modelKey: string): void {
    this.auditModelKey = modelKey
    const [, providerId, modelId] = modelKey.split(':')
    if (providerId && modelId && !this.isFavorite(`${providerId}:${modelId}`)) {
      this.addRecentModel(`${providerId}:${modelId}`)
      return
    }
    this.persist()
  }

  private persist(): void {
    persistRendererRecoveryState(this.storage, this.snapshot())
  }
}

export const rendererRecovery = new RendererRecoveryStore()
