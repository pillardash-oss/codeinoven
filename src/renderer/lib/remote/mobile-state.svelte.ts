/**
 * Minimal mobile client state.
 *
 * The phone PWA reuses the desktop conversation stores for message streaming,
 * but it must NOT drag the desktop workspace graph (workspace/scope/provider/
 * renderer-recovery stores, notification/memory stores, sidebar and modal
 * components) into its closure. This store is the mobile replacement: it holds
 * the selected thread and project, the thread/project lists, the sidebar mode,
 * the optional sheet flags, project icons, expanded folders, and the thread
 * actions. It talks to the desktop only through the typed IPC contract, and
 * keeps its own minimal attention counter instead of importing the desktop
 * notification/memory stores.
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { loadProjectIcons } from '$lib/project-icons'
import { hasProjectNameCollision } from '$lib/project-location'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { chatEffectiveSettings, threadSettings } from '$lib/stores/thread-settings.svelte'
import {
  coordinatorHasActiveDelegates,
  DEFAULT_THREAD_TITLE,
  INBOX_PROJECT_ID,
  isOrchestrationChildThread,
  isThreadWorking,
  type Project,
  type Thread
} from '$shared/types'

export type MobileSidebarMode = 'projects' | 'threads' | 'chats'

/** Status-based sort key mirroring the desktop sidebar ordering. */
function threadSortKey(thread: Thread): number {
  // The empty "New Thread" placeholder stays pinned at the top until first use.
  if (thread.status === 'created') return 0
  if (
    thread.status === 'planning' ||
    thread.status === 'executing' ||
    thread.status === 'working-paused' ||
    thread.status === 'awaiting_approval' ||
    thread.status === 'spec' ||
    thread.status === 'failed' ||
    thread.status === 'interrupted'
  ) {
    return 1
  }
  if (!thread.read) return 1
  return 2
}

/** Sort threads exactly like the desktop sidebar: status, order, then recency. */
export function mobileThreadSort(a: Thread, b: Thread): number {
  const keyDiff = threadSortKey(a) - threadSortKey(b)
  if (keyDiff !== 0) return keyDiff
  // Order by last modified time; manual reorder only breaks exact ties.
  const activityDiff = b.lastActivity - a.lastActivity
  if (activityDiff !== 0) return activityDiff
  const aOrder = a.sortOrder ?? -1
  const bOrder = b.sortOrder ?? -1
  if (aOrder !== bOrder) return aOrder - bOrder
  return a.id.localeCompare(b.id)
}

/** Pinned threads share one pin-time order across every surface: newest-pinned first. */
function mobilePinnedThreadSort(a: Thread, b: Thread): number {
  const aAt = a.pinnedAt ?? -1
  const bAt = b.pinnedAt ?? -1
  if (aAt !== bAt) return bAt - aAt
  const activityDiff = b.lastActivity - a.lastActivity
  if (activityDiff !== 0) return activityDiff
  return a.id.localeCompare(b.id)
}

export interface MobileJumpTarget {
  id: string
  content: string
  nonce: number
}

/**
 * A desktop starts the thread before it prepares a replacement harness session.
 * Check a few progressively wider gaps so an older desktop that does not push
 * the new binding can still hand the PWA the stream without continuous polling.
 */
const SESSION_BINDING_REFRESH_DELAYS_MS = [75, 250, 750, 2_000, 5_000]

class MobileState {
  projects = $state<Project[]>([])
  allThreads = $state<Thread[]>([])
  orchestrationThreads = $state<Thread[]>([])
  loading = $state(true)
  loadError = $state<string | null>(null)

  selectedThread = $state<Thread | null>(null)
  selectedProject = $state<Project | null>(null)

  sidebarMode = $state<MobileSidebarMode>('projects')
  sidebarOpen = $state(false)

