import { invoke } from '$lib/ipc.svelte'
import { gitState } from './git.svelte'
import type { AgentMessage, AgentSubagentActivity, ThreadSettings } from '$shared/types'

const TEMPORARY_CHAT_INACTIVITY_MS = 3 * 60 * 60 * 1000
const AUDIT_SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000
const CONTEXT_SIDEBAR_MIN_WIDTH = 340
const CONTEXT_SIDEBAR_MAX_WIDTH = 1600
const TERMINAL_DOCK_MIN_HEIGHT = 180
const TERMINAL_DOCK_MAX_HEIGHT = 560

export type TerminalPlacement = 'right' | 'bottom'

export interface TerminalContextTab {
  id: string
  kind: 'terminal'
  title: string
  terminalId: string
  projectId: string
  threadId: string
}

export interface FilesContextTab {
  id: string
  kind: 'files'
  title: string
  projectId: string
  threadId: string
  fileTabId: string | null
  path: string | null
  preview: boolean
}

export interface DiffContextTab {
  id: string
  kind: 'diff'
  title: string
  projectId: string
  threadId: string
  checkpointId: string | null
  /** When set, the Changes panel scrolls to this file's diff. */
  revealPath: string | null
  /** Bumped on every reveal request so re-clicking the same file re-triggers. */
  revealNonce: number
}

export interface SubagentContextTab {
  id: string
  kind: 'subagent'
  title: string
  projectId: string
  threadId: string
  sourcePartId: string
  activity: AgentSubagentActivity
}

export interface DebuggerContextTab {
  id: string
  kind: 'debugger'
  title: string
  projectId: string
  threadId: string
}

export interface SourcesContextTab {
  id: string
  kind: 'sources'
  title: string
  projectId: string
  threadId: string
}

export interface GitContextTab {
  id: string
  kind: 'git'
  title: string
  projectId: string
  threadId: string
}

export interface CloudDeploymentContextTab {
  id: string
  kind: 'cloud-deployment'
  title: string
  projectId: string
  threadId: string
}

export interface NotificationContextTab {
  id: string
  kind: 'notifications'
  title: string
}

export type MemorySection = 'active' | 'proposed'

export interface MemoryContextTab {
  id: string
  kind: 'memory'
  title: string
  projectId: string
  threadId: string
  memorySection: MemorySection
}

export type TemporaryChatMode = 'audit' | 'elaborate' | 'quick'

export interface TemporaryChatContextTab {
  id: string
  kind: 'temporary-chat'
  title: string
  projectId: string
  threadId: string
  temporaryChatId: string
  sessionId: string | null
  mode: TemporaryChatMode
  selections: string[]
  initialContext: string
  settings: ThreadSettings
  messages: AgentMessage[]
  busy: boolean
  error: string
  draft: string
  selectionAttached: boolean
  selectionMessageId: string | null
  autoPromptSent: boolean
  /** Override for the auto-sent explain prompt, when the tab was opened to
   *  explain a specific selection (e.g. an agent question) rather than the
   *  generic "explain this selection" elaboration. */
  autoPrompt?: string
  sessionStarted: boolean
  expired: boolean
  expiresAt: number
}

export type ContextSidebarTab =
  | FilesContextTab
  | DiffContextTab
  | TerminalContextTab
  | SubagentContextTab
  | DebuggerContextTab
  | SourcesContextTab
  | GitContextTab
  | CloudDeploymentContextTab
  | TemporaryChatContextTab
  | NotificationContextTab
  | MemoryContextTab

interface ThreadSidebarContext {
  projectId: string
  threadId: string
  tabs: ContextSidebarTab[]
  activeTabId: string | null
  /** Last active non-terminal tab — kept so the sidebar keeps a focused tab
   * while a terminal (docked at the bottom) holds the global active tab. */
  sidebarActiveTabId: string | null
  /** Last active terminal tab — kept so the bottom dock keeps a focused tab
   * while a sidebar tab holds the global active tab. */
  terminalActiveTabId: string | null
  visible: boolean
  /** Whether the bottom terminal dock is open. Only meaningful while
   * `terminalPlacement === 'bottom'`; lets the dock hide independently of the
   * sidebar (e.g. from the header terminal toggle). */
  terminalDockOpen: boolean
  terminalSequence: number
}

const EMPTY_TABS: ContextSidebarTab[] = []

function contextKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

function sameSubagentActivity(
  current: AgentSubagentActivity,
  next: AgentSubagentActivity
): boolean {
  return (
    current.status === next.status &&
    current.agent === next.agent &&
    current.description === next.description &&
    current.prompt === next.prompt &&
    current.childSessionId === next.childSessionId &&
    current.providerTaskId === next.providerTaskId &&
    current.providerId === next.providerId &&
    current.modelId === next.modelId &&
    current.background === next.background &&
    current.output === next.output &&
    current.error === next.error &&
    current.time?.start === next.time?.start &&
    current.time?.end === next.time?.end
  )
}

class ContextSidebarState {
  private contexts: Record<string, ThreadSidebarContext> = $state({})
  private activeKey: string | null = $state(null)
  private temporaryChatExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  width = $state(480)
  terminalHeight = $state(320)
  terminalPlacement = $state<TerminalPlacement>('right')

  get tabs(): ContextSidebarTab[] {
    return this.activeContext?.tabs ?? EMPTY_TABS
  }

  get activeTabId(): string | null {
    return this.activeContext?.activeTabId ?? null
  }

  get visible(): boolean {
    return this.activeContext?.visible ?? false
  }

  get activeTab(): ContextSidebarTab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null
  }

  /**
   * Tabs shown in the right sidebar. When the terminal is docked at the
   * bottom, terminal tabs live in the dock and are excluded here; otherwise
   * every tab (including terminals) renders in the sidebar.
   */
  get sidebarTabs(): ContextSidebarTab[] {
    const tabs = this.activeContext?.tabs ?? EMPTY_TABS
    return this.terminalPlacement === 'bottom'
      ? tabs.filter((tab) => tab.kind !== 'terminal')
      : tabs
  }

  /** Tabs shown in the bottom terminal dock. Empty while docked to the right. */
  get terminalTabs(): TerminalContextTab[] {
    if (this.terminalPlacement !== 'bottom') return EMPTY_TABS as TerminalContextTab[]
    return (this.activeContext?.tabs ?? EMPTY_TABS).filter(
      (tab): tab is TerminalContextTab => tab.kind === 'terminal'
    )
  }

  /**
   * Whether the right sidebar should render at all. Independent of the bottom
   * terminal dock: when the sidebar has no non-terminal tabs it still renders
   * its empty/actions state so the user can add files, git, sources, etc.
   */
  get sidebarVisible(): boolean {
    return this.visible
  }

  /**
   * Whether the bottom terminal dock should render at all. Fully independent
   * of the right sidebar — hiding the sidebar never hides the dock.
   */
  get terminalDockVisible(): boolean {
    return (
      this.terminalPlacement === 'bottom' &&
      this.activeContext?.terminalDockOpen !== false &&
      this.terminalTabs.length > 0
    )
  }

  /**
   * Whether the bottom terminal dock is folded into its thin restore bar.
   * True while the dock is closed but terminal tabs still exist, so a user can
   * expand the shell back to its previous height from the chevron bar.
   */
  get terminalDockCollapsed(): boolean {
    return (
      this.terminalPlacement === 'bottom' &&
      this.activeContext?.terminalDockOpen === false &&
      this.terminalTabs.length > 0
    )
  }

  /** Toggle the bottom terminal dock without touching the sidebar. */
  toggleTerminalDock(): void {
    const context = this.activeContext
    if (!context || this.terminalPlacement !== 'bottom') return
    context.terminalDockOpen = !context.terminalDockOpen
  }

  /** Move terminals between the sidebar and the bottom dock. */
  setTerminalPlacement(placement: TerminalPlacement): void {
    this.terminalPlacement = placement
    const context = this.activeContext
    if (!context) return
    if (placement === 'bottom') {
      context.terminalDockOpen = true
      const sidebarTabs = context.tabs.filter((tab) => tab.kind !== 'terminal')
      if (sidebarTabs.length === 0) {
        // Nothing else lives in the sidebar — close it; only the dock stays.
        context.visible = false
      } else {
        // Bring the remaining (last active non-terminal) tab into focus.
        const focusId =
          context.sidebarActiveTabId &&
          sidebarTabs.some((tab) => tab.id === context.sidebarActiveTabId)
            ? context.sidebarActiveTabId
            : (sidebarTabs.at(-1)?.id ?? null)
        if (focusId) {
          context.activeTabId = focusId
          context.sidebarActiveTabId = focusId
        }
        context.visible = true
      }
    } else {
      // Terminals rejoin the sidebar — reveal it so the shell stays visible.
      context.visible = true
    }
  }

  /** Active tab id for the right sidebar (ignores terminal tabs). */
  get sidebarActiveTabId(): string | null {
    if (this.terminalPlacement === 'right') return this.activeTabId
    const context = this.activeContext
    if (!context) return null
    if (
      context.sidebarActiveTabId &&
      this.sidebarTabs.some((tab) => tab.id === context.sidebarActiveTabId)
    ) {
      return context.sidebarActiveTabId
    }
    return this.sidebarTabs.at(-1)?.id ?? null
  }

  /** Active tab id for the bottom terminal dock. */
  get terminalActiveTabId(): string | null {
    if (this.terminalPlacement !== 'bottom') return null
    const context = this.activeContext
    if (!context) return null
    if (
      context.terminalActiveTabId &&
      this.terminalTabs.some((tab) => tab.id === context.terminalActiveTabId)
    ) {
      return context.terminalActiveTabId
    }
    return this.terminalTabs.at(-1)?.id ?? null
  }

  /** The tab the sidebar content should render for. */
  get sidebarActiveTab(): ContextSidebarTab | null {
    return this.sidebarTabs.find((tab) => tab.id === this.sidebarActiveTabId) ?? null
  }

  /** The terminal the dock content should render for. */
  get terminalActiveTab(): TerminalContextTab | null {
    return this.terminalTabs.find((tab) => tab.id === this.terminalActiveTabId) ?? null
  }

  threadIdForProject(projectId: string): string | null {
    const context = this.activeContext
    return context?.projectId === projectId ? context.threadId : null
  }

  activateThread(projectId: string, threadId: string): void {
    this.activeKey = contextKey(projectId, threadId)
  }

  deactivateThread(): void {
    this.activeKey = null
  }

  toggle(): void {
    const context = this.ensureActiveContext()
    if (!context) return
    context.visible = !context.visible
  }

  show(): void {
    const context = this.ensureActiveContext()
    if (context) context.visible = true
  }

  hide(): void {
    const context = this.activeContext
    if (context) context.visible = false
  }

  openFiles(projectId: string, threadId: string): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `files:${projectId}:${threadId}:browser`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
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
    const context = this.ensureContext(projectId, threadId)
    const id = `files:${projectId}:${threadId}:${fileTabId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'files') existing.preview = preview
      this.focusInContext(context, id)
      return
    }
    const browserIndex = context.tabs.findIndex(
      (tab) => tab.kind === 'files' && tab.fileTabId === null
    )
    if (browserIndex >= 0 && context.activeTabId === context.tabs[browserIndex]?.id) {
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
      context.activeTabId = id
      return
    }
    this.open(context, {
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
    for (const context of Object.values(this.contexts)) {
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
    nextPath: string
  ): boolean {
    for (const context of Object.values(this.contexts)) {
      const index = context.tabs.findIndex(
        (tab) =>
          tab.kind === 'files' && tab.projectId === projectId && tab.fileTabId === previousFileTabId
      )
      if (index < 0) continue
      const previous = context.tabs[index]
      if (previous.kind !== 'files') continue
      const nextId = `files:${projectId}:${previous.threadId}:${nextFileTabId}`
      context.tabs[index] = {
        ...previous,
        id: nextId,
        title: nextPath.split('/').at(-1) ?? nextPath,
        fileTabId: nextFileTabId,
        path: nextPath
      }
      if (context.activeTabId === previous.id) context.activeTabId = nextId
      return true
    }
    return false
  }

  /** Stop rendering a file tab as a preview (italicised) — used when the user
   *  starts editing it, which pins the tab. */
  pinProjectFile(projectId: string, fileTabId: string): void {
    for (const context of Object.values(this.contexts)) {
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
    for (const context of Object.values(this.contexts)) {
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
      if (context.tabs.length === 0) {
        context.tabs = [
          {
            id: `files:${context.projectId}:${context.threadId}:browser`,
            kind: 'files',
            title: 'Open file',
            projectId: context.projectId,
            threadId: context.threadId,
            fileTabId: null,
            path: null,
            preview: false
          }
        ]
      }
      if (context.activeTabId && closingIds.has(context.activeTabId)) {
        context.activeTabId = context.tabs.at(-1)?.id ?? null
      }
    }
  }

  openDiff(
    projectId: string,
    threadId: string,
    checkpointId: string | null = null,
    revealPath: string | null = null
  ): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `diff:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing?.kind === 'diff') {
      existing.checkpointId = checkpointId
      existing.revealPath = revealPath
      existing.revealNonce += 1
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'diff',
      title: 'Changes',
      projectId,
      threadId,
      checkpointId,
      revealPath,
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
    const context = this.ensureContext(projectId, threadId)
    const id = `git:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.focusInContext(context, id)
    } else {
      this.open(context, {
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

  openCloudDeployments(projectId: string, threadId: string): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `cloud-deployment:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'cloud-deployment',
      title: 'Cloud Deployments',
      projectId,
      threadId
    })
  }

  openMemory(projectId: string, threadId: string, section?: MemorySection): void {
    const context = this.ensureContext(projectId, threadId)
    const id = `memory:${projectId}:${threadId}`
    const existing = context.tabs.find((tab) => tab.id === id)
    if (existing) {
      if (existing.kind === 'memory' && section) existing.memorySection = section
      this.focusInContext(context, id)
      return
    }
    this.open(context, {
      id,
      kind: 'memory',
      title: 'Memory',
      projectId,
      threadId,
      memorySection: section ?? 'active'
    })
  }

  toggleNotifications(): void {
    const id = 'notifications'
    const context = this.ensureActiveContext()
    if (context) {
      const existing = context.tabs.find((tab) => tab.id === id)
      if (existing && context.visible && context.activeTabId === id) {
        context.visible = false
        return
      }
      if (existing) {
        this.focusInContext(context, id)
        return
      }
      this.open(context, {
        id,
        kind: 'notifications',
        title: 'Notifications'
      })
      return
    }
    // No active thread context — use a pseudo-global entry so the
    // notification panel can be toggled from any view.
    const globalKey = '__notifications_global__'
    let global = this.contexts[globalKey]
    if (!global) {
      global = {
        projectId: '',
        threadId: '',
        tabs: [],
        activeTabId: null,
        sidebarActiveTabId: null,
        terminalActiveTabId: null,
        visible: false,
        terminalDockOpen: false,
        terminalSequence: 0
      }
      this.contexts[globalKey] = global
    }
    const existing = global.tabs.find((tab) => tab.id === id)
    if (existing && global.visible && global.activeTabId === id) {
      global.visible = false
      return
    }
    if (existing) {
      this.activeKey = globalKey
      this.focusInContext(global, id)
      return
    }
    this.activeKey = globalKey
    this.open(global, { id, kind: 'notifications', title: 'Notifications' })
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
          !tab.busy &&
          tab.messages.length === 0
      )
      if (existing) {
        existing.selections = [...existing.selections, selection]
        this.focusInContext(context, existing.id)
        this.touchTemporaryChat(existing)
        return existing
      }
    }

    const temporaryChatId = crypto.randomUUID()
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
      settings: { ...settings, engineeringMode: false, permissionLevel: 'auto_review' },
      messages: [],
      busy: false,
      error: '',
      draft: '',
      selectionAttached,
      selectionMessageId: null,
      autoPromptSent: false,
      autoPrompt,
      sessionStarted: false,
      expired: false,
      expiresAt: Date.now() + TEMPORARY_CHAT_INACTIVITY_MS
    }
    this.open(context, tab)
    this.scheduleTemporaryChatExpiry(tab)
    return tab
  }

  openAuditSession(
    projectId: string,
    threadId: string,
    settings: ThreadSettings
  ): TemporaryChatContextTab {
    const context = this.ensureContext(projectId, threadId)
    const existing = context.tabs.find(
      (tab): tab is TemporaryChatContextTab => tab.kind === 'temporary-chat' && tab.mode === 'audit'
    )
    if (existing) {
      existing.settings = { ...settings, engineeringMode: false, permissionLevel: 'auto_review' }
      this.focusInContext(context, existing.id)
      this.touchTemporaryChat(existing)
      return existing
    }

    const temporaryChatId = crypto.randomUUID()
    const tab: TemporaryChatContextTab = {
      id: `temporary-chat:${temporaryChatId}`,
      kind: 'temporary-chat',
      title: 'Audit',
      projectId,
      threadId,
      temporaryChatId,
      sessionId: null,
      mode: 'audit',
      selections: [],
      initialContext: '',
      settings: { ...settings, engineeringMode: false, permissionLevel: 'auto_review' },
      messages: [],
      busy: false,
      error: '',
      draft: '',
      selectionAttached: false,
      selectionMessageId: null,
      autoPromptSent: true,
      sessionStarted: false,
      expired: false,
      expiresAt: Date.now() + AUDIT_SESSION_INACTIVITY_MS
    }
    this.open(context, tab)
    this.scheduleTemporaryChatExpiry(tab)
    return tab
  }

  touchTemporaryChat(
    tab: TemporaryChatContextTab,
    expiresAt = Date.now() +
      (tab.mode === 'audit' ? AUDIT_SESSION_INACTIVITY_MS : TEMPORARY_CHAT_INACTIVITY_MS)
  ): void {
    if (tab.expired) return
    tab.expiresAt = expiresAt
    this.scheduleTemporaryChatExpiry(tab)
  }

  expireTemporaryChat(tab: TemporaryChatContextTab, closeRemote = true): void {
    if (tab.expired) return
    const temporaryChatId = tab.temporaryChatId
    tab.expired = true
    tab.messages = []
    tab.draft = ''
    tab.initialContext = ''
    tab.busy = false
    tab.error = ''
    tab.selectionAttached = false
    tab.selectionMessageId = null
    this.clearTemporaryChatExpiry(temporaryChatId)
    if (closeRemote) void invoke('agent:closeTemporaryChat', temporaryChatId)
  }

  restartTemporaryChat(tab: TemporaryChatContextTab): void {
    this.clearTemporaryChatExpiry(tab.temporaryChatId)
    tab.temporaryChatId = crypto.randomUUID()
    tab.sessionId = null
    tab.messages = []
    tab.busy = false
    tab.error = ''
    tab.draft = ''
    // Re-attach the selections on restart only when there are any — a quick chat
    // opened from the last agent turn has no selection attached.
    tab.selectionAttached = tab.selections.length > 0
    tab.selectionMessageId = null
    tab.autoPromptSent = false
    tab.sessionStarted = false
    tab.expired = false
    tab.expiresAt =
      Date.now() +
      (tab.mode === 'audit' ? AUDIT_SESSION_INACTIVITY_MS : TEMPORARY_CHAT_INACTIVITY_MS)
    this.scheduleTemporaryChatExpiry(tab)
  }

  openPrimaryTerminal(projectId: string, threadId: string): void {
    const context = this.ensureContext(projectId, threadId)
    const existing = context.tabs.find(
      (tab) => tab.kind === 'terminal' && tab.projectId === projectId && tab.threadId === threadId
    )
    if (existing) {
      this.focusInContext(context, existing.id)
      return
    }
    this.openNewTerminal(projectId, threadId)
  }

  openNewTerminal(projectId: string, threadId: string): void {
    const context = this.ensureContext(projectId, threadId)
    context.terminalSequence += 1
    const sequence = context.terminalSequence
    const id = `terminal:${projectId}:${threadId}:${sequence}`
    this.open(context, {
      id,
      kind: 'terminal',
      title: sequence === 1 ? 'Terminal' : `Terminal ${sequence}`,
      terminalId: `workbench-${projectId}-${threadId}-${sequence}`,
      projectId,
      threadId
    })
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
      title: activity.description || activity.agent || 'Sub-agent',
      projectId,
      threadId,
      sourcePartId: partId,
      activity
    }

    if (existingIndex >= 0) {
      const previousId = context.tabs[existingIndex].id
      context.tabs[existingIndex] = next
      context.tabs = [...context.tabs]
      if (context.activeTabId === previousId) context.activeTabId = id
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
    const context = this.contexts[contextKey(projectId, threadId)]
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
    const nextTitle = activity.agent || 'Sub-agent'
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
    if (context.activeTabId === current.id) {
      context.activeTabId = context.tabs[index].id
    }
    context.tabs = [...context.tabs]
  }

  focus(id: string): void {
    const context = this.activeContext
    if (context) this.focusInContext(context, id)
  }

  close(id: string): void {
    const context = this.activeContext
    if (!context) return
    const index = context.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tab = context.tabs[index]
    if (tab.kind === 'temporary-chat') {
      this.clearTemporaryChatExpiry(tab.temporaryChatId)
    }
    const closedKind = tab.kind
    context.tabs = context.tabs.filter((tab) => tab.id !== id)
    if (context.activeTabId === id) {
      const replacement = context.tabs[Math.min(index, context.tabs.length - 1)]
      context.activeTabId = replacement?.id ?? null
    }
    if (closedKind === 'terminal') {
      if (context.terminalActiveTabId === id) {
        const replacement = context.tabs.filter((t) => t.kind === 'terminal').at(-1)
        context.terminalActiveTabId = replacement?.id ?? null
      }
    } else if (context.sidebarActiveTabId === id) {
      const replacement = context.tabs.filter((t) => t.kind !== 'terminal').at(-1)
      context.sidebarActiveTabId = replacement?.id ?? null
    }
    if (context.tabs.length === 0) {
      context.visible = false
    }
  }

  reorder(id: string, targetId: string, position: 'before' | 'after'): void {
    const context = this.activeContext
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

  setWidth(width: number): void {
    this.width = Math.max(CONTEXT_SIDEBAR_MIN_WIDTH, Math.min(width, CONTEXT_SIDEBAR_MAX_WIDTH))
  }

  setTerminalHeight(height: number): void {
    this.terminalHeight = Math.max(
      TERMINAL_DOCK_MIN_HEIGHT,
      Math.min(height, TERMINAL_DOCK_MAX_HEIGHT)
    )
  }

  private get activeContext(): ThreadSidebarContext | null {
    return this.activeKey ? (this.contexts[this.activeKey] ?? null) : null
  }

  private ensureActiveContext(): ThreadSidebarContext | null {
    if (!this.activeKey) return null
    const existing = this.contexts[this.activeKey]
    if (existing) return existing
    const separator = this.activeKey.indexOf(':')
    if (separator < 0) return null
    return this.ensureContext(
      this.activeKey.slice(0, separator),
      this.activeKey.slice(separator + 1)
    )
  }

  private ensureContext(projectId: string, threadId: string): ThreadSidebarContext {
    const key = contextKey(projectId, threadId)
    const existing = this.contexts[key]
    if (existing) return existing
    const context: ThreadSidebarContext = {
      projectId,
      threadId,
      tabs: [],
      activeTabId: null,
      sidebarActiveTabId: null,
      terminalActiveTabId: null,
      visible: false,
      terminalDockOpen: false,
      terminalSequence: 0
    }
    this.contexts[key] = context
    return context
  }

  private focusInContext(context: ThreadSidebarContext, id: string): void {
    if (!context.tabs.some((tab) => tab.id === id)) return
    context.activeTabId = id
    this.trackRegionActiveTab(context, id)
    this.revealRegion(context, id, false)
  }

  private open(context: ThreadSidebarContext, tab: ContextSidebarTab): void {
    const index = context.tabs.findIndex((existing) => existing.id === tab.id)
    if (index >= 0) {
      context.tabs[index] = tab
      context.tabs = [...context.tabs]
    } else {
      context.tabs = [...context.tabs, tab]
    }
    context.activeTabId = tab.id
    this.trackRegionActiveTab(context, tab.id)
    this.revealRegion(context, tab.id, true)
  }

  /** Remember which area (sidebar vs bottom dock) owns the focused tab. */
  private trackRegionActiveTab(context: ThreadSidebarContext, id: string): void {
    const tab = context.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (tab.kind === 'terminal') {
      context.terminalActiveTabId = id
    } else {
      context.sidebarActiveTabId = id
    }
  }

  /**
   * Reveal only the region the tab belongs to, keeping the two regions
   * independent:
   * - Terminal tabs docked at the bottom open the dock; on a brand-new open
   *   the sidebar is revealed too so its add-actions stay reachable.
   * - Everything else reveals the sidebar. The dock is never touched.
   */
  private revealRegion(context: ThreadSidebarContext, id: string, opening: boolean): void {
    const tab = context.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (tab.kind === 'terminal' && this.terminalPlacement === 'bottom') {
      context.terminalDockOpen = true
      if (opening) context.visible = true
    } else {
      context.visible = true
    }
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

export const contextSidebarState = new ContextSidebarState()
