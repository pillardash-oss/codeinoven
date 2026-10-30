import { gitState } from '$lib/stores/git.svelte'
import type { GitBranchInfo, GitStatus } from '$shared/types'

/**
 * What the branch controls need from the panel they act on: which repository is
 * in front of the user, what its current branch is, and which local branch names
 * already exist so a remote branch is only tracked when it has no local twin.
 */
export interface GitStatusPanelBranchesHost {
  readonly projectId: string
  readonly status: GitStatus | null
  readonly localBranchNames: Set<string>
}

/**
 * The Branches view's state and operations.
 *
 * Checking a branch out rewrites the working tree and re-recording a branch on
 * the remote deletes something GitHub alone can restore, so both go through a
 * confirmation target that lives here rather than in the view that asked.
 */
export class GitStatusPanelBranchesController {
  creatingBranch = $state(false)
  newBranchName = $state('')
  checkoutConfirm = $state<GitBranchInfo | null>(null)
  deleteBranchConfirm = $state<string | null>(null)
  forceDeleteBranchConfirm = $state<string | null>(null)
  /** Remote-branch delete confirmation: which remote and which branch name. */
  deleteRemoteBranchConfirm = $state<{ remote: string; name: string } | null>(null)
  private readonly host: GitStatusPanelBranchesHost

  constructor(host: GitStatusPanelBranchesHost) {
    this.host = host
  }

  async checkoutBranch(branch: GitBranchInfo): Promise<void> {
    if (branch.kind === 'local') {
      if (branch.name === this.host.status?.branch) return
      await gitState.checkout(this.host.projectId, branch.ref)
      return
    }
    if (!branch.remote || this.host.localBranchNames.has(branch.name)) return
    await gitState.createTrackingBranch(this.host.projectId, branch.remote, branch.name)
  }

  async createBranch(name: string): Promise<void> {
    await gitState.createBranch(this.host.projectId, name)
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    const result = await gitState.deleteBranch(this.host.projectId, name, force)
    if (result === 'requires-force') this.forceDeleteBranchConfirm = name
  }

  /** Checking out switches the working tree, so it always confirms first from the Branches tab. */
  requestCheckout(branch: GitBranchInfo): void {
    if (branch.kind === 'local' && branch.name === this.host.status?.branch) return
    if (branch.kind === 'remote' && this.host.localBranchNames.has(branch.name)) return
    // Git refuses the same branch in two worktrees; those branches are display-only here.
    if (branch.worktreePath !== null) return
    this.checkoutConfirm = branch
  }

  async confirmCheckoutBranch(): Promise<void> {
    const target = this.checkoutConfirm
    if (!target) return
    this.checkoutConfirm = null
    await this.checkoutBranch(target)
  }

  requestDeleteBranch(name: string): void {
    this.deleteBranchConfirm = name
  }

  async confirmDeleteBranch(): Promise<void> {
    const target = this.deleteBranchConfirm
    if (!target) return
    this.deleteBranchConfirm = null
    await this.deleteBranch(target)
  }

  async confirmForceDeleteBranch(): Promise<void> {
    const target = this.forceDeleteBranchConfirm
    if (!target) return
    this.forceDeleteBranchConfirm = null
    await this.deleteBranch(target, true)
  }

  requestDeleteRemoteBranch(branch: GitBranchInfo): void {
    const remote = branch.remote
    if (!remote) return
    this.deleteRemoteBranchConfirm = { remote, name: branch.name }
  }

  async confirmDeleteRemoteBranch(): Promise<void> {
    const target = this.deleteRemoteBranchConfirm
    if (!target) return
    this.deleteRemoteBranchConfirm = null
    await gitState.deleteRemoteBranch(this.host.projectId, target.remote, target.name)
  }

  /** `git fetch <remote> <name>`   updates that branch's tracking ref without touching HEAD. */
  async fetchBranch(branch: GitBranchInfo): Promise<void> {
    const remote = branch.remote
    if (!remote) return
    await gitState.fetchBranch(this.host.projectId, remote, branch.name)
  }

  /** A scope swap starts a new checkout's branch list, so nothing pending survives it. */
  resetForScopeSwap(): void {
    this.checkoutConfirm = null
    this.deleteBranchConfirm = null
    this.forceDeleteBranchConfirm = null
    this.deleteRemoteBranchConfirm = null
    this.creatingBranch = false
    this.newBranchName = ''
  }
}
