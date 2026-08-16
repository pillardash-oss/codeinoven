import type {
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference
} from '$shared/types'
import { parseModelKey } from '$lib/model-keys'
import { setDraftLabelCookie } from './draft-label'
import {
  MAX_DRAFT_LENGTH,
  MAX_RECOVERY_DRAFTS,
  browserRecoveryStorage,
  emptyRendererRecoverySnapshot,
  isRecoveryIdentifier,
  isSettingsView,
  loadRendererRecoveryState,
  persistRendererRecoveryState,
  recoveryDraftKey,
  removeRendererRecoveryState,
  type ComposerDraftEntry,
  type MainView,
  type QueuedMessageEntry,
  type QueuedResponseReference,
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
 * Whether two persisted model keys reference the same underlying model, ignoring
 * how a key was re-serialized. A legacy 2-segment key (`providerId:modelId`) and
 * its harness-scoped reconstruction (`:providerId:modelId`, produced when an
 * empty harness is re-encoded) both identify the same model, so toggling must
 * treat them as equal — otherwise "remove favorite" re-adds instead of removing.
 *
 * Harness is compared too so distinct harnesses stay distinct; only an absent
 * (undefined) harness and an explicitly empty one are considered equivalent,
 * which is the exact mismatch the picker's remove button can produce.
 */
function sameModelIdentity(left: string, right: string): boolean {
  const a = parseModelKey(left)
  const b = parseModelKey(right)
  if (a.providerId !== b.providerId || a.modelId !== b.modelId) return false
  const harnessA = a.harnessId ?? ''
  const harnessB = b.harnessId ?? ''
  return harnessA === harnessB
}

/**
 * Restart-safe renderer navigation and composer state.
 *
 * Mutations persist synchronously and tolerate blocked/quota-limited storage.
 * Consumers should restore IDs against main-process data before selecting them.
 */
export class RendererRecoveryStore {
  activeView = $state<MainView>('projects')
  lastContentView = $state<'projects' | 'chats' | 'threads'>('projects')
  lastViewBeforeSettings = $state<MainView>('projects')
  selectedProjectId = $state<string | null>(null)
  selectedThread = $state<SelectedThreadReference | null>(null)
  collapsedFolders = $state<string[]>([])
  favoriteModels = $state<string[]>([])
  recentModels = $state<string[]>([])
  chatFavoriteModels = $state<string[]>([])
  chatRecentModels = $state<string[]>([])
  auditModelKey = $state<string | undefined>(undefined)
  private composerDrafts = $state<Record<string, ComposerDraftEntry>>({})
  private queuedMessages = $state<Record<string, QueuedMessageEntry>>({})

  constructor(private readonly storage: RecoveryStorage | undefined = browserRecoveryStorage()) {
    const saved = loadRendererRecoveryState(this.storage)
    this.activeView = saved.activeView
    this.lastContentView = saved.lastContentView
    this.lastViewBeforeSettings = saved.lastViewBeforeSettings
    this.selectedProjectId = saved.selectedProjectId
    this.selectedThread = saved.selectedThread
    this.collapsedFolders = saved.collapsedFolders
    this.favoriteModels = saved.favoriteModels
    this.recentModels = saved.recentModels
    this.chatFavoriteModels = saved.chatFavoriteModels
    this.chatRecentModels = saved.chatRecentModels
    this.auditModelKey = saved.auditModelKey
    this.composerDrafts = saved.composerDrafts
    this.queuedMessages = saved.queuedMessages
  }

  private entryFor(projectId: string, threadId: string): ComposerDraftEntry {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId))
      return {
        text: '',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: []
      }
    return (
      this.composerDrafts[recoveryDraftKey(projectId, threadId)] ?? {
        text: '',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: []
      }
    )
  }

  snapshot(): RendererRecoverySnapshot {
    return {
      version: 1,
      activeView: this.activeView,
      lastContentView: this.lastContentView,
      lastViewBeforeSettings: this.lastViewBeforeSettings,
      selectedProjectId: this.selectedProjectId,
      selectedThread: this.selectedThread ? { ...this.selectedThread } : null,
      composerDrafts: { ...this.composerDrafts },
      queuedMessages: { ...this.queuedMessages },
      collapsedFolders: [...this.collapsedFolders],
      favoriteModels: [...this.favoriteModels],
      recentModels: [...this.recentModels],
      chatFavoriteModels: [...this.chatFavoriteModels],
      chatRecentModels: [...this.chatRecentModels],
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
    // Track the last content view so returning from Settings/Scope — even
    // across a restart made on a Settings page — lands back on the same view.
    if (view === 'projects' || view === 'chats' || view === 'threads') {
      this.lastContentView = view
    }
    // Remember the last non-settings view for the Settings back button.
    if (!isSettingsView(view)) {
      this.lastViewBeforeSettings = view
    }
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
      entry.promptReferences.length > 0 ||
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
    taskReferences?: PromptAssignmentTaskReference[],
    promptReferences?: QueuedResponseReference[]
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
      taskReferences: [],
      promptReferences: []
    }
    const nextAttachments = attachments ?? current.attachments
    const nextProjectReferences = projectReferences ?? current.projectReferences
    const nextTaskReferences = taskReferences ?? current.taskReferences
    const nextPromptReferences = promptReferences ?? current.promptReferences
    // No-op writes must not reassign state — callers may run inside effects.
    if (
      current.text === draft &&
      current.attachments === nextAttachments &&
      current.projectReferences === nextProjectReferences &&
      current.taskReferences === nextTaskReferences &&
      current.promptReferences === nextPromptReferences
    )
      return

    const next = { ...this.composerDrafts }
    if (
      draft.length === 0 &&
      nextAttachments.length === 0 &&
      nextProjectReferences.length === 0 &&
      nextTaskReferences.length === 0 &&
      nextPromptReferences.length === 0
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
        taskReferences: nextTaskReferences,
        promptReferences: nextPromptReferences
      }
    }
    this.composerDrafts = next
    // Mirror the draft-derived label into its 24h cookie so the sidebar/header
    // can show what the user is typing instead of the "New Thread" placeholder.
    setDraftLabelCookie(threadId, draft)
    this.persist()
  }

  clearDraft(projectId: string, threadId: string): void {
    this.setDraft(projectId, threadId, '', [], [], [], [])
  }

  /** The persisted response-selection annotations attached to a thread's composer draft. */
  draftPromptReferences(projectId: string, threadId: string): QueuedResponseReference[] {
    return this.entryFor(projectId, threadId).promptReferences
  }

  /** Persist a thread's response-selection annotations, preserving any existing
   *  composer text/attachments so annotations never clobber the draft. */
  setPromptReferences(
    projectId: string,
    threadId: string,
    references: QueuedResponseReference[]
  ): void {
    const entry = this.entryFor(projectId, threadId)
    this.setDraft(
      projectId,
      threadId,
      entry.text,
      entry.attachments,
      entry.projectReferences,
      entry.taskReferences,
      references
    )
  }

  /** The persisted queued message for a thread, if any. */
  queuedMessageFor(projectId: string, threadId: string): QueuedMessageEntry | null {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId)) return null
    return this.queuedMessages[recoveryDraftKey(projectId, threadId)] ?? null
  }

  /** Enumerate every thread that currently has a persisted queued message. */
  queuedMessageThreads(): Array<{ projectId: string; threadId: string }> {
    const threads: Array<{ projectId: string; threadId: string }> = []
    for (const key of Object.keys(this.queuedMessages)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(key)
      } catch {
        continue
      }
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        isRecoveryIdentifier(parsed[0]) &&
        isRecoveryIdentifier(parsed[1])
      ) {
        threads.push({ projectId: parsed[0], threadId: parsed[1] })
      }
    }
    return threads
  }

  /** Persist a message queued while the agent was busy. */
  setQueuedMessage(projectId: string, threadId: string, entry: QueuedMessageEntry): void {
    const hasContext =
      entry.text.length > 0 ||
      entry.attachments.length > 0 ||
      Boolean(entry.promptContext) ||
      entry.promptReferences.length > 0 ||
      entry.projectReferences.length > 0 ||
      entry.taskReferences.length > 0
    if (
      !isRecoveryIdentifier(projectId) ||
      !isRecoveryIdentifier(threadId) ||
      typeof entry.text !== 'string' ||
      entry.text.length > MAX_DRAFT_LENGTH ||
      !hasContext
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
      taskReferences: entry.taskReferences,
      startAfterThreadId: entry.startAfterThreadId,
      startAfterThreadTitle: entry.startAfterThreadTitle
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
    this.lastContentView = initial.lastContentView
    this.lastViewBeforeSettings = initial.lastViewBeforeSettings
    this.selectedProjectId = initial.selectedProjectId
    this.selectedThread = initial.selectedThread
    this.composerDrafts = initial.composerDrafts
    this.queuedMessages = initial.queuedMessages
    removeRendererRecoveryState(this.storage)
  }

  toggleFavorite(modelKey: string): void {
    const idx = this.favoriteModels.findIndex(
      (k) => k === modelKey || sameModelIdentity(k, modelKey)
    )
    if (idx === -1) {
      this.favoriteModels = [...this.favoriteModels, modelKey]
    } else {
      this.favoriteModels = this.favoriteModels.filter((k) => k !== this.favoriteModels[idx])
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

  toggleChatFavorite(modelKey: string): void {
    const idx = this.chatFavoriteModels.findIndex(
      (k) => k === modelKey || sameModelIdentity(k, modelKey)
    )
    if (idx === -1) {
      this.chatFavoriteModels = [...this.chatFavoriteModels, modelKey]
    } else {
      this.chatFavoriteModels = this.chatFavoriteModels.filter(
        (k) => k !== this.chatFavoriteModels[idx]
      )
    }
    this.persist()
  }

  isChatFavorite(modelKey: string): boolean {
    return this.chatFavoriteModels.includes(modelKey)
  }

  /**
   * Move a chat favorite to a new position relative to another chat favorite.
   * The array is stored oldest-first; the picker displays it reversed, so
   * callers should pass the position in storage order.
   */
  reorderChatFavorite(draggedKey: string, targetKey: string, position: 'before' | 'after'): void {
    if (draggedKey === targetKey) return
    const favorites = [...this.chatFavoriteModels]
    const draggedIndex = favorites.indexOf(draggedKey)
    if (draggedIndex === -1) return
    favorites.splice(draggedIndex, 1)
    const targetIndex = favorites.indexOf(targetKey)
    if (targetIndex === -1) return
    favorites.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, draggedKey)
    this.chatFavoriteModels = favorites
    this.persist()
  }

  addChatRecentModel(modelKey: string): void {
    this.chatRecentModels = [
      modelKey,
      ...this.chatRecentModels.filter((k) => k !== modelKey)
    ].slice(0, 10)
    this.persist()
  }

  setAuditModel(modelKey: string): void {
    this.auditModelKey = modelKey
    const { providerId, modelId } = parseModelKey(modelKey)
    if (providerId && modelId && !this.isFavorite(modelKey)) {
      this.addRecentModel(modelKey)
      return
    }
    this.persist()
  }

  private persist(): void {
    persistRendererRecoveryState(this.storage, this.snapshot())
  }
}

export const rendererRecovery = new RendererRecoveryStore()
