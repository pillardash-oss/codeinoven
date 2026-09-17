import { scopeState } from '$lib/stores/scope.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { revealInOsFileManager } from '$lib/os-file-manager'
import { scopeWorktreeHealthGuidance } from '$shared/scope-worktree-health'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  type GitSyncDirection,
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
  /**
   * Scope whose worktree is the checkout a peer sync runs in. Opened from the
   * menu as "Merge from project…", which is a sync from the project root into
   * that worktree, but the chooser still lets the user pick any other end.
   */
  syncTarget = $state<{ bucket: ScopeBucket; direction: GitSyncDirection } | null>(null)
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
      this.fail(this.message(error, 'The scope could not be edited.'))
    }
  }

  async togglePinned(bucket: ScopeBucket): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId) return
    try {
      await scopeState.setPinned(projectId, bucket.id, bucket.pinned !== true)
    } catch (error) {
      this.fail(this.message(error, 'The scope could not be pinned.'))
    }
  }

  async setArchived(bucket: ScopeBucket, archived: boolean): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId) return
    try {
      await scopeState.setArchive(projectId, bucket.id, archived)
    } catch (error) {
      this.fail(this.message(error, 'The scope could not be archived.'))
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

  /**
   * Hand the confirmed deletion to the app-level worktree dock, mirroring how a
   * create or adopt runs: the threads, the checkout and the scope record are
   * removed by a job the user can background while they keep working. Every
   * value the run needs is read BEFORE the dialog state is cleared, because the
   * dock panel outlives this dialog.
   */
  confirmDelete(): void {
    const target = this.deleteTarget
    if (!target || target.id === DEFAULT_SCOPE_BUCKET_ID) return
    const projectId = this.getProjectId()
    if (!projectId) return
    // A second confirmation for a scope already being removed would only fail
    // inside the dock, so the dialog closes on the run in progress instead.
    if (scopeJobs.isRemoving(projectId, target.id)) {
      this.deleteTarget = null
      this.deleteThreads = false
      this.deletePreflight = null
      return
    }
    const input = {
      bucketId: target.id,
      title: target.name,
      isolated: target.root.kind === 'worktree',
      deleteThreads: this.deleteThreads
    }
    this.deleteTarget = null
    this.deleteThreads = false
    this.deletePreflight = null
    scopeJobs.remove(projectId, input, {
      onRemoved: () => this.redockIfScoped(target)
    })
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

  /**
   * Open this scope's managed checkout in the OS file manager. Health is the
   * authority for where the checkout is (it reports `expectedPath`, and the
   * actual path when Git disagrees), and the reveal itself runs through the
   * same `shell:revealPath` contract every file surface uses, which re-validates
   * the path in main.
   */
  async revealWorktree(bucket: ScopeBucket): Promise<void> {
    const projectId = this.getProjectId()
    if (!projectId || bucket.root.kind !== 'worktree') return
    try {
      const health = await scopeState.revalidateWorktreeHealth(projectId, bucket.id, {
        force: true
      })
      const path = health?.actualPath ?? health?.expectedPath
      if (!path) throw new Error('This scope has no worktree folder on disk to reveal')
      const revealed = await revealInOsFileManager(path)
      if (!revealed) {
        throw new Error(`The file manager could not open ${path}`)
      }
    } catch (error) {
      this.fail(this.message(error, 'The worktree folder could not be revealed.'))
    }
  }

  /**
   * "Merge from project": bring the project root's commits into this worktree's
   * branch, through the same peer chooser the Git panel uses.
   */
  askSyncFrom(bucket: ScopeBucket): void {
    this.syncTarget = { bucket, direction: 'from' }
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
      this.fail(this.message(error, 'Setup could not be run.'))
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
        // Name what is still wrong and which action resolves it instead of
        // leaving the user with a health category they cannot act on.
        const guidance = scopeWorktreeHealthGuidance(health)
        this.fail(`${guidance.cause}. ${guidance.fix}`)
      }
    } catch (error) {
      this.fail(this.message(error, 'The worktree could not be repaired.'))
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
      this.fail('The merge hit conflicts. Open the Git panel from a thread to resolve them.')
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

  /**
   * Record a failure for the surface that renders it (the scope board and the
   * scoped sidebar both show `error` in a dismissible banner).
   */
  private fail(message: string): void {
    this.error = message
  }

  private message(error: unknown, fallback: string): string {
    return ipcErrorMessage(error, fallback)
  }
}