  notificationsOpen = $state(false)
  memoryOpen = $state(false)
  historyOpen = $state(false)
  gitOpen = $state(false)
  sourcesOpen = $state(false)
  notesOpen = $state(false)
  usageOpen = $state(false)
  settingsOpen = $state(false)
  installGuideOpen = $state(false)

  /** The open temporary (explain/quick) chat tab, and whether its sheet shows.
   *  The id survives closing the sheet so the header overflow menu can reopen
   *  the conversation; switching threads discards it. */
  temporaryChatTabId = $state<string | null>(null)
  temporaryChatOpen = $state(false)

  openTemporaryChatTab(tabId: string): void {
    this.temporaryChatTabId = tabId
    this.temporaryChatOpen = true
  }

  projectIcons = new SvelteMap<string, string>()
  expandedFolders = new SvelteSet<string>()

  /** The message the history sheet asked the transcript to scroll to. */
  jumpTarget = $state<MobileJumpTarget | null>(null)

  /** Mobile-owned attention counter — bumped when a thread update pushes an
   *  awaiting-approval or unread thread into the list. No desktop stores. */
  attentionCount = $state(0)

  private sessionBindingRefreshGeneration = 0
  private sessionBindingRefreshTimer: ReturnType<typeof setTimeout> | null = null

  // ─── Derived lists (same grouping as the desktop sidebar) ───────────────

  visibleProjects = $derived(
    this.projects
      .filter((project) => !project.hidden)
      .sort((a, b) => (a.sortOrder ?? -1) - (b.sortOrder ?? -1))
  )

