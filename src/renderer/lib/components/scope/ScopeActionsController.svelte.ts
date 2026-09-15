import { invoke } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  type ScopeBucket,
  type ScopeLifecycleAction,
  type ScopeLifecyclePreflight
} from '$shared/types'

export interface ScopeActionsOptions {
  /** Project the actions target; read per call so the controller follows the active project. */
  getProjectId: () => string | null
  /** Called when an action lands the user on the scoped-threads view (dock, conflict handoff). */
  onNavigateToScopedThreads?: () => void
}

/**
 * Owns every scope-level action (edit, pin, archive, worktree lifecycle, merge,
 * delete) plus the dialogs they need, so the scope board and the scoped-threads
 * sidebar expose exactly the same actions through
 * `src/renderer/lib/components/shared/ScopeActionsMenu.svelte` and
 * `src/renderer/lib/components/scope/ScopeActionsModals.svelte`.
 */
export class ScopeActionsController {
  private readonly getProjectId: () => string | null
  private readonly onNavigateToScopedThreads: () => void

  editTarget = $state<ScopeBucket | null>(null)
  editName = $state('')
  editColor = $state<string | undefined>(undefined)
  editIconType = $state<string | undefined>(undefined)
  deleteTarget = $state<ScopeBucket | null>(null)
  deleteThreads = $state(false)
  /** Display-only preflight warnings shown in the Delete Scope dialog for managed scopes. */
  deletePreflight = $state<ScopeLifecyclePreflight | null>(null)
  lifecycleAction = $state<{ action: ScopeLifecycleAction; bucket: ScopeBucket } | null>(null)
  mergeTarget = $state<ScopeBucket | null>(null)
  createWorktreeTarget = $state<ScopeBucket | null>(null)
  adoptWorktreeTarget = $state<ScopeBucket | null>(null)
  /** Last failed action, surfaced by whichever surface renders the controller. */
  error: string | null = $state(null)

  constructor(options: ScopeActionsOptions) {
    this.getProjectId = options.getProjectId
    this.onNavigateToScopedThreads = options.onNavigateToScopedThreads ?? (() => {})
  }

  get projectId(): string | null {
    return this.getProjectId()
  }

  /** Dock a scope: make it the scoped-threads sidebar's scope with no thread focused. */
  dock(bucket: ScopeBucket): void {
    if (!this.getProjectId()) return
    scopeState.dockScope(bucket.id)
    if (workspaceState.selectedThread) workspaceState.clearThread()
    this.onNavigateToScopedThreads()
  }

  askEdit(bucket: ScopeBucket): void {
    this.editTarget = bucket
    this.editName = bucket.name
    this.editColor = bucket.color
    this.editIconType = bucket.iconType
  }

  async confirmEdit(): Promise<void> {
    if (!this.editTarget || !this.editName.trim()) return
    try {
      await scopeState.editBucket(this.editTarget.id, {
        name: this.editName,
        color: this.editColor,
        iconType: this.editIconType
      })
      this.editTarget = null
    } catch (error) {
      this.error = this.message(error, 'The scope could not be edited.')
    }
  }

