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
}

export interface SpecAgentResponse {
  id: string
  content: string
  createdAt: number
}

export interface ProjectFileOpenRequest {
  projectId: string
  path: string
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
  openThreadFromNotification: ((thread: Thread, project: Project) => Promise<void>) | null = null

  // ─── Sources (fed by ThreadView) ───────────────────────────────────────
  sources: AgentSource[] = $state([])

  // ─── History (fed by ThreadView) ───────────────────────────────────────
  messageCount = $state(0)
  userMessages: JumpTarget[] = $state([])
  jumpToMessage: ((id: string) => void) | null = null

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
    contextSidebarState.activateThread(thread.projectId, thread.id)
    rendererRecovery.setSelectedThread(thread.projectId, thread.id)
    // The moment a thread is opened its notifications are stale — drop them so
    // an error/completion that was already seen never lingers in the panel.
    notificationPanelState.dismissForThread(thread.projectId, thread.id)
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

  requestProjectFileOpen(projectId: string, path: string): void {
    this.pendingProjectFileOpen = { projectId, path }
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

  /** A project added externally (e.g. from Scope view) that Workspace needs to pick up. */
  pendingAddedProject: Project | null = $state(null)

  clearThread(): void {
    const closingThread = this.selectedThread
    if (closingThread) {
      void invoke('agent:killThreadProcesses', closingThread.projectId, closingThread.id).catch(
        () => undefined
      )
    }
    this.selectedThread = null
    this.activeProject = null
    this.activeProjectIconUrl = null
    contextSidebarState.deactivateThread()
    this.sources = []
    this.messageCount = 0
    this.userMessages = []
    this.jumpToMessage = null
    this.specStudioAvailable = false
    this.specStudioOpen = false
    this.pendingThreadStudioOpen = null
    this.specStudioBusy = false
    this.specStudioFormulating = false
    this.specStudioError = ''
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

export function threadSortKey(t: Thread, draftThreadKeys?: ReadonlySet<string> | null): number {
  if (draftThreadKeys?.has(threadVisitKey(t))) return -1
  // The empty "New Thread" placeholder stays pinned at the top until first use.
  if (t.status === 'created') return 0
  if (
    t.status === 'planning' ||
    t.status === 'executing' ||
    t.status === 'awaiting_approval' ||
    t.status === 'failed' ||
    t.status === 'interrupted'
  )
    return 1
  if (!t.read) return 1
  return 2
}

export function threadSort(
  a: Thread,
  b: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  const ka = threadSortKey(a, draftThreadKeys)
  const kb = threadSortKey(b, draftThreadKeys)
  if (ka !== kb) return ka - kb
  // Order by last modified time. A manual drag-reorder (sortOrder) only breaks
  // exact lastActivity ties — it must never pin a thread out of recency order.
  const activityDiff = b.lastActivity - a.lastActivity
  if (activityDiff !== 0) return activityDiff
  const aOrder = a.sortOrder ?? -1
  const bOrder = b.sortOrder ?? -1
  if (aOrder !== bOrder) return aOrder - bOrder
  return a.id.localeCompare(b.id)
}

/** Sort modes for the Threads view. */
export type ThreadSortMode = 'default' | 'status' | 'time'

export function threadStatusSortKey(
  t: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): number {
  if (draftThreadKeys?.has(threadVisitKey(t))) return -1
  // Todo first, then unread, then anything that still needs attention, then done.
  if (t.status === 'created') return 0
  if (!t.read) return 1
  if (t.status !== 'completed') return 2
  return 3
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
    const draft = rendererRecovery.draftFor(projectId, t.id)
    if (draft.length > 0) return false
    const attachments = rendererRecovery.attachmentsFor(projectId, t.id)
    if (attachments.length > 0) return false
    const refs = rendererRecovery.projectReferencesFor(projectId, t.id)
    if (refs.length > 0) return false
    return true
  })
}

export const workspaceState = new WorkspaceState()
