import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { APP_SLUG } from '$shared/brand'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  isOrchestrationChildThread,
  type ManagedWorktreeDescriptor,
  type Project,
  type ScopeBoard,
  type ScopeBucket,
  type ScopeEnvironmentMode,
  type ScopeLifecycleAction,
  type ScopeLifecyclePreflight,
  type ScopeSlice,
  type ScopeTarget,
  type ScopeWorktreeDefaults,
  type ScopeWorktreeHealth,
  type ScopeWorktreeProgress,
  type Thread,
  scopeSliceForStatus
} from '$shared/types'
import type { ThreadStatusTone } from '$shared/thread-status-policy'

export type ThreadStage = ScopeSlice

export interface ScopeProject {
  id: string
  name: string
  path?: string
  source?: 'local' | 'ssh'
  host?: string
  iconUrl?: string | null
  color?: string
}

export interface ScopeSidebarContext {
  projectId: string
  bucketId: string
  stage: ThreadStage
  threadId: string
}

export interface ScopeBucketEdit {
  name: string
  color?: string
  iconType?: string
}

export interface ProjectBadge {
  hasWorking: boolean
  hasUnread: boolean
  hasAttention: boolean
  hasError: boolean
}

export const STAGE_LABELS: Record<ThreadStage, string> = {
  pinned: 'Pinned',
  todo: 'Todo',
  working: 'Working',
  spec: 'Spec',
  issue: 'Issue',
  unread: 'Unread',
  done: 'Done'
}

export const STAGE_COLORS: Record<ThreadStage, string> = {
  pinned: 'var(--color-thread-pinned)',
  todo: 'var(--color-dimmed)',
  working: 'var(--color-thread-working)',
  spec: 'var(--color-thread-spec)',
  issue: 'var(--color-warning)',
  unread: 'var(--color-thread-unread)',
  done: 'var(--color-thread-done)'
}

export const STATUS_TONE_COLORS: Record<ThreadStatusTone, string> = {
  todo: 'var(--color-dimmed)',
  working: 'var(--color-thread-working)',
  'working-paused': 'var(--color-thread-working-paused)',
  attention: 'var(--color-warning)',
  spec: 'var(--color-thread-spec)',
  done: 'var(--color-thread-done)',
  error: 'var(--color-thread-error)'
}

export const STAGE_ORDER: ThreadStage[] = [
  'pinned',
  'todo',
  'working',
  'spec',
  'issue',
  'unread',
  'done'
]

const EMPTY_BOARD: ScopeBoard = {
  version: 2,
  buckets: [
    {
      id: DEFAULT_SCOPE_BUCKET_ID,
      name: 'Default',
      sortOrder: 0,
      collapsed: false,
      collapsedSlices: [],
      root: { kind: 'project' }
    }
  ],
  worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' }
}

interface ScopeSnapshot {
  activeProjectId: string | null
  sidebarContext: ScopeSidebarContext | null
}

const SCOPE_STORAGE_KEY = `${APP_SLUG}.scope.v1`

function parseSidebarContext(value: unknown): ScopeSidebarContext | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (
    typeof obj.projectId !== 'string' ||
    typeof obj.bucketId !== 'string' ||
    typeof obj.threadId !== 'string' ||
    typeof obj.stage !== 'string' ||
    !STAGE_ORDER.includes(obj.stage as ThreadStage)
  ) {
    return null
  }
  return {
    projectId: obj.projectId,
    bucketId: obj.bucketId,
    stage: obj.stage as ThreadStage,
    threadId: obj.threadId
  }
}

function loadScopeSnapshot(): ScopeSnapshot {
  if (typeof window === 'undefined') return { activeProjectId: null, sidebarContext: null }
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY)
    if (!raw) return { activeProjectId: null, sidebarContext: null }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null,
      sidebarContext: parseSidebarContext(parsed.sidebarContext)
    }
  } catch {
    return { activeProjectId: null, sidebarContext: null }
  }
}

function persistScopeSnapshot(snapshot: ScopeSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Scope persistence is optional; unavailable storage must not break the app.
  }
}

export function clearScopeSnapshot(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(SCOPE_STORAGE_KEY)
  } catch {
    // Best-effort cleanup.
  }
}