  async togglePinned(bucket: ScopeBucket): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId) return
    try {
      await scopeState.setPinned(projectId, bucket.id, bucket.pinned !== true)
    } catch (error) {
      this.error = this.message(error, 'The scope could not be pinned.')
    }
  }

  async setArchived(bucket: ScopeBucket, archived: boolean): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId) return
    try {
      await scopeState.setArchive(projectId, bucket.id, archived)
    } catch (error) {
      this.error = this.message(error, 'The scope could not be archived.')
    }
  }

  askDelete(bucket: ScopeBucket): void {
    this.deleteTarget = bucket
    this.deleteThreads = false
    this.deletePreflight = null
    const projectId = this.getProjectId()
    if (!projectId || bucket.root.kind !== 'worktree') return
    // Display-only preflight so the dialog can warn about dirty files, unpushed
    // commits, and running processes before the user confirms.
    void scopeState
      .preflightWorktree(projectId, bucket.id, 'delete-scope')
      .then((preflight) => {
        if (this.deleteTarget?.id === bucket.id) this.deletePreflight = preflight
      })
      .catch(() => {
        if (this.deleteTarget?.id === bucket.id) this.deletePreflight = null
      })
  }

  async confirmDelete(): Promise<void> {
    const target = this.deleteTarget
    if (!target || target.id === DEFAULT_SCOPE_BUCKET_ID) return
    try {
      const affectedThreads = scopeState.currentProjectThreads.filter(
        (thread) => scopeState.bucketForThread(thread) === target.id
      )
      if (this.deleteThreads) {
        await Promise.all(
          affectedThreads.map((thread) => invoke('thread:delete', thread.projectId, thread.id))
        )
        for (const thread of affectedThreads) {
          scopeState.removeThread(thread.id)
          if (workspaceState.selectedThread?.id === thread.id) {
            workspaceState.clearThread()
          }
        }
      } else {
        const reassigned = await Promise.all(
          affectedThreads.map((thread) =>
            invoke('thread:update', thread.projectId, thread.id, {
              scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
            })
          )
        )
        for (const thread of reassigned) {
          scopeState.updateThread(thread)
          workspaceState.updateThread(thread)
        }
      }
      const projectId = this.getProjectId()
      if (target.root.kind === 'worktree' && projectId) {
        // Full cleanup for worktree-backed scopes   the worktree and its branch
        // are removed through the guarded lifecycle. The token is minted here
        // (fresh) rather than reusing the dialog's display preflight, so it can
        // never be stale by the time the user confirms.
        const preflight = await scopeState.preflightWorktree(projectId, target.id, 'delete-scope')
        await scopeState.confirmDeleteScope(projectId, target.id, preflight.confirmationId, true)
      } else {
        await scopeState.removeBucket(target.id)
      }
      this.deleteTarget = null
      this.deleteThreads = false
      this.deletePreflight = null
      this.redockIfScoped(target)
    } catch (error) {
      this.error = this.message(error, 'The scope could not be deleted.')
    }
  }

  /** Never leave the scoped-threads sidebar pointing at a scope that is gone. */
  private redockIfScoped(bucket: ScopeBucket): void {
    if (scopeState.sidebarContext?.bucketId !== bucket.id) return
    scopeState.dockScope(DEFAULT_SCOPE_BUCKET_ID)
  }

  openLifecycle(bucket: ScopeBucket, action: ScopeLifecycleAction): void {
    if (bucket.root.kind !== 'worktree') return
    this.lifecycleAction = { action, bucket }
  }

  askMerge(bucket: ScopeBucket): void {
    this.mergeTarget = bucket
  }

  askCreateWorktree(bucket: ScopeBucket): void {
    this.createWorktreeTarget = bucket
  }

  askAdoptWorktree(bucket: ScopeBucket): void {
    this.adoptWorktreeTarget = bucket
  }

  async retrySetup(bucket: ScopeBucket): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId || bucket.root.kind !== 'worktree') return
    try {
      await scopeState.retryWorktreeSetup(projectId, bucket.id, true)
    } catch (error) {
      this.error = this.message(error, 'Setup could not be retried.')
    }
  }

  async repairWorktree(bucket: ScopeBucket): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId || bucket.root.kind !== 'worktree') return
    try {
      const health = await scopeState.repairWorktree({
        projectId,
        scopeBucketId: bucket.id
      })
      if (health.category !== 'healthy') {
        this.error = health.detail ?? `The worktree is still ${health.category}.`
      }
    } catch (error) {
      this.error = this.message(error, 'The worktree could not be repaired.')
    }
  }

  /**
   * A merge that landed in conflict keeps everything intact. Hand the user off
   * to the Git panel aimed at the merge-target scope so they can resolve the
   * conflict manually or with an agent, like any other conflicted merge.
   */
  openConflictsHandoff(projectId: string, targetScopeBucketId: string): void {
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === projectId) ?? null
    const anchor =
      scopeState.allScopeThreads.find(
        (thread) =>
          thread.projectId === projectId &&
          !thread.archived &&
          scopeState.bucketForThread(thread) === targetScopeBucketId
      ) ??
      scopeState.allScopeThreads.find(
        (thread) => thread.projectId === projectId && !thread.archived
      ) ??
      (workspaceState.selectedThread?.projectId === projectId
        ? workspaceState.selectedThread
        : undefined)
    if (!anchor) {
      this.error = 'The merge hit conflicts. Open the Git panel from a thread to resolve them.'
      return
    }
    scopeState.showSidebarForThread(anchor)
    this.onNavigateToScopedThreads()
    workspaceState.openThread(anchor, project)
    contextSidebarState.openGit(projectId, anchor.id)
  }

  dismissError(): void {
    this.error = null
  }

  private message(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
  }
}
