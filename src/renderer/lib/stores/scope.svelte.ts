import { SvelteMap } from 'svelte/reactivity'
import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { getProjectIcon } from '$lib/project-icons'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  isOrchestrationChildThread,
  type AdoptableWorktreeInfo,
  type ManagedWorktreeDescriptor,
  type Project,
  type ScopeBoard,
  type ScopeBoardChangedEvent,
  type ScopeBucket,
  type ScopeLifecycleAction,
  type ScopeLifecyclePreflight,
  type ScopeMergeMode,
  type ScopeMergeOutcome,
  type ScopeMergePreflight,
  type ScopeTarget,
  type ScopeWorktreeCreateInput,
  type ScopeWorktreeDefaults,
  type ScopeWorktreeHealth,
  type ScopeWorktreeSourceInfo,
  type Thread
} from '$shared/types'
import {
  cloneBoard,
  EMPTY_BOARD,
  loadScopeSnapshot,
  orderedBuckets,
  persistScopeSnapshot,
  type ProjectBadge,
  type ScopeBucketEdit,
  type ScopeProject,
  type ScopeSidebarContext,
  type ThreadStage
} from './scope-board'
import { ScopeThreads } from './scope-threads.svelte'
import { ScopeWorktrees } from './scope-worktrees.svelte'

export type {
  ProjectBadge,
  ScopeBucketEdit,
  ScopeProject,
  ScopeSidebarContext,
  ThreadStage
} from './scope-board'
export {
  clearScopeSnapshot,
  STAGE_COLORS,
  STAGE_LABELS,
  STAGE_ORDER,
  STATUS_TONE_COLORS,
  threadStage
} from './scope-board'

class ScopeState {
  projectRecords: Project[] = $state([])
  projects: ScopeProject[] = $state([])
  activeProjectId: string | null = $state(loadScopeSnapshot().activeProjectId)
  board: ScopeBoard = $state(cloneBoard(EMPTY_BOARD))
  boards: Map<string, ScopeBoard> = $state(new SvelteMap())
  sidebarContext: ScopeSidebarContext | null = $state(loadScopeSnapshot().sidebarContext)
  /**
   * Saved scope context for when the user navigates away from the project view
   * (e.g. to chats) and comes back.  Cleared whenever the sidebar is explicitly
   * dismissed.
   */
  stashedSidebarContext: ScopeSidebarContext | null = $state(null)
  /** Thread that was active in the project scope before the user switched away. */
  stashedProjectThreadId: string | null = $state(null)
  /** Thread that was active in the chat view before the user switched away. */
  stashedChatThreadId: string | null = $state(null)
  lastBucketByProject: Map<string, string> = $state(new SvelteMap())
  loading = $state(false)
  saving = $state(false)
  error: string | null = $state(null)
  draftThreadId: string | null = $state(null)
  /** Signal for ScopeView to create a thread in a specific bucket (triggered by Cmd+N). */
  requestCreateScopedThreadCount = $state(0)
  pendingCreateBucketId: string | null = $state(null)
  private loadSequence = 0
  private saveSequence = 0

  private threads = new ScopeThreads({
    activeProjectId: () => this.activeProjectId,
    draftThreadId: () => this.draftThreadId,
    boardForProject: (projectId) => this.boards.get(projectId),
    boardForProjectOrActive: (projectId) => this.boards.get(projectId) ?? this.board,
    ensureBoardLoaded: (projectId) => this.ensureBoardLoaded(projectId),
    currentSidebarContext: () => this.sidebarContext,
    updateSidebarContext: (context) => {
      this.sidebarContext = context
    },
    persist: () => this.persistSnapshot()
  })

  private worktrees = new ScopeWorktrees({
    bucketFor: (projectId, bucketId) => this.bucketFor(projectId, bucketId),
    boardForProject: (projectId) => this.boards.get(projectId),
    applyBoard: (projectId, board) => this.applyBoard(projectId, board),
    reloadBoard: (projectId) => this.reloadBoard(projectId),
    setError: (message) => {
      this.error = message
    }
  })

