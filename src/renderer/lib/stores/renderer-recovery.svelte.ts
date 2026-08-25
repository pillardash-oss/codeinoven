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
  type SelectedThreadReference,
  type StartAfterThreadReference
} from './renderer-recovery'

export type {
  ComposerDraftEntry,
  MainView,
  QueuedMessageEntry,
  RecoveryStorage,
  RendererRecoverySnapshot,
  SelectedThreadReference,
  StartAfterThreadReference,
  SettingsSection
} from './renderer-recovery'
export {
  isSettingsSection,
  isSettingsView,
  settingsSectionForView,
  settingsViewForSection
} from './renderer-recovery'

/** How long to wait after the last mutation before writing recovery state to
 *  storage. Long enough that bursts of mutations (draft typing, model toggles)
 *  collapse into a single write, short enough that state is durable on a quick
 *  navigation/quit (the flush-on-hide path writes immediately regardless). */
const PERSIST_DEBOUNCE_MS = 400

/**
 * Restart-safe renderer navigation and composer state.
 *
 * Mutations update in-memory state immediately and persist to storage on a
 * trailing debounce (with a flush on window hide/shutdown), tolerating
 * blocked/quota-limited storage. Consumers should restore IDs against
 * main-process data before selecting them.
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

  /** Trailing debounce so rapid mutations (e.g. typing a draft) coalesce into
   *  one disk write instead of serializing the whole snapshot on every keystroke.
   *  In-memory state stays instant-reactive; only the localStorage write lags. */
  private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined

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

    // Flush any pending write when the page is hidden or torn down so a quit or
    // backgrounding never loses the latest recovery state.
    if (typeof window !== 'undefined') {
      const flush = (): void => this.flushPersist()
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush()
      })
    }
  }

  private entryFor(projectId: string, threadId: string): ComposerDraftEntry {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId))
      return {
        text: '',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: [],
        startAfterThreads: []
      }
    return (
      this.composerDrafts[recoveryDraftKey(projectId, threadId)] ?? {
        text: '',
        attachments: [],
        projectReferences: [],
        taskReferences: [],
        promptReferences: [],
        startAfterThreads: []
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
      entry.startAfterThreads.length > 0 ||
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

  startAfterThreadsFor(projectId: string, threadId: string): StartAfterThreadReference[] {
    return this.entryFor(projectId, threadId).startAfterThreads
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
      promptReferences: [],
      startAfterThreads: []
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
      nextPromptReferences.length === 0 &&
      current.startAfterThreads.length === 0
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
        promptReferences: nextPromptReferences,
        startAfterThreads: current.startAfterThreads
      }
    }
    this.composerDrafts = next
    // Mirror the draft-derived label into its 24h cookie so the sidebar/header
    // can show what the user is typing instead of the "New Thread" placeholder.
    setDraftLabelCookie(threadId, draft)
    this.persist()
  }

  clearDraft(projectId: string, threadId: string): void {
    this.clearStartAfterThreads(projectId, threadId)
    this.setDraft(projectId, threadId, '', [], [], [], [])
  }

  /** Persist the source threads the next message waits for before it starts. */
  setStartAfterThreads(
    projectId: string,
    threadId: string,
    references: StartAfterThreadReference[]
  ): void {
    if (!isRecoveryIdentifier(projectId) || !isRecoveryIdentifier(threadId)) return

    const unique = references.filter(
      (reference, index) =>
        isRecoveryIdentifier(reference.id) &&
        reference.title.length > 0 &&
        references.findIndex((existing) => existing.id === reference.id) === index
    )
    if (unique.length !== references.length) return

    const key = recoveryDraftKey(projectId, threadId)
    const current = this.entryFor(projectId, threadId)
    if (current.startAfterThreads.length === unique.length) {
      const same =
        current.startAfterThreads.length === unique.length &&
        current.startAfterThreads.every(
          (reference, index) =>
            reference.id === unique[index]?.id && reference.title === unique[index]?.title
        )
      if (same) return
    }
    const next = { ...this.composerDrafts }
    if (unique.length === 0) {
      if (!(key in next)) return
      if (
        current.text.length === 0 &&
        current.attachments.length === 0 &&
        current.projectReferences.length === 0 &&
        current.taskReferences.length === 0 &&
        current.promptReferences.length === 0
      ) {
        delete next[key]
      } else {
        next[key] = {
          ...current,
          startAfterThreads: []
        }
      }
    } else {
      next[key] = {
        ...current,
        startAfterThreads: unique
      }
    }
    this.composerDrafts = next
    this.persist()
  }

  clearStartAfterThreads(projectId: string, threadId: string): void {
    this.setStartAfterThreads(projectId, threadId, [])
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
      startAfterThreads: entry.startAfterThreads
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
    const idx = this.favoriteModels.indexOf(modelKey)
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
    const idx = this.chatFavoriteModels.indexOf(modelKey)
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
    const parsed = parseModelKey(modelKey)
    if (parsed && !this.isFavorite(modelKey)) {
      this.addRecentModel(modelKey)
      return
    }
    this.persist()
  }

  private persist(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      persistRendererRecoveryState(this.storage, this.snapshot())
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Write any pending state immediately (used on window hide/shutdown). */
  flushPersist(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    persistRendererRecoveryState(this.storage, this.snapshot())
  }
}

export const rendererRecovery = new RendererRecoveryStore()
