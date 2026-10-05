import { invoke } from '$lib/ipc.svelte'
import { SvelteSet } from 'svelte/reactivity'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { threadStage, type ScopeSidebarContext, type ThreadStage } from './scope-board'
import {
  isOrchestrationChildThread,
  DEFAULT_SCOPE_BUCKET_ID,
  type ScopeBoard,
  type Thread
} from '$shared/types'

/**
 * Board and sidebar access the thread controller needs from the scope store.
 * The controller owns the in-memory thread list, hydration marks, and draft
 * staging; the store keeps the board cache and sidebar context.
 */
export interface ScopeThreadsHost {
  activeProjectId(): string | null
  draftThreadId(): string | null
  boardForProject(projectId: string): ScopeBoard | undefined
  boardForProjectOrActive(projectId: string): ScopeBoard
  ensureBoardLoaded(projectId: string): Promise<void>
  currentSidebarContext(): ScopeSidebarContext | null
  updateSidebarContext(context: ScopeSidebarContext): void
  persist(): void
}

/**
 * Whether two values describe the same thing.
 *
 * Scalars compare by value; objects and arrays compare structurally. A thread
 * snapshot that came back over IPC is a fresh object graph, so a nested object
 * or array is never the same reference as the copy already in memory: comparing
 * `settings`, `contextUsage` or `usedHarnessIds` by reference reported every
 * unchanged row as moved. Threads carry those three on nearly every row, so the
 * whole list was replaced on every fold and every consumer re-rendered for a
 * page that had not moved at all.
 */
function snapshotValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!snapshotValueEqual(a[index], b[index])) return false
    }
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!(key in right)) return false
    if (!snapshotValueEqual(left[key], right[key])) return false
  }
  return true
}

/**
 * Whether a thread snapshot describes the same row as the copy in memory.
 *
 * Used by the `thread:updated` guard in `updateThread` and by the page merge:
 * a broadcast or a page carrying a genuinely changed nested object must rebuild
 * the list anyway, so only a fully unchanged row is worth short-circuiting.
 */
function threadSnapshotEqual(a: Thread, b: Thread): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof Thread>
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!snapshotValueEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * Thread memory, hydration, and scope classification for the scope board.
 *
 * Owns `allScopeThreads`, the per-project hydration marks, the draft-staged
 * thread set, and the selected draft thread id. Board reads go through the
 * host so the store stays the single owner of the board cache.
 */
export class ScopeThreads {
  allScopeThreads: Thread[] = $state([])
  /** Threads holding unsent composer content. Draft state lives in renderer
   *  storage only, so it is applied here as an in-memory stage: drafted
   *  threads slice into 'todo' and return to their DB-derived slice (done)
   *  the moment the draft is cleared. */
  private draftStageThreadIds: SvelteSet<string> = $state(new SvelteSet())
  /** Projects whose full non-archived thread list has been merged into memory. */
  private fullyHydratedProjects: SvelteSet<string> = $state(new SvelteSet())
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private hydratingProjects = new Set<string>()

  constructor(private readonly host: ScopeThreadsHost) {}

  setDraftStageThreadIds(ids: readonly string[]): void {
    const next = new SvelteSet<string>(ids)
    const current = this.draftStageThreadIds
    if (next.size === current.size && [...next].every((id) => current.has(id))) return
    this.draftStageThreadIds = next
  }

  /** Whether a project's full thread list has been merged into `allScopeThreads`. */
  isProjectFullyHydrated(projectId: string): boolean {
    return this.fullyHydratedProjects.has(projectId)
  }

  /**
   * Merge a project's complete non-archived thread list into memory. The
   * first-paint hydration is a bounded per-project recent slice, so a read
   * thread older than that slice would never appear in scoped board views
   * (a scope shows exactly the threads of its bucket). Runs once per project;
   * on failure nothing is marked hydrated and the next open retries.
   */
  async ensureProjectThreadsLoaded(projectId: string): Promise<void> {
    if (projectId === '' || this.fullyHydratedProjects.has(projectId)) return
    if (this.hydratingProjects.has(projectId)) return
    this.hydratingProjects.add(projectId)
    try {
      const threads = await invoke('thread:list', projectId)
      for (const thread of threads) {
        if (thread.archived || isOrchestrationChildThread(thread)) continue
        if (this.allScopeThreads.some((existing) => existing.id === thread.id)) {
          this.updateThread(thread)
        } else {
          this.allScopeThreads = [...this.allScopeThreads, thread]
        }
      }
      this.fullyHydratedProjects.add(projectId)
    } catch {
      // Keep the bounded slice; the next open of this scope retries.
    } finally {
      this.hydratingProjects.delete(projectId)
    }
  }