  /** Live thread list shared across every scope surface. */
  get allScopeThreads(): Thread[] {
    return this.threads.allScopeThreads
  }

  set allScopeThreads(value: Thread[]) {
    this.threads.allScopeThreads = value
  }

  /** Target-keyed health of managed worktrees, refreshed on demand. */
  get healthByTarget(): Map<string, ScopeWorktreeHealth> {
    return this.worktrees.healthByTarget
  }

  set healthByTarget(value: Map<string, ScopeWorktreeHealth>) {
    this.worktrees.healthByTarget = value
  }

  setDraftStageThreadIds(ids: readonly string[]): void {
    this.threads.setDraftStageThreadIds(ids)
  }

  /** Whether a project's full thread list has been merged into `allScopeThreads`. */
  isProjectFullyHydrated(projectId: string): boolean {
    return this.threads.isProjectFullyHydrated(projectId)
  }

  /**
   * Merge a project's complete non-archived thread list into memory. The
   * first-paint hydration is a bounded per-project recent slice, so a read
   * thread older than that slice would never appear in scoped board views
   * (a scope shows exactly the threads of its bucket). Runs once per project;
   * on failure nothing is marked hydrated and the next open retries.
   */
  async ensureProjectThreadsLoaded(projectId: string): Promise<void> {
    await this.threads.ensureProjectThreadsLoaded(projectId)
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
    await this.threads.ensureScopeBoardThreadsLoaded(projectId)
  }

  get projectBadges(): SvelteMap<string, ProjectBadge> {
    const badges = new SvelteMap<string, ProjectBadge>()
    for (const project of this.projects) {
      const projectThreads = this.threads.allScopeThreads.filter(
        (t) => t.projectId === project.id && !t.archived
      )
      const userThreads = projectThreads.filter((t) => !isOrchestrationChildThread(t))
      badges.set(project.id, {
        hasWorking: projectThreads.some((t) => t.status === 'planning' || t.status === 'executing'),
        hasUnread: userThreads.some((t) => t.status === 'completed' && !t.read),
        hasAttention: userThreads.some((t) => t.status === 'awaiting_approval' && !t.read),
        hasError: userThreads.some((t) => t.status === 'failed')
      })
    }
    return badges
  }

  get buckets(): ScopeBucket[] {
    return orderedBuckets(this.board)
  }

  get currentProjectThreads(): Thread[] {
    return this.threads.currentProjectThreads
  }

