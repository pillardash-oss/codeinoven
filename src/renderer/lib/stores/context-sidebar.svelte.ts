import { invoke } from '$lib/ipc.svelte'
import { messageId } from '$shared/id'
import { SvelteSet } from 'svelte/reactivity'
import { gitState } from './git.svelte'
import { APP_SLUG } from '$shared/brand'
import type {
  AgentMessage,
  AgentSessionStatus,
  AgentSubagentActivity,
  ThreadSettings
} from '$shared/types'

const TEMPORARY_CHAT_INACTIVITY_MS = 3 * 60 * 60 * 1000
const CONTEXT_SIDEBAR_MIN_WIDTH = 340
const CONTEXT_SIDEBAR_MAX_WIDTH = 1600
const TERMINAL_DOCK_MIN_HEIGHT = 180
const TERMINAL_DOCK_MAX_HEIGHT = 560
const TERMINAL_PLACEMENT_STORAGE_KEY = `${APP_SLUG}.terminal-placement.v1`
const BROWSER_TABS_STORAGE_KEY = `${APP_SLUG}.browser-tabs.v1`
const MAX_PERSISTED_BROWSER_TABS = 50
const BROWSER_TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u

export type TerminalPlacement = 'right' | 'bottom'

function loadTerminalPlacement(): TerminalPlacement {
  if (typeof window === 'undefined') return 'right'
  try {
    const raw = window.localStorage.getItem(TERMINAL_PLACEMENT_STORAGE_KEY)
    return raw === 'bottom' ? 'bottom' : 'right'
  } catch {
    return 'right'
  }
}

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

export interface BrowserContextTab {
  id: string
  kind: 'browser'
  title: string
  projectId: string
  threadId: string
  url: string
  surface: 'page' | 'console'
}

