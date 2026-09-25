import { invoke } from '$lib/ipc.svelte'
import { SvelteMap } from 'svelte/reactivity'
import type {
  AdoptableWorktreeInfo,
  ManagedWorktreeDescriptor,
  ScopeBoard,
  ScopeBucket,
  ScopeLifecycleAction,
  ScopeLifecyclePreflight,
  ScopeMergeMode,
  ScopeMergeOutcome,
  ScopeMergePreflight,
  ScopeTarget,
  ScopeWorktreeCreateInput,
  ScopeWorktreeDefaults,
  ScopeWorktreeHealth,
  ScopeWorktreeSourceInfo
} from '$shared/types'

/** Minimum interval between two health reads of the same managed scope. */
const HEALTH_RECHECK_INTERVAL_MS = 2_000

/**
 * Board and error access the worktree controller needs from the scope store.
 * The controller owns the health cache and the lifecycle IPC; the store keeps
 * the board state and remains the composition root.
 */
export interface ScopeWorktreeHost {
  bucketFor(projectId: string, bucketId: string): ScopeBucket | null
  boardForProject(projectId: string): ScopeBoard | undefined
  applyBoard(projectId: string, board: ScopeBoard): void
  reloadBoard(projectId: string): Promise<void>
  setError(message: string): void
}

/**
 * Managed worktree lifecycle and health for scope buckets. Owns the
 * target-keyed health cache and the background revalidation throttle; every
 * mutation delegates to the main-owned lifecycle IPC and refreshes the board
 * through the host.
 */
export class ScopeWorktrees {
  /** Target-keyed health of managed worktrees, refreshed on demand. */
  healthByTarget: Map<string, ScopeWorktreeHealth> = $state(new SvelteMap())
  /** Board signature of the last background health refresh, so views can ask
   *  for a refresh from any reactive block without hammering the IPC channel. */
  private healthSyncSignature = ''
  /** Targets whose health was read recently, so reactive callers cannot hammer
   *  the IPC channel. Plain (non-reactive) state: it never needs to render. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private healthCheckTimes: Map<string, number> = new Map()

  constructor(private readonly host: ScopeWorktreeHost) {}

  /** Create a managed worktree for an existing scope bucket. */
  async createWorktree(
    projectId: string,
    bucketId: string,
    input: ScopeWorktreeCreateInput
  ): Promise<ManagedWorktreeDescriptor | null> {
    try {
      // Build the payload from the wire contract instead of forwarding the
      // caller's object: main rejects unknown fields, and callers hold richer
      // inputs (the worktree job carries an `isolated` flag the service has no
      // field for).
      const descriptor = await invoke(
        'scope:worktree:create',
        { projectId, scopeBucketId: bucketId },
        {
          title: input.title,
          runSetup: input.runSetup,
          environmentMode: input.environmentMode,
          ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
          ...(input.setupCommands === undefined ? {} : { setupCommands: input.setupCommands })
        }
      )
      await this.host.reloadBoard(projectId)
      return descriptor
    } catch (error) {
      this.host.setError(
        error instanceof Error ? error.message : 'The worktree could not be created.'
      )
      throw error
    }
  }

  /** Inspect the source checkout before creating a worktree. */
  worktreeSourceInfo(projectId: string): Promise<ScopeWorktreeSourceInfo> {
    return invoke('scope:worktree:sourceInfo', projectId)
  }

  /** Read the typed health of a managed scope worktree. */
  async worktreeHealth(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const health = await invoke('scope:worktree:health', target)
    this.healthByTarget.set(`${target.projectId}:${target.scopeBucketId}`, health)
    return health
  }

  /** Repair an unhealthy managed scope and refresh its cached health. */
  async repairWorktree(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const health = await invoke('scope:worktree:repair', target)
    this.healthByTarget.set(`${target.projectId}:${target.scopeBucketId}`, health)
    await this.host.reloadBoard(target.projectId)
    return health
  }

  /** Preview whether an existing Git worktree checkout can be adopted. */
  detectAdoptableWorktree(projectId: string, sourcePath: string): Promise<AdoptableWorktreeInfo> {
    return invoke('scope:worktree:detectAdopt', projectId, sourcePath)
  }

  /** Adopt an existing raw Git worktree as a managed scope root. */
  async adoptWorktree(
    projectId: string,
    bucketId: string,
    input: { sourcePath: string; runSetup: boolean }
  ): Promise<ManagedWorktreeDescriptor | null> {
    try {
      const descriptor = await invoke(
        'scope:worktree:adopt',
        { projectId, scopeBucketId: bucketId },
        input
      )
      await this.host.reloadBoard(projectId)
      await this.worktreeHealth({ projectId, scopeBucketId: bucketId })
      return descriptor
    } catch (error) {
      this.host.setError(
        error instanceof Error ? error.message : 'The worktree could not be adopted.'
      )
      throw error
    }
  }

  /** Cached typed health of one scope (undefined until it has been refreshed). */
  healthFor(bucketId: string, projectId: string | null): ScopeWorktreeHealth | undefined {
    if (!projectId) return undefined
    return this.healthByTarget.get(`${projectId}:${bucketId}`)
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
    if (!projectId || !buckets) return
    const managed = buckets.filter((bucket) => bucket.root.kind === 'worktree')
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const live = new Set(managed.map((bucket) => `${projectId}:${bucket.id}`))
    for (const key of [...this.healthByTarget.keys()]) {
      if (!key.startsWith(`${projectId}:`) || live.has(key)) continue
      this.healthByTarget.delete(key)
      this.healthCheckTimes.delete(key)
    }
    if (managed.length === 0) return
    const signature = `${projectId}:${managed.map((bucket) => bucket.id).join(',')}`
    if (signature === this.healthSyncSignature) return
    this.healthSyncSignature = signature
    for (const bucket of managed) {
      void this.revalidateWorktreeHealth(projectId, bucket.id).catch(() => undefined)
    }
  }