  setScopesFromProjects(
    projects: Project[],
    icons: Map<string, string>,
    activeProjectId?: string | null
  ): void {
    this.projectRecords = projects.filter((project) => !project.hidden)
    this.projects = this.projectRecords.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      source: project.source,
      host: project.host,
      iconUrl: getProjectIcon(project, icons.get(project.id)),
      color: project.color
    }))

    const preferredId =
      activeProjectId && this.projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : this.activeProjectId &&
            this.projects.some((project) => project.id === this.activeProjectId)
          ? this.activeProjectId
          : (this.projects[0]?.id ?? null)

    if (preferredId !== this.activeProjectId) {
      this.activeProjectId = preferredId
      this.board = cloneBoard(EMPTY_BOARD)
      persistScopeSnapshot({
        activeProjectId: this.activeProjectId,
        sidebarContext: this.sidebarContext
      })
    }
  }

  setThreads(threads: Thread[]): void {
    this.threads.setThreads(threads)
  }

  setSelectedThreadDraftState(threadId: string | null, hasDraft: boolean): void {
    this.draftThreadId = hasDraft ? threadId : null
  }

  async activateProject(id: string): Promise<void> {
    if (id === this.activeProjectId) {
      const loadedBoard = this.boards.get(id)
      if (loadedBoard) {
        this.board = loadedBoard
        void this.ensureScopeBoardThreadsLoaded(id)
        return
      }
      await this.loadBoard(id)
      return
    }
    this.activeProjectId = id
    this.board = this.boards.get(id) ?? cloneBoard(EMPTY_BOARD)
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
    await this.loadBoard(id)
    void this.ensureScopeBoardThreadsLoaded(id)
  }

  activateScope(id: string): void {
    void this.activateProject(id)
  }

  bucketFor(projectId: string, bucketId: string): ScopeBucket | null {
    const board = this.boards.get(projectId)
    if (!board) return null
    return board.buckets.find((b) => b.id === bucketId) ?? null
  }

  async ensureBoardLoaded(projectId: string): Promise<void> {
    if (this.boards.has(projectId)) return
    await this.loadBoard(projectId)
  }

  /** Whether a project's scope board is already cached for read-only lookups. */
  hasBoard(projectId: string): boolean {
    return this.boards.has(projectId)
  }

  /**
   * Cache one project's scope board for a read-only lookup (the cross-project
   * thread search resolves a thread's scope badge from it) without touching the
   * active board, the shared loading flag, or the visible error. Safe to call
   * concurrently for different projects: each call owns its own cache entry.
   */
  async cacheBoardForLookup(projectId: string): Promise<void> {
    if (this.boards.has(projectId)) return
    try {
      const board = await invoke('scope:get', projectId)
      this.boards.set(projectId, cloneBoard(board))
    } catch {
      // Lookup-only warm-up: a failure here must never surface as a scope error.
    }
  }

  async loadBoard(projectId = this.activeProjectId): Promise<void> {
    if (!projectId) {
      this.board = cloneBoard(EMPTY_BOARD)
      return
    }

    const sequence = ++this.loadSequence
    this.loading = true
    this.error = null
    try {
      const board = await invoke('scope:get', projectId)
      if (sequence === this.loadSequence) {
        const cloned = cloneBoard(board)
        this.boards.set(projectId, cloned)
        if (projectId === this.activeProjectId) {
          this.board = cloned
        }
      }
    } catch (error) {
      if (sequence === this.loadSequence) {
        this.error = error instanceof Error ? error.message : 'The scope board could not be loaded.'
      }
    } finally {
      if (sequence === this.loadSequence) this.loading = false
    }
  }

  /**
   * Apply a main-owned board mutation. The renderer never sends whole boards;
   * each call maps to one validated lifecycle operation on the main side.
   */
  private async mutate<T extends ScopeBoard>(run: (projectId: string) => Promise<T>): Promise<T> {
    const projectId = this.activeProjectId
    if (!projectId) throw new Error('No active project')

    const previous = cloneBoard(this.board)
    const sequence = ++this.saveSequence
    this.saving = true
    this.error = null
    try {
      const saved = await run(projectId)
      if (sequence === this.saveSequence && projectId === this.activeProjectId) {
        const cloned = cloneBoard(saved)
        this.board = cloned
        this.boards.set(projectId, cloned)
      }
      return saved
    } catch (error) {
      if (sequence === this.saveSequence) {
        this.board = previous
        this.boards.set(projectId, previous)
        this.error = error instanceof Error ? error.message : 'The scope board could not be saved.'
      }
      throw error
    } finally {
      if (sequence === this.saveSequence) this.saving = false
    }
  }

  async updateLayout(orderedIds: string[]): Promise<void> {
    await this.mutate((projectId) => invoke('scope:updateLayout', projectId, orderedIds))
  }

  async createBucket(name: string): Promise<ScopeBucket | null> {
    const trimmedName = name.trim()
    if (!trimmedName) return null

    const projectId = this.activeProjectId
    if (!projectId) throw new Error('No active project')

    const previous = cloneBoard(this.board)
    const sequence = ++this.saveSequence
    this.saving = true
    this.error = null
    try {
      const result = await invoke('scope:create', projectId, { name: trimmedName })
      const cloned = cloneBoard(result.board)
      if (sequence === this.saveSequence && projectId === this.activeProjectId) {
        this.board = cloned
        this.boards.set(projectId, cloned)
      }
      return cloned.buckets.find((bucket) => bucket.id === result.bucket.id) ?? result.bucket
    } catch (error) {
      if (sequence === this.saveSequence) {
        this.board = previous
        this.boards.set(projectId, previous)
        this.error = error instanceof Error ? error.message : 'The scope board could not be saved.'
      }
      throw error
    } finally {
      if (sequence === this.saveSequence) this.saving = false
    }
  }

  /** Create a scope bucket on a specific project's board (used when the
   *  targeted project is not the active one, e.g. the change-scope modal). */
  async createBucketForProject(projectId: string, name: string): Promise<ScopeBucket | null> {
    const trimmedName = name.trim()
    if (!trimmedName) return null

    await this.ensureBoardLoaded(projectId)
    const result = await invoke('scope:create', projectId, { name: trimmedName })
    const cloned = cloneBoard(result.board)
    this.boards.set(projectId, cloned)
    if (projectId === this.activeProjectId) {
      this.board = cloned
    }
    return cloned.buckets.find((candidate) => candidate.id === result.bucket.id) ?? result.bucket
  }

  async editBucket(bucketId: string, edit: ScopeBucketEdit): Promise<void> {
    const trimmedName = edit.name.trim()
    if (!trimmedName) return
    await this.mutate((projectId) =>
      invoke('scope:updateAppearance', projectId, bucketId, {
        name: trimmedName,
        ...(edit.color ? { color: edit.color } : { color: null }),
        ...(edit.iconType ? { iconType: edit.iconType } : { iconType: null })
      })
    )
  }

  async reorderBucket(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    if (draggedId === targetId || this.saving) return
    const buckets = [...this.buckets]
    const draggedIndex = buckets.findIndex((bucket) => bucket.id === draggedId)
    if (draggedIndex === -1) return
    const [dragged] = buckets.splice(draggedIndex, 1)
    const targetIndex = buckets.findIndex((bucket) => bucket.id === targetId)
    if (targetIndex === -1) return
    buckets.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, dragged)
    await this.updateLayout(buckets.map((bucket) => bucket.id))
  }

  async removeBucket(bucketId: string): Promise<void> {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) return
    await this.mutate((projectId) => invoke('scope:delete', projectId, bucketId))
  }

  async toggleBucket(bucketId: string): Promise<void> {
    await this.mutate((projectId) =>
      invoke('scope:updateCollapse', projectId, bucketId, {
        collapsed: !this.buckets.find((bucket) => bucket.id === bucketId)?.collapsed
      })
    )
  }

  async toggleSlice(bucketId: string, slice: ThreadStage): Promise<void> {
    const current = this.buckets.find((bucket) => bucket.id === bucketId)
    const collapsedSlices = current?.collapsedSlices.includes(slice)
      ? current.collapsedSlices.filter((candidate) => candidate !== slice)
      : [...(current?.collapsedSlices ?? []), slice]
    await this.mutate((projectId) =>
      invoke('scope:updateCollapse', projectId, bucketId, { collapsedSlices })
    )
  }

  bucketForThread(thread: Thread): string {
    return this.threads.bucketForThread(thread)
  }

  threadsFor(bucketId: string, slice: ThreadStage): Thread[] {
    return this.threads.threadsFor(bucketId, slice)
  }

  async reorderThreads(
    bucketId: string,
    slice: ThreadStage,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    await this.threads.reorderThreads(bucketId, slice, draggedId, targetId, position)
  }

  stageForThread(thread: Thread): ThreadStage {
    return this.threads.stageForThread(thread)
  }

  threadsByStage(stage: ThreadStage): Thread[] {
    return this.threads.threadsByStage(stage)
  }

  showSidebarForThread(thread: Thread, bucketId?: string): void {
    if (thread.projectId !== this.activeProjectId) {
      void this.activateProject(thread.projectId)
    }
    void this.threads.ensureProjectThreadsLoaded(thread.projectId)
    this.sidebarContext = {
      projectId: thread.projectId,
      bucketId: bucketId ?? thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID,
      stage: this.threads.stageForThread(thread),
      threadId: thread.id
    }
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  showSidebarForProject(projectId: string): void {
    if (projectId !== this.activeProjectId) {
      void this.activateProject(projectId)
    }
    void this.threads.ensureProjectThreadsLoaded(projectId)
    this.sidebarContext = {
      projectId,
      bucketId: this.lastBucketForProject(projectId),
      stage: 'todo',
      threadId: ''
    }
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  /** Dock to a scope from the scope board: open the scoped-threads sidebar for
   *  the active project with that bucket current and no thread focused, so the
   *  conversation screen shows its empty state until the user opens a thread. */
  dockScope(bucketId: string): void {
    const projectId = this.activeProjectId
    if (!projectId) return
    void this.threads.ensureProjectThreadsLoaded(projectId)
    this.sidebarContext = {
      projectId,
      bucketId,
      stage: 'todo',
      threadId: ''
    }
    this.lastBucketByProject.set(projectId, bucketId)
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  selectSidebarStage(stage: ThreadStage): void {
    if (!this.sidebarContext) return
    this.sidebarContext = { ...this.sidebarContext, stage }
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  setSidebarBucket(bucketId: string): void {
    if (!this.sidebarContext) return
    this.sidebarContext = { ...this.sidebarContext, bucketId }
    if (this.activeProjectId) this.lastBucketByProject.set(this.activeProjectId, bucketId)
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  /** Record the bucket that became active for a project (e.g. a thread opened
   *  inside it) so scope-driven surfaces can follow without a sidebar click. */
  noteProjectBucket(projectId: string, bucketId: string): void {
    this.lastBucketByProject.set(projectId, bucketId)
  }

  lastBucketForProject(projectId: string): string {
    const saved = this.lastBucketByProject.get(projectId)
    if (saved) return saved
    const board = this.boards.get(projectId)
    if (board && board.buckets.length > 0) return orderedBuckets(board)[0].id
    return DEFAULT_SCOPE_BUCKET_ID
  }

  requestCreateScopedThread(bucketId: string): void {
    this.pendingCreateBucketId = bucketId
    this.requestCreateScopedThreadCount++
  }

  /** Save the current sidebar context so it can be restored later (e.g. when
   *  the user switches to chats and comes back).  Also clears the live context
   *  so the sidebar disappears immediately. */
  stashSidebarContext(): void {
    if (!this.sidebarContext) return
    this.stashedSidebarContext = { ...this.sidebarContext }
    this.sidebarContext = null
    persistScopeSnapshot({ activeProjectId: this.activeProjectId, sidebarContext: null })
  }

  /** Restore a previously-stashed sidebar context.  No-op if nothing stashed. */
  restoreStashedSidebarContext(): void {
    if (!this.stashedSidebarContext) return
    this.sidebarContext = this.stashedSidebarContext
    this.stashedSidebarContext = null
    if (this.sidebarContext.projectId !== this.activeProjectId) {
      void this.activateProject(this.sidebarContext.projectId)
    }
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  clearSidebarContext(): void {
    this.sidebarContext = null
    this.stashedSidebarContext = null
    this.stashedProjectThreadId = null
    persistScopeSnapshot({ activeProjectId: this.activeProjectId, sidebarContext: null })
  }

  updateThread(updated: Thread): void {
    this.threads.updateThread(updated)
  }

  removeThread(threadId: string): void {
    this.threads.removeThread(threadId)
  }

  // ─── Managed worktree lifecycle ─────────────────────────────────────────

  /** Create a managed worktree for an existing scope bucket. */
  createWorktree(
    projectId: string,
    bucketId: string,
    input: ScopeWorktreeCreateInput
  ): Promise<ManagedWorktreeDescriptor | null> {
    return this.worktrees.createWorktree(projectId, bucketId, input)
  }

  /** Inspect the source checkout before creating a worktree. */
  worktreeSourceInfo(projectId: string): Promise<ScopeWorktreeSourceInfo> {
    return this.worktrees.worktreeSourceInfo(projectId)
  }

  /** Read the typed health of a managed scope worktree. */
  worktreeHealth(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    return this.worktrees.worktreeHealth(target)
  }

  /** Repair an unhealthy managed scope and refresh its cached health. */
  repairWorktree(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    return this.worktrees.repairWorktree(target)
  }

  /** Preview whether an existing Git worktree checkout can be adopted. */
  detectAdoptableWorktree(projectId: string, sourcePath: string): Promise<AdoptableWorktreeInfo> {
    return this.worktrees.detectAdoptableWorktree(projectId, sourcePath)
  }

  /** Adopt an existing raw Git worktree as a managed scope root. */
  adoptWorktree(
    projectId: string,
    bucketId: string,
    input: { sourcePath: string; runSetup: boolean }
  ): Promise<ManagedWorktreeDescriptor | null> {
    return this.worktrees.adoptWorktree(projectId, bucketId, input)
  }

  /** Cached typed health of one scope (undefined until it has been refreshed). */
  healthFor(bucketId: string, projectId?: string | null): ScopeWorktreeHealth | undefined {
    return this.worktrees.healthFor(bucketId, projectId ?? this.activeProjectId)
  }

  /**
   * Refresh managed-worktree health for a board in the background. Deduped by
   * board signature, so reactive callers (the scope board and the scoped-threads
   * sidebar) can call it on every update while the health they render stays fresh.
   * Targets whose scope no longer exists are dropped, so a stale verdict can
   * never outlive its scope.
   */
  syncBoardWorktreeHealth(
    projectId: string | null | undefined,
    buckets: readonly ScopeBucket[] | undefined
  ): void {
    this.worktrees.syncBoardWorktreeHealth(projectId, buckets)
  }

  /**
   * Re-read one managed scope's health when its cached verdict is older than the
   * throttle window. Detection stays passive (nothing polls the filesystem), but
   * every surface that has a reason to touch a scope (board switch, scoped
   * sidebar, Git panel, scope actions menu, a failed operation) calls this, so a
   * checkout that changed on disk is re-detected at the moment it matters.
   */
  revalidateWorktreeHealth(
    projectId: string,
    bucketId: string,
    options?: { force?: boolean }
  ): Promise<ScopeWorktreeHealth | undefined> {
    return this.worktrees.revalidateWorktreeHealth(projectId, bucketId, options)
  }

  /** Revalidate every managed scope of a board in the background. */
  revalidateBoardWorktreeHealth(
    projectId: string | null | undefined,
    buckets: readonly ScopeBucket[] | undefined
  ): void {
    this.worktrees.revalidateBoardWorktreeHealth(projectId, buckets)
  }

  /** Refresh the cached health of every managed bucket on the active board. */
  async refreshWorktreeHealth(projectId?: string): Promise<void> {
    const targetProjectId = projectId ?? this.activeProjectId
    if (!targetProjectId) return
    await this.worktrees.refreshWorktreeHealth(targetProjectId)
  }

  /** Compute a state-bound preflight and mint a single-use confirmation token. */
  preflightWorktree(
    projectId: string,
    bucketId: string,
    action: ScopeLifecycleAction
  ): Promise<ScopeLifecyclePreflight> {
    return this.worktrees.preflightWorktree(projectId, bucketId, action)
  }

  /** Consume a confirmation token to apply a guarded lifecycle action. */
  confirmWorktreeLifecycle(
    projectId: string,
    bucketId: string,
    action: ScopeLifecycleAction,
    confirmationId: string,
    options?: { force?: boolean }
  ): Promise<void> {
    return this.worktrees.confirmWorktreeLifecycle(
      projectId,
      bucketId,
      action,
      confirmationId,
      options
    )
  }

  /** Preflight merging a managed scope into another scope and mint a token. */
  mergeToScopePreflight(
    projectId: string,
    bucketId: string,
    mergeTargetBucketId: string,
    mode: ScopeMergeMode
  ): Promise<ScopeMergePreflight> {
    return this.worktrees.mergeToScopePreflight(projectId, bucketId, mergeTargetBucketId, mode)
  }

  /**
   * Consume a delete-scope token to fully remove a managed scope: worktree,
   * scope bucket, and (by default) its branch. Threads are handled by the
   * caller before this runs.
   */
  confirmDeleteScope(
    projectId: string,
    bucketId: string,
    confirmationId: string,
    deleteBranch = true
  ): Promise<void> {
    return this.worktrees.confirmDeleteScope(projectId, bucketId, confirmationId, deleteBranch)
  }

  /** Consume a merge token to merge a scope and apply its post-merge mode. */
  confirmScopeMerge(
    projectId: string,
    bucketId: string,
    mergeTargetBucketId: string,
    mode: ScopeMergeMode,
    confirmationId: string
  ): Promise<ScopeMergeOutcome> {
    return this.worktrees.confirmScopeMerge(
      projectId,
      bucketId,
      mergeTargetBucketId,
      mode,
      confirmationId
    )
  }

  /** Retry from a failed/interrupted setup, or continue without setup. */
  retryWorktreeSetup(projectId: string, bucketId: string, runSetup: boolean): Promise<void> {
    return this.worktrees.retryWorktreeSetup(projectId, bucketId, runSetup)
  }

  /** Archive or restore a custom scope. Never touches its worktree. */
  setArchive(projectId: string, bucketId: string, archived: boolean): Promise<void> {
    return this.worktrees.setArchive(projectId, bucketId, archived)
  }

  /** Pin or unpin a scope. Pinned scopes are exempt from thread eviction. */
  setPinned(projectId: string, bucketId: string, pinned: boolean): Promise<void> {
    return this.worktrees.setPinned(projectId, bucketId, pinned)
  }

  /** Persistent project-level managed-worktree defaults. */
  setWorktreeDefaults(projectId: string, defaults: ScopeWorktreeDefaults): Promise<void> {
    return this.worktrees.setWorktreeDefaults(projectId, defaults)
  }

  /**
   * An agent changed scope state in main. Reload the project's board so the new
   * or removed scope appears immediately instead of waiting for a navigation,
   * and say what happened so the user is never looking at a silent change.
   */
  async handleBoardChangedEvent(event: ScopeBoardChangedEvent): Promise<void> {
    const { projectId } = event
    if (!projectId) return
    // A project whose board was never opened has nothing stale to fix; it will
    // read the current board the first time the user looks.
    if (this.boards.has(projectId)) {
      try {
        await this.reloadBoard(projectId)
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'The scope board could not reload.'
      }
    }
    const project = this.projects.find((candidate) => candidate.id === projectId)
    toast.info(`An agent ${event.summary}`, {
      description: project ? `in ${project.name}` : undefined,
      closeButton: true
    })
  }

  private persistSnapshot(): void {
    persistScopeSnapshot({
      activeProjectId: this.activeProjectId,
      sidebarContext: this.sidebarContext
    })
  }

  private applyBoard(projectId: string, board: ScopeBoard): void {
    const cloned = cloneBoard(board)
    this.boards.set(projectId, cloned)
    if (projectId === this.activeProjectId) this.board = cloned
  }

  private async reloadBoard(projectId: string): Promise<void> {
    if (!projectId) return
    const board = await invoke('scope:get', projectId)
    const cloned = cloneBoard(board)
    this.boards.set(projectId, cloned)
    if (projectId === this.activeProjectId) this.board = cloned
  }
}

export const scopeState = new ScopeState()
