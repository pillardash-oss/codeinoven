import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { INBOX_PROJECT_ID, isOrchestrationChildThread, type Project } from '$shared/types'
import type { ThreadSearchResult } from '$shared/types'

/**
 * Owns the sidebar's list presentation state: which project folders are
 * expanded, how many rows each list shows, and the per-project / global thread
 * search machines, so `Workspace.svelte` and the sidebar components only read
 * and call into one object.
 */
export class WorkspaceSidebarController {
  /** Rows shown per group before the "Show more" affordance grows the budget. */
  readonly threadsPerPage = 5

  // Built-in Set/Map are not reactive in runes mode   mutations must go through SvelteSet/SvelteMap.
  expandedFolders = new SvelteSet<string>()

  private readonly threadShowCount = new SvelteMap<string, number>()

  // Per-project thread search (activation + query)
  readonly projectSearchOpen = new SvelteSet<string>()
  readonly projectSearchQueries = new SvelteMap<string, string>()
  readonly projectSearchResults = new SvelteMap<string, ThreadSearchResult[]>()
  readonly projectSearching = new SvelteSet<string>()
  private readonly projectSearchTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>()
  private readonly projectSearchRequestIds = new SvelteMap<string, number>()
  private projectSearchBootstrap = false

  // Threads-view global search (activation + query), mirroring the per-project
  // search above: the popover only hosts the input, results render in the sidebar
  // and stay put until the search is explicitly dismissed (Escape / re-click / X).
  threadsSearchOpen = $state(false)
  threadsSearchQuery = $state('')
  threadsSearchResults = $state<ThreadSearchResult[]>([])
  threadsSearching = $state(false)
  private threadsSearchTimer: ReturnType<typeof setTimeout> | undefined
  private threadsSearchRequestId = 0

  /** Initialise expandedFolders: start with all projects expanded, then fold
   *  any the user has previously collapsed. */
  initExpandedFolders(visible: Project[]): void {
    this.expandedFolders.clear()
    for (const p of visible) this.expandedFolders.add(p.id)
    for (const id of rendererRecovery.collapsedFolders) this.expandedFolders.delete(id)
  }

  getVisibleCount(groupId: string, pageSize: number = this.threadsPerPage): number {
    return this.threadShowCount.get(groupId) ?? pageSize
  }

  showMoreThreads(groupId: string, total: number, pageSize: number = this.threadsPerPage): void {
    const current = this.threadShowCount.get(groupId) ?? pageSize
    this.threadShowCount.set(groupId, Math.min(current + pageSize, total))
  }

  showLessThreads(groupId: string, pageSize: number = this.threadsPerPage): void {
    this.threadShowCount.set(groupId, pageSize)
  }

  /** Raise a group's row budget so a specific row number renders. */
  ensureRowVisible(groupId: string, needed: number, pageSize: number = this.threadsPerPage): void {
    const current = this.threadShowCount.get(groupId) ?? pageSize
    if (needed > current) this.threadShowCount.set(groupId, needed)
  }

  /** Grow a group's row budget by freshly fetched rows, capped at the real total. */
  extendVisibleCount(
    groupId: string,
    extra: number,
    cap: number,
    pageSize: number = this.threadsPerPage
  ): void {
    const current = this.threadShowCount.get(groupId) ?? pageSize
    this.threadShowCount.set(groupId, Math.min(current + extra, cap))
  }

  clearProjectSearch(projectId: string): void {
    this.projectSearchOpen.delete(projectId)
    this.projectSearchQueries.delete(projectId)
    this.projectSearchResults.delete(projectId)
    this.projectSearching.delete(projectId)
    const timer = this.projectSearchTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.projectSearchTimers.delete(projectId)
  }

  openProjectSearch(projectId: string): void {
    this.projectSearchOpen.add(projectId)
    // Keep the folder expanded so search results stay visible in the sidebar.
    this.expandedFolders.add(projectId)
    if (!this.projectSearchBootstrap) {
      this.projectSearchBootstrap = true
      setTimeout(() => {
        this.projectSearchBootstrap = false
        for (const projectId of this.projectSearchOpen) {
          this.runProjectSearch(projectId, this.projectSearchQueries.get(projectId) ?? '')
        }
      }, 0)
    }
  }

  closeProjectSearch(projectId: string): void {
    this.clearProjectSearch(projectId)
  }

  /** Dismiss every open sidebar search   the composer took the user's focus. */
  closeAllSearches(): void {
    if (this.threadsSearchOpen) this.closeThreadsSearch()
    for (const projectId of [...this.projectSearchOpen]) this.closeProjectSearch(projectId)
  }

  runProjectSearch(projectId: string, raw: string): void {
    const safeQuery = raw.trim()
    const timer = this.projectSearchTimers.get(projectId)
    if (timer) clearTimeout(timer)
    const requestId = (this.projectSearchRequestIds.get(projectId) ?? 0) + 1
    this.projectSearchRequestIds.set(projectId, requestId)
    if (!safeQuery) {
      this.projectSearchResults.delete(projectId)
      this.projectSearching.delete(projectId)
      return
    }
    this.projectSearching.add(projectId)
    this.projectSearchTimers.set(
      projectId,
      setTimeout(() => {
        void invoke('threads:search', safeQuery, { projectId, limit: 50 })
          .then((results) => {
            if (this.projectSearchRequestIds.get(projectId) !== requestId) return
            this.projectSearchResults.set(
              projectId,
              results.filter((r) => !isOrchestrationChildThread(r.thread))
            )
            this.projectSearching.delete(projectId)
          })
          .catch(() => {
            if (this.projectSearchRequestIds.get(projectId) !== requestId) return
            this.projectSearchResults.delete(projectId)
            this.projectSearching.delete(projectId)
          })
      }, 120)
    )
  }

  openThreadsSearch(): void {
    this.threadsSearchOpen = true
    if (this.threadsSearchQuery.trim()) this.runThreadsSearch(this.threadsSearchQuery)
  }

  closeThreadsSearch(): void {
    this.threadsSearchOpen = false
    this.threadsSearchQuery = ''
    this.threadsSearchResults = []
    this.threadsSearching = false
    this.threadsSearchRequestId++
    if (this.threadsSearchTimer) clearTimeout(this.threadsSearchTimer)
    this.threadsSearchTimer = undefined
  }

  runThreadsSearch(raw: string): void {
    this.threadsSearchQuery = raw
    const safeQuery = raw.trim()
    if (this.threadsSearchTimer) clearTimeout(this.threadsSearchTimer)
    const requestId = ++this.threadsSearchRequestId
    if (!safeQuery) {
      this.threadsSearchResults = []
      this.threadsSearching = false
      return
    }
    this.threadsSearching = true
    this.threadsSearchTimer = setTimeout(() => {
      void invoke('threads:search', safeQuery, { limit: 50 })
        .then((results) => {
          if (requestId !== this.threadsSearchRequestId) return
          this.threadsSearchResults = results.filter(
            (r) =>
              !isOrchestrationChildThread(r.thread) &&
              r.thread.projectId !== INBOX_PROJECT_ID &&
              !r.thread.archived
          )
          this.threadsSearching = false
        })
        .catch(() => {
          if (requestId !== this.threadsSearchRequestId) return
          this.threadsSearchResults = []
          this.threadsSearching = false
        })
    }, 120)
  }
}
