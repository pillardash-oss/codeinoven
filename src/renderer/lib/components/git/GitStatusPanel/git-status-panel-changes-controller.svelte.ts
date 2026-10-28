import { gitState } from '$lib/stores/git.svelte'
import type { GitDiff, GitFileChange, GitRestoreTarget } from '$shared/types'
import { fileDiffKey } from '../git-status-panel-format'

/**
 * What the working-tree controls need from the panel around them: the repository
 * they edit, the working tree they edit it through, and the two moves that follow
 * a change leaving the index or the tree.
 */
export interface GitStatusPanelChangesHost {
  readonly projectId: string
  readonly changes: GitFileChange[]
  readonly staged: GitFileChange[]
  refreshStatus(): Promise<void>
  /** Hand the caret to the commit message box, which lives in the composer. */
  requestCommitMessageFocus(): void
}

/**
 * The Changes view's working-tree state and operations: the diffs it has read,
 * which files are open, which are selected, and the stage, ignore, discard and
 * restore actions that act on them.
 */
export class GitStatusPanelChangesController {
  diffs = $state<Record<string, GitDiff>>({})
  expanded = $state<Record<string, boolean>>({})
  loadingDiff = $state<Record<string, boolean>>({})
  diffErrors = $state<Record<string, string | null>>({})
  selectedPaths = $state<Record<string, boolean>>({})
  discardConfirm = $state<string[] | null>(null)
  restoreWorktreeConfirm = $state<{ source: string; path: string } | null>(null)
  /**
   * Selected paths in the order they were picked. Read by the batch actions and by
   * the row's own flags, so it is declared with the other view deriveds rather
   * than beside the actions that consume it.
   */
  readonly selectedPathList = $derived(Object.keys(this.selectedPaths))
  private readonly host: GitStatusPanelChangesHost

  constructor(host: GitStatusPanelChangesHost) {
    this.host = host
  }

  async toggleDiff(change: GitFileChange): Promise<void> {
    const key = fileDiffKey(change)
    if (this.expanded[key]) {
      this.expanded = { ...this.expanded, [key]: false }
      return
    }
    this.expanded = { ...this.expanded, [key]: true }
    this.diffErrors = { ...this.diffErrors, [key]: null }
    if (this.diffs[key]) return
    this.loadingDiff = { ...this.loadingDiff, [key]: true }
    try {
      const diff = await gitState.getDiff(this.host.projectId, change.path, change.staged)
      this.diffs = { ...this.diffs, [key]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      this.diffErrors = { ...this.diffErrors, [key]: message }
    } finally {
      this.loadingDiff = { ...this.loadingDiff, [key]: false }
    }
  }

  async toggleStage(change: GitFileChange): Promise<void> {
    if (change.staged) {
      await gitState.unstage(this.host.projectId, [change.path])
      return
    }
    await gitState.stage(this.host.projectId, [change.path])
    if (!gitState.error) this.host.requestCommitMessageFocus()
  }

  async stageAll(): Promise<void> {
    // Only paths with a worktree-side change (unstaged, untracked, or conflicted
    // work) can be staged; already-staged entries, such as staged deletions,
    // are no-ops for git add.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway path set for one call, never rendered
    const paths = new Set(
      this.host.changes.filter((change) => !change.staged).map((change) => change.path)
    )
    const allPaths = [...paths].filter(
      (path) => !(gitState.status?.conflicted ?? []).includes(path)
    )
    if (allPaths.length === 0) return
    await gitState.stage(this.host.projectId, allPaths)
    if (!gitState.error) this.host.requestCommitMessageFocus()
  }

  async unstageAll(): Promise<void> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway path set for one call, never rendered
    const paths = new Set(this.host.staged.map((change) => change.path))
    const allPaths = [...paths].filter(
      (path) => !(gitState.status?.conflicted ?? []).includes(path)
    )
    if (allPaths.length === 0) return
    await gitState.unstage(this.host.projectId, allPaths)
  }

  async stagePaths(paths: string[], staged: boolean): Promise<void> {
    if (staged) {
      await gitState.unstage(this.host.projectId, paths)
    } else {
      await gitState.stage(this.host.projectId, paths)
    }
  }

  toggleSelection(change: GitFileChange, additive: boolean): void {
    const next = { ...this.selectedPaths }
    if (additive && next[change.path]) {
      delete next[change.path]
    } else {
      next[change.path] = true
    }
    this.selectedPaths = next
  }

  toggleSectionSelection(sectionFiles: GitFileChange[]): void {
    const allSelected =
      sectionFiles.length > 0 && sectionFiles.every((f) => this.selectedPaths[f.path])
    const next = { ...this.selectedPaths }
    for (const file of sectionFiles) {
      if (allSelected) {
        delete next[file.path]
      } else {
        next[file.path] = true
      }
    }
    this.selectedPaths = next
  }

  clearSelection(): void {
    this.selectedPaths = {}
  }

  async stageSelectedAction(stage: boolean): Promise<void> {
    const paths = this.selectedPathList
    if (paths.length === 0) return
    await this.stagePaths(paths, stage)
    if (gitState.error) return
    this.clearSelection()
    // Staging is followed by writing the message, never by the reverse.
    if (!stage) this.host.requestCommitMessageFocus()
  }

  async ignoreSelectedAction(): Promise<void> {
    const paths = this.selectedPathList
    if (paths.length === 0) return
    await gitState.ignore(this.host.projectId, paths)
    if (!gitState.error) {
      this.clearSelection()
      void this.host.refreshStatus()
    }
  }

  async ignorePathsAction(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await gitState.ignore(this.host.projectId, paths)
    if (!gitState.error) {
      this.clearSelection()
      void this.host.refreshStatus()
    }
  }

  requestDiscard(paths: string[]): void {
    this.discardConfirm = paths
  }

  async confirmDiscard(): Promise<void> {
    const paths = this.discardConfirm
    if (!paths) return
    this.discardConfirm = null
    await gitState.discard(this.host.projectId, paths)
    if (!gitState.error) {
      this.clearSelection()
      void this.host.refreshStatus()
    }
  }

  /** Restore a file's content from the commit or stash being viewed. Restoring
   *  to the working tree overwrites uncommitted local edits, so that target is
   *  confirmed by the user before it runs. */
  async restoreFromSource(source: string, path: string, target: GitRestoreTarget): Promise<void> {
    if (target === 'worktree') {
      this.restoreWorktreeConfirm = { source, path }
      return
    }
    await gitState.restoreFiles(this.host.projectId, source, [path], target)
    if (!gitState.error) void this.host.refreshStatus()
  }

  async confirmRestoreWorktree(): Promise<void> {
    const pending = this.restoreWorktreeConfirm
    if (!pending) return
    this.restoreWorktreeConfirm = null
    await gitState.restoreFiles(this.host.projectId, pending.source, [pending.path], 'worktree')
    if (!gitState.error) void this.host.refreshStatus()
  }

  requestCommitSelected(): void {
    if (this.selectedPathList.length === 0) return
    void this.stageSelectedAction(false).then(() => {
      if (!gitState.error) {
        this.clearSelection()
        this.host.requestCommitMessageFocus()
      }
    })
  }

  /** A scope swap starts a new working tree, so no diff or selection survives it. */
  resetForScopeSwap(): void {
    this.selectedPaths = {}
    this.diffs = {}
    this.expanded = {}
    this.loadingDiff = {}
    this.diffErrors = {}
    this.discardConfirm = null
    this.restoreWorktreeConfirm = null
  }
}
