import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { RowPageBudget } from '$lib/components/shared/RowPageBudget.svelte'
import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
import { isOrchestrationChildThread, type Project, type Thread } from '$shared/types'
import type { ThreadSearchResult } from '$shared/types'
import { mergeThreadSearchBatches, isProjectFamilyThread } from './workspace-thread-helpers'

/** Result cap for one search - the same cap a single unfiltered query uses. */
const THREADS_SEARCH_LIMIT = 50
/**
 * Widest project filter that still fans out one query per project. Past this the
 * filter covers most projects anyway, so one family-wide query is cheaper than
 * two dozen IPC round trips through the serialized worker connection.
 */
const MAX_FILTERED_FANOUT = 12

/**
 * Owns the sidebar's list presentation state: which project folders are
 * expanded, how many rows each list shows, and the per-project / global thread
 * search machines, so `Workspace.svelte` and the sidebar components only read
 * and call into one object.
 */
export class WorkspaceSidebarController {
  /** Rows shown per group before the "Show more" affordance grows the budget.
   *  A project folder shows a short head; the thread-family lists (the timeline,
   *  chats, assistant tasks) page at the shared `THREAD_LIST_PAGE_SIZE` instead,
   *  passed explicitly at each call site. */
  readonly threadsPerPage = 5

  // Built-in Set/Map are not reactive in runes mode   mutations must go through SvelteSet/SvelteMap.
  expandedFolders = new SvelteSet<string>()

  /** The one paging budget the sidebar's lists draw from; see `RowPageBudget`. */
  private readonly rowBudget = new RowPageBudget(this.threadsPerPage)

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
  /**
   * Whether the sidebar list is showing search results rather than the timeline
   * the reader was already on.
   *
   * It turns on when a search first settles, not when a key is pressed. The
   * panel replaces the list, so turning it on with the query emptied the sidebar
   * for as long as the search took to answer - and left it empty for good when
   * the answer never came. It goes off again when the query is cleared or the
   * search is dismissed, which puts the timeline back.
   */
  threadsSearchShowingResults = $state(false)
  private threadsSearchTimer: ReturnType<typeof setTimeout> | undefined
  private threadsSearchRequestId = 0
  /** Project-filter selection the live threads search was run under, so a filter
   *  change re-runs that search instead of leaving stale results on screen. */
  private threadsSearchFilterKey = threadProjectFilterState.selectedIds.join(',')

  /** Initialise expandedFolders: start with all projects expanded, then fold
   *  any the user has previously collapsed. */
  initExpandedFolders(visible: Project[]): void {
    this.expandedFolders.clear()
    for (const p of visible) this.expandedFolders.add(p.id)
    for (const id of rendererRecovery.collapsedFolders) this.expandedFolders.delete(id)
  }

  getVisibleCount(groupId: string, pageSize: number = this.threadsPerPage): number {
    return this.rowBudget.visibleCount(groupId, pageSize)
  }

  showMoreThreads(groupId: string, total: number, pageSize: number = this.threadsPerPage): void {
    this.rowBudget.showMore(groupId, total, pageSize)
  }

  showLessThreads(groupId: string, pageSize: number = this.threadsPerPage): void {
    this.rowBudget.showLess(groupId, pageSize)
  }

  /** Raise a group's row budget so a specific row number renders. */
  ensureRowVisible(groupId: string, needed: number, pageSize: number = this.threadsPerPage): void {
    this.rowBudget.ensureVisible(groupId, needed, pageSize)
  }

  /**
   * Rows a project folder renders: the budgeted head slice, plus the active
   * thread appended last when it sits beyond the budget. The active row is
   * artificial   it leaves the list the moment selection moves elsewhere,
   * so the collapsed budget always keeps the thread the user is on in focus
   * without growing the list to its natural position.
   */
  visibleThreads(
    groupId: string,
    threads: readonly Thread[],
    activeThreadId: string | null,
    pageSize: number = this.threadsPerPage
  ): Thread[] {
    return this.rowBudget.visibleRows(groupId, threads, activeThreadId, pageSize)
  }

