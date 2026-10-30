import { gitState } from '$lib/stores/git.svelte'
import type { GitDiff, GitFileChange, GitStashEntry } from '$shared/types'
import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'

/**
 * What the stash controls need from the panel around them: the repository they
 * shelve into, and the two moves that follow a stash leaving the list.
 */
export interface GitStatusPanelStashesHost {
  readonly projectId: string
  readonly activeTab: GitPanelTabId
  setActiveTab(id: GitPanelTabId): void
  refreshStatus(): Promise<void>
  reloadHistory(): Promise<void>
}

/**
 * The Stashes view: which stash is being read, the file diffs it carries, and
 * the stash, pop and drop operations that edit the list.
 */
export class GitStatusPanelStashesController {
  showStashModal = $state(false)
  stashMessage = $state('')
  stashPaths = $state<string[] | null>(null)
  stashDropTarget = $state<GitStashEntry | null>(null)
  selectedStash = $state<GitStashEntry | null>(null)
  loadingStashDiff = $state(false)
  stashDiffChanges = $state<GitFileChange[]>([])
  stashDiffs = $state<Record<string, GitDiff>>({})
  stashExpanded = $state<Record<string, boolean>>({})
  loadingStashDiffFile = $state<Record<string, boolean>>({})
  stashDiffErrors = $state<Record<string, string | null>>({})
  private readonly host: GitStatusPanelStashesHost

  constructor(host: GitStatusPanelStashesHost) {
    this.host = host
  }

  async selectStash(stash: GitStashEntry): Promise<void> {
    this.selectedStash = stash
    this.loadingStashDiff = true
    this.stashDiffChanges = await gitState.getStashDiff(this.host.projectId, stash.id)
    this.stashDiffs = {}
    this.stashExpanded = {}
    this.loadingStashDiffFile = {}
    this.stashDiffErrors = {}
    this.loadingStashDiff = false
  }

  clearSelectedStash(): void {
    this.selectedStash = null
    this.stashDiffChanges = []
    this.stashDiffs = {}
    this.stashExpanded = {}
    this.loadingStashDiffFile = {}
    this.stashDiffErrors = {}
  }

  async toggleStashDiff(change: GitFileChange): Promise<void> {
    const stash = this.selectedStash
    if (!stash) return
    if (this.stashExpanded[change.path]) {
      this.stashExpanded = { ...this.stashExpanded, [change.path]: false }
      return
    }
    this.stashExpanded = { ...this.stashExpanded, [change.path]: true }
    this.stashDiffErrors = { ...this.stashDiffErrors, [change.path]: null }
    if (this.stashDiffs[change.path]) return
    this.loadingStashDiffFile = { ...this.loadingStashDiffFile, [change.path]: true }
    try {
      const diff = await gitState.getStashFileDiff(this.host.projectId, stash.id, change.path)
      this.stashDiffs = { ...this.stashDiffs, [change.path]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      this.stashDiffErrors = { ...this.stashDiffErrors, [change.path]: message }
    } finally {
      this.loadingStashDiffFile = { ...this.loadingStashDiffFile, [change.path]: false }
    }
  }

  async stashChanges(): Promise<void> {
    await gitState.stash(
      this.host.projectId,
      this.stashMessage.trim() || undefined,
      this.stashPaths ?? undefined
    )
    if (!gitState.error) {
      this.stashMessage = ''
      this.stashPaths = null
      this.showStashModal = false
      this.host.setActiveTab('stashes')
      void this.host.refreshStatus()
    }
  }

  requestStashFor(paths: string[]): void {
    this.stashPaths = paths
    this.stashMessage = ''
    this.showStashModal = true
  }

  async popStash(id?: string): Promise<void> {
    await gitState.popStash(this.host.projectId, id)
    if (!gitState.error) {
      this.clearSelectedStash()
      this.leaveStashesTabIfEmpty()
      void this.host.refreshStatus()
      void this.host.reloadHistory()
    }
  }

  /** The Stashes tab only exists while stashes do   fall back to Changes when the last one goes. */
  leaveStashesTabIfEmpty(): void {
    if (this.host.activeTab === 'stashes' && gitState.stashes.length === 0)
      this.host.setActiveTab('changes')
  }

  requestStashDrop(stash: GitStashEntry): void {
    this.stashDropTarget = stash
  }

  async confirmStashDrop(): Promise<void> {
    const target = this.stashDropTarget
    if (!target) return
    this.stashDropTarget = null
    await gitState.dropStash(this.host.projectId, target.id)
    if (!gitState.error) {
      this.clearSelectedStash()
      this.leaveStashesTabIfEmpty()
      void this.host.refreshStatus()
    }
  }

  /** A scope swap shelves nothing that was already asked for. */
  resetForScopeSwap(): void {
    this.selectedStash = null
    this.stashDiffChanges = []
    this.stashDiffs = {}
    this.stashExpanded = {}
    this.loadingStashDiff = false
    this.loadingStashDiffFile = {}
    this.stashDiffErrors = {}
    this.stashDropTarget = null
    this.showStashModal = false
    this.stashMessage = ''
    this.stashPaths = null
  }
}