export function threadStage(thread: Thread, draftThreadId?: string | null): ThreadStage {
  if (draftThreadId && thread.id === draftThreadId) return 'todo'
  if (thread.pinned) return 'pinned'
  if (thread.status === 'completed' && !thread.read && !isOrchestrationChildThread(thread)) {
    return 'unread'
  }
  return scopeSliceForStatus(thread.status)
}

function orderedBuckets(board: ScopeBoard): ScopeBucket[] {
  return [...board.buckets].sort((a, b) => a.sortOrder - b.sortOrder)
}

function cloneBoard(board: ScopeBoard): ScopeBoard {
  return {
    version: 2,
    buckets: orderedBuckets(board).map((bucket) => ({
      ...bucket,
      collapsedSlices: [...bucket.collapsedSlices],
      root:
        bucket.root.kind === 'worktree'
          ? {
              ...bucket.root,
              setup: {
                ...bucket.root.setup,
                commands: bucket.root.setup.commands.map((command) => ({ ...command }))
              }
            }
          : { kind: 'project' }
    })),
    worktreeDefaults: {
      ...board.worktreeDefaults,
      setupCommands: board.worktreeDefaults.setupCommands.map((command) => ({ ...command }))
    }
  }
}

class ScopeState {
  projectRecords: Project[] = $state([])
  projects: ScopeProject[] = $state([])
  activeProjectId: string | null = $state(loadScopeSnapshot().activeProjectId)
  board: ScopeBoard = $state(cloneBoard(EMPTY_BOARD))
  boards: Map<string, ScopeBoard> = $state(new SvelteMap())
  allScopeThreads: Thread[] = $state([])
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
  /** Target-keyed health of managed worktrees, refreshed on demand. */
  healthByTarget: Map<string, ScopeWorktreeHealth> = $state(new SvelteMap())
  /** Transient worktree creation/setup progress. */
  worktreeProgress = $state<ScopeWorktreeProgress>({ stage: 'none' })
  private loadSequence = 0
  private saveSequence = 0