  /** Whether a project's board holds any scope beyond the Default bucket. */
  private boardHasCustomScopes(board: ScopeBoard): boolean {
    return board.buckets.some((bucket) => bucket.id !== DEFAULT_SCOPE_BUCKET_ID)
  }

  /**
   * Hydrate a project's full thread list for its scope board. Custom scopes
   * must show every bucket thread even when the bounded first-paint recent
   * slice never included it (older threads never surface on their own), so
   * the board pulls the complete non-archived list from the database and
   * merges it per project. Projects whose board holds only the Default scope
   * skip hydration: the regular thread list and the recent slice already
   * cover them. Runs once per project; on failure the next board open retries.
   */
  async ensureScopeBoardThreadsLoaded(projectId: string): Promise<void> {
    if (projectId === '') return
    await this.host.ensureBoardLoaded(projectId)
    const board = this.host.boardForProject(projectId)
    if (!board || !this.boardHasCustomScopes(board)) return
    await this.ensureProjectThreadsLoaded(projectId)
  }

  get currentProjectThreads(): Thread[] {
    const activeProjectId = this.host.activeProjectId()
    if (!activeProjectId) return []
    // Orchestration children (Assignment workers and auditors) stay in
    // `allScopeThreads` so the Sr. Engineer row can aggregate their unread and
    // active-delegate state, but they are never listed as their own row on the
    // scoped sidebar or board. A `thread:updated` broadcast can introduce a
    // child that the bounded hydration slice excluded, so the predicate has to
    // sit on this read and not only on the ingestion paths.
    return this.allScopeThreads.filter(
      (thread) =>
        thread.projectId === activeProjectId &&
        !thread.archived &&
        !isOrchestrationChildThread(thread)
    )
  }

  setThreads(threads: Thread[]): void {
    // Projects already fully hydrated for the scope board must survive this
    // bounded re-seed: replacing the whole array would empty their custom
    // scopes even though `fullyHydratedProjects` still marks them complete.
    const hydrated = this.fullyHydratedProjects
    if (hydrated.size === 0) {
      this.allScopeThreads = threads
      return
    }
    const merged: Thread[] = []
    const seen = new SvelteSet<string>()
    for (const thread of this.allScopeThreads) {
      if (hydrated.has(thread.projectId) && !seen.has(thread.id)) {
        seen.add(thread.id)
        merged.push(thread)
      }
    }
    for (const thread of threads) {
      if (!seen.has(thread.id)) {
        seen.add(thread.id)
        merged.push(thread)
      }
    }
    this.allScopeThreads = merged
  }

  bucketForThread(thread: Thread): string {
    const bucketId = thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    // Resolve against the thread's OWN project board, not the active project's.
    // The regular thread list spans many projects; validating against the active
    // board would misclassify every non-active thread as default whenever its
    // bucket isn't on the active board. Fall back to the active board only when
    // the thread's project board hasn't been loaded yet.
    const board = this.host.boardForProjectOrActive(thread.projectId)
    return board.buckets.some((bucket) => bucket.id === bucketId)
      ? bucketId
      : DEFAULT_SCOPE_BUCKET_ID
  }

  threadsFor(bucketId: string, slice: ThreadStage): Thread[] {
    const threads = this.currentProjectThreads.filter(
      (thread) => this.bucketForThread(thread) === bucketId && this.stageForThread(thread) === slice
    )
    return threads.sort((a, b) => {
      // Pinned threads share one pin-time order across every surface; manual
      // reorder (pinned_at) is the only override. Other slices use scope order.
      if (slice === 'pinned') {
        const aAt = a.pinnedAt ?? -1
        const bAt = b.pinnedAt ?? -1
        if (aAt !== bAt) return bAt - aAt
      } else {
        const aPosition = a.scopeSortOrder ?? Number.MAX_SAFE_INTEGER
        const bPosition = b.scopeSortOrder ?? Number.MAX_SAFE_INTEGER
        if (aPosition !== bPosition) return aPosition - bPosition
      }
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity
      return a.id.localeCompare(b.id)
    })
  }

  async reorderThreads(
    bucketId: string,
    slice: ThreadStage,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const projectId = this.host.activeProjectId()
    if (!projectId || draggedId === targetId) return

    const orderedIds = this.threadsFor(bucketId, slice).map((thread) => thread.id)
    const draggedIndex = orderedIds.indexOf(draggedId)
    if (draggedIndex === -1) return
    orderedIds.splice(draggedIndex, 1)

    const targetIndex = orderedIds.indexOf(targetId)
    if (targetIndex === -1) return
    orderedIds.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, draggedId)

