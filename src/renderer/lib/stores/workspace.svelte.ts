/**
 * Shared workspace state — lets the app header reflect the active thread
 * (title, connection source, status, history, sources, terminal) without prop-drilling
 * through view components.
 */
import type { Project, Thread } from '$shared/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import type { AgentSource } from '$lib/agent-sources'
import { contextSidebarState } from './context-sidebar.svelte'
import { rendererRecovery } from './renderer-recovery.svelte'
import { notificationPanelState } from './notification-panel.svelte'
import { gitState } from './git.svelte'
import { scopeState } from './scope.svelte'
import { APP_SLUG } from '$shared/brand'
import { invoke } from '$lib/ipc.svelte'

const RECENT_THREAD_VISITS_KEY = `${APP_SLUG}.recent-thread-visits.v1`
const RECENT_THREAD_VISITS_LIMIT = 50

function loadRecentThreadVisits(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_THREAD_VISITS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function persistRecentThreadVisits(visits: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENT_THREAD_VISITS_KEY, JSON.stringify(visits))
  } catch {
    // Recent navigation history is optional and must never block task switching.
  }
}

export function threadVisitKey(thread: Pick<Thread, 'projectId' | 'id'>): string {
  return `${thread.projectId}:${thread.id}`
}

export interface JumpTarget {
  id: string
  content: string
  /** First few work-trace snippets of the turn that follows this message. */
  tracePreview?: string[]
}

/** Actions the mounted thread exposes to the history side panel. */
export interface HistoryMessageActions {
  fork: (id: string) => void
  requestDelete: (id: string, content: string, mode: 'down' | 'single' | 'up') => void
  /** A turn is running — destructive history actions are disabled. */
  busy: boolean
  /** Id of the message a fork is being created from, if any. */
  forkingId: string | null
}

export interface SpecAgentResponse {
  id: string
  content: string
  createdAt: number
}

export interface ProjectFileOpenRequest {
  projectId: string
  path: string
  kind: 'file' | 'directory'
}

export type StudioDocument = 'brainstorm' | 'spec' | 'assignment' | 'audit'

export interface ThreadStudioOpenRequest {
  projectId: string
  threadId: string
  document: StudioDocument
  auditReportId?: string
  auditReportVersion?: number
}

class WorkspaceState {
  /** Currently open thread, if any. */
  selectedThread: Thread | null = $state(null)
  /** Project that owns the selected thread (null for standalone chats). */
  activeProject: Project | null = $state(null)
  /** Resolved icon URL for the active project (custom image, SVG icon, or initials). */
  activeProjectIconUrl: string | null = $state(null)
  /** Thread stats for the active project, displayed in the header menu. */
  activeProjectThreadCount = $state(0)
  activeProjectWorkingThreadCount = $state(0)
  /** Signal used by AppHeader to ask Workspace to open the edit modal. */
  projectIdToEdit: string | null = $state(null)
  /** Globally ordered task visits, newest first, independent of project. */
  recentThreadVisits: string[] = $state(loadRecentThreadVisits())

  // ─── Terminal ──────────────────────────────────────────────────────────
  /** True only while a view that hosts a terminal panel is mounted. */
  terminalAvailable = $state(false)

  // ─── Spec studio (fed by ThreadView) ───────────────────────────────────
  /** True while the active thread runs in Engineering. */
  specStudioAvailable = $state(false)
  specStudioOpen = $state(false)
  specStudioBusy = $state(false)
  specStudioFormulating = $state(false)
  specStudioError = $state('')
  /** True when the header action is an eligible final-response retry. */
  specStudioRetryable = $state(false)
  specAgentSidebarOpen = $state(false)
  toggleSpecStudio: (() => void) | null = null
  /** Assistant responses shown in the sidebar while reviewing a specification. */
  specAgentResponses: SpecAgentResponse[] = $state([])
  pendingThreadStudioOpen: ThreadStudioOpenRequest | null = $state(null)

  // ─── Navigation (set by App.svelte) ────────────────────────────────────
  navigateToSettings: ((tab?: string) => void) | null = null
  navigateToContent: (() => void) | null = null
  /**
   * Opens a thread from a notification while preserving the current view:
   * regular project view stays, scope state stays, threads view stays, and
   * chat notifications switch to the chats view.  Registered by App.svelte.
   */
  openThreadFromNotification:
    ((thread: Thread, project: Project, temporaryChatId?: string) => Promise<void>) | null = null