  get projectBadges(): SvelteMap<string, ProjectBadge> {
    const badges = new SvelteMap<string, ProjectBadge>()
    for (const project of this.projects) {
      const projectThreads = this.allScopeThreads.filter(
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
    if (!this.activeProjectId) return []
    return this.allScopeThreads.filter(
      (thread) => thread.projectId === this.activeProjectId && !thread.archived
    )
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
    this.allScopeThreads = threads
  }

  setSelectedThreadDraftState(threadId: string | null, hasDraft: boolean): void {
    this.draftThreadId = hasDraft ? threadId : null
  }

  async activateProject(id: string): Promise<void> {
    if (id === this.activeProjectId) {
      const loadedBoard = this.boards.get(id)
      if (loadedBoard) {
        this.board = loadedBoard
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
    const bucketId = thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    // Resolve against the thread's OWN project board, not the active project's.
    // The regular thread list spans many projects; validating against `this.board`
    // (the active project) would misclassify every non-active thread as default
    // whenever its bucket isn't on the active board. Fall back to the active board
    // only when the thread's project board hasn't been loaded yet.
    const board = this.boards.get(thread.projectId) ?? this.board
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
    const projectId = this.activeProjectId
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
    const updates = new Map(updatedThreads.map((thread) => [thread.id, thread]))
    this.allScopeThreads = this.allScopeThreads.map((thread) => updates.get(thread.id) ?? thread)
  }

  stageForThread(thread: Thread): ThreadStage {
    return threadStage(thread, this.draftThreadId)
  }

  threadsByStage(stage: ThreadStage): Thread[] {
    return this.currentProjectThreads.filter((thread) => this.stageForThread(thread) === stage)
  }

  showSidebarForThread(thread: Thread, bucketId?: string): void {
    if (thread.projectId !== this.activeProjectId) {
      void this.activateProject(thread.projectId)
    }
    this.sidebarContext = {
      projectId: thread.projectId,
      bucketId: bucketId ?? thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID,
      stage: this.stageForThread(thread),
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
    const exists = this.allScopeThreads.some((thread) => thread.id === updated.id)
    this.allScopeThreads = exists
      ? this.allScopeThreads.map((thread) => (thread.id === updated.id ? updated : thread))
      : [updated, ...this.allScopeThreads]
    if (this.sidebarContext?.threadId === updated.id) {
      this.sidebarContext = {
        projectId: updated.projectId,
        bucketId: this.bucketForThread(updated),
        stage: this.stageForThread(updated),
        threadId: updated.id
      }
      persistScopeSnapshot({
        activeProjectId: this.activeProjectId,
        sidebarContext: this.sidebarContext
      })
    }
  }

  removeThread(threadId: string): void {
    const removedIds = new Set(
      this.allScopeThreads
        .filter((thread) => thread.id === threadId || thread.coordinatorThreadId === threadId)
        .map((thread) => thread.id)
    )
    this.allScopeThreads = this.allScopeThreads.filter((thread) => !removedIds.has(thread.id))
  }

  // ─── Managed worktree lifecycle ─────────────────────────────────────────

  /** Create an isolated managed worktree for an existing scope bucket. */
  async createWorktree(
    projectId: string,
    bucketId: string,
    input: {
      title: string
      runSetup: boolean
      environmentMode: ScopeEnvironmentMode
    }
  ): Promise<ManagedWorktreeDescriptor | null> {
    this.worktreeProgress = { stage: 'naming' }
    try {
      const descriptor = await invoke(
        'scope:worktree:create',
        { projectId, scopeBucketId: bucketId },
        input
      )
      this.worktreeProgress = { stage: 'done' }
      await this.reloadBoard(projectId)
      return descriptor
    } catch (error) {
      this.worktreeProgress = { stage: 'failed' }
      this.error = error instanceof Error ? error.message : 'The worktree could not be created.'
      throw error
    }
  }

  /** Read the typed health of a managed scope worktree. */
  async worktreeHealth(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const health = await invoke('scope:worktree:health', target)
    this.healthByTarget.set(`${target.projectId}:${target.scopeBucketId}`, health)
    return health
  }

  /** Compute a state-bound preflight and mint a single-use confirmation token. */
  preflightWorktree(
    projectId: string,
    bucketId: string,
    action: ScopeLifecycleAction
  ): Promise<ScopeLifecyclePreflight> {
    return invoke('scope:worktree:preflight', action, { projectId, scopeBucketId: bucketId })
  }

  /** Consume a confirmation token to apply a guarded lifecycle action. */
  confirmWorktreeLifecycle(
    projectId: string,
    bucketId: string,
    action: ScopeLifecycleAction,
    confirmationId: string,
    options?: { force?: boolean }
  ): Promise<void> {
    const target = { projectId, scopeBucketId: bucketId }
    switch (action) {
      case 'detach':
        return invoke('scope:worktree:confirmDetach', target, confirmationId)
      case 'remove-worktree':
        return invoke(
          'scope:worktree:confirmRemove',
          target,
          confirmationId,
          options?.force ?? false
        )
      case 'delete-branch':
        return invoke('scope:worktree:confirmDeleteBranch', target, confirmationId)
      default:
        return Promise.reject(new Error(`Unsupported lifecycle action for this path: ${action}`))
    }
  }

  /** Retry from a failed/interrupted setup, or continue without setup. */
  async retryWorktreeSetup(projectId: string, bucketId: string, runSetup: boolean): Promise<void> {
    await invoke('scope:worktree:retrySetup', { projectId, scopeBucketId: bucketId }, { runSetup })
    await this.reloadBoard(projectId)
  }

  /** Archive or restore a custom scope. Never touches its worktree. */
  async setArchive(projectId: string, bucketId: string, archived: boolean): Promise<void> {
    const board = await invoke('scope:setArchive', projectId, bucketId, archived)
    const cloned = cloneBoard(board)
    this.boards.set(projectId, cloned)
    if (projectId === this.activeProjectId) this.board = cloned
  }

  /** Persistent project-level managed-worktree defaults. */
  async setWorktreeDefaults(projectId: string, defaults: ScopeWorktreeDefaults): Promise<void> {
    const board = await invoke('scope:setWorktreeDefaults', projectId, defaults)
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