    const updatedThreads = await invoke(
      'thread:reorderScope',
      projectId,
      bucketId,
      slice,
      orderedIds
    )
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const updates = new Map(updatedThreads.map((thread) => [thread.id, thread]))
    this.allScopeThreads = this.allScopeThreads.map((thread) => updates.get(thread.id) ?? thread)
  }

  stageForThread(thread: Thread): ThreadStage {
    if (this.draftStageThreadIds.has(thread.id)) return 'todo'
    return threadStage(thread, this.host.draftThreadId())
  }

  threadsByStage(stage: ThreadStage): Thread[] {
    return this.currentProjectThreads.filter((thread) => this.stageForThread(thread) === stage)
  }

  updateThread(updated: Thread): void {
    // A browser tab's assistant conversation is a real thread in the reserved
    // hidden browser container. Every list is filtered at the repository
    // boundary, but a `thread:updated` broadcast is not a list: without this the
    // chat would appear as a phantom row in the thread timeline and the
    // switcher, pointing at a container the workspace never shows. The browser's
    // own rail owns that conversation instead.
    if (updated.projectId === GLOBAL_BROWSER_PROJECT_ID) return
    const index = this.allScopeThreads.findIndex((thread) => thread.id === updated.id)
    if (index === -1) {
      this.allScopeThreads = [updated, ...this.allScopeThreads]
    } else if (!threadSnapshotEqual(this.allScopeThreads[index], updated)) {
      // `thread:updated` broadcasts arrive on every agent status tick. Rebuilding
      // the whole list for a row whose fields did not change invalidates every
      // consumer (the header activity badges rescan the entire list), so compare
      // the incoming snapshot first and keep the existing array when it matches.
      const next = this.allScopeThreads.slice()
      next[index] = updated
      this.allScopeThreads = next
    }
    const context = this.host.currentSidebarContext()
    if (context?.threadId === updated.id) {
      this.host.updateSidebarContext({
        projectId: updated.projectId,
        bucketId: this.bucketForThread(updated),
        stage: this.stageForThread(updated),
        threadId: updated.id
      })
      this.host.persist()
    }
  }

  /**
   * Fold a list of thread snapshots into memory in one pass.
   *
   * {@link updateThread} has to find the row it replaces, so it costs a walk of
   * the whole list, and a caller that folds a hydration page row by row pays that
   * walk once per row: the Threads view's entry hydration folded two hundred rows
   * into a list of a few hundred that way, and on a deeply reactive array that
   * quadratic pass measured as a third of a second on every entry into the view.
   * A page is a list, so it merges as one: one walk, one new array, and no
   * reassignment at all when nothing moved.
   */
  mergeThreads(threads: readonly Thread[]): void {
    if (threads.length === 0) return
    // A scratch index for this one pass: it is never read reactively, and making
    // it a SvelteMap would put a signal behind every lookup in the loop this
    // method exists to make cheap.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const incoming = new Map<string, Thread>()
    for (const thread of threads) {
      // A browser tab's assistant conversation is a real thread in the reserved
      // hidden browser container; see {@link updateThread} for why it never
      // enters this list. An archived row is excluded from the listing by design,
      // so a page must not be able to put one in either.
      if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID || thread.archived) continue
      incoming.set(thread.id, thread)
    }
    if (incoming.size === 0) return

    const next: Thread[] = []
    let changed = 0
    for (const thread of this.allScopeThreads) {
      const replacement = incoming.get(thread.id)
      if (replacement === undefined) {
        next.push(thread)
        continue
      }
      incoming.delete(thread.id)
      if (threadSnapshotEqual(thread, replacement)) {
        next.push(thread)
      } else {
        next.push(replacement)
        changed += 1
      }
    }
    // A row the list did not hold yet takes the head, matching `updateThread`,
    // so nothing re-sorts.
    const additions = [...incoming.values()]
    changed += additions.length
    if (changed === 0) return
    this.allScopeThreads = additions.length === 0 ? next : [...additions, ...next]
    // The remembered sidebar context carries the row's own fields, so a page
    // that moved it has to hand the fresh copy back   once, not once per row.
    const context = this.host.currentSidebarContext()
    if (context) {
      const updated = this.allScopeThreads.find((thread) => thread.id === context.threadId)
      if (updated) {
        this.host.updateSidebarContext({
          projectId: updated.projectId,
          bucketId: this.bucketForThread(updated),
          stage: this.stageForThread(updated),
          threadId: updated.id
        })
        this.host.persist()
      }
    }
  }

  removeThread(threadId: string): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const removedIds = new Set(
      this.allScopeThreads
        .filter((thread) => thread.id === threadId || thread.coordinatorThreadId === threadId)
        .map((thread) => thread.id)
    )
    this.allScopeThreads = this.allScopeThreads.filter((thread) => !removedIds.has(thread.id))
  }
}
