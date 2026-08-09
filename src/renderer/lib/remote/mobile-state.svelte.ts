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
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import {
  coordinatorHasActiveDelegates,
  INBOX_PROJECT_ID,
  isOrchestrationChildThread,
  type Project,
  type Thread
} from '$shared/types'

export type MobileSidebarMode = 'projects' | 'threads' | 'chats'

/** Status-based sort key mirroring the desktop sidebar ordering. */
function threadSortKey(thread: Thread): number {
  if (thread.status === 'created') return 0
  if (
    thread.status === 'planning' ||
    thread.status === 'executing' ||
    thread.status === 'awaiting_approval' ||
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
  const aOrder = a.sortOrder ?? -1
  const bOrder = b.sortOrder ?? -1
  if (aOrder !== bOrder) return aOrder - bOrder
  return b.lastActivity - a.lastActivity
}

export interface MobileJumpTarget {
  id: string
  content: string
  nonce: number
}

class MobileState {
  projects = $state<Project[]>([])
  allThreads = $state<Thread[]>([])
  orchestrationThreads = $state<Thread[]>([])
  loading = $state(true)

  selectedThread = $state<Thread | null>(null)
  selectedProject = $state<Project | null>(null)

  sidebarMode = $state<MobileSidebarMode>('projects')
  sidebarOpen = $state(false)

  notificationsOpen = $state(false)
  memoryOpen = $state(false)
  historyOpen = $state(false)
  gitOpen = $state(false)
  settingsOpen = $state(false)
  installGuideOpen = $state(false)

  projectIcons = new SvelteMap<string, string>()
  expandedFolders = new SvelteSet<string>()

  /** The message the history sheet asked the transcript to scroll to. */
  jumpTarget = $state<MobileJumpTarget | null>(null)

  /** Mobile-owned attention counter — bumped when a thread update pushes an
   *  awaiting-approval or unread thread into the list. No desktop stores. */
  attentionCount = $state(0)

  // ─── Derived lists (same grouping as the desktop sidebar) ───────────────

  visibleProjects = $derived(
    this.projects
      .filter((project) => !project.hidden)
      .sort((a, b) => (a.sortOrder ?? -1) - (b.sortOrder ?? -1))
  )

  pinnedThreads = $derived(
    this.allThreads
      .filter((t) => t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort(mobileThreadSort)
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

  async loadData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listAll')
      ])
      this.projects = projectList
      this.allThreads = (threadList as Thread[]).filter((t) => !isOrchestrationChildThread(t))
      this.orchestrationThreads = (threadList as Thread[]).filter(isOrchestrationChildThread)
      this.refreshAttention()
      this.projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(this.projects)) {
        this.projectIcons.set(projectId, iconUrl)
      }
    } catch {
      this.projects = []
      this.allThreads = []
      this.orchestrationThreads = []
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

  async openThread(thread: Thread): Promise<void> {
    const project = this.projects.find((p) => p.id === thread.projectId) ?? null
    this.selectedThread = thread
    this.selectedProject = project
    this.sidebarOpen = false
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    this.applyThreadUpdate(updated)
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
    this.refreshAttention()
    if (this.selectedThread?.id === thread.id) {
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
    this.allThreads = this.allThreads.map((t) => (t.id === updated.id ? updated : t))
    this.refreshAttention()
    if (this.selectedThread?.id === updated.id) {
      this.selectedThread = updated
      if (!updated.read) {
        void invoke('thread:markRead', updated.projectId, updated.id).catch(() => undefined)
      }
    }
  }

  isWorking(thread: Thread): boolean {
    return (
      thread.status === 'planning' ||
      thread.status === 'executing' ||
      coordinatorHasActiveDelegates(thread, this.orchestrationThreads)
    )
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
  return subscribe('thread:updated', (...args: unknown[]) => {
    const updated = args[0] as Thread
    if (updated) mobileState.applyThreadUpdate(updated)
  })
}