  pinnedThreads = $derived(
    this.allThreads
      .filter((t) => t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort(mobilePinnedThreadSort)
  )

  threadsByProject = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const thread of this.allThreads) {
      if (thread.archived || thread.pinned) continue
      const list = map.get(thread.projectId) ?? []
      list.push(thread)
      map.set(thread.projectId, list)
    }
    for (const list of map.values()) list.sort(mobileThreadSort)
    return map
  })

  flatThreads = $derived(
    this.allThreads
      .filter((t) => !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort(mobileThreadSort)
  )

  chatThreads = $derived(
    this.allThreads
      .filter((t) => !t.archived && t.projectId === INBOX_PROJECT_ID)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return mobileThreadSort(a, b)
      })
  )

  chatMode = $derived(this.selectedThread?.projectId === INBOX_PROJECT_ID)

  /** One dot on the overflow trigger so nothing important hides behind it. */
  hasOverflowAttention = $derived(this.attentionCount > 0)

  /** User-authored messages in the selected thread, for the history sheet. */
  userMessages = $derived(
    this.selectedThread
      ? threadMessages
          .messages(this.selectedThread.projectId, this.selectedThread.id)
          .filter((message) => message.role === 'user')
          .map((message) => {
            const text = message.parts
              .filter(
                (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
              )
              .map((part) => part.text)
              .join('\n')
            return { id: message.id, content: text || '(attachment)' }
          })
      : []
  )

  // ─── Data loading ───────────────────────────────────────────────────────

  async loadData(options: { background?: boolean } = {}): Promise<void> {
    const { background = false } = options
    // Keep the already-rendered list visible on a background refresh so a
    // slight reconnect never flashes the whole sidebar to "Loading…". The
    // full-screen loading state is reserved for the first paint, when there is
    // nothing to show yet.
    const hasData = this.projects.length > 0 || this.allThreads.length > 0
    if (!background || !hasData) this.loading = true
    this.loadError = null
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listAll')
      ])
      this.projects = projectList
      this.allThreads = (threadList as Thread[]).filter((t) => !isOrchestrationChildThread(t))
      this.orchestrationThreads = (threadList as Thread[]).filter(isOrchestrationChildThread)
      for (const thread of this.allThreads) {
        if (agentRuns.hasSettled(thread.projectId, thread.id) && !isThreadWorking(thread)) {
          agentRuns.setIdle(thread.projectId, thread.id)
        }
      }
      this.refreshAttention()
      this.projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(this.projects)) {
        this.projectIcons.set(projectId, iconUrl)
      }
    } catch (error) {
      // A background refresh must not discard data the phone already shows —
      // keep the last-known list and surface the failure only on first paint.
      if (!background || !hasData) {
        this.projects = []
        this.allThreads = []
        this.orchestrationThreads = []
      }
      this.loadError =
        error instanceof Error ? error.message : 'The desktop workspace could not be loaded.'
    } finally {
      this.loading = false
    }
  }

  /** Recompute the mobile-owned attention count from the thread list. */
  refreshAttention(): void {
    this.attentionCount = this.allThreads.filter(
      (t) =>
        (t.status === 'awaiting_approval' || t.status === 'failed') &&
        !t.read &&
        !isOrchestrationChildThread(t)
    ).length
  }

  // ─── Thread + folder actions ────────────────────────────────────────────

  private bindThreadSession(thread: Thread): void {
    if (!thread.sessionId) return
    threadMessages.setSessionId(thread.projectId, thread.id, thread.sessionId)
  }

  private cancelSessionBindingRefresh(): void {
    this.sessionBindingRefreshGeneration += 1
    if (this.sessionBindingRefreshTimer !== null) {
      clearTimeout(this.sessionBindingRefreshTimer)
      this.sessionBindingRefreshTimer = null
    }
  }

  /**
   * Older desktops publish the working status before creating a replacement
   * harness session, then omit the binding update. Reconcile only the visible
   * active thread, with a bounded backoff, and hydrate once if its id changes so
   * any stream fragments sent during the small discovery window are recovered.
   */
  private refreshPreparingSession(thread: Thread): void {
    this.cancelSessionBindingRefresh()
    const generation = this.sessionBindingRefreshGeneration
    const expectedSessionId = thread.sessionId
    let retryIndex = 0

    const scheduleNext = (): void => {
      const delay = SESSION_BINDING_REFRESH_DELAYS_MS[retryIndex]
      if (delay === undefined || generation !== this.sessionBindingRefreshGeneration) return
      retryIndex += 1
      this.sessionBindingRefreshTimer = setTimeout(() => {
        this.sessionBindingRefreshTimer = null
        void refresh()
      }, delay)
    }

    const refresh = async (): Promise<void> => {
      const selected = this.selectedThread
      if (
        generation !== this.sessionBindingRefreshGeneration ||
        selected?.projectId !== thread.projectId ||
        selected.id !== thread.id ||
        !isThreadWorking(selected)
      ) {
        return
      }

      try {
        const latest = await invoke('thread:get', thread.projectId, thread.id)
        if (generation !== this.sessionBindingRefreshGeneration) return
        if (latest?.sessionId && latest.sessionId !== expectedSessionId) {
          this.allThreads = this.allThreads.map((candidate) =>
            candidate.projectId === latest.projectId && candidate.id === latest.id
              ? latest
              : candidate
          )
          this.selectedThread = latest
          this.bindThreadSession(latest)
          await threadMessages.load(latest.projectId, latest.id)
          return
        }
      } catch {
        // A later bounded attempt can recover a transient bridge failure.
      }
      scheduleNext()
    }

    scheduleNext()
  }

  async openThread(thread: Thread): Promise<void> {
    const project = this.projects.find((p) => p.id === thread.projectId) ?? null
    this.cancelSessionBindingRefresh()
    this.selectedThread = thread
    this.selectedProject = project
    this.bindThreadSession(thread)
    if (isThreadWorking(thread) && !thread.sessionId) this.refreshPreparingSession(thread)
    this.sidebarOpen = false
    this.temporaryChatTabId = null
    this.temporaryChatOpen = false
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    this.applyThreadUpdate(updated)
    // The notification store is intentionally loaded lazily on the phone; a
    // thread that was opened no longer needs its panel notifications.
    void import('$lib/stores/notification-panel.svelte').then(({ notificationPanelState }) => {
      notificationPanelState.dismissForThread(thread.projectId, thread.id)
    })
  }

  async openThreadById(projectId: string, threadId: string): Promise<void> {
    const thread = this.allThreads.find(
      (t) => t.id === threadId && t.projectId === projectId && !t.archived
    )
    if (thread) {
      await this.openThread(thread)
      return
    }
    await this.loadData()
    const reloaded = this.allThreads.find((t) => t.id === threadId && t.projectId === projectId)
    if (reloaded) await this.openThread(reloaded)
  }

  async handleRename(thread: Thread, newName: string): Promise<void> {
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: newName,
      titleSource: 'manual'
    })
    this.applyThreadUpdate(updated)
  }

  async togglePin(thread: Thread): Promise<void> {
    const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    this.applyThreadUpdate(updated)
  }

  async handleDelete(thread: Thread): Promise<void> {
    await invoke('thread:delete', thread.projectId, thread.id)
    this.allThreads = this.allThreads.filter((t) => t.id !== thread.id)
    this.orchestrationThreads = this.orchestrationThreads.filter(
      (candidate) => candidate.id !== thread.id && candidate.coordinatorThreadId !== thread.id
    )
    this.refreshAttention()
    if (this.selectedThread?.id === thread.id) {
      this.cancelSessionBindingRefresh()
      this.selectedThread = null
      this.selectedProject = null
    }
  }

  async forkThread(thread: Thread): Promise<void> {
    const forked = await invoke(
      'thread:fork',
      thread.projectId,
      thread.id,
      `${thread.title} (fork)`
    )
    this.allThreads = [forked, ...this.allThreads]
    await this.openThread(forked)
  }

  async createProjectThread(project: Project): Promise<void> {
    const inherited =
      this.selectedThread?.projectId === project.id && this.selectedThread.settings
        ? this.selectedThread.settings
        : threadSettings.lastUsed
    const created = await invoke('thread:create', {
      projectId: project.id,
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: inherited
    })
    this.allThreads = [created, ...this.allThreads.filter((thread) => thread.id !== created.id)]
    this.expandedFolders.add(project.id)
    await this.openThread(created)
  }

  async createChat(): Promise<void> {
    const inbox = await invoke('project:ensureInbox')
    if (!this.projects.some((project) => project.id === inbox.id)) {
      this.projects = [...this.projects, inbox]
    }
    const created = await invoke('thread:create', {
      projectId: inbox.id,
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: '',
      settings: chatEffectiveSettings()
    })
    this.allThreads = [created, ...this.allThreads.filter((thread) => thread.id !== created.id)]
    await this.openThread(created)
  }

  toggleFolder(projectId: string): void {
    if (this.expandedFolders.has(projectId)) this.expandedFolders.delete(projectId)
    else this.expandedFolders.add(projectId)
  }

  /** Scroll the transcript to a past user message. */
  historyJump(messageId: string, content: string): void {
    this.historyOpen = false
    this.jumpTarget = { id: messageId, content, nonce: Date.now() }
  }

  /** Apply a pushed thread update to the list and the selection. */
  applyThreadUpdate(updated: Thread): void {
    if (isOrchestrationChildThread(updated)) {
      const exists = this.orchestrationThreads.some((thread) => thread.id === updated.id)
      this.orchestrationThreads = exists
        ? this.orchestrationThreads.map((thread) => (thread.id === updated.id ? updated : thread))
        : [updated, ...this.orchestrationThreads]
      return
    }
    const exists = this.allThreads.some((thread) => thread.id === updated.id)
    this.allThreads = exists
      ? this.allThreads.map((thread) => (thread.id === updated.id ? updated : thread))
      : [updated, ...this.allThreads]
    this.refreshAttention()
    if (agentRuns.hasSettled(updated.projectId, updated.id) && !isThreadWorking(updated)) {
      agentRuns.setIdle(updated.projectId, updated.id)
    }
    if (
      this.selectedThread?.projectId === updated.projectId &&
      this.selectedThread.id === updated.id
    ) {
      const startedWorking = !isThreadWorking(this.selectedThread) && isThreadWorking(updated)
      this.selectedThread = updated
      this.bindThreadSession(updated)
      if (startedWorking) this.refreshPreparingSession(updated)
      else if (!isThreadWorking(updated)) this.cancelSessionBindingRefresh()
      if (!updated.read) {
        void invoke('thread:markRead', updated.projectId, updated.id).catch(() => undefined)
      }
    }
  }

  applyThreadDeletion(threadId: string): void {
    this.allThreads = this.allThreads.filter((thread) => thread.id !== threadId)
    this.orchestrationThreads = this.orchestrationThreads.filter(
      (thread) => thread.id !== threadId && thread.coordinatorThreadId !== threadId
    )
    if (this.selectedThread?.id === threadId) {
      this.cancelSessionBindingRefresh()
      this.selectedThread = null
    }
    this.refreshAttention()
  }

  isWorking(thread: Thread): boolean {
    const liveWorking = agentRuns.hasSettled(thread.projectId, thread.id)
      ? agentRuns.isBusy(thread.projectId, thread.id)
      : Boolean(thread.sessionId) && isThreadWorking(thread)
    return liveWorking || coordinatorHasActiveDelegates(thread, this.orchestrationThreads)
  }

  /** Reconcile state that may have changed while the mobile browser was frozen. */
  async reconcileAfterReconnect(): Promise<void> {
    const selected = this.selectedThread
      ? { projectId: this.selectedThread.projectId, threadId: this.selectedThread.id }
      : null
    // Background-hydrate: keep the visible thread list mounted so a quick
    // bounce of the socket never flashes the whole sidebar to "Loading…".
    await this.loadData({ background: true })
    if (!selected) return
    const refreshed = this.allThreads.find(
      (thread) => thread.projectId === selected.projectId && thread.id === selected.threadId
    )
    this.selectedProject =
      this.projects.find((project) => project.id === selected.projectId) ?? this.selectedProject
    if (refreshed) {
      this.selectedThread = refreshed
      this.bindThreadSession(refreshed)
      if (isThreadWorking(refreshed) && !refreshed.sessionId) {
        this.refreshPreparingSession(refreshed)
      }
    }
    const status = await invoke(
      'agent:getSessionStatus',
      selected.projectId,
      selected.threadId
    ).catch(() => null)
    if (status?.state === 'working' || status?.state === 'waiting') {
      agentRuns.setBusy(
        selected.projectId,
        selected.threadId,
        true,
        undefined,
        status.state === 'working' ? status.startedAt : undefined
      )
      threadMessages.setRunIssue(selected.projectId, selected.threadId, null)
    } else {
      agentRuns.setIdle(selected.projectId, selected.threadId)
      if (status?.state === 'error') {
        threadMessages.setRunIssue(selected.projectId, selected.threadId, status.issue)
      }
    }
    await threadMessages.load(selected.projectId, selected.threadId)
  }
}

export const mobileState = new MobileState()

/** Whether two project names collide — used to show locations on folder rows. */
export function mobileHasProjectNameCollision(
  project: Pick<Project, 'name'>,
  projects: readonly Pick<Project, 'name'>[]
): boolean {
  return hasProjectNameCollision(project, projects)
}

/** Live thread updates pushed from the desktop keep the mobile lists fresh. */
export function subscribeMobileThreadUpdates(): () => void {
  const unsubscribeUpdated = subscribe('thread:updated', (...args: unknown[]) => {
    const updated = args[0] as Thread
    if (updated) mobileState.applyThreadUpdate(updated)
  })
  const unsubscribeDeleted = subscribe('thread:deleted', (_projectId, threadId) => {
    mobileState.applyThreadDeletion(threadId)
  })
  return () => {
    unsubscribeUpdated()
    unsubscribeDeleted()
  }
}
