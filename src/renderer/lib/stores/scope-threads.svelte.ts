import { invoke } from '$lib/ipc.svelte'
import { SvelteSet } from 'svelte/reactivity'
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
    return this.allScopeThreads.filter(
      (thread) => thread.projectId === activeProjectId && !thread.archived
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
    const exists = this.allScopeThreads.some((thread) => thread.id === updated.id)
    this.allScopeThreads = exists
      ? this.allScopeThreads.map((thread) => (thread.id === updated.id ? updated : thread))
      : [updated, ...this.allScopeThreads]
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