  /** Rows still hidden behind "Show more", excluding the artificial active row. */
  hiddenThreadCount(
    groupId: string,
    threads: readonly Thread[],
    visible: readonly Thread[],
    pageSize: number = this.threadsPerPage
  ): number {
    void groupId
    void pageSize
    return this.rowBudget.hiddenCount(threads, visible)
  }

  /** Grow a group's row budget by freshly fetched rows, capped at the real total. */
  extendVisibleCount(
    groupId: string,
    extra: number,
    cap: number,
    pageSize: number = this.threadsPerPage
  ): void {
    this.rowBudget.extend(groupId, extra, cap, pageSize)
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
    this.threadsSearchShowingResults = false
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
      this.threadsSearchShowingResults = false
      this.threadsSearching = false
      return
    }
    // The list keeps whatever it is showing until the answer lands: the panel
    // swaps on the first result set, never on the keystroke that asked for it.
    this.threadsSearching = true
    this.threadsSearchTimer = setTimeout(() => {
      void this.searchThreadsView(safeQuery)
        .then((results) => {
          if (requestId !== this.threadsSearchRequestId) return
          this.threadsSearchResults = results
          this.threadsSearchShowingResults = true
          this.threadsSearching = false
        })
        .catch((error: unknown) => {
          if (requestId !== this.threadsSearchRequestId) return
          this.threadsSearchResults = []
          this.threadsSearching = false
          // The list keeps whatever it was showing: a search that failed found
          // nothing out, so it must not read as "no matching threads".
          logRendererError('Thread search failed', error)
        })
    }, 120)
  }

  /**
   * Re-run an open threads search when the project filter changes.
   *
   * The Threads view is the project threads timeline, so its search obeys that
   * view's own scope: the project family (never the chats, assistant or browser
   * containers) narrowed to the projects the filter is set to. A filter change
   * is a scope change, so results already on screen are re-queried rather than
   * left over from the previous selection. Keyed on the selection so keystrokes
   * and unrelated re-renders never trigger an extra search.
   */
  syncThreadsSearchFilter(): void {
    const selection = threadProjectFilterState.selectedIds
    const key = [...selection].join(',')
    if (key === this.threadsSearchFilterKey) return
    this.threadsSearchFilterKey = key
    if (!this.threadsSearchOpen || !this.threadsSearchQuery.trim()) return
    this.runThreadsSearch(this.threadsSearchQuery)
  }

  /**
   * One search for the Threads view. With a project filter on, every selected
   * project is asked separately so its matches cannot be crowded out of a single
   * cross-project result cap; with no filter (or a filter spanning most
   * projects) one family-wide query answers. Either way the answer is narrowed to
   * the family that view lists: project threads, live, never an orchestration
   * child. Which of those projects the view then shows is the view's own filter,
   * applied where its rows render.
   */
  private async searchThreadsView(query: string): Promise<ThreadSearchResult[]> {
    const selection = threadProjectFilterState.selectedIds
    const fanOut =
      !threadProjectFilterState.isAll &&
      selection.length > 0 &&
      selection.length <= MAX_FILTERED_FANOUT
        ? [...selection]
        : []
    const batches =
      fanOut.length > 0
        ? await Promise.all(
            fanOut.map((projectId) =>
              invoke('threads:search', query, {
                family: 'projects',
                projectId,
                limit: THREADS_SEARCH_LIMIT
              }).catch((): ThreadSearchResult[] => [])
            )
          )
        : [
            await invoke('threads:search', query, {
              family: 'projects',
              limit: THREADS_SEARCH_LIMIT
            })
          ]
    return mergeThreadSearchBatches(batches, THREADS_SEARCH_LIMIT).filter((result) =>
      this.threadsSearchIncludes(result)
    )
  }

  /** Whether one search result belongs to the family the Threads view lists. */
  private threadsSearchIncludes(result: ThreadSearchResult): boolean {
    const thread = result.thread
    return (
      !thread.archived &&
      !isOrchestrationChildThread(thread) &&
      isProjectFamilyThread(thread.projectId)
    )
  }
}
