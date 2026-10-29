import { copyText } from '$lib/copy-text'
import { gitState } from '$lib/stores/git.svelte'
import { githubNotifications } from '$lib/stores/github-notifications.svelte'
import type { GitCommitInfo, GitResetMode } from '$shared/types'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelState extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }
  resetOptions: Array<{ mode: GitResetMode; label: string; hint: string }> = [
    { mode: 'soft', label: 'Soft', hint: 'keep index + worktree' },
    { mode: 'mixed', label: 'Mixed', hint: 'reset index, keep worktree' },
    { mode: 'hard', label: 'Hard', hint: 'discard all local changes' }
  ]

  worktreeBranches = $derived(
    gitState.branches.filter((branch) => branch.kind === 'local' && branch.worktreePath !== null)
  )

  busy = $derived(
    gitState.isBusy(['refresh', 'init', 'commit', 'amend', 'reset', 'remove-commit-changes'])
  )

  commitBusy = $derived(gitState.isBusy(['commit', 'amend']))

  batchBusy = $derived(
    gitState.isBusy([
      'stage',
      'unstage',
      'commit',
      'stash',
      'ignore',
      'discard',
      'remove-commit-changes'
    ])
  )

  stashOpBusy = $derived(gitState.isBusy(['stash-pop', 'stash-drop']))

  async copyCommitHash(commit: GitCommitInfo): Promise<void> {
    try {
      await copyText(commit.hash)
    } catch {
      // Clipboard may be unavailable; nothing else to do.
    }
  }

  async copyCommitMessage(commit: GitCommitInfo): Promise<void> {
    try {
      await copyText(commit.message)
    } catch {
      // Clipboard may be unavailable; nothing else to do.
    }
  }

  /** Mirrors of the last target the swap logic saw. Plain (non-$state) locals
   *  on purpose: writing them inside an effect must not create dependencies,
   *  they only exist to tell first mount, project changes and pure scope
   *  swaps apart. */
  appliedProjectId = ''

  appliedScopeBucketId = ''

  /** Whether a notification action is in flight, so its controls can hold still. */
  notificationBusy = $derived(githubNotifications.busyThreadId !== null)

  /** The notification action style, shared by the header group's controls. */
  notificationActionClass =
    'flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40'

  integrateBusy = $derived(
    gitState.isBusy([
      'merge',
      'rebase',
      'stash',
      'abortMerge',
      'abortRebase',
      'rebase-action',
      'accept-conflicts'
    ])
  )

  /**
   * Route conflict resolution to the file panel: enable the tree's Conflicts
   * filter and open the requested (or first) conflicted file, which the viewer
   * renders as the per-hunk resolution editor.
   */
  routeConflictResolution(initial?: string): void {
    gitState.conflictsMode = true
    contextSidebarState.openFiles(this.root.props.projectId, this.root.props.threadId)
    const path = initial ?? gitState.conflicted[0]
    if (!path) return
    void projectFilesWorkspace.openFile(this.root.props.projectId, path).then(() => {
      projectFilesWorkspace.requestFullscreen(this.root.props.projectId)
    })
  }

  async openInEditor(path: string): Promise<void> {
    await projectFilesWorkspace.openFile(this.root.props.projectId, path)
  }

  async openDirectory(path: string): Promise<void> {
    contextSidebarState.openFiles(this.root.props.projectId, this.root.props.threadId)
    await projectFilesWorkspace.ensureState(this.root.props.projectId)
    await projectFilesWorkspace.loadDirectory(this.root.props.projectId, '')
    await projectFilesWorkspace.revealDirectory(this.root.props.projectId, path)
  }

  /**
   * Panes: Conflicts (if any) sits above Staged, which sits above the working
   * tree. Each pane hugs its content and none of them scroll, so the whole tab
   * shares the panel's single scroll region instead of nesting up to three
   * scrollbars inside it.
   */
  /**
   * Each pane carries a little padding of its own, so the staged and unstaged
   * cards read as separate containers instead of two halves of one block. The
   * wrapper's inset is what lines their outer edge up with the rows above.
   */
  paneClass = 'flex flex-col p-1'
}
