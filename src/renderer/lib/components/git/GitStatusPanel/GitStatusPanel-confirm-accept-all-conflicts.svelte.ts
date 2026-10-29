import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { buildCommitTree } from '../git-status-panel-format'
import {
  assignAgentToPullRequest as assignAgentToPullRequestAction,
  openAgentThread as openAgentThreadAction
} from '../git-status-panel-agent-actions'
import type { GitCommitInfo, GitConflictSide } from '$shared/types'
import { type PrDetailTabId, type PrMetadataMode } from '../pr-view'
import { gitPanelView } from '$lib/stores/git-panel-view.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import type { PullRequestSummary } from '$shared/types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelConfirmAcceptAllConflicts {
  #root: GitStatusPanel | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): GitStatusPanel {
    if (!this.#root)
      throw new Error('GitStatusPanelConfirmAcceptAllConflicts read its board before it was bound')
    return this.#root
  }
  constructor(root: GitStatusPanel) {
    this.#root = root
  }
  /** Why the Oven could not answer, for the surface overlay, or null. */
  ovenError = $derived(
    this.root.confirmPrMerge.ovenTarget
      ? (gitState.workingTreeError ?? this.root.loadRepoState.preflightError)
      : null
  )

  // Hiding the sidebar destroys and recreates this component, so the tab/
  // selection state is seeded from (and mirrored back into) a persisted
  // view-state store keyed by project+thread to survive that remount.
  initialViewState(): ReturnType<typeof gitPanelView.get> {
    return gitPanelView.get(this.root.props.projectId, this.root.props.threadId)
  }

  preflightDetail = $state('')

  changesView = $state<'list' | 'tree'>(this.root.handlePrListAction.savedView.changesView)

  commitSelection = $state(false)

  /**
   * The commit and paths waiting on the rewrite confirmation: taking a file's
   * change out of a commit moves the branch, so it is asked for first.
   */
  removeCommitChangesConfirm = $state<{ hash: string; paths: string[] } | null>(null)

  /** The pull request a metadata picker is editing, or null when none is open. */
  prMetadata = $state<{ pr: PullRequestSummary; mode: PrMetadataMode } | null>(null)

  /**
   * The view the detail reader is showing, mirrored so the header's check pill
   * can open Checks without reaching into the reader.
   */
  prDetailTab = $state<PrDetailTabId>('conversation')

  /** One PR check-directed workflow run to reveal in the Deployments tab. */
  requestedWorkflowRunId = $state<number | null>(null)

  loadingCommitDiff = $state(false)

  /** Directories collapsed by the user in the commit diff's tree view   expanded by default. */
  commitTreeCollapsedDirs = $state<Record<string, boolean>>({})

  localBranches = $derived(
    gitState.branches.filter((branch) => branch.kind === 'local' && branch.worktreePath === null)
  )

  localBranchNames = $derived(new SvelteSet(this.localBranches.map((branch) => branch.name)))

  isHeadCommit = $derived(
    this.root.handlePrListAction.selectedCommit !== null &&
      this.root.loadRepoState.commitHistory[0]?.hash ===
        this.root.handlePrListAction.selectedCommit.hash
  )

  commitTree = $derived(buildCommitTree(this.root.handlePrListAction.commitDiffChanges))

  assignAgentToPullRequest(pr: PullRequestSummary): void {
    void assignAgentToPullRequestAction(this.root.props.projectId, pr)
  }

  openAgentThread(threadId: string): void {
    void openAgentThreadAction(this.root.props.projectId, threadId)
  }

  /** Infinite scroll for the History tab   the panel's tabs share one scroll container. */
  handleContentScroll(event: Event): void {
    if (this.root.handlePrListAction.activeTab !== 'history') return
    const el = event.currentTarget as HTMLDivElement
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200)
      void this.root.loadRepoState.loadMoreHistory()
  }

  toggleCommitDir(path: string): void {
    this.commitTreeCollapsedDirs = {
      ...this.commitTreeCollapsedDirs,
      [path]: !(this.commitTreeCollapsedDirs[path] ?? false)
    }
  }

  canGoNewer = $derived(this.root.loadRepoState.selectedCommitIndex > 0)

  requestDeleteCommit(commit: GitCommitInfo): void {
    this.root.handlePrListAction.deleteCommitTarget = commit
  }

  /** Take files out of the commit the panel has open. Destructive, so asked first. */
  requestRemoveCommitChanges(paths: string[]): void {
    const commit = this.root.handlePrListAction.selectedCommit
    if (!commit || paths.length === 0) return
    this.removeCommitChangesConfirm = { hash: commit.hash, paths }
  }

  onCommitMessageKeydown(event: KeyboardEvent): void {
    // Enter never commits by itself   only Cmd/Ctrl+Enter does, so writing a
    // multi-line message can never fire the commit early.
    if (!keymapState.matches('git-commit', event)) return
    event.preventDefault()
    void this.root.handlePrListAction.commitInline()
  }

  /**
   * The remote URL as a plain string. `primaryRemote` is a fresh object on
   * every 8s refresh, so deriving the identity straight off it would hand the
   * PR components a new `identity` prop each tick and re-fire their fetch
   * effects. A string compares by value and stops the churn here.
   */
  primaryRemoteUrl = $derived(this.root.loadRepoState.primaryRemote?.url ?? '')

  /**
   * The active scope's bucket. Sync lives behind `showsSync`, so this is what
   * tells the header whether the panel is looking at a managed worktree.
   */
  activeScopeBucket = $derived(
    scopeState.bucketFor(this.root.props.projectId, this.root.props.scopeBucketId)
  )

  showsActionRow = $derived(
    this.root.handlePrListAction.showsViewContext || this.root.loadRepoState.showsRemoteActions
  )

  /**
   * Stop choosing for the user: the next pull opens the chooser again, the same
   * preference the Settings page writes.
   */
  askEveryPull(): void {
    this.root.confirmPrMerge.savePullPreference('ask')
  }

  completeMergeBusy = $derived(gitState.isBusy(['commit', 'push']))

  /**
   * Accept-all is destructive: the other side of every conflicted file is
   * discarded, so it asks before it runs, like Abort does.
   */
  acceptConflictsSide = $state<GitConflictSide | null>(null)

  requestAcceptAllConflicts(side: GitConflictSide): void {
    this.acceptConflictsSide = side
  }

  async confirmAcceptAllConflicts(): Promise<void> {
    const side = this.acceptConflictsSide
    this.acceptConflictsSide = null
    if (!side) return
    await gitState.acceptConflictSide(this.root.props.projectId, side)
    if (gitState.error) return
    void this.root.handlePrListAction.refreshStatus()
  }

  conflictSections = $derived(
    this.root.loadRepoState.fileSections.filter((section) => section.title === 'Conflicts')
  )

  stagedSections = $derived(
    this.root.loadRepoState.fileSections.filter((section) => section.title === 'Staged')
  )

  workingSections = $derived(
    this.root.loadRepoState.fileSections.filter(
      (section) => section.title !== 'Staged' && section.title !== 'Conflicts'
    )
  )
}
