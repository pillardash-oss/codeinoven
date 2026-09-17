import { invoke } from '$lib/ipc.svelte'
import { messageId } from '$shared/id'
import { agentRuns } from './agent-runs.svelte'
import { conversationAttention } from './conversation-attention.svelte'
import { threadMessages } from './thread-messages.svelte'
import { temporaryChatUnread } from './temporary-chat-unread.svelte'
import { gitState } from './git.svelte'
import { subagentTaskLabel } from '$lib/subagent-presentation'
import {
  contextKey,
  PROJECT_TAB_KINDS,
  sameSubagentActivity,
  TEMPORARY_CHAT_INACTIVITY_MS,
  type ContextSidebarTab,
  type FilesContextTab,
  type MemorySection,
  type ProjectSidebarContext,
  type SubagentContextTab,
  type TemporaryChatContextTab,
  type TemporaryChatMode,
  type TerminalPlacement,
  type ThreadSidebarContext
} from './context-sidebar-types'
import type { AgentSubagentActivity, ThreadSettings } from '$shared/types'

/**
 * Host access the tab-context controller needs from the sidebar store. The
 * controller owns the per-thread and per-project tab contexts; the store owns
 * the active identities, browser visibility, notifications, and terminal
 * placement.
 */
export interface SidebarTabContextsHost {
  activeProjectId(): string | null
  activeThreadId(): string | null
  terminalPlacement(): TerminalPlacement
  hideBrowserForFocus(): void
  clearNotifications(): void
}

/**
 * Per-thread and per-project sidebar tab contexts.
 *
 * Owns the tab lists, the per-kind active ids, terminal sequence, the thread
 * note tab lifecycle, temporary side-chat tabs (including their expiry
 * timers), and the sub-agent tab registry. The store remains the composition
 * root and orchestrates browser tabs, notifications, and active identities.
 */