  /**
   * Re-read one managed scope's health when its cached verdict is older than the
   * throttle window. Detection stays passive (nothing polls the filesystem), but
   * every surface that has a reason to touch a scope (board switch, scoped
   * sidebar, Git panel, scope actions menu, a failed operation) calls this, so a
   * checkout that changed on disk is re-detected at the moment it matters.
   */
  async revalidateWorktreeHealth(
    projectId: string,
    bucketId: string,
    options?: { force?: boolean }
  ): Promise<ScopeWorktreeHealth | undefined> {
    // Project-rooted scopes have no checkout to inspect, and a scope that is not
    // loaded yet is not on screen, so neither costs an IPC round trip.
    const bucket = this.host.bucketFor(projectId, bucketId)
    if (!bucket || bucket.root.kind !== 'worktree') return undefined
    const key = `${projectId}:${bucketId}`
    const now = Date.now()
    const last = this.healthCheckTimes.get(key) ?? 0
    if (!options?.force && now - last < HEALTH_RECHECK_INTERVAL_MS) {
      return this.healthByTarget.get(key)
    }
    this.healthCheckTimes.set(key, now)
    try {
      return await this.worktreeHealth({ projectId, scopeBucketId: bucketId })
    } catch {
      // Keep the previous verdict and let the next interaction retry.
      this.healthCheckTimes.delete(key)
      return this.healthByTarget.get(key)
    }
  }

  /** Revalidate every managed scope of a board in the background. */
  revalidateBoardWorktreeHealth(
    projectId: string | null | undefined,
    buckets: readonly ScopeBucket[] | undefined
  ): void {
    if (!projectId || !buckets) return
    for (const bucket of buckets) {
      if (bucket.root.kind !== 'worktree') continue
      void this.revalidateWorktreeHealth(projectId, bucket.id).catch(() => undefined)
    }
  }

  /** Refresh the cached health of every managed bucket on the active board. */
  async refreshWorktreeHealth(projectId: string): Promise<void> {
    const buckets = this.host.boardForProject(projectId)?.buckets ?? []
    for (const bucket of buckets) {
      if (bucket.root.kind !== 'worktree') continue
      try {
        await this.worktreeHealth({ projectId, scopeBucketId: bucket.id })
      } catch {
        // Health stays at its previous cached value; failures surface in UI state.
      }
    }
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
        return invoke(
          'scope:worktree:confirmDetach',
          target,
          confirmationId,
          options?.force ?? false
        )
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

  /** Preflight merging a managed scope into another scope and mint a token. */
  async mergeToScopePreflight(
    projectId: string,
    bucketId: string,
    mergeTargetBucketId: string,
    mode: ScopeMergeMode
  ): Promise<ScopeMergePreflight> {
    const source = { projectId, scopeBucketId: bucketId }
    const dest = { projectId, scopeBucketId: mergeTargetBucketId }
    return invoke('scope:worktree:mergePreflight', source, dest, mode)
  }

  /**
   * Consume a delete-scope token to fully remove a managed scope: worktree,
   * scope bucket, and (by default) its branch. Threads are handled by the
   * caller before this runs.
   */
  async confirmDeleteScope(
    projectId: string,
    bucketId: string,
    confirmationId: string,
    deleteBranch = true
  ): Promise<void> {
    const target = { projectId, scopeBucketId: bucketId }
    await invoke('scope:worktree:confirmDeleteScope', target, confirmationId, deleteBranch)
    await this.host.reloadBoard(projectId)
  }

  /** Consume a merge token to merge a scope and apply its post-merge mode. */
  async confirmScopeMerge(
    projectId: string,
    bucketId: string,
    mergeTargetBucketId: string,
    mode: ScopeMergeMode,
    confirmationId: string
  ): Promise<ScopeMergeOutcome> {
    const source = { projectId, scopeBucketId: bucketId }
    const dest = { projectId, scopeBucketId: mergeTargetBucketId }
    return invoke('scope:worktree:confirmMerge', source, dest, mode, confirmationId)
  }

  /** Retry from a failed/interrupted setup, or continue without setup. */
  async retryWorktreeSetup(projectId: string, bucketId: string, runSetup: boolean): Promise<void> {
    await invoke('scope:worktree:retrySetup', { projectId, scopeBucketId: bucketId }, { runSetup })
    await this.host.reloadBoard(projectId)
  }

  /** Archive or restore a custom scope. Never touches its worktree. */
  async setArchive(projectId: string, bucketId: string, archived: boolean): Promise<void> {
    const board = await invoke('scope:setArchive', projectId, bucketId, archived)
    this.host.applyBoard(projectId, board)
  }

  /** Pin or unpin a scope. Pinned scopes are exempt from thread eviction. */
  async setPinned(projectId: string, bucketId: string, pinned: boolean): Promise<void> {
    const board = await invoke('scope:setPinned', projectId, bucketId, pinned)
    this.host.applyBoard(projectId, board)
  }

  /** Persistent project-level managed-worktree defaults. */
  async setWorktreeDefaults(projectId: string, defaults: ScopeWorktreeDefaults): Promise<void> {
    const board = await invoke('scope:setWorktreeDefaults', projectId, defaults)
    this.host.applyBoard(projectId, board)
  }
}