  // ─── Sources (fed by ThreadView) ───────────────────────────────────────
  sources: AgentSource[] = $state([])
  sourceProcessCount = $state(0)
  private sourceProcessCountRequestId = 0

  async refreshSourceProcessCount(projectId: string, threadId: string): Promise<void> {
    const requestId = ++this.sourceProcessCountRequestId
    try {
      const processes = await invoke('agent:listProcesses', projectId, threadId)
      if (
        requestId === this.sourceProcessCountRequestId &&
        this.selectedThread?.projectId === projectId &&
        this.selectedThread.id === threadId
      ) {
        this.sourceProcessCount = processes.length
      }
    } catch {
      if (requestId === this.sourceProcessCountRequestId) this.sourceProcessCount = 0
    }
  }

  // ─── History (fed by ThreadView) ───────────────────────────────────────
  messageCount = $state(0)
  userMessages: JumpTarget[] = $state([])
  jumpToMessage: ((id: string) => void) | null = null
  loadUserMessageHistory: (() => Promise<void>) | null = null
  historyActions: HistoryMessageActions | null = $state(null)

  openThread(thread: Thread, project: Project | null, iconUrl?: string | null): void {
    const visitKey = threadVisitKey(thread)
    this.recentThreadVisits = [
      visitKey,
      ...this.recentThreadVisits.filter((candidate) => candidate !== visitKey)
    ].slice(0, RECENT_THREAD_VISITS_LIMIT)
    persistRecentThreadVisits(this.recentThreadVisits)
    this.selectedThread = thread
    this.activeProject = project
    this.activeProjectIconUrl = iconUrl ?? null
    this.sourceProcessCount = 0
    void this.refreshSourceProcessCount(thread.projectId, thread.id)
    contextSidebarState.activateThread(thread.projectId, thread.id, thread.title)
    rendererRecovery.setSelectedThread(thread.projectId, thread.id)
    // Opening a thread re-anchors the project's active scope (file manager,
    // terminal, and action roots follow the thread's scope bucket).
    scopeState.noteProjectBucket(thread.projectId, thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
    // Event-driven git refresh: every thread open (creation, switch, restore)
    // tells the git store the project is in use, so it can refresh status and
    // the connection-gated PR indicators without any polling.
    gitState.notifyThreadOpened(project, thread)
    // The moment a thread is opened its notifications are stale — drop them so
    // an error/completion that was already seen never lingers in the panel.
    notificationPanelState.dismissForThread(thread.projectId, thread.id)
  }

  /** The project's active scope bucket: the open thread's bucket when it belongs
   *  to that project, else the bucket last selected for it in the scope sidebar.
   *  Drives the file manager, terminal, and action roots so managed-worktree
   *  scopes never fall back to the main project directory. */
  activeScopeBucketIdFor(projectId: string): string {
    if (this.selectedThread?.projectId === projectId) {
      return this.selectedThread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    }
    return scopeState.lastBucketForProject(projectId)
  }

  openThreadStudio(
    thread: Thread,
    project: Project | null,
    document: StudioDocument,
    iconUrl?: string | null,
    auditTarget?: { reportId: string; version: number }
  ): void {
    this.pendingThreadStudioOpen = {
      projectId: thread.projectId,
      threadId: thread.id,
      document,
      ...(auditTarget
        ? { auditReportId: auditTarget.reportId, auditReportVersion: auditTarget.version }
        : {})
    }
    this.openThread(thread, project, iconUrl)
  }

  consumeThreadStudioOpen(projectId: string, threadId: string): ThreadStudioOpenRequest | null {
    const request = this.pendingThreadStudioOpen
    if (!request || request.projectId !== projectId || request.threadId !== threadId) return null
    this.pendingThreadStudioOpen = null
    return request
  }

  setActiveProjectIconUrl(url: string | null): void {
    this.activeProjectIconUrl = url
  }

  setActiveProjectStats(total: number, working: number): void {
    this.activeProjectThreadCount = total
    this.activeProjectWorkingThreadCount = working
  }

  openProjectEdit(projectId: string): void {
    this.projectIdToEdit = projectId
  }

  closeProjectEdit(): void {
    this.projectIdToEdit = null
  }

  /** Update the selected thread object in place (e.g. after a status change). */
  updateThread(thread: Thread): void {
    if (this.selectedThread?.id === thread.id) this.selectedThread = thread
  }

  // ─── Keyboard shortcut signals ──────────────────────────────────────────
  /** Incremented to signal Workspace to create a thread in the active project. */
  requestCreateThreadCount = $state(0)
  private consumedCreateThreadRequestCount = 0
  /** Scope bucket to create the next thread in (null = default scope). */
  pendingScopeBucketId: string | null = $state(null)
  /** Incremented to signal ThreadView to refocus its composer. */
  focusComposerCount = $state(0)

  requestFocusComposer(): void {
    this.focusComposerCount++
  }

  /** Incremented to focus the composer editor in place (no remount). */
  focusComposerEditorCount = $state(0)

  requestFocusComposerEditor(): void {
    this.focusComposerEditorCount++
  }

  requestCreateThread(scopeBucketId?: string): void {
    this.requestCreateThreadCount++
    this.pendingScopeBucketId = scopeBucketId ?? null
  }

  consumeCreateThreadRequest(): boolean {
    if (this.consumedCreateThreadRequestCount === this.requestCreateThreadCount) return false
    this.consumedCreateThreadRequestCount = this.requestCreateThreadCount
    return true
  }

  /** Incremented to signal Workspace to open a fresh standalone chat composer. */
  requestNewChatCount = $state(0)
  private consumedNewChatRequestCount = 0

  requestNewChat(): void {
    this.requestNewChatCount++
  }

  consumeNewChatRequest(): boolean {
    if (this.consumedNewChatRequestCount === this.requestNewChatCount) return false
    this.consumedNewChatRequestCount = this.requestNewChatCount
    return true
  }

  /** Cross-project file result that Workspace should reveal in its file sidebar. */
  pendingProjectFileOpen: ProjectFileOpenRequest | null = $state(null)
  requestProjectFileOpenCount = $state(0)
  private consumedProjectFileOpenCount = 0

  requestProjectFileOpen(projectId: string, path: string, kind: 'file' | 'directory'): void {
    this.pendingProjectFileOpen = { projectId, path, kind }
    this.requestProjectFileOpenCount++
  }

  consumeProjectFileOpenRequest(): ProjectFileOpenRequest | null {
    if (this.consumedProjectFileOpenCount === this.requestProjectFileOpenCount) return null
    this.consumedProjectFileOpenCount = this.requestProjectFileOpenCount
    return this.pendingProjectFileOpen
  }

  /** Incremented to signal Workspace that a thread was moved to a different project. */
  pendingMoveThreadId: string | null = $state(null)
  pendingMoveThread: Thread | null = $state(null)
  moveThreadCount = $state(0)

  requestMoveThread(oldThreadId: string, newThread: Thread): void {
    this.pendingMoveThreadId = oldThreadId
    this.pendingMoveThread = newThread
    this.moveThreadCount++
  }

  /** Incremented to signal ProjectCreateControl to open the add-project dialog. */
  requestAddProjectCount = $state(0)
  private consumedAddProjectRequestCount = 0

  requestAddProject(): void {
    this.requestAddProjectCount++
  }

  consumeAddProjectRequest(): boolean {
    if (this.consumedAddProjectRequestCount === this.requestAddProjectCount) return false
    this.consumedAddProjectRequestCount = this.requestAddProjectCount
    return true
  }

  /** Incremented to signal the app shell to open the getting-started tour. */
  requestOnboardingCount = $state(0)
  private consumedOnboardingRequestCount = 0

  requestOnboarding(): void {
    this.requestOnboardingCount++
  }

  consumeOnboardingRequest(): boolean {
    if (this.consumedOnboardingRequestCount === this.requestOnboardingCount) return false
    this.consumedOnboardingRequestCount = this.requestOnboardingCount
    return true
  }

  /** A project added externally (e.g. from Scope view) that Workspace needs to pick up. */
  pendingAddedProject: Project | null = $state(null)

  clearThread(): void {
    this.sourceProcessCountRequestId += 1
    this.selectedThread = null
    this.activeProject = null
    this.activeProjectIconUrl = null
    contextSidebarState.deactivateThread()
    this.sources = []
    this.sourceProcessCount = 0
    this.messageCount = 0
    this.userMessages = []
    this.jumpToMessage = null
    this.loadUserMessageHistory = null
    this.historyActions = null
    this.specStudioAvailable = false
    this.specStudioOpen = false
    this.pendingThreadStudioOpen = null
    this.specStudioBusy = false
    this.specStudioFormulating = false
    this.specStudioError = ''
    this.specStudioRetryable = false
    this.specAgentSidebarOpen = false
    this.toggleSpecStudio = null
    this.specAgentResponses = []
    rendererRecovery.clearSelectedThread()
  }
}

/**
 * Check whether a thread update would change its position in the sort/slice order.
 * Position-relevant fields: status, read, pinned, sortOrder, lastActivity (with 50ms tolerance).
 */
export function wouldThreadChangePosition(prev: Thread, next: Thread): boolean {
  if (prev.status !== next.status) return true
  if (prev.read !== next.read) return true
  if (prev.pinned !== next.pinned) return true
  if (prev.sortOrder !== next.sortOrder) return true
  if (prev.scopeBucketId !== next.scopeBucketId) return true
  if (Math.abs(prev.lastActivity - next.lastActivity) > 50) return true
  return false
}

export function threadSort(
  a: Thread,
  b: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  // Unsent drafts and the empty "New Thread" placeholder stay pinned at the top.
  const aDraft = draftThreadKeys?.has(threadVisitKey(a)) ?? false
  const bDraft = draftThreadKeys?.has(threadVisitKey(b)) ?? false
  if (aDraft !== bDraft) return aDraft ? -1 : 1
  if (a.status === 'created' && b.status !== 'created') return -1
  if (b.status === 'created' && a.status !== 'created') return 1
  // Order by the newer of the thread's last activity and its manual sort-order
  // anchor. Any new activity (a send, rename, status change, a working thread,
  // etc.) always pushes the thread to the top, because its lastActivity (epoch
  // time, always growing) outranks an older manual anchor. A manual drag sets a
  // newer timestamp so the thread holds its place — until something moves again,
  // at which point it can be dragged back above. Threads without an anchor just
  // fall back to last activity, so the default is pure recency ordering.
  const aKey = Math.max(a.sortOrder ?? 0, a.lastActivity)
  const bKey = Math.max(b.sortOrder ?? 0, b.lastActivity)
  if (aKey !== bKey) return bKey - aKey
  return a.id.localeCompare(b.id)
}

/**
 * Sort for pinned threads. Pin order is authoritative and shared across every
 * surface: newest-pinned first, with a manual drag-reorder (which rewrites
 * pinned_at) as the only override. Threads with unsent draft content float to
 * the top so they are never buried.
 */
export function pinnedThreadSort(
  a: Thread,
  b: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  const aDraft = draftThreadKeys?.has(threadVisitKey(a)) ?? false
  const bDraft = draftThreadKeys?.has(threadVisitKey(b)) ?? false
  if (aDraft !== bDraft) return aDraft ? -1 : 1
  const aAt = a.pinnedAt ?? -1
  const bAt = b.pinnedAt ?? -1
  if (aAt !== bAt) return bAt - aAt
  const activityDiff = b.lastActivity - a.lastActivity
  if (activityDiff !== 0) return activityDiff
  return a.id.localeCompare(b.id)
}

/** Sort modes for the Threads view. */
export type ThreadSortMode = 'default' | 'status' | 'time'

export function threadStatusSortKey(
  t: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  if (draftThreadKeys?.has(threadVisitKey(t))) return -1
  // Todo first, then unread, then spec-ready artifacts, then other attention, then done.
  if (t.status === 'created') return 0
  if (!t.read) return 1
  if (t.status === 'spec') return 2
  if (t.status !== 'completed') return 3
  return 4
}

/** Threads view sort grouped by attention status, most recent activity first within each group. */
export function threadStatusSort(
  a: Thread,
  b: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  const ka = threadStatusSortKey(a, draftThreadKeys)
  const kb = threadStatusSortKey(b, draftThreadKeys)
  if (ka !== kb) return ka - kb
  return b.lastActivity - a.lastActivity
}

/**
 * Find a thread that is still in 'created' status and has no draft content
 * in the given project + scope bucket. Returns undefined if none exists.
 */
export function findEmptyNewThread(
  threads: Thread[],
  projectId: string,
  scopeBucketId: string | undefined
): Thread | undefined {
  return threads.find((t) => {
    if (t.projectId !== projectId) return false
    if (t.status !== 'created') return false
    const thisBucket = t.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    const targetBucket = scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    if (thisBucket !== targetBucket) return false
    // A thread is only "empty" when it holds no draft, staged, or queued
    // content. A brand-new thread with a message scheduled behind other
    // threads (start-after) must not be reused as a blank New Thread — it
    // needs to stay put so the user can start a fresh one.
    if (rendererRecovery.hasDraftContent(projectId, t.id)) return false
    return true
  })
}

export const workspaceState = new WorkspaceState()