export class SidebarTabContexts {
  private contexts: Record<string, ThreadSidebarContext> = $state({})
  private projectContexts: Record<string, ProjectSidebarContext> = $state({})
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private temporaryChatExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly host: SidebarTabContextsHost) {}

  get activeContext(): ThreadSidebarContext | null {
    const activeProjectId = this.host.activeProjectId()
    const activeThreadId = this.host.activeThreadId()
    if (!activeProjectId || activeThreadId === null) return null
    return this.contexts[contextKey(activeProjectId, activeThreadId)] ?? null
  }

  get activeProjectContext(): ProjectSidebarContext | null {
    const activeProjectId = this.host.activeProjectId()
    return activeProjectId ? (this.projectContexts[activeProjectId] ?? null) : null
  }

  contextFor(projectId: string, threadId: string): ThreadSidebarContext | null {
    return this.contexts[contextKey(projectId, threadId)] ?? null
  }

  projectContextFor(projectId: string): ProjectSidebarContext | null {
    return this.projectContexts[projectId] ?? null
  }

  activeTabIdForKind(
    kind: ContextSidebarTab['kind']
  ): Partial<Record<ContextSidebarTab['kind'], string>> | null {
    if (PROJECT_TAB_KINDS.has(kind)) return this.activeProjectContext?.activeTabIds ?? null
    return this.activeContext?.activeTabIds ?? null
  }

  /** Resolve a live temporary-chat tab without passing its mutable proxy
   *  through a component prop. The sidebar store remains the sole owner. */
  temporaryChatTab(tabId: string): TemporaryChatContextTab | null {
    const tab = this.activeContext?.tabs.find((candidate) => candidate.id === tabId)
    return tab?.kind === 'temporary-chat' ? tab : null
  }

  ensureContext(projectId: string, threadId: string): ThreadSidebarContext {
    const key = contextKey(projectId, threadId)
    const existing = this.contexts[key]
    if (existing) return existing
    const context: ThreadSidebarContext = {
      projectId,
      threadId,
      tabs: [],
      activeTabIds: {}
    }
    this.contexts[key] = context
    return this.contexts[key]
  }

  ensureProjectContext(projectId: string): ProjectSidebarContext {
    const existing = this.projectContexts[projectId]
    if (existing) return existing
    const context: ProjectSidebarContext = {
      projectId,
      tabs: [],
      activeKind: null,
      activeTabIds: {},
      terminalActiveTabId: null,
      visible: false,
      terminalDockOpen: false,
      terminalSequence: 0
    }
    this.projectContexts[projectId] = context
    return this.projectContexts[projectId]
  }

  rebindProjectTabs(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    for (const tab of context.tabs) {
      if ('threadId' in tab) tab.threadId = threadId
    }
  }

  ensureActiveThreadPanel(projectId: string, threadId: string, threadTitle?: string): void {
    const project = this.ensureProjectContext(projectId)
    const kind = project.activeKind
    if (!project.visible || !kind || PROJECT_TAB_KINDS.has(kind)) return
    const thread = this.ensureContext(projectId, threadId)
    const existing = thread.tabs.filter((tab) => tab.kind === kind).at(-1)
    if (existing) {
      this.focusInContext(thread, thread.activeTabIds[kind] ?? existing.id)
      return
    }
    // Panels bound to live thread-scoped sessions/content (temporary chat,
    // sub-agents, coordinator) cannot be produced with meaningful data for a
    // thread that never opened them, so there is no tab to focus here. Instead
    // of leaving an empty-looking panel open, hide the sidebar in the new
    // thread; returning to a thread that does own one restores it via the
    // `existing` branch above.
    if (kind === 'coordinator' || kind === 'temporary-chat' || kind === 'subagent') {
      project.visible = false
      return
    }
    if (kind === 'diff') this.openDiff(projectId, threadId)
    else if (kind === 'sources') this.openSources(projectId, threadId)
    else if (kind === 'debugger') this.openDebugger(projectId, threadId)
    else if (kind === 'thread-note' && threadTitle)
      this.openThreadNote(projectId, threadId, threadTitle)
  }

  /** Focus an existing tab in its owning project or thread context. */
  focusTab(id: string): void {
    const project = this.activeProjectContext
    if (project?.tabs.some((tab) => tab.id === id)) {
      this.focusInProjectContext(project, id)
      return
    }
    const thread = this.activeContext
    if (thread) this.focusInContext(thread, id)
  }

  /** Close one tab in its owning project or thread context. */
  closeContextTab(id: string): void {
    const project = this.activeProjectContext
    const thread = this.activeContext
    const context = project?.tabs.some((tab) => tab.id === id) ? project : thread
    if (!context) return
    const index = context.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tab = context.tabs[index]
    if (tab.kind === 'temporary-chat') {
      this.clearTemporaryChatExpiry(tab.temporaryChatId)
      temporaryChatUnread.clear(tab.projectId, tab.threadId, tab.temporaryChatId)
      // A closed side chat can no longer answer its blocked request.
      conversationAttention.clear(tab.projectId, tab.temporaryChatId)
    }
    const closedKind = tab.kind
    context.tabs = context.tabs.filter((candidate) => candidate.id !== id)
    const replacement = context.tabs.filter((candidate) => candidate.kind === closedKind).at(-1)
    context.activeTabIds[closedKind] = replacement?.id
    if ('terminalActiveTabId' in context && closedKind === 'terminal') {
      context.terminalActiveTabId = replacement?.id ?? null
    }
    if (project?.activeKind === closedKind && !replacement) {
      project.visible = false
    }
  }

  reorderContextTab(id: string, targetId: string, position: 'before' | 'after'): void {
    const project = this.activeProjectContext
    const thread = this.activeContext
    const context = project?.tabs.some((tab) => tab.id === id && tab.kind !== 'notifications')
      ? project
      : thread
    if (!context) return
    const fromIndex = context.tabs.findIndex((tab) => tab.id === id)
    const toIndex = context.tabs.findIndex((tab) => tab.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
    const ordered = [...context.tabs]
    const [moved] = ordered.splice(fromIndex, 1)
    const adjustedTarget = ordered.findIndex((tab) => tab.id === targetId)
    ordered.splice(position === 'before' ? adjustedTarget : adjustedTarget + 1, 0, moved)
    context.tabs = ordered
  }

  /** Opened from the dock rail's Files icon. Reveals whatever file panel was
   *  last in focus instead of always jumping to the empty "Open file"
   *  browser tab, hiding the sidebar must not lose the file the user was
   *  looking at. The browser tab only ever appears when no file has been
   *  opened yet. */
  openFiles(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    const filesTabs = context.tabs.filter((tab) => tab.kind === 'files')
    if (filesTabs.length > 0) {
      const activeTab = context.tabs.find((tab) => tab.id === context.activeTabIds.files)
      const target = activeTab?.kind === 'files' ? activeTab.id : filesTabs.at(-1)!.id
      this.focusInProjectContext(context, target)
      return
    }
    const id = `files:${projectId}:browser`
    this.openProject(context, {
      id,
      kind: 'files',
      title: 'Open file',
      projectId,
      threadId,
      fileTabId: null,
      path: null,
      preview: false
    })
  }

  openProjectFile(
    projectId: string,
    threadId: string,
    fileTabId: string,
    path: string,
    preview = false
  ): void {
    const context = this.ensureProjectContext(projectId)
    const id = `files:${projectId}:${fileTabId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'files') existing.preview = preview
      this.focusInProjectContext(context, id)
      return
    }
    const browserIndex = context.tabs.findIndex(
      (tab) => tab.kind === 'files' && tab.fileTabId === null
    )
    if (browserIndex >= 0 && context.activeTabIds.files === context.tabs[browserIndex]?.id) {
      context.tabs[browserIndex] = {
        id,
        kind: 'files',
        title: path.split('/').at(-1) ?? path,
        projectId,
        threadId,
        fileTabId,
        path,
        preview
      }
      context.activeTabIds.files = id
      context.activeKind = 'files'
      context.visible = true
      this.host.clearNotifications()
      return
    }
    this.openProject(context, {
      id,
      kind: 'files',
      title: path.split('/').at(-1) ?? path,
      projectId,
      threadId,
      fileTabId,
      path,
      preview
    })
  }

  updateProjectFileMapping(
    projectId: string,
    previousFileTabId: string,
    nextFileTabId: string,
    nextPath: string
  ): void {
    for (const context of Object.values(this.projectContexts)) {
      const tab = context.tabs.find(
        (t) => t.kind === 'files' && t.projectId === projectId && t.fileTabId === previousFileTabId
      )
      if (!tab || tab.kind !== 'files') continue
      tab.fileTabId = nextFileTabId
      tab.title = nextPath.split('/').at(-1) ?? nextPath
      tab.path = nextPath
    }
  }

  /** Rewrite a sidebar tab's file mapping. Returns whether any tab was remapped
   *  so callers can fall back to opening a fresh sidebar tab when the workspace
   *  tab has no matching sidebar tab anymore (e.g. after the tab was closed). */
  remapProjectFile(
    projectId: string,
    previousFileTabId: string,
    nextFileTabId: string,
    nextPath: string,
    preview: boolean,
    /** False for bulk remaps (e.g. a directory rename touching many open
     *  tabs at once), those shouldn't fight over which tab ends up
     *  focused. True for a remap that represents the user looking at this
     *  file right now (a preview replacing another preview). */
    focus: boolean
  ): boolean {
    for (const context of Object.values(this.projectContexts)) {
      const index = context.tabs.findIndex(
        (tab) =>
          tab.kind === 'files' && tab.projectId === projectId && tab.fileTabId === previousFileTabId
      )
      if (index < 0) continue
      const previous = context.tabs[index]
      if (previous.kind !== 'files') continue
      const nextId = `files:${projectId}:${nextFileTabId}`
      context.tabs[index] = {
        ...previous,
        id: nextId,
        title: nextPath.split('/').at(-1) ?? nextPath,
        fileTabId: nextFileTabId,
        path: nextPath,
        preview
      }
      if (focus) {
        context.activeTabIds.files = nextId
        context.activeKind = 'files'
        context.visible = true
        this.host.clearNotifications()
      } else if (context.activeTabIds.files === previous.id) {
        context.activeTabIds.files = nextId
      }
      return true
    }
    return false
  }

  /** Stop rendering a file tab as a preview (italicised), used when the user
   *  starts editing it, which pins the tab. */
  pinProjectFile(projectId: string, fileTabId: string): void {
    for (const context of Object.values(this.projectContexts)) {
      for (const tab of context.tabs) {
        if (
          tab.kind === 'files' &&
          tab.projectId === projectId &&
          tab.fileTabId === fileTabId &&
          tab.preview
        ) {
          tab.preview = false
        }
      }
    }
  }

  closeProjectFile(projectId: string, fileTabIds: ReadonlySet<string>): void {
    for (const context of Object.values(this.projectContexts)) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const closingIds = new Set(
        context.tabs
          .filter(
            (tab) =>
              tab.kind === 'files' &&
              tab.projectId === projectId &&
              tab.fileTabId !== null &&
              fileTabIds.has(tab.fileTabId)
          )
          .map((tab) => tab.id)
      )
      if (closingIds.size === 0) continue
      context.tabs = context.tabs.filter((tab) => !closingIds.has(tab.id))
      if (!context.tabs.some((tab) => tab.kind === 'files')) {
        const activeProjectId = this.host.activeProjectId()
        const browser: FilesContextTab = {
          id: `files:${context.projectId}:browser`,
          kind: 'files',
          title: 'Open file',
          projectId: context.projectId,
          threadId: activeProjectId === context.projectId ? (this.host.activeThreadId() ?? '') : '',
          fileTabId: null,
          path: null,
          preview: false
        }
        context.tabs = [...context.tabs, browser]
      }
      if (context.activeTabIds.files && closingIds.has(context.activeTabIds.files)) {
        context.activeTabIds.files = context.tabs.filter((tab) => tab.kind === 'files').at(-1)?.id
      }
    }
  }

  /** `checkpointId`/`revealPath` are `undefined` (omitted) for a plain
   *  reopen, the dock rail's toggle calls this with no reveal target and
   *  must not clobber whatever checkpoint the user already had selected.
   *  `null` is only meaningful when explicitly passed, e.g. to clear a
   *  reveal. Without this distinction every dock-icon toggle reset the tab
   *  back to its defaults, which is what made the panel look like it never
   *  remembered anything and re-fetched from scratch every time. */
  openDiff(
    projectId: string,
    threadId: string,
    checkpointId?: string | null,
    revealPath?: string | null
  ): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `diff:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing?.kind === 'diff') {
      if (checkpointId !== undefined) existing.checkpointId = checkpointId
      if (revealPath !== undefined) {
        existing.revealPath = revealPath
        existing.revealNonce += 1
      }
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'diff',
      title: 'Changes',
      projectId,
      threadId,
      checkpointId: checkpointId ?? null,
      revealPath: revealPath ?? null,
      revealNonce: 1
    })
  }

  openSources(projectId: string, threadId: string): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `sources:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'sources',
      title: 'Sources',
      projectId,
      threadId
    })
  }

  openGit(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    const id = `git:${projectId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'git') existing.threadId = threadId
      this.focusInProjectContext(context, id)
    } else {
      this.openProject(context, {
        id,
        kind: 'git',
        title: 'Git',
        projectId,
        threadId
      })
    }
    // Opening the git panel is an event-driven refresh trigger: the store
    // re-reads local status and the connection-gated PR indicators so the
    // panel never shows data older than the moment it was opened.
    gitState.notifyGitPanelOpened(projectId)
  }

  openActions(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    const id = `actions:${projectId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'actions') existing.threadId = threadId
      this.focusInProjectContext(context, id)
      return
    }
    this.openProject(context, { id, kind: 'actions', title: 'Actions', projectId, threadId })
  }

  /** Opens the thread's note as a sidebar panel, creating one the first time
   *  it's visited so the panel is ready to write into even before a note
   *  exists. The body loads asynchronously onto the tab itself (not local
   *  component state) so an in-progress draft survives the panel being
   *  hidden and shown again. */
  openThreadNote(
    projectId: string,
    threadId: string,
    threadTitle: string,
    options: { edit?: boolean; focusEditor?: boolean } = {}
  ): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `note:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'thread-note') {
        if (options.edit) existing.mode = 'edit'
        if (options.focusEditor) existing.focusRequest += 1
      }
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'thread-note',
      title: 'Notes',
      projectId,
      threadId,
      threadTitle,
      savedBody: null,
      draftBody: '',
      mode: 'edit',
      focusRequest: options.focusEditor ? 1 : 0,
      loading: true,
      saving: false,
      error: null
    })
    void this.loadThreadNote(context, id, projectId, threadId)
  }

  private async loadThreadNote(
    context: ThreadSidebarContext,
    tabId: string,
    projectId: string,
    threadId: string
  ): Promise<void> {
    try {
      const note = await invoke('note:get', projectId, threadId)
      const tab = context.tabs.find((candidate) => candidate.id === tabId)
      if (!tab || tab.kind !== 'thread-note') return
      tab.savedBody = note?.body ?? null
      tab.draftBody = note?.body ?? ''
      // Explicit write entry points keep saved notes editable; passive sidebar
      // opens preserve the read-first behavior.
      tab.mode = note && tab.focusRequest === 0 ? 'read' : 'edit'
      tab.loading = false
    } catch (err) {
      const tab = context.tabs.find((candidate) => candidate.id === tabId)
      if (!tab || tab.kind !== 'thread-note') return
      tab.error = err instanceof Error ? err.message : 'Could not load the note'
      tab.loading = false
    }
  }

  openCloudDeployments(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    const id = `cloud-deployment:${projectId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'cloud-deployment') existing.threadId = threadId
      this.focusInProjectContext(context, id)
      return
    }
    this.openProject(context, {
      id,
      kind: 'cloud-deployment',
      title: 'Cloud Deployments',
      projectId,
      threadId
    })
  }

  /**
   * Dock the coordinator for a thread. The title tracks the coordination kind
   * (Assignment vs Achievement vs Audit), so an existing tab is re-titled rather than
   * duplicated when a thread switches modes.
   */
  openCoordinator(projectId: string, threadId: string, title: string): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `coordinator:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      existing.title = title
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'coordinator',
      title,
      projectId,
      threadId
    })
  }

  /** Whether the coordinator tab is already docked for a thread. */
  hasCoordinator(projectId: string, threadId: string): boolean {
    const context = this.contextFor(projectId, threadId)
    return context?.tabs.some((tab) => tab.kind === 'coordinator') ?? false
  }

  /** Close the coordinator tab for a thread whose coordination ended, e.g.
   *  the Independent Audit switch was turned off before its first run. The
   *  whole sidebar shell closes with the tab, not just the panel. */
  closeCoordinator(projectId: string, threadId: string): void {
    const context = this.contextFor(projectId, threadId)
    const tab = context?.tabs.find((candidate) => candidate.kind === 'coordinator')
    if (!tab) return
    this.closeContextTab(tab.id)
  }

  openMemory(projectId: string, threadId: string, section?: MemorySection): void {
    const context = this.ensureProjectContext(projectId)
    const id = `memory:${projectId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'memory') {
        existing.threadId = threadId
        if (section) existing.memorySection = section
      }
      this.focusInProjectContext(context, id)
      return
    }
    this.openProject(context, {
      id,
      kind: 'memory',
      title: 'Memory',
      projectId,
      threadId,
      memorySection: section ?? 'active'
    })
  }

  openTemporaryChat(
    projectId: string,
    threadId: string,
    mode: TemporaryChatMode,
    selection: string,
    initialContext: string,
    settings: ThreadSettings,
    selectionAttached = true,
    autoPrompt?: string
  ): TemporaryChatContextTab {
    const context = this.ensureContext(projectId, threadId)

    // Combine repeated "Quick chat" selections into the same tab as long as it
    // has not yet sent its first message, so a user can build up one quick chat
    // with multiple selections and ask across all of them. Once the tab has a
    // message, further selections open a fresh tab.
    if (mode === 'quick' && selectionAttached) {
      const existing = context.tabs.find(
        (tab): tab is TemporaryChatContextTab =>
          tab.kind === 'temporary-chat' &&
          tab.mode === 'quick' &&
          !tab.expired &&
          !agentRuns.isBusy(projectId, tab.temporaryChatId) &&
          threadMessages.messages(projectId, tab.temporaryChatId).length === 0
      )
      if (existing) {
        existing.selections = [...existing.selections, selection]
        this.focusInContext(context, existing.id)
        this.touchTemporaryChat(existing)
        return existing
      }
    }

    const temporaryChatId = crypto.randomUUID()
    // The explain auto-prompt commits as a user-sent message immediately, so
    // the moment the tab opens the conversation already shows the selection
    // chip with the action label, never a blank panel while the harness
    // session is still being assembled. The message lives in the shared
    // thread-messages pipeline like every other conversation.
    const seededAutoPrompt = mode === 'elaborate' && selectionAttached ? (autoPrompt ?? '') : ''
    const autoPromptMessageId = seededAutoPrompt ? messageId() : null
    if (autoPromptMessageId !== null) {
      threadMessages.seedMessage(projectId, temporaryChatId, {
        id: autoPromptMessageId,
        role: 'user',
        parts: [
          {
            type: 'text',
            id: `${autoPromptMessageId}:text`,
            messageID: autoPromptMessageId,
            text: mode === 'elaborate' ? 'Explain' : seededAutoPrompt
          }
        ],
        references: [
          {
            id: `${temporaryChatId}.selection.0`,
            label: 'Selection 1',
            text: selection
          }
        ],
        createdAt: Date.now(),
        completedAt: Date.now()
      })
    }
    const tab: TemporaryChatContextTab = {
      id: `temporary-chat:${temporaryChatId}`,
      kind: 'temporary-chat',
      title: mode === 'elaborate' ? 'Explain' : 'Quick chat',
      projectId,
      threadId,
      temporaryChatId,
      sessionId: null,
      mode,
      selections: selectionAttached ? [selection] : [],
      initialContext,
      settings: { ...settings, permissionLevel: 'auto_review' },
      selectionAttached,
      autoPromptSent: false,
      autoPromptMessageId,
      autoPrompt,
      sessionStarted: false,
      expired: false,
      expiresAt: Date.now() + TEMPORARY_CHAT_INACTIVITY_MS
    }
    this.open(context, tab)
    this.scheduleTemporaryChatExpiry(tab)
    return tab
  }

  /** Reveal the sidebar and focus one of the thread's temporary-chat tabs,
   *  the deep-link target for a side-chat notification. Returns false when
   *  the tab no longer exists (closed or never opened), so the caller can
   *  drop the unread badge instead of leaving it stuck. */
  focusTemporaryChat(projectId: string, threadId: string, temporaryChatId: string): boolean {
    const context = this.contextFor(projectId, threadId)
    const id = `temporary-chat:${temporaryChatId}`
    if (!context?.tabs.some((tab) => tab.id === id)) return false
    this.focusInContext(context, id)
    return true
  }

  touchTemporaryChat(
    tab: TemporaryChatContextTab,
    expiresAt = Date.now() + TEMPORARY_CHAT_INACTIVITY_MS
  ): void {
    if (tab.expired) return
    tab.expiresAt = expiresAt
    this.scheduleTemporaryChatExpiry(tab)
  }

  expireTemporaryChat(tab: TemporaryChatContextTab, closeRemote = true): void {
    if (tab.expired) return
    const temporaryChatId = tab.temporaryChatId
    tab.expired = true
    temporaryChatUnread.clear(tab.projectId, tab.threadId, temporaryChatId)
    tab.initialContext = ''
    tab.selectionAttached = false
    tab.autoPromptMessageId = null
    // Conversation state lives in the shared pipeline now, drop its cache so
    // an expired side chat leaves nothing behind.
    threadMessages.clear(tab.projectId, temporaryChatId)
    agentRuns.clear(tab.projectId, temporaryChatId)
    conversationAttention.clear(tab.projectId, temporaryChatId)
    this.clearTemporaryChatExpiry(temporaryChatId)
    if (closeRemote) void invoke('agent:closeTemporaryChat', temporaryChatId)
  }

  restartTemporaryChat(tab: TemporaryChatContextTab): void {
    // A fresh conversation identity: drop the old cache, then regenerate the id.
    threadMessages.clear(tab.projectId, tab.temporaryChatId)
    agentRuns.clear(tab.projectId, tab.temporaryChatId)
    conversationAttention.clear(tab.projectId, tab.temporaryChatId)
    temporaryChatUnread.clear(tab.projectId, tab.threadId, tab.temporaryChatId)
    this.clearTemporaryChatExpiry(tab.temporaryChatId)
    tab.temporaryChatId = crypto.randomUUID()
    tab.sessionId = null
    // Re-attach the selections on restart only when there are any, a quick chat
    // opened from the last agent turn has no selection attached.
    tab.selectionAttached = tab.selections.length > 0
    tab.autoPromptSent = false
    tab.autoPromptMessageId = null
    tab.sessionStarted = false
    tab.expired = false
    tab.expiresAt = Date.now() + TEMPORARY_CHAT_INACTIVITY_MS
    this.scheduleTemporaryChatExpiry(tab)
  }

  openPrimaryTerminal(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    const existing = context.tabs.find(
      (tab) => tab.kind === 'terminal' && tab.projectId === projectId
    )
    if (existing?.kind === 'terminal') {
      existing.threadId = threadId
      this.focusInProjectContext(context, existing.id)
      return
    }
    this.openNewTerminal(projectId, threadId)
  }

  openNewTerminal(projectId: string, threadId: string): string {
    const context = this.ensureProjectContext(projectId)
    context.terminalSequence += 1
    const sequence = context.terminalSequence
    const id = `terminal:${projectId}:${sequence}`
    this.openProject(context, {
      id,
      kind: 'terminal',
      title: sequence === 1 ? 'Terminal' : `Terminal ${sequence}`,
      terminalId: `workbench-${projectId}-${sequence}`,
      projectId,
      threadId
    })
    return id
  }

  openDebugger(projectId: string, threadId: string): void {
    if (!import.meta.env.DEV) return
    const context = this.ensureContext(projectId, threadId)
    const id = `debugger:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'debugger',
      title: 'Debugger',
      projectId,
      threadId
    })
  }

  openSubagent(
    projectId: string,
    threadId: string,
    partId: string,
    activity: AgentSubagentActivity
  ): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `subagent:${projectId}:${threadId}:${activity.childSessionId ?? partId}`
    const existingIndex = context.tabs.findIndex(
      (tab) =>
        tab.kind === 'subagent' &&
        tab.projectId === projectId &&
        tab.threadId === threadId &&
        (tab.sourcePartId === partId ||
          (activity.childSessionId && tab.activity.childSessionId === activity.childSessionId))
    )
    const next: SubagentContextTab = {
      id,
      kind: 'subagent',
      title: subagentTaskLabel(activity),
      projectId,
      threadId,
      sourcePartId: partId,
      activity
    }

    if (existingIndex >= 0) {
      const previousId = context.tabs[existingIndex].id
      context.tabs[existingIndex] = next
      context.tabs = [...context.tabs]
      if (context.activeTabIds.subagent === previousId) context.activeTabIds.subagent = id
      this.focusInContext(context, id)
      return
    }
    this.open(context, next)
  }

  updateSubagent(
    projectId: string,
    threadId: string,
    partId: string,
    activity: AgentSubagentActivity
  ): void {
    const context = this.contextFor(projectId, threadId)
    if (!context) return
    const index = context.tabs.findIndex(
      (tab) =>
        tab.kind === 'subagent' &&
        tab.projectId === projectId &&
        tab.threadId === threadId &&
        (tab.sourcePartId === partId ||
          (activity.childSessionId && tab.activity.childSessionId === activity.childSessionId))
    )
    if (index < 0) return
    const current = context.tabs[index]
    if (current.kind !== 'subagent') return
    const nextId = `subagent:${projectId}:${threadId}:${activity.childSessionId ?? partId}`
    const nextTitle = subagentTaskLabel(activity)
    if (
      current.id === nextId &&
      current.title === nextTitle &&
      sameSubagentActivity(current.activity, activity)
    ) {
      return
    }
    context.tabs[index] = {
      ...current,
      id: nextId,
      title: nextTitle,
      activity
    }
    if (context.activeTabIds.subagent === current.id) {
      context.activeTabIds.subagent = context.tabs[index].id
    }
    context.tabs = [...context.tabs]
  }

  private focusInContext(context: ThreadSidebarContext, id: string): void {
    const tab = context.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    this.host.hideBrowserForFocus()
    context.activeTabIds[tab.kind] = id
    const project = this.ensureProjectContext(context.projectId)
    project.activeKind = tab.kind
    project.visible = true
    this.host.clearNotifications()
    // Focusing a side chat is the act of reading its response, drop the
    // parent thread's unread-side-chat badge the moment the panel surfaces.
    if (tab.kind === 'temporary-chat') {
      temporaryChatUnread.clear(context.projectId, context.threadId, tab.temporaryChatId)
    }
  }

  private open(context: ThreadSidebarContext, tab: ContextSidebarTab): void {
    const index = context.tabs.findIndex((existing) => existing.id === tab.id)
    if (index >= 0) {
      context.tabs[index] = tab
      context.tabs = [...context.tabs]
    } else {
      context.tabs = [...context.tabs, tab]
    }
    this.focusInContext(context, tab.id)
  }

  private focusInProjectContext(context: ProjectSidebarContext, id: string): void {
    const tab = context.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    this.host.hideBrowserForFocus()
    context.activeTabIds[tab.kind] = id
    this.host.clearNotifications()
    if (tab.kind === 'terminal' && this.host.terminalPlacement() === 'bottom') {
      context.terminalActiveTabId = id
      context.terminalDockOpen = true
    } else {
      context.activeKind = tab.kind
      context.visible = true
    }
  }

  private openProject(context: ProjectSidebarContext, tab: ContextSidebarTab): void {
    const index = context.tabs.findIndex((existing) => existing.id === tab.id)
    if (index >= 0) {
      context.tabs[index] = tab
      context.tabs = [...context.tabs]
    } else {
      context.tabs = [...context.tabs, tab]
    }
    this.focusInProjectContext(context, tab.id)
  }

  private scheduleTemporaryChatExpiry(tab: TemporaryChatContextTab): void {
    this.clearTemporaryChatExpiry(tab.temporaryChatId)
    if (tab.expired) return
    const temporaryChatId = tab.temporaryChatId
    const timer = setTimeout(
      () => {
        if (tab.temporaryChatId === temporaryChatId) {
          this.expireTemporaryChat(tab)
        }
      },
      Math.max(0, tab.expiresAt - Date.now())
    )
    this.temporaryChatExpiryTimers.set(temporaryChatId, timer)
  }

  private clearTemporaryChatExpiry(temporaryChatId: string): void {
    const timer = this.temporaryChatExpiryTimers.get(temporaryChatId)
    if (timer) clearTimeout(timer)
    this.temporaryChatExpiryTimers.delete(temporaryChatId)
  }
}