export interface ThreadNoteContextTab {
  id: string
  kind: 'thread-note'
  title: string
  projectId: string
  threadId: string
  /** Display name of the owning thread, used in the delete confirmation. */
  threadTitle: string
  /** The last-saved body, or null before the first save. Diffing against
   *  this (rather than a separate `dirty` flag) is what lets the panel
   *  survive a hide/show without losing an unsaved draft — both fields
   *  live on the tab itself, not in the component that gets unmounted. */
  savedBody: string | null
  draftBody: string
  mode: 'edit' | 'read'
  /** Monotonic request used to return keyboard focus to the editor when an
   *  already-open note is explicitly opened for writing. */
  focusRequest: number
  loading: boolean
  saving: boolean
  error: string | null
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

/**
 * The Assignment / Achievement / Audit coordinator, docked into the sidebar. The tab
 * carries no data of its own: the panel is a snippet published by the thread
 * that owns the coordination, registered on `coordinatorDockState`.
 */
export interface CoordinatorContextTab {
  id: string
  kind: 'coordinator'
  title: string
  projectId: string
  threadId: string
}

export type TemporaryChatMode = 'elaborate' | 'quick'

/** Shared instruction sent to the harness when the user asks a side chat to
 *  explain a selection. Displayed in the conversation as the short action
 *  label ("Explain") while the full instruction travels as the transport text. */
export const EXPLAIN_SELECTION_PROMPT =
  'Explain the selected content clearly, based on the surrounding context. Use simple, everyday language and avoid unnecessary technical jargon unless it is truly needed. Be read-only — do not make changes or run commands.'

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
  /** Structured provider lifecycle state mirroring the main chat, so the
   *  temporary chat renders the same provider status card above its composer. */
  status: Extract<AgentSessionStatus, { state: 'waiting' | 'error' }> | null
  draft: string
  selectionAttached: boolean
  selectionMessageId: string | null
  autoPromptSent: boolean
  /** Id of the user message seeded at open time for the auto-sent explain
   *  prompt, so the prompt shows as a sent message the instant the tab opens
   *  (the controller reuses it instead of appending a duplicate). */
  autoPromptMessageId: string | null
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
  | ThreadNoteContextTab
  | CloudDeploymentContextTab
  | TemporaryChatContextTab
  | NotificationContextTab
  | MemoryContextTab
  | CoordinatorContextTab
  | BrowserContextTab

interface ThreadSidebarContext {
  projectId: string
  threadId: string
  tabs: ContextSidebarTab[]
  activeTabIds: Partial<Record<ContextSidebarTab['kind'], string>>
}

interface ProjectSidebarContext {
  projectId: string
  tabs: ContextSidebarTab[]
  activeKind: ContextSidebarTab['kind'] | null
  activeTabIds: Partial<Record<ContextSidebarTab['kind'], string>>
  terminalActiveTabId: string | null
  visible: boolean
  /** Whether the bottom terminal dock is open. Only meaningful while
   * `terminalPlacement === 'bottom'`; lets the dock hide independently of the
   * sidebar (e.g. from the header terminal toggle). */
  terminalDockOpen: boolean
  terminalSequence: number
}

const EMPTY_TABS: ContextSidebarTab[] = []
const NOTIFICATIONS_TAB: NotificationContextTab = {
  id: 'notifications',
  kind: 'notifications',
  title: 'Notifications'
}

/** Tabs whose component/session state belongs to a project. Every other tab
 * remains in its owning thread context and is swapped when the thread changes. */
const PROJECT_TAB_KINDS = new Set<ContextSidebarTab['kind']>([
  'files',
  'terminal',
  'git',
  'cloud-deployment',
  'memory'
])

function isProjectTab(tab: ContextSidebarTab): boolean {
  return PROJECT_TAB_KINDS.has(tab.kind)
}

function loadBrowserTabs(): BrowserContextTab[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(BROWSER_TABS_STORAGE_KEY)
    if (!raw) return []
    const snapshot: unknown = JSON.parse(raw)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
    const tabs = (snapshot as Record<string, unknown>)['tabs']
    if (!Array.isArray(tabs)) return []
    const restored: BrowserContextTab[] = []
    for (const value of tabs.slice(-MAX_PERSISTED_BROWSER_TABS)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const tab = value as Record<string, unknown>
      const id = tab['id']
      const projectId = tab['projectId']
      const threadId = tab['threadId']
      const title = tab['title']
      const url = tab['url']
      if (
        typeof id !== 'string' ||
        !BROWSER_TAB_ID_PATTERN.test(id) ||
        restored.some((candidate) => candidate.id === id) ||
        typeof projectId !== 'string' ||
        projectId.length === 0 ||
        projectId.length > 512 ||
        typeof threadId !== 'string' ||
        threadId.length > 512 ||
        typeof title !== 'string' ||
        title.length > 240 ||
        typeof url !== 'string'
      ) {
        continue
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        continue
      }
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        continue
      }
      restored.push({
        id,
        kind: 'browser',
        title,
        projectId,
        threadId,
        url: parsed.href,
        // Restored tabs stay inert until the user opens the project's browser.
        // Start on the page so that explicit action is the only load trigger.
        surface: 'page'
      })
    }
    return restored
  } catch {
    return []
  }
}

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
  private projectContexts: Record<string, ProjectSidebarContext> = $state({})
  private browserTabs: BrowserContextTab[] = $state(loadBrowserTabs())
  private browserActiveTabId: string | null = $state(null)
  private browserVisible = $state(false)
  /** Keys of full-window DOM surfaces currently covering the workspace (e.g.
   *  fullscreen terminal/media/file editors). The browser's native view must
   *  hide while any is active, because a native view floats above every DOM
   *  modal. Tracked as a keyed set so nested/overlapping surfaces are safe. */
  private fullscreenSurfaceKeys = new SvelteSet<string>()
  private activeProjectId: string | null = $state(null)
  private activeThreadId: string | null = $state(null)
  private notificationsVisible = $state(false)
  private temporaryChatExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  width = $state(480)
  terminalHeight = $state(320)
  terminalPlacement = $state<TerminalPlacement>(loadTerminalPlacement())
  /** Monotonic trigger: each `requestCloseActiveTab()` call bumps this so a
   *  consumer (Workspace) can run the close-through-confirmation flow. */
  closeActiveTabRequest = $state(0)

  get tabs(): ContextSidebarTab[] {
    return [
      ...(this.activeProjectContext?.tabs ?? EMPTY_TABS),
      ...(this.activeContext?.tabs.filter((tab) => !isProjectTab(tab)) ?? EMPTY_TABS),
      ...this.activeBrowserTabs,
      ...(this.notificationsVisible ? [NOTIFICATIONS_TAB] : [])
    ]
  }

  /** Resolve a live temporary-chat tab without passing its mutable proxy
   *  through a component prop. The sidebar store remains the sole owner. */
  temporaryChatTab(tabId: string): TemporaryChatContextTab | null {
    const tab = this.activeContext?.tabs.find((candidate) => candidate.id === tabId)
    return tab?.kind === 'temporary-chat' ? tab : null
  }

  get activeTabId(): string | null {
    return this.sidebarActiveTabId
  }

  get visible(): boolean {
    return this.sidebarVisible
  }

  get activeTab(): ContextSidebarTab | null {
    return this.sidebarActiveTab
  }

  /** Whether any full-window DOM surface is suppressing native surfaces. */
  get fullscreenSuppression(): boolean {
    return this.fullscreenSurfaceKeys.size > 0
  }

  /** Register (or unregister) a full-window DOM surface that covers the
   *  workspace. While any key is active the browser's native view is hidden —
   *  it would otherwise float above the DOM surface. */
  setFullscreenSurfaceActive(key: string, active: boolean): void {
    if (active) this.fullscreenSurfaceKeys.add(key)
    else this.fullscreenSurfaceKeys.delete(key)
  }

  /**
   * Whether the native browser view is currently on screen from the right
   * sidebar (a visible browser tab whose surface is the page). The native
   * Ctrl+Tab overlay is only needed while this is true.
   */
  get sidebarBrowserNativeVisible(): boolean {
    if (this.fullscreenSuppression) return false
    if (!this.browserVisible) return false
    const active =
      this.activeBrowserTabs.find((tab) => tab.id === this.browserActiveTabId) ??
      this.activeBrowserTabs.at(-1)
    return active?.surface === 'page'
  }

  /**
   * Tabs shown in the right sidebar. When the terminal is docked at the
   * bottom, terminal tabs live in the dock and are excluded here; otherwise
   * every tab (including terminals) renders in the sidebar.
   */
  get sidebarTabs(): ContextSidebarTab[] {
    const tabs = [
      ...(this.activeProjectContext?.tabs ?? EMPTY_TABS),
      ...(this.activeContext?.tabs.filter((tab) => !isProjectTab(tab)) ?? EMPTY_TABS),
      ...this.activeBrowserTabs
    ]
    const positionedTabs =
      this.terminalPlacement === 'bottom' ? tabs.filter((tab) => tab.kind !== 'terminal') : tabs
    return this.notificationsVisible ? [...positionedTabs, NOTIFICATIONS_TAB] : positionedTabs
  }

  /** Tabs shown in the bottom terminal dock. Empty while docked to the right. */
  get terminalTabs(): TerminalContextTab[] {
    if (this.terminalPlacement !== 'bottom') return EMPTY_TABS as TerminalContextTab[]
    return (this.activeProjectContext?.tabs ?? EMPTY_TABS).filter(
      (tab): tab is TerminalContextTab => tab.kind === 'terminal'
    )
  }

  /**
   * Whether the right sidebar should render at all. Independent of the bottom
   * terminal dock: when the sidebar has no non-terminal tabs it still renders
   * its empty/actions state so the user can add files, git, sources, etc.
   */
  get sidebarVisible(): boolean {
    if (this.notificationsVisible) return true
    if (this.browserVisible && this.activeBrowserTabs.length > 0) return true
    return this.activeThreadId !== null && (this.activeProjectContext?.visible ?? false)
  }

  /**
   * Whether the bottom terminal dock should render at all. Fully independent
   * of the right sidebar — hiding the sidebar never hides the dock.
   */
  get terminalDockVisible(): boolean {
    return (
      this.terminalPlacement === 'bottom' &&
      this.activeThreadId !== null &&
      this.activeProjectContext?.terminalDockOpen !== false &&
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
      this.activeThreadId !== null &&
      this.activeProjectContext?.terminalDockOpen === false &&
      this.terminalTabs.length > 0
    )
  }

  /** Toggle the bottom terminal dock without touching the sidebar. */
  toggleTerminalDock(): void {
    const context = this.activeProjectContext
    if (!context || this.terminalPlacement !== 'bottom') return
    context.terminalDockOpen = !context.terminalDockOpen
  }

  /** Move terminals between the sidebar and the bottom dock. */
  setTerminalPlacement(placement: TerminalPlacement): void {
    this.terminalPlacement = placement
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(TERMINAL_PLACEMENT_STORAGE_KEY, placement)
      } catch {
        // Terminal placement is cosmetic; unavailable storage must not break the app.
      }
    }
    const context = this.activeProjectContext
    if (!context) return
    const terminalTabs = context.tabs.filter(
      (tab): tab is TerminalContextTab => tab.kind === 'terminal'
    )
    const rememberedTerminalId = context.terminalActiveTabId ?? context.activeTabIds.terminal
    const activeTerminalId =
      rememberedTerminalId && terminalTabs.some((tab) => tab.id === rememberedTerminalId)
        ? rememberedTerminalId
        : (terminalTabs.at(-1)?.id ?? null)

    this.notificationsVisible = false
    if (placement === 'bottom') {
      context.terminalDockOpen = true
      context.terminalActiveTabId = activeTerminalId
      // Moving the terminal out of the sidebar also closes that region. The
      // bottom dock is the only panel the placement action should reveal.
      context.visible = false
    } else {
      // Terminals rejoin the sidebar as the active tool, rather than revealing
      // whichever non-terminal panel happened to be active before docking.
      if (activeTerminalId) {
        context.activeKind = 'terminal'
        context.activeTabIds.terminal = activeTerminalId
        context.visible = true
      }
    }
  }

  /** Active tab id for the right sidebar (ignores terminal tabs). */
  get sidebarActiveTabId(): string | null {
    if (this.notificationsVisible) return NOTIFICATIONS_TAB.id
    if (this.browserVisible) {
      return this.browserActiveTabId &&
        this.activeBrowserTabs.some((tab) => tab.id === this.browserActiveTabId)
        ? this.browserActiveTabId
        : (this.activeBrowserTabs.at(-1)?.id ?? null)
    }
    const project = this.activeProjectContext
    const kind = project?.activeKind
    if (!project || !kind) return null
    const tabs = this.sidebarTabs.filter((tab) => tab.kind === kind)
    const activeId = this.activeTabIdsForKind(kind)?.[kind]
    return activeId && tabs.some((tab) => tab.id === activeId)
      ? activeId
      : (tabs.at(-1)?.id ?? null)
  }

  /** Active tab id for the bottom terminal dock. */
  get terminalActiveTabId(): string | null {
    if (this.terminalPlacement !== 'bottom') return null
    const context = this.activeProjectContext
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
    if (this.notificationsVisible) return NOTIFICATIONS_TAB
    return this.sidebarTabs.find((tab) => tab.id === this.sidebarActiveTabId) ?? null
  }

  /** The terminal the dock content should render for. */
  get terminalActiveTab(): TerminalContextTab | null {
    return this.terminalTabs.find((tab) => tab.id === this.terminalActiveTabId) ?? null
  }

  threadIdForProject(projectId: string): string | null {
    return this.activeProjectId === projectId ? this.activeThreadId : null
  }

  activateThread(projectId: string, threadId: string, threadTitle?: string): void {
    const keepNotificationsVisible = this.notificationsVisible
    const projectChanged = this.activeProjectId !== projectId
    // Capture before `activeProjectId` moves: the native view (if any) belongs
    // to the outgoing project and must be detached from the store layer so the
    // floating view never outlives its sidebar visibility.
    const browserWasVisible = this.browserVisible
    const previousBrowserTabId =
      this.browserActiveTabId ?? this.activeBrowserTabs.at(-1)?.id ?? null
    this.activeProjectId = projectId
    this.activeThreadId = threadId
    this.ensureProjectContext(projectId)
    this.ensureContext(projectId, threadId)
    this.rebindProjectTabs(projectId, threadId)
    this.ensureActiveThreadPanel(projectId, threadId, threadTitle)
    this.notificationsVisible = keepNotificationsVisible
    this.browserVisible =
      !keepNotificationsVisible &&
      !projectChanged &&
      this.browserVisible &&
      this.activeBrowserTabs.length > 0
    if (browserWasVisible && !this.browserVisible && previousBrowserTabId) {
      void invoke('browser:hide', previousBrowserTabId)
    }
  }

  deactivateThread(): void {
    this.detachNativeBrowserView()
    this.browserVisible = false
    this.activeProjectId = null
    this.activeThreadId = null
  }

  toggle(): void {
    if (this.browserVisible) {
      this.detachNativeBrowserView()
      this.browserVisible = false
      const context = this.activeProjectContext
      if (context) context.visible = false
      return
    }
    const context = this.activeProjectId ? this.ensureProjectContext(this.activeProjectId) : null
    if (!context) return
    context.visible = !context.visible
  }

  show(): void {
    const context = this.activeProjectId ? this.ensureProjectContext(this.activeProjectId) : null
    if (context) context.visible = true
  }

  hide(): void {
    if (this.notificationsVisible) {
      this.notificationsVisible = false
      return
    }
    if (this.browserVisible) {
      this.detachNativeBrowserView()
      this.browserVisible = false
      const context = this.activeProjectContext
      if (context) context.visible = false
      return
    }
    const context = this.activeProjectContext
    if (context) context.visible = false
  }

  /** Opened from the dock rail's Files icon. Reveals whatever file panel was
   *  last in focus instead of always jumping to the empty "Open file"
   *  browser tab — hiding the sidebar must not lose the file the user was
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
      this.notificationsVisible = false
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
     *  tabs at once) — those shouldn't fight over which tab ends up
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
        this.notificationsVisible = false
      } else if (context.activeTabIds.files === previous.id) {
        context.activeTabIds.files = nextId
      }
      return true
    }
    return false
  }

  /** Stop rendering a file tab as a preview (italicised) — used when the user
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
        const browser: FilesContextTab = {
          id: `files:${context.projectId}:browser`,
          kind: 'files',
          title: 'Open file',
          projectId: context.projectId,
          threadId: this.activeProjectId === context.projectId ? (this.activeThreadId ?? '') : '',
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
   *  reopen — the dock rail's toggle calls this with no reveal target and
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

  openBrowser(url: string, requestedTabId?: string): string | null {
    if (!this.activeProjectId || !this.activeThreadId) return null
    return this.openBrowserForContext(
      url,
      this.activeProjectId,
      this.activeThreadId,
      requestedTabId,
      true
    )
  }

  openBrowserForContext(
    url: string,
    projectId: string,
    threadId: string,
    requestedTabId?: string,
    reveal = false
  ): string {
    const id = requestedTabId ?? `browser:${crypto.randomUUID()}`
    const existing = this.browserTabs.find((tab) => tab.id === id && tab.projectId === projectId)
    if (existing) {
      existing.url = url
      existing.threadId = threadId
      this.persistBrowserTabs()
      if (reveal && this.activeProjectId === projectId && this.activeThreadId === threadId) {
        this.focusBrowser(id)
      }
      return id
    }
    let title = 'Browser'
    try {
      const parsed = new URL(url)
      title = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
    } catch {
      // The main-process browser boundary reports malformed custom URLs.
    }
    this.browserTabs = [
      ...this.browserTabs,
      { id, kind: 'browser', title, projectId, threadId, url, surface: 'page' }
    ]
    this.persistBrowserTabs()
    if (reveal && this.activeProjectId === projectId && this.activeThreadId === threadId) {
      this.focusBrowser(id)
    }
    return id
  }

  updateBrowserTab(tabId: string, url: string, title?: string): void {
    const tab = this.browserTabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.url = url
    if (title?.trim()) tab.title = title.trim()
    this.persistBrowserTabs()
  }

  updateBrowserSurface(tabId: string, surface: BrowserContextTab['surface']): void {
    const tab = this.browserTabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      tab.surface = surface
      this.persistBrowserTabs()
    }
  }

  removeProjectBrowsers(projectId: string): string[] {
    const removedIds = this.browserTabs
      .filter((tab) => tab.projectId === projectId)
      .map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.browserTabs = this.browserTabs.filter((tab) => tab.projectId !== projectId)
    if (this.browserActiveTabId && removedIds.includes(this.browserActiveTabId)) {
      this.browserActiveTabId = null
    }
    if (this.activeProjectId === projectId) this.browserVisible = false
    this.persistBrowserTabs()
    return removedIds
  }

  removeThreadBrowsers(projectId: string, threadId: string): string[] {
    const removedIds = this.browserTabs
      .filter((tab) => tab.projectId === projectId && tab.threadId === threadId)
      .map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.browserTabs = this.browserTabs.filter(
      (tab) => tab.projectId !== projectId || tab.threadId !== threadId
    )
    if (this.browserActiveTabId && removedIds.includes(this.browserActiveTabId)) {
      this.browserActiveTabId = this.activeBrowserTabs.at(-1)?.id ?? null
    }
    if (this.activeBrowserTabs.length === 0) this.browserVisible = false
    this.persistBrowserTabs()
    return removedIds
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
    const context = this.contexts[contextKey(projectId, threadId)]
    return context?.tabs.some((tab) => tab.kind === 'coordinator') ?? false
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

  toggleNotifications(): void {
    this.notificationsVisible = !this.notificationsVisible
    if (this.notificationsVisible) {
      if (this.browserVisible) this.detachNativeBrowserView()
      this.browserVisible = false
    }
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
    // The explain auto-prompt commits as a user-sent message immediately, so
    // the moment the tab opens the conversation already shows the selection
    // chip with the action label — never a blank panel while the harness
    // session is still being assembled.
    const seededAutoPrompt = mode === 'elaborate' && selectionAttached ? (autoPrompt ?? '') : ''
    const autoPromptMessageId = seededAutoPrompt ? messageId() : null
    const messages: AgentMessage[] =
      autoPromptMessageId !== null
        ? [
            {
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
                  id: `${temporaryChatId}:selection:0`,
                  label: 'Selection 1',
                  text: selection
                }
              ],
              createdAt: Date.now(),
              completedAt: Date.now()
            }
          ]
        : []
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
      messages,
      busy: false,
      error: '',
      status: null,
      draft: '',
      selectionAttached,
      selectionMessageId: null,
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
    tab.messages = []
    tab.draft = ''
    tab.initialContext = ''
    tab.busy = false
    tab.error = ''
    tab.status = null
    tab.selectionAttached = false
    tab.selectionMessageId = null
    tab.autoPromptMessageId = null
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
    tab.status = null
    tab.draft = ''
    // Re-attach the selections on restart only when there are any — a quick chat
    // opened from the last agent turn has no selection attached.
    tab.selectionAttached = tab.selections.length > 0
    tab.selectionMessageId = null
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

  openNewTerminal(projectId: string, threadId: string): void {
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
    if (context.activeTabIds.subagent === current.id) {
      context.activeTabIds.subagent = context.tabs[index].id
    }
    context.tabs = [...context.tabs]
  }

  focus(id: string): void {
    if (this.browserTabs.some((tab) => tab.id === id)) {
      this.focusBrowser(id)
      return
    }
    const project = this.activeProjectContext
    if (project?.tabs.some((tab) => tab.id === id)) {
      this.focusInProjectContext(project, id)
      return
    }
    const thread = this.activeContext
    if (thread) this.focusInContext(thread, id)
  }

  close(id: string): void {
    if (id === NOTIFICATIONS_TAB.id) {
      this.notificationsVisible = false
      return
    }
    const browserIndex = this.browserTabs.findIndex((tab) => tab.id === id)
    if (browserIndex >= 0) {
      const closedProjectId = this.browserTabs[browserIndex].projectId
      this.browserTabs = this.browserTabs.filter((tab) => tab.id !== id)
      if (this.browserActiveTabId === id) {
        this.browserActiveTabId =
          this.browserTabs.filter((tab) => tab.projectId === closedProjectId).at(-1)?.id ?? null
      }
      if (this.activeBrowserTabs.length === 0) this.browserVisible = false
      this.persistBrowserTabs()
      return
    }
    const project = this.activeProjectContext
    const thread = this.activeContext
    const context = project?.tabs.some((tab) => tab.id === id) ? project : thread
    if (!context) return
    const index = context.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tab = context.tabs[index]
    if (tab.kind === 'temporary-chat') {
      this.clearTemporaryChatExpiry(tab.temporaryChatId)
    }
    const closedKind = tab.kind
    context.tabs = context.tabs.filter((tab) => tab.id !== id)
    const replacement = context.tabs.filter((candidate) => candidate.kind === closedKind).at(-1)
    context.activeTabIds[closedKind] = replacement?.id
    if ('terminalActiveTabId' in context && closedKind === 'terminal') {
      context.terminalActiveTabId = replacement?.id ?? null
    }
    if (project?.activeKind === closedKind && !replacement) {
      project.visible = false
    }
  }

  /** Signal Workspace to close the active tab through its confirmation flow
   *  (unsaved-file dialog). The tab is not closed here — Workspace decides. */
  requestCloseActiveTab(): void {
    this.closeActiveTabRequest += 1
  }

  reorder(id: string, targetId: string, position: 'before' | 'after'): void {
    if (this.browserTabs.some((tab) => tab.id === id)) {
      const fromIndex = this.browserTabs.findIndex((tab) => tab.id === id)
      const toIndex = this.browserTabs.findIndex((tab) => tab.id === targetId)
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
      const ordered = [...this.browserTabs]
      const [moved] = ordered.splice(fromIndex, 1)
      const adjustedTarget = ordered.findIndex((tab) => tab.id === targetId)
      ordered.splice(position === 'before' ? adjustedTarget : adjustedTarget + 1, 0, moved)
      this.browserTabs = ordered
      this.persistBrowserTabs()
      return
    }
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
    if (!this.activeProjectId || this.activeThreadId === null) return null
    return this.contexts[contextKey(this.activeProjectId, this.activeThreadId)] ?? null
  }

  private get activeProjectContext(): ProjectSidebarContext | null {
    return this.activeProjectId ? (this.projectContexts[this.activeProjectId] ?? null) : null
  }

  private get activeBrowserTabs(): BrowserContextTab[] {
    if (!this.activeProjectId) return EMPTY_TABS as BrowserContextTab[]
    return this.browserTabs.filter((tab) => tab.projectId === this.activeProjectId)
  }

  private ensureContext(projectId: string, threadId: string): ThreadSidebarContext {
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

  private ensureProjectContext(projectId: string): ProjectSidebarContext {
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

  private focusInContext(context: ThreadSidebarContext, id: string): void {
    const tab = context.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (this.browserVisible) this.detachNativeBrowserView()
    context.activeTabIds[tab.kind] = id
    const project = this.ensureProjectContext(context.projectId)
    project.activeKind = tab.kind
    project.visible = true
    this.browserVisible = false
    this.notificationsVisible = false
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
    if (this.browserVisible) this.detachNativeBrowserView()
    context.activeTabIds[tab.kind] = id
    this.browserVisible = false
    this.notificationsVisible = false
    if (tab.kind === 'terminal' && this.terminalPlacement === 'bottom') {
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

  private focusBrowser(id: string): void {
    const tab = this.browserTabs.find((candidate) => candidate.id === id)
    if (!tab || tab.projectId !== this.activeProjectId) return
    this.browserActiveTabId = id
    this.browserVisible = true
    this.notificationsVisible = false
  }

  /** Detach the native browser view at the store layer. The panel's own
   *  attachment also hides on teardown; this duplicate is the safety net that
   *  keeps the floating native view bound to sidebar visibility even when a
   *  component lifecycle or effect flush is interrupted (transitions, HMR,
   *  a sibling render error). Firing it for a tab that is not attached is a
   *  cheap no-op in the main process. */
  private detachNativeBrowserView(): void {
    const tabId = this.browserActiveTabId ?? this.activeBrowserTabs.at(-1)?.id
    if (tabId) void invoke('browser:hide', tabId)
  }

  private persistBrowserTabs(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        BROWSER_TABS_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: this.browserTabs.slice(-MAX_PERSISTED_BROWSER_TABS) })
      )
    } catch {
      // Browser restoration is best-effort; blocked storage must not break the sidebar.
    }
  }

  private activeTabIdsFor(
    tab: ContextSidebarTab
  ): Partial<Record<ContextSidebarTab['kind'], string>> {
    if (isProjectTab(tab) && 'projectId' in tab) {
      return this.ensureProjectContext(tab.projectId).activeTabIds
    }
    if ('projectId' in tab && 'threadId' in tab) {
      return this.ensureContext(tab.projectId, tab.threadId).activeTabIds
    }
    return {}
  }

  private activeTabIdsForKind(
    kind: ContextSidebarTab['kind']
  ): Partial<Record<ContextSidebarTab['kind'], string>> | null {
    if (PROJECT_TAB_KINDS.has(kind)) return this.activeProjectContext?.activeTabIds ?? null
    return this.activeContext?.activeTabIds ?? null
  }

  private rebindProjectTabs(projectId: string, threadId: string): void {
    const context = this.ensureProjectContext(projectId)
    for (const tab of context.tabs) {
      if ('threadId' in tab) tab.threadId = threadId
    }
  }

  private ensureActiveThreadPanel(projectId: string, threadId: string, threadTitle?: string): void {
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
