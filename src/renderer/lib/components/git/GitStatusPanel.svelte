<script lang="ts">
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import {
    invalidateRepositoryPreflight,
    loadRepositoryPreflight
  } from '$lib/repository-preflight-cache'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { cachedHasDeployments, cacheHasDeployments } from '$lib/git-deployments-cache'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import { buildCommitTree, fileDiffKey, relativeTime } from './git-status-panel-format'
  import {
    diagnoseDeployment,
    diagnoseWorkflowJob,
    openReviewThread as openReviewThreadAction,
    preparePrConflictSession,
    resolveCurrentConflictsWithAgent,
    resolvePrConflictsWithAgent,
    startAgentReview as startAgentReviewAction
  } from './git-status-panel-agent-actions'
  import type {
    GitBranchInfo,
    GitCommitInfo,
    GitConflictSide,
    GitDiff,
    GitFileChange,
    GitPullStrategy,
    GitSyncDirection,
    GitRebaseAction,
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubUser,
    GitHubWorkflowRun,
    GitResetMode,
    GitRemoteUpdate,
    GitRestoreTarget,
    GitStashEntry,
    ThreadStatus
  } from '$shared/types'
  import {
    Archive,
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpFromLine,
    Bot,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleCheck,
    Download,
    ExternalLink,
    FileDiff,
    FolderGit2,
    GitBranch,
    GitCommit,
    GitCommitHorizontal,
    GitGraph,
    GitMerge,
    GitPullRequest,
    Info,
    Loader2,
    Maximize2,
    MoreHorizontal,
    NetworkIcon,
    Play,
    Plus,
    RefreshCw,
    Rocket,
    RotateCcwClock,
    Search,
    SkipForward,
    Trash2,
    TriangleAlert
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import BranchPicker from './BranchPicker.svelte'
  import CommitActionsMenu from './CommitActionsMenu.svelte'
  import GitHubAccountMenu from './GitHubAccountMenu.svelte'
  import GitStatusPanelBranchesView from './GitStatusPanelBranchesView.svelte'
  import GitStatusPanelConfirmDialogs from './GitStatusPanelConfirmDialogs.svelte'
  import GitStatusPanelChangesView from './GitStatusPanelChangesView.svelte'
  import GitStatusPanelCommitComposer from './GitStatusPanelCommitComposer.svelte'
  import GitStatusPanelCommitSearch from './GitStatusPanelCommitSearch.svelte'
  import GitStatusPanelNotices from './GitStatusPanelNotices.svelte'
  import GitStatusPanelRepoStates from './GitStatusPanelRepoStates.svelte'
  import GitStatusPanelDialogs from './GitStatusPanelDialogs.svelte'
  import GitStatusPanelStashesView from './GitStatusPanelStashesView.svelte'
  import GitSyncButton from './GitSyncButton.svelte'
  import GitSyncPeerDialog from './GitSyncPeerDialog.svelte'
  import { reportSyncResult } from './git-sync-copy'
  import GitGraphView from './GitGraphView.svelte'
  import GitPullRequestList from './GitPullRequestList.svelte'
  import GitPullRequestDetail from './GitPullRequestDetail.svelte'
  import GitDeploymentsMonitor from './GitDeploymentsMonitor.svelte'
  import PrViewSwitcher from './PrViewSwitcher.svelte'
  import { stateGlyph, stateGlyphClass, stateLabel } from './deployment-state'
  import { PR_DETAIL_VIEWS, prViewCount } from './pr-view'
  import GitViewMenu from './GitViewMenu.svelte'
  import PrIdentityRow from './PrIdentityRow.svelte'
  import PrListOptionsMenu from './PrListOptionsMenu.svelte'
  import PrStateFilter from './PrStateFilter.svelte'
  import { type PrDetailTabId } from './pr-view'

  import FullscreenPanelDialog from '../workspace/FullscreenPanelDialog.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { gitPanelView, type GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { PrListFilter, PrListSort, PrState, PullRequestSummary } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    scopeBucketId?: string
  }

  let { projectId, threadId, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID }: Props = $props()

  /**
   * Health of the scope this panel is attached to. A managed checkout that is
   * gone (or otherwise unhealthy) is why every Git operation here fails, so the
   * panel offers the repair instead of the raw failure text.
   */
  let scopeHealth = $derived(scopeState.healthFor(scopeBucketId, projectId))
  let scopeUnhealthy = $derived(scopeHealth !== undefined && scopeHealth.category !== 'healthy')

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'

  // Hiding the sidebar destroys and recreates this component, so the tab/
  // selection state is seeded from (and mirrored back into) a persisted
  // view-state store keyed by project+thread to survive that remount.
  function initialViewState(): ReturnType<typeof gitPanelView.get> {
    return gitPanelView.get(projectId, threadId)
  }

  const savedView = initialViewState()

  let repoState = $state<RepoState>('loading')
  let preflightDetail = $state('')
  let diffs = $state<Record<string, GitDiff>>({})
  let expanded = $state<Record<string, boolean>>({})
  let loadingDiff = $state<Record<string, boolean>>({})
  let diffErrors = $state<Record<string, string | null>>({})

  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')
  let pushConfirm = $state(false)
  /** Pull strategy chooser, opened by the default `ask` preference or a failed strategy. */
  let pullStrategyOpen = $state(false)
  let pullStrategyError = $state('')
  /**
   * Main-sync strategy chooser, opened by the `ask` preference, a failure, or
   * always when sending commits out of this checkout (that mutates a branch the
   * user is not looking at).
   */
  let syncMainOpen = $state(false)
  let syncMainError = $state('')
  /** Which direction the chooser and its actions apply to. */
  let syncDirection = $state<GitSyncDirection>('from')
  /**
   * Peer chooser, opened from the Sync menu's branch entries. It owns the other
   * end's selection and the sync itself, so the panel only says which direction
   * the user started from.
   */
  let syncPeerOpen = $state(false)
  let syncPeerDirection = $state<GitSyncDirection>('from')
  /** Divergence recovery dialog: the branch is behind the remote, push was rejected. */
  let pushDiverged = $state(false)
  /** Which recovery action is running ('merge' | 'rebase'), to disable the buttons. */
  let pushRecoverMode = $state<'merge' | 'rebase' | null>(null)
  let showIntegrateModal = $state(false)
  let showStashModal = $state(false)
  let stashMessage = $state('')
  let stashPaths = $state<string[] | null>(null)
  let stashDropTarget = $state<GitStashEntry | null>(null)
  let mergeTarget = $state('')
  let pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)
  let checkoutConfirm = $state<GitBranchInfo | null>(null)
  let deleteBranchConfirm = $state<string | null>(null)
  let forceDeleteBranchConfirm = $state<string | null>(null)
  /** Remote-branch delete confirmation: which remote and which branch name. */
  let deleteRemoteBranchConfirm = $state<{ remote: string; name: string } | null>(null)
  let creatingBranch = $state(false)
  let newBranchName = $state('')
  /** Add/Replace Git Origin modal on the branch picker. */
  let originModalOpen = $state(false)
  let originMode = $state<'add' | 'replace'>('add')
  let originName = $state('origin')
  let originUrl = $state('')
  let originBusy = $state(false)
  /** Destructive confirmation that a replace-origin is intended. */
  let originReplaceConfirm = $state(false)
  let acknowledgeActiveTurn = $state(false)
  let agentTurnActive = $state(false)
  let activeTab = $state<GitPanelTabId>(savedView.activeTab)
  let changesView = $state<'list' | 'tree'>(savedView.changesView)
  let selectedPaths = $state<Record<string, boolean>>({})
  let discardConfirm = $state<string[] | null>(null)
  let restoreWorktreeConfirm = $state<{ source: string; path: string } | null>(null)
  let commitSelection = $state(false)
  let commitHistory = $state<GitCommitInfo[]>([])
  /**
   * Where each batch of commits reached the upstream, newest first, read from
   * the upstream ref's reflog. Empty when the branch has no remote-tracking
   * upstream or git kept no reflog for it, in which case the graph falls back to
   * its single unpushed boundary.
   */
  let remoteUpdates = $state.raw<GitRemoteUpdate[]>([])
  /** Invalidates an in-flight reflog read whose drift has already moved on. */
  let remoteUpdatesRequestId = 0
  let loadingHistory = $state(false)
  let loadingMoreHistory = $state(false)
  let commitSearchQuery = $state('')
  let commitSearchResults = $state.raw<GitCommitInfo[]>([])
  let commitSearchLoading = $state(false)
  let commitSearchActiveIndex = $state(0)
  let commitSearchRequestId = 0
  /** Invalidated whenever the panel swaps scope buckets, so a history page
   *  fetched for the previous worktree can never land in the new one's list. */
  let historyRequestId = 0
  /** False once a page comes back shorter than requested   there's nothing older left. */
  let historyHasMore = $state(true)
  const HISTORY_PAGE_SIZE = 30
  let commitMessage = $state('')
  let selectedCommit = $state<GitCommitInfo | null>(savedView.selectedCommit)
  let commitDiffChanges = $state<GitFileChange[]>([])
  let deleteCommitTarget = $state<GitCommitInfo | null>(null)
  /** Commit whose full record is open in the info dialog. */
  let commitInfoTarget = $state<GitCommitInfo | null>(null)
  let showGitHubSignIn = $state(false)
  let selectedPullRequest = $state<PullRequestSummary | null>(savedView.selectedPullRequest)
  /**
   * Which pull requests the PR view lists, and where its paging stands. Both are
   * panel state rather than list state because the panel draws the filter in its
   * own action row, beside Push and Pull.
   */
  let prListState = $state<PrState>(savedView.prListState)
  let prListFilter = $state<PrListFilter>(savedView.prListFilter)
  let prListSort = $state<PrListSort>(savedView.prListSort)
  let prListPage = $state(1)
  /**
   * The view the detail reader is showing, mirrored so the header's check pill
   * can open Checks without reaching into the reader.
   */
  let prDetailTab = $state<PrDetailTabId>('conversation')

  /**
   * Full screen pull request reader. It mirrors the fullscreen terminal and
   * browser: the reader owns its own tab list, opens from the pull request
   * surfaces, and closes by clearing the active tab id. The list is a tab of
   * its own, so the reader can both browse and read without leaving fullscreen.
   */
  const PR_READER_LIST_TAB = '__pullRequests__'
  let fullscreenPullRequests = $state<PullRequestSummary[]>([])
  let fullscreenPullRequestId = $state<string | null>(null)

  const fullscreenPullRequestTabs = $derived([
    { id: PR_READER_LIST_TAB, title: 'All pull requests' },
    ...fullscreenPullRequests.map((pr) => ({
      id: String(pr.number),
      title: `#${pr.number} ${pr.title}`
    }))
  ])

  const fullscreenActivePullRequest = $derived(
    fullscreenPullRequestId && fullscreenPullRequestId !== PR_READER_LIST_TAB
      ? (fullscreenPullRequests.find((pr) => String(pr.number) === fullscreenPullRequestId) ?? null)
      : null
  )

  /** Opens the reader, adding the pull request as a tab when it is not one yet. */
  function openPullRequestFullscreen(pr: PullRequestSummary | null): void {
    if (!pr) {
      fullscreenPullRequestId = PR_READER_LIST_TAB
      return
    }
    if (!fullscreenPullRequests.some((open) => open.number === pr.number)) {
      fullscreenPullRequests = [...fullscreenPullRequests, pr]
    }
    fullscreenPullRequestId = String(pr.number)
  }

  /**
   * Closes one reader tab, falling back to the last tab still open. The list is
   * the reader's home tab, so closing it closes the reader rather than leaving a
   * close button that does nothing.
   */
  function closeFullscreenPullRequestTab(id: string): void {
    if (id === PR_READER_LIST_TAB) {
      fullscreenPullRequestId = null
      return
    }
    const remaining = fullscreenPullRequests.filter((pr) => String(pr.number) !== id)
    fullscreenPullRequests = remaining
    if (fullscreenPullRequestId !== id) return
    const fallback = remaining.at(-1)
    fullscreenPullRequestId = fallback ? String(fallback.number) : PR_READER_LIST_TAB
  }

  // A full window DOM surface covers the workspace, so the browser's native view
  // has to detach underneath it. This is the same contract the fullscreen
  // terminal and the fullscreen file editor publish.
  $effect(() =>
    browserVisibility.hideWhile(
      'git-pr-reader-fullscreen',
      'fullscreen-surface',
      fullscreenPullRequestId !== null
    )
  )
  let githubConnected = $state(false)
  let githubConfigured = $state(false)
  let githubUser = $state<GitHubUser | null>(null)
  /**
   * Whether the repo has GitHub deployments, which gates the Deployments view.
   * Null means "not read yet": the cache and the project row are both read
   * asynchronously, and treating that as "no deployments" threw a reader out of
   * the Deployments view whenever the panel remounted on a cold cache.
   */
  let hasDeployments = $state<boolean | null>(null)
  /** One PR check-directed workflow run to reveal in the Deployments tab. */
  let requestedWorkflowRunId = $state<number | null>(null)
  /** Re-entrancy guard for the background deployment probe (not rendered). */
  let detectingDeployments = false
  let loadingCommitDiff = $state(false)
  let commitDiffs = $state<Record<string, GitDiff>>({})
  let commitExpanded = $state<Record<string, boolean>>({})
  let loadingCommitDiffFile = $state<Record<string, boolean>>({})
  let commitDiffErrors = $state<Record<string, string | null>>({})
  /** Directories collapsed by the user in the commit diff's tree view   expanded by default. */
  let commitTreeCollapsedDirs = $state<Record<string, boolean>>({})
  let amendMode = $state(false)
  let resetConfirm = $state<{ mode: GitResetMode; target: string } | null>(null)
  let selectedStash = $state<GitStashEntry | null>(savedView.selectedStash)
  /**
   * The deployment or workflow run open in the Deploys view. The panel owns the
   * selection, like every other view's, so its action row can name what is open
   * and its external link can follow it.
   */
  let selectedDeployment = $state<GitHubDeployment | null>(null)
  let selectedRun = $state<GitHubWorkflowRun | null>(null)
  let loadingStashDiff = $state(false)
  let stashDiffChanges = $state<GitFileChange[]>([])
  let stashDiffs = $state<Record<string, GitDiff>>({})
  let stashExpanded = $state<Record<string, boolean>>({})
  let loadingStashDiffFile = $state<Record<string, boolean>>({})
  let stashDiffErrors = $state<Record<string, string | null>>({})

  $effect(() => {
    gitPanelView.set(projectId, threadId, {
      activeTab,
      changesView,
      selectedCommit,
      selectedPullRequest,
      selectedStash,
      prListState,
      prListFilter,
      prListSort
    })
  })

  const resetOptions: Array<{ mode: GitResetMode; label: string; hint: string }> = [
    { mode: 'soft', label: 'Soft', hint: 'keep index + worktree' },
    { mode: 'mixed', label: 'Mixed', hint: 'reset index, keep worktree' },
    { mode: 'hard', label: 'Hard', hint: 'discard all local changes' }
  ]

  const status = $derived(gitState.status)
  const localBranches = $derived(
    gitState.branches.filter((branch) => branch.kind === 'local' && branch.worktreePath === null)
  )
  const worktreeBranches = $derived(
    gitState.branches.filter((branch) => branch.kind === 'local' && branch.worktreePath !== null)
  )
  const localBranchNames = $derived(new Set(localBranches.map((branch) => branch.name)))
  const isHeadCommit = $derived(
    selectedCommit !== null && commitHistory[0]?.hash === selectedCommit.hash
  )
  const changes = $derived(status?.changes ?? [])
  const staged = $derived(
    changes.filter((change) => change.staged && change.status !== 'conflicted')
  )
  const unstaged = $derived(
    changes.filter(
      (change) => !change.staged && change.status !== 'untracked' && change.status !== 'conflicted'
    )
  )
  const untracked = $derived(changes.filter((change) => change.status === 'untracked'))
  const conflicted = $derived(changes.filter((change) => change.status === 'conflicted'))
  /**
   * Selected paths in the order they were picked. Read by the batch actions and by
   * the row's own flags, so it is declared with the other view deriveds rather
   * than beside the actions that consume it.
   */
  const selectedPathList = $derived(Object.keys(selectedPaths))
  const commitTree = $derived(buildCommitTree(commitDiffChanges))
  /** Local commits not yet on the upstream remote, oldest-first-among-them   matches history order. */
  const unpushedCount = $derived(status?.upstream ? Math.max(0, status.ahead) : 0)

  const busy = $derived(gitState.isBusy(['refresh', 'init', 'commit', 'amend', 'reset']))
  const commitBusy = $derived(gitState.isBusy(['commit', 'amend']))
  const batchBusy = $derived(
    gitState.isBusy(['stage', 'unstage', 'commit', 'stash', 'ignore', 'discard'])
  )
  const stashOpBusy = $derived(gitState.isBusy(['stash-pop', 'stash-drop']))

  /**
   * The refresh button: git status, the History pages, and the view in focus.
   *
   * The view's reload goes through the store rather than through a signal the
   * view watches. A view that watched a signal had to call a store method that
   * reads the very record it writes, so a forced reload re-ran its own effect:
   * the PR list and the deployments view refetched forever. The store is what
   * every view renders from, so reloading it is enough.
   */
  async function refreshPanel(): Promise<void> {
    // The button exists to make the panel trustworthy again, and the one thing a
    // cache can be wrong about is whether the directory is still a repository at
    // all, so this re-asks instead of trusting the stored answer.
    await loadRepoState(true)
    await refreshFocusedView()
  }

  /** Force a reload of whatever the active view shows, when the store has it. */
  async function refreshFocusedView(): Promise<void> {
    const identity = githubIdentity
    if (!identity || !githubConnected) return
    if (activeTab === 'pulls') {
      if (selectedPullRequest) {
        await gitState.ensurePullRequestBundle(
          projectId,
          identity.owner,
          identity.repo,
          selectedPullRequest.number,
          true
        )
        return
      }
      await gitState.ensurePullRequestPage(
        projectId,
        identity.owner,
        identity.repo,
        prListState,
        prListPage,
        { filter: prListFilter, sort: prListSort },
        true
      )
      return
    }
    if (activeTab === 'deployments') {
      await gitState.ensureDeploymentOverview(projectId, identity.owner, identity.repo, true)
    }
  }

  async function refreshStatus(): Promise<void> {
    gitState.ensureProjectEvents(projectId)
    await gitState.refresh(projectId)
    // The refresh button must bring the whole panel up to date, including the
    // History tab   its pages are cached client-side and would otherwise keep
    // showing stale commits until a mutation happens to reload them.
    if (activeTab === 'history' || commitHistory.length > 0) await reloadHistory()
  }

  async function loadRepoState(force = false): Promise<void> {
    // Re-checking in place must not blank a panel that is already showing data:
    // the "Checking repository" takeover belongs to the first answer, not to a
    // refresh of one.
    if (!force) repoState = 'loading'
    try {
      // Cached per project, so re-opening the panel does not spawn git again to
      // ask a question whose answer has not changed.
      const snapshot = await loadRepositoryPreflight(projectId, force)
      if (snapshot.hasDeployments !== undefined) {
        // Authoritative database value; reconcile the fast-render cache with it.
        hasDeployments = snapshot.hasDeployments
        cacheHasDeployments(projectId, snapshot.hasDeployments)
      }
      if (!snapshot.path || snapshot.preflight.status === 'not_git') {
        repoState = 'not_git'
        return
      }
      if (snapshot.preflight.status === 'git_unavailable') {
        repoState = 'git_unavailable'
        preflightDetail = snapshot.preflight.detail ?? ''
        return
      }
      repoState = 'git'
      await refreshStatus()
    } catch {
      repoState = 'not_git'
    }
  }

  async function initializeRepository(): Promise<void> {
    await gitState.initialize(projectId)
    // The cached preflight still says "not a repository". Without this the panel
    // would keep reporting that for the rest of the cache's life.
    invalidateRepositoryPreflight(projectId)
    if (gitState.status) repoState = 'git'
  }

  async function toggleDiff(change: GitFileChange): Promise<void> {
    const key = fileDiffKey(change)
    if (expanded[key]) {
      expanded = { ...expanded, [key]: false }
      return
    }
    expanded = { ...expanded, [key]: true }
    diffErrors = { ...diffErrors, [key]: null }
    if (diffs[key]) return
    loadingDiff = { ...loadingDiff, [key]: true }
    try {
      const diff = await gitState.getDiff(projectId, change.path, change.staged)
      diffs = { ...diffs, [key]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      diffErrors = { ...diffErrors, [key]: message }
    } finally {
      loadingDiff = { ...loadingDiff, [key]: false }
    }
  }

  async function toggleStage(change: GitFileChange): Promise<void> {
    if (change.staged) {
      await gitState.unstage(projectId, [change.path])
      return
    }
    await gitState.stage(projectId, [change.path])
    if (!gitState.error) requestCommitMessageFocus()
  }

  async function stageAll(): Promise<void> {
    // Only paths with a worktree-side change (unstaged, untracked, or conflicted
    // work) can be staged; already-staged entries, such as staged deletions,
    // are no-ops for git add.
    const allPaths = [
      ...new Set(changes.filter((change) => !change.staged).map((change) => change.path))
    ].filter((path) => !(gitState.status?.conflicted ?? []).includes(path))
    if (allPaths.length === 0) return
    await gitState.stage(projectId, allPaths)
    if (!gitState.error) requestCommitMessageFocus()
  }

  async function unstageAll(): Promise<void> {
    const allPaths = [...new Set(staged.map((change) => change.path))].filter(
      (path) => !(gitState.status?.conflicted ?? []).includes(path)
    )
    if (allPaths.length === 0) return
    await gitState.unstage(projectId, allPaths)
  }

  async function checkoutBranch(branch: GitBranchInfo): Promise<void> {
    if (branch.kind === 'local') {
      if (branch.name === status?.branch) return
      await gitState.checkout(projectId, branch.ref)
      return
    }
    if (!branch.remote || localBranchNames.has(branch.name)) return
    await gitState.createTrackingBranch(projectId, branch.remote, branch.name)
  }

  async function createBranchAction(name: string): Promise<void> {
    await gitState.createBranch(projectId, name)
  }

  async function deleteBranchAction(name: string, force = false): Promise<void> {
    const result = await gitState.deleteBranch(projectId, name, force)
    if (result === 'requires-force') forceDeleteBranchConfirm = name
  }

  /** Checking out switches the working tree, so it always confirms first from the Branches tab. */
  function requestCheckout(branch: GitBranchInfo): void {
    if (branch.kind === 'local' && branch.name === status?.branch) return
    if (branch.kind === 'remote' && localBranchNames.has(branch.name)) return
    // Git refuses the same branch in two worktrees; those branches are display-only here.
    if (branch.worktreePath !== null) return
    checkoutConfirm = branch
  }

  async function confirmCheckoutBranch(): Promise<void> {
    const target = checkoutConfirm
    if (!target) return
    checkoutConfirm = null
    await checkoutBranch(target)
  }

  function requestDeleteBranch(name: string): void {
    deleteBranchConfirm = name
  }

  async function confirmDeleteBranch(): Promise<void> {
    const target = deleteBranchConfirm
    if (!target) return
    deleteBranchConfirm = null
    await deleteBranchAction(target)
  }

  async function confirmForceDeleteBranch(): Promise<void> {
    const target = forceDeleteBranchConfirm
    if (!target) return
    forceDeleteBranchConfirm = null
    await deleteBranchAction(target, true)
  }

  function requestDeleteRemoteBranch(branch: GitBranchInfo): void {
    const remote = branch.remote
    if (!remote) return
    deleteRemoteBranchConfirm = { remote, name: branch.name }
  }

  async function confirmDeleteRemoteBranch(): Promise<void> {
    const target = deleteRemoteBranchConfirm
    if (!target) return
    deleteRemoteBranchConfirm = null
    await gitState.deleteRemoteBranch(projectId, target.remote, target.name)
  }

  /** `git fetch <remote> <name>`   updates that branch's tracking ref without touching HEAD. */
  async function fetchBranchAction(branch: GitBranchInfo): Promise<void> {
    const remote = branch.remote
    if (!remote) return
    await gitState.fetchBranch(projectId, remote, branch.name)
  }

  async function loadGitHubAuth(): Promise<void> {
    const status = await gitState.githubAuthStatus()
    githubConnected = status.connected
    githubConfigured = status.configured
    githubUser = status.user ?? null
  }

  /**
   * Discover whether the repo has GitHub deployment activity so the Deployments
   * tab can appear on its own. Only meaningful while signed in with a GitHub
   * origin remote. Routes through the store so the probe also warms the overview
   * cache the Deployments tab reads   first visit renders instantly.
   */
  async function detectDeployments(): Promise<void> {
    const identity = githubIdentity
    if (!githubConnected || !identity || detectingDeployments) return
    detectingDeployments = true
    try {
      const overview = await gitState.ensureDeploymentOverview(
        projectId,
        identity.owner,
        identity.repo
      )
      if (overview) {
        hasDeployments = overview.hasDeployments
        cacheHasDeployments(projectId, overview.hasDeployments)
      }
    } catch {
      // Sign-in or network failure   keep the current flag and try again later.
    } finally {
      detectingDeployments = false
    }
  }

  /** Route a GitHub Actions PR check into the matching in-app workflow detail. */
  function openWorkflowRunFromCheck(runId: number): void {
    selectedPullRequest = null
    requestedWorkflowRunId = runId
    hasDeployments = true
    cacheHasDeployments(projectId, true)
    activeTab = 'deployments'
  }

  /** Route a failed workflow run job to a fresh diagnosis thread. */
  function startWorkflowDiagnosis(
    run: GitHubWorkflowRun,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    diagnoseWorkflowJob(projectId, run, job, log)
  }

  /** Route a failed deployment job to a fresh diagnosis thread. */
  function startDeploymentDiagnosis(
    deployment: GitHubDeployment,
    run: GitHubWorkflowRun | null,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    diagnoseDeployment(
      projectId,
      githubIdentity?.owner ?? '',
      githubIdentity?.repo ?? '',
      deployment,
      run,
      job,
      log
    )
  }

  function startAgentReview(pr: PullRequestSummary): void {
    void startAgentReviewAction(projectId, pr)
  }

  function openReviewThread(threadId: string): void {
    void openReviewThreadAction(projectId, threadId)
  }

  /**
   * Resolve a PR's online conflicts manually: check out the PR head locally,
   * merge the base in, and hand the resulting conflicts to the changes-tab
   * conflict UI so the user can fix each file, commit, and push.
   */
  async function resolveConflictsLocally(pr: PullRequestSummary): Promise<void> {
    const prepared = await preparePrConflictSession(
      projectId,
      pr,
      primaryRemote?.name ?? 'origin',
      gitState.status?.branch ?? 'main'
    )
    if (!prepared) return
    selectedPullRequest = null
    activeTab = 'changes'
    void refreshStatus()
  }

  /**
   * Resolve a PR's online conflicts with the agent's help: check out the PR head
   * and merge the base in (so conflicts land in the tree), then hand the agent a
   * thread to resolve the conflict markers. The agent never pushes   the user
   * finishes with Complete merge, which pushes the resolution to the PR and
   * deletes the temporary branch.
   */
  async function startConflictResolution(pr: PullRequestSummary): Promise<void> {
    await resolvePrConflictsWithAgent(
      projectId,
      pr,
      primaryRemote?.name ?? 'origin',
      gitState.status?.branch ?? 'main',
      () => {
        selectedPullRequest = null
        activeTab = 'changes'
      }
    )
  }

  /**
   * Resolve whatever integration is in progress with the agent's help. The
   * conflicts are already in the working tree (a pull, a merge or a rebase), so
   * this only has to hand the agent the brief   the same brief the PR path uses.
   */
  async function resolveConflictsWithAgent(): Promise<void> {
    await resolveCurrentConflictsWithAgent(projectId, status?.branch ?? 'this worktree')
  }

  async function signOutGitHub(): Promise<void> {
    const status = await gitState.logoutGitHub()
    githubConnected = status.connected
    githubConfigured = status.configured
    githubUser = status.user ?? null
  }

  async function saveIdentity(): Promise<void> {
    await gitState.setIdentity(projectId, identityName, identityEmail)
    if (!gitState.error) showIdentityForm = false
  }

  async function refreshAgentTurnState(): Promise<void> {
    if (!threadId) return
    const thread = await invoke('thread:get', projectId, threadId).catch(() => null)
    agentTurnActive = thread?.status === 'executing' || thread?.status === 'planning'
  }

  async function loadHistory(): Promise<void> {
    if (commitHistory.length > 0) return
    loadingHistory = true
    const request = ++historyRequestId
    try {
      const page = await gitState.getLog(projectId, HISTORY_PAGE_SIZE)
      if (request !== historyRequestId) return
      commitHistory = page
      historyHasMore = page.length === HISTORY_PAGE_SIZE
    } finally {
      // A superseded or failed request must never leave the spinner stuck.
      if (request === historyRequestId) loadingHistory = false
    }
  }

  /** Pages in older commits as the history list scrolls toward its end. */
  async function loadMoreHistory(): Promise<void> {
    if (loadingHistory || loadingMoreHistory || !historyHasMore) return
    loadingMoreHistory = true
    const request = ++historyRequestId
    try {
      const page = await gitState.getLog(projectId, HISTORY_PAGE_SIZE, commitHistory.length)
      if (request !== historyRequestId) return
      commitHistory = [...commitHistory, ...page]
      historyHasMore = page.length === HISTORY_PAGE_SIZE
    } finally {
      if (request === historyRequestId) loadingMoreHistory = false
    }
  }

  /**
   * Read the upstream ref's reflog: git stamps every movement of that ref, which
   * is the only native record of when commits actually reached the remote.
   * `remoteUpdatesRequestId` drops an answer whose drift has already moved on.
   */
  async function loadRemoteUpdates(): Promise<void> {
    const request = ++remoteUpdatesRequestId
    const updates = await gitState.getRemoteUpdates(projectId)
    if (request !== remoteUpdatesRequestId) return
    remoteUpdates = updates
  }

  /**
   * The drift this panel has with its upstream, plus the worktree it belongs to.
   * Pushing and fetching both move it, and both add a reflog entry, so it is the
   * cheap signal that the batch boundaries in the graph are out of date. The
   * scope bucket is part of the key so a worktree swap always re-reads, even
   * when two checkouts happen to sit at the same drift.
   */
  const remoteUpdatesKey = $derived(
    status?.upstream === null || status?.upstream === undefined
      ? null
      : [scopeBucketId ?? '', status.upstream, String(status.ahead), String(status.behind)].join(
          '|'
        )
  )

  /** Infinite scroll for the History tab   the panel's tabs share one scroll container. */
  function handleContentScroll(event: Event): void {
    if (activeTab !== 'history') return
    const el = event.currentTarget as HTMLDivElement
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMoreHistory()
  }

  /** Switch the panel's view. History is the one view that pages its data in. */
  function selectTab(id: GitPanelTabId): void {
    activeTab = id
    if (id === 'history') void loadHistory()
  }

  /**
   * Switch which pull requests the PR view lists. The filter is the panel's, so
   * the page it belonged to goes with it: page 4 of the closed list has nothing
   * to do with page 4 of the open one.
   */
  function selectPrListState(next: PrState): void {
    if (next === prListState) return
    prListState = next
    prListPage = 1
  }

  /**
   * Switch which relationship the PR view keeps, or how it orders the result.
   * Both are the panel's, so the page goes with them: page 4 of "everything" has
   * nothing to do with page 4 of "authored by me".
   */
  function selectPrListFilter(next: PrListFilter): void {
    if (next === prListFilter) return
    prListFilter = next
    prListPage = 1
  }

  function selectPrListSort(next: PrListSort): void {
    if (next === prListSort) return
    prListSort = next
    prListPage = 1
  }

  function openCommitSearch(): void {
    findNavState.openGitFind()
  }

  function closeCommitSearch(): void {
    commitSearchRequestId++
    commitSearchQuery = ''
    commitSearchResults = []
    commitSearchLoading = false
    commitSearchActiveIndex = 0
    findNavState.closeGitFind()
  }

  async function searchCommits(rawQuery: string): Promise<void> {
    const query = rawQuery.trim()
    commitSearchQuery = query
    commitSearchActiveIndex = 0
    const requestId = ++commitSearchRequestId
    if (!query) {
      commitSearchResults = []
      commitSearchLoading = false
      return
    }

    commitSearchResults = []
    commitSearchLoading = true
    const results = await gitState.getLog(projectId, 50, 0, query)
    if (requestId !== commitSearchRequestId) return
    commitSearchResults = results
    commitSearchLoading = false
  }

  function moveCommitSearch(direction: -1 | 1): void {
    if (commitSearchResults.length === 0) return
    commitSearchActiveIndex =
      (commitSearchActiveIndex + direction + commitSearchResults.length) %
      commitSearchResults.length
  }

  function openActiveCommitSearchResult(): void {
    const commit = commitSearchResults[commitSearchActiveIndex]
    if (!commit) return
    closeCommitSearch()
    void selectCommit(commit)
  }

  function selectCommitSearchResult(commit: GitCommitInfo): void {
    closeCommitSearch()
    void selectCommit(commit)
  }

  async function selectCommit(commit: GitCommitInfo): Promise<void> {
    selectedCommit = commit
    activeTab = 'changes'
    loadingCommitDiff = true
    commitDiffChanges = await gitState.getCommitDiff(projectId, commit.hash)
    commitDiffs = {}
    commitExpanded = {}
    loadingCommitDiffFile = {}
    commitDiffErrors = {}
    commitTreeCollapsedDirs = {}
    loadingCommitDiff = false
  }

  function toggleCommitDir(path: string): void {
    commitTreeCollapsedDirs = {
      ...commitTreeCollapsedDirs,
      [path]: !(commitTreeCollapsedDirs[path] ?? false)
    }
  }

  const selectedCommitIndex = $derived.by(() => {
    const current = selectedCommit
    if (!current) return -1
    return commitHistory.findIndex((commit) => commit.hash === current.hash)
  })
  const canGoNewer = $derived(selectedCommitIndex > 0)
  const canGoOlder = $derived(
    selectedCommitIndex >= 0 && (selectedCommitIndex < commitHistory.length - 1 || historyHasMore)
  )

  async function navigateCommit(direction: -1 | 1): Promise<void> {
    const index = selectedCommitIndex
    const next = index + direction
    if (next >= commitHistory.length - 1 && direction > 0 && historyHasMore) {
      await loadMoreHistory()
    }
    const commit = commitHistory[next]
    if (commit) void selectCommit(commit)
  }

  function clearSelectedCommit(): void {
    selectedCommit = null
    commitDiffChanges = []
    commitDiffs = {}
    commitExpanded = {}
    loadingCommitDiffFile = {}
    commitDiffErrors = {}
  }

  async function toggleCommitDiff(change: GitFileChange): Promise<void> {
    const commit = selectedCommit
    if (!commit) return
    if (commitExpanded[change.path]) {
      commitExpanded = { ...commitExpanded, [change.path]: false }
      return
    }
    commitExpanded = { ...commitExpanded, [change.path]: true }
    commitDiffErrors = { ...commitDiffErrors, [change.path]: null }
    if (commitDiffs[change.path]) return
    loadingCommitDiffFile = { ...loadingCommitDiffFile, [change.path]: true }
    try {
      const diff = await gitState.getCommitFileDiff(projectId, commit.hash, change.path)
      commitDiffs = { ...commitDiffs, [change.path]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      commitDiffErrors = { ...commitDiffErrors, [change.path]: message }
    } finally {
      loadingCommitDiffFile = { ...loadingCommitDiffFile, [change.path]: false }
    }
  }

  async function selectStash(stash: GitStashEntry): Promise<void> {
    selectedStash = stash
    loadingStashDiff = true
    stashDiffChanges = await gitState.getStashDiff(projectId, stash.id)
    stashDiffs = {}
    stashExpanded = {}
    loadingStashDiffFile = {}
    stashDiffErrors = {}
    loadingStashDiff = false
  }

  function clearSelectedStash(): void {
    selectedStash = null
    stashDiffChanges = []
    stashDiffs = {}
    stashExpanded = {}
    loadingStashDiffFile = {}
    stashDiffErrors = {}
  }

  async function toggleStashDiff(change: GitFileChange): Promise<void> {
    const stash = selectedStash
    if (!stash) return
    if (stashExpanded[change.path]) {
      stashExpanded = { ...stashExpanded, [change.path]: false }
      return
    }
    stashExpanded = { ...stashExpanded, [change.path]: true }
    stashDiffErrors = { ...stashDiffErrors, [change.path]: null }
    if (stashDiffs[change.path]) return
    loadingStashDiffFile = { ...loadingStashDiffFile, [change.path]: true }
    try {
      const diff = await gitState.getStashFileDiff(projectId, stash.id, change.path)
      stashDiffs = { ...stashDiffs, [change.path]: diff }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The diff could not be loaded'
      stashDiffErrors = { ...stashDiffErrors, [change.path]: message }
    } finally {
      loadingStashDiffFile = { ...loadingStashDiffFile, [change.path]: false }
    }
  }

  function startAmend(): void {
    const commit = selectedCommit
    if (!commit) return
    commitMessage = commit.message.split('\n')[0]
    amendMode = true
    clearSelectedCommit()
    activeTab = 'changes'
  }

  function requestReset(mode: GitResetMode, target: string): void {
    resetConfirm = { mode, target }
    acknowledgeActiveTurn = false
  }

  function requestDeleteCommit(commit: GitCommitInfo): void {
    deleteCommitTarget = commit
  }

  async function confirmDeleteCommit(): Promise<void> {
    const target = deleteCommitTarget
    if (!target) return
    deleteCommitTarget = null
    await gitState.deleteCommit(projectId, target.hash)
    if (!gitState.error) {
      clearSelectedCommit()
      void reloadHistory()
      void refreshStatus()
    }
  }

  async function copyCommitHash(commit: GitCommitInfo): Promise<void> {
    try {
      await copyText(commit.hash)
    } catch {
      // Clipboard may be unavailable; nothing else to do.
    }
  }

  async function copyCommitMessage(commit: GitCommitInfo): Promise<void> {
    try {
      await copyText(commit.message)
    } catch {
      // Clipboard may be unavailable; nothing else to do.
    }
  }

  async function confirmReset(): Promise<void> {
    const pending = resetConfirm
    if (!pending) return
    resetConfirm = null
    await gitState.reset(projectId, pending.mode, pending.target)
    if (!gitState.error) {
      clearSelectedCommit()
      void reloadHistory()
      void refreshStatus()
    }
  }

  async function commitInline(): Promise<void> {
    if (!commitMessage.trim()) return
    if (amendMode) {
      await gitState.amend(projectId, commitMessage)
    } else {
      if (staged.length === 0) return
      await gitState.commit(projectId, commitMessage)
    }
    if (!gitState.error) {
      commitMessage = ''
      amendMode = false
      // The committed files have left the panel   drop their selection so the
      // "N selected" counter next to "Stage all" doesn't point at ghosts.
      clearSelection()
      void refreshStatus()
      void reloadHistory()
    }
  }

  function onCommitMessageKeydown(event: KeyboardEvent): void {
    // Enter never commits by itself   only Cmd/Ctrl+Enter does, so writing a
    // multi-line message can never fire the commit early.
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void commitInline()
  }

  async function reloadHistory(): Promise<void> {
    commitHistory = []
    historyHasMore = true
    await loadHistory()
  }

  /**
   * Swap to another scope bucket (a sibling worktree) without remounting:
   * clear every piece of view state scoped to the previous bucket so its
   * changes, commits, stashes and pending dialogs can never bleed into the
   * new target, then refetch. Repo availability checks and GitHub auth stay
   * untouched   they belong to the project, not the bucket   which is what
   * keeps scoped thread switches free of a full loading flash.
   */
  function resetForScopeSwap(): void {
    historyRequestId += 1
    remoteUpdatesRequestId += 1
    remoteUpdates = []
    closeCommitSearch()
    selectedCommit = null
    selectedStash = null
    selectedPaths = {}
    amendMode = false
    commitSelection = false
    diffs = {}
    expanded = {}
    loadingDiff = {}
    diffErrors = {}
    commitDiffChanges = []
    commitDiffs = {}
    commitExpanded = {}
    loadingCommitDiff = false
    loadingCommitDiffFile = {}
    commitDiffErrors = {}
    commitTreeCollapsedDirs = {}
    deleteCommitTarget = null
    stashDiffChanges = []
    stashDiffs = {}
    stashExpanded = {}
    loadingStashDiff = false
    loadingStashDiffFile = {}
    stashDiffErrors = {}
    stashDropTarget = null
    pendingOperation = null
    checkoutConfirm = null
    deleteBranchConfirm = null
    forceDeleteBranchConfirm = null
    deleteRemoteBranchConfirm = null
    creatingBranch = false
    newBranchName = ''
    discardConfirm = null
    resetConfirm = null
    pushConfirm = false
    pushDiverged = false
    pushRecoverMode = null
    pullStrategyOpen = false
    pullStrategyError = ''
    syncMainOpen = false
    syncMainError = ''
    showIntegrateModal = false
    showStashModal = false
    stashMessage = ''
    stashPaths = null
    void refreshStatus()
    void reloadHistory()
  }

  $effect(() => {
    // Claim this project+scope before anything else reads/writes shared state
    // so a previous target's data can never be shown or overwrite this view.
    // Runs for scope swaps too   the shared git store targets exactly one
    // worktree at a time, so switching threads must retarget it even though
    // this component stays mounted.
    gitState.activate(projectId, scopeBucketId)
    // Attaching the panel to a scope is an interaction with it, so re-read the
    // checkout's live state (throttled) for the banner below.
    void scopeState.revalidateWorktreeHealth(projectId, scopeBucketId).catch(() => undefined)
  })

  // A Git failure in a scope-backed panel usually means the checkout is gone:
  // re-read the scope's health so the repair banner replaces the bare error.
  $effect(() => {
    if (!gitState.error) return
    void scopeState.revalidateWorktreeHealth(projectId, scopeBucketId, { force: true })
  })

  /** Project-scope bootstrap. Runs on mount and when the panel is aimed at a
   *  different project. Deliberately NOT re-run when only the scope bucket
   *  changes: repo/git availability is a property of the project path, and
   *  re-running it would flash the full-panel loading state on every scoped
   *  thread switch. */
  $effect(() => {
    hasDeployments = cachedHasDeployments(projectId) ?? null
    void loadRepoState()
  })

  /** Mirrors of the last target the swap logic saw. Plain (non-$state) locals
   *  on purpose: writing them inside an effect must not create dependencies,
   *  they only exist to tell first mount, project changes and pure scope
   *  swaps apart. */
  let appliedProjectId = ''
  let appliedScopeBucketId = ''
  $effect(() => {
    if (appliedProjectId === '') {
      // First run   the bootstrap effect above owns initial loading.
      appliedProjectId = projectId
      appliedScopeBucketId = scopeBucketId
      return
    }
    if (projectId !== appliedProjectId) {
      // Project change   full reload is handled by the bootstrap effect.
      appliedProjectId = projectId
      appliedScopeBucketId = scopeBucketId
      return
    }
    if (scopeBucketId === appliedScopeBucketId) return
    appliedScopeBucketId = scopeBucketId
    // Scope-only change (thread switch between worktrees): reset scope-local
    // view state in place, then refetch status/history against the new bucket.
    resetForScopeSwap()
  })

  $effect(() => {
    void refreshAgentTurnState()
  })

  $effect(() => {
    // Loaded eagerly (not just when the History tab opens) so the composer
    // knows whether there's a commit to amend before the user gets there.
    if (repoState === 'git' || activeTab === 'history') void loadHistory()
  })

  $effect(() => {
    // The graph's push boundaries lag behind the repository until this re-reads,
    // and this effect is what re-reads: `remoteUpdatesKey` is the panel's drift
    // with its upstream, which only a push or a fetch moves.
    if (repoState !== 'git' || remoteUpdatesKey === null) return
    void loadRemoteUpdates()
  })

  $effect(() => {
    void loadGitHubAuth()
  })

  $effect(() => {
    // When the user is signed in and the repo points at GitHub, probe for
    // deployment activity in the background and surface the view if found.
    if (repoState === 'git' && githubConnected && hasDeployments !== true && githubIdentity) {
      void detectDeployments()
    }
  })

  $effect(() => {
    // The Deployments view only exists while the flag does   fall back to
    // Changes when it is *known* to be gone (e.g. after switching to a project
    // without them). While it is still unknown the view stays put: the project
    // row has not answered yet, and that is not the same as "none".
    if (activeTab === 'deployments' && hasDeployments === false) activeTab = 'changes'
  })

  onMount(() => {
    gitState.ensureProjectEvents(projectId)
    const unsubscribePullRequestOpen = gitPanelView.onPullRequestOpen(
      (requestedProjectId, requestedThreadId, pullRequest) => {
        if (requestedProjectId !== projectId || requestedThreadId !== threadId) return
        selectedPullRequest = pullRequest
        activeTab = 'pulls'
      }
    )
    // Agent-turn state is event-driven: main broadcasts `thread:updated` on
    // every status transition (planning/executing/completed/failed), so the
    // panel reacts to those instead of polling. The one-shot fetch of the
    // current status lives in the `refreshAgentTurnState` $effect above.
    const unsubscribeThreadUpdates = subscribe('thread:updated', (...args: unknown[]) => {
      const thread = args[0] as
        { projectId?: string; id?: string; status?: ThreadStatus } | undefined
      if (thread && thread.projectId === projectId && thread.id === threadId) {
        agentTurnActive = thread.status === 'executing' || thread.status === 'planning'
      }
    })
    return () => {
      unsubscribePullRequestOpen()
      unsubscribeThreadUpdates()
      if (findNavState.gitFindOpen) closeCommitSearch()
    }
  })

  const identityNeeded = $derived(
    repoState === 'git' && gitState.identity !== null && !gitState.identity.configured
  )

  const remotes = $derived(gitState.remotes)
  const primaryRemote = $derived(
    remotes.find((remote) => remote.name === 'origin') ?? remotes[0] ?? null
  )
  /**
   * The remote URL as a plain string. `primaryRemote` is a fresh object on
   * every 8s refresh, so deriving the identity straight off it would hand the
   * PR components a new `identity` prop each tick and re-fire their fetch
   * effects. A string compares by value and stops the churn here.
   */
  const primaryRemoteUrl = $derived(primaryRemote?.url ?? '')
  /** `owner/repo` when origin points at GitHub   the PR tab needs it to query. */
  const githubIdentity = $derived.by(() => {
    const url = primaryRemoteUrl
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
    const owner = match?.[1] ?? ''
    const repo = match?.[2] ?? ''
    return owner && repo ? { owner, repo } : null
  })
  /**
   * Remote-tracking ref names, used to recognise a commit the remote already
   * has without asking git: a commit wearing one of these decorations is on the
   * remote by definition.
   */
  const remoteTrackingRefs = $derived(
    new Set(
      gitState.branches.filter((branch) => branch.kind === 'remote').map((branch) => branch.ref)
    )
  )
  /**
   * Whether GitHub can show the commit open in the info dialog. History is
   * `HEAD`'s log, so anything at or below the unpushed boundary the graph draws
   * is already upstream; a commit outside the loaded page has to wear a
   * remote-tracking ref to qualify.
   */
  const commitInfoOnRemote = $derived.by(() => {
    const target = commitInfoTarget
    if (!target) return false
    if (target.refs.some((ref) => remoteTrackingRefs.has(ref.name))) return true
    if (!status?.upstream) return false
    return commitHistory.findIndex((commit) => commit.hash === target.hash) >= unpushedCount
  })
  const commitInfoUrl = $derived(
    githubIdentity && commitInfoTarget
      ? `https://github.com/${encodeURIComponent(githubIdentity.owner)}/${encodeURIComponent(githubIdentity.repo)}/commit/${commitInfoTarget.hash}`
      : null
  )
  /**
   * The open deployment's state, read from the same store record the detail body
   * renders, so the action row and the page below it cannot disagree.
   */
  const openDeploymentState = $derived.by(() => {
    const deployment = selectedDeployment
    const identity = githubIdentity
    if (!deployment || !identity) return 'unknown'
    const cached =
      gitState.deploymentDetails[
        GitState.deploymentDetailKey(identity.owner, identity.repo, deployment.id)
      ]
    return (
      cached?.detail.deployment.latestStatus?.state ?? deployment.latestStatus?.state ?? 'unknown'
    )
  })
  /** A run's state is its conclusion once it is done, its status until then. */
  const openRunState = $derived.by(() => {
    const run = selectedRun
    if (!run) return 'unknown'
    return run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
  })
  /**
   * Where the Deploys view's external link points: the deployment page, the run,
   * or the repository's Actions when neither is open. It replaces the per-view
   * external buttons the detail pages used to carry.
   */
  const deploymentsExternal = $derived.by(() => {
    const identity = githubIdentity
    if (!identity) return null
    const repository = `https://github.com/${identity.owner}/${identity.repo}`
    if (selectedDeployment) {
      return {
        url: `${repository}/deployments/${String(selectedDeployment.id)}`,
        title: 'Open this deployment on GitHub'
      }
    }
    if (selectedRun?.url) {
      return { url: selectedRun.url, title: 'Open this workflow run on GitHub' }
    }
    return { url: `${repository}/actions`, title: 'View these workflow runs on GitHub' }
  })
  /**
   * The reader's views with their counts, for the switcher in the action row. The
   * counts come from the same bundle the reader renders, so the switcher and the
   * rail agree.
   */
  const prDetailViews = $derived(
    PR_DETAIL_VIEWS.map((view) => ({
      ...view,
      count: prViewCount(
        view.id,
        pullRequestBundle,
        (
          (selectedPullRequest
            ? gitState.prAgentReports[String(selectedPullRequest.number)]?.content
            : '') ?? ''
        ).trim().length > 0
      )
    }))
  )

  /**
   * The open pull request's fetched record. The reader reads the same bundle
   * from the store, so the panel's identity row and its pills cannot show one
   * thing while the reader shows another.
   */
  const pullRequestBundle = $derived(
    githubIdentity && selectedPullRequest
      ? gitState.prBundles[
          GitState.bundleKey(githubIdentity.owner, githubIdentity.repo, selectedPullRequest.number)
        ]
      : undefined
  )
  const needsUpstreamPush = $derived(
    Boolean(status?.branch) && !status?.detached && status?.upstream === null
  )
  /**
   * Whether the remote already carries a branch under this name, read from the
   * last branch refresh. A branch without an upstream is not necessarily a
   * branch the remote has never seen, and the confirmation has to name which
   * of the two this push does: publish a new remote branch, or start tracking
   * the one that is already there.
   */
  const remoteBranchExists = $derived(
    gitState.branches.some(
      (branch) =>
        branch.kind === 'remote' &&
        branch.name === status?.branch &&
        branch.remote === primaryRemote?.name
    )
  )
  /**
   * Whether a fetch is in flight.
   *
   * Fetch has its own lane in main (`GitService.enqueueRemote`), so it holds up
   * nothing local: staging, committing, stashing, checking a branch out and
   * reading a diff all keep working while the network answers. It only gates
   * what a fetch can actually make stale, which is Push.
   */
  const fetching = $derived(gitState.isBusy('fetch'))
  /**
   * The branch actions that publish or integrate. Each one reads what a fetch
   * writes, so they stand aside while another is running. Fetch itself is not in
   * this set; see `fetching`.
   */
  const branchSyncBusy = $derived(gitState.isBusy(['pull', 'push', 'sync']))
  /**
   * Push waits for an in-flight fetch. It decides from the remote-tracking refs
   * whether it is a fast-forward and whether there is anything to send at all,
   * and both answers change the moment the fetch lands.
   */
  const pushBlocked = $derived(branchSyncBusy || fetching)
  /** Commits the remote does not have yet, according to the last fetch. */
  const commitsAhead = $derived(status?.ahead ?? 0)
  /**
   * Whether the Push slot has anything to do. A branch whose upstream is simply
   * missing has no `ahead` count to show   the push is what creates the tracking
   * branch   so it qualifies as soon as the repository is known to have commits.
   * Rendering the button on an empty repository would only offer a push that git
   * must reject.
   */
  const hasWorkToPush = $derived(
    commitsAhead > 0 || (needsUpstreamPush && commitHistory.length > 0)
  )
  /**
   * Push copy: a count when there is one, otherwise what the push sets up. While
   * a fetch is in flight it says why the button is unavailable, because Push is
   * the one control a fetch blocks and an unexplained disabled button reads as a
   * broken panel.
   */
  const pushTitle = $derived(
    fetching
      ? 'Push is waiting for the fetch in progress'
      : commitsAhead > 0
        ? `Push ${String(commitsAhead)} commit(s) to the remote`
        : 'Push this branch and track it on the remote'
  )

  /**
   * The active scope's bucket. Sync lives behind `showsSync`, so this is what
   * tells the header whether the panel is looking at a managed worktree.
   */
  const activeScopeBucket = $derived(scopeState.bucketFor(projectId, scopeBucketId))
  const worktreeScope = $derived(activeScopeBucket?.root.kind === 'worktree')

  /** Commits waiting on the remote, according to the last fetch. */
  const commitsBehind = $derived(status?.behind ?? 0)
  const hasRemote = $derived(remotes.length > 0)
  /**
   * Which remote actions have work, and therefore whether the header's second row
   * exists at all. The row and its buttons read the same three flags, so they can
   * never disagree about whether there is anything to do.
   */
  const showsPull = $derived(repoState === 'git' && hasRemote && commitsBehind > 0)
  const showsPush = $derived(repoState === 'git' && hasRemote && hasWorkToPush)
  /**
   * Only a managed worktree scope gets the Sync control. Sync exists to trade
   * commits between two checkouts of the same repository, and a worktree is the
   * only scope that has a second checkout to trade with; from the project root
   * the worktree's own Git panel already offers the same move in the direction
   * that lands here, so an entry point on `main` would be a second door onto one
   * operation, with the receiver off screen.
   */
  const showsSync = $derived(repoState === 'git' && worktreeScope)
  /**
   * Pull and Push are the only remote actions that earn the second row: they act
   * on the branch you are standing on, one each, and they fill the row between
   * them. Sync main is a menu, so it sits with the other header tools.
   *
   * The Deploys view reads runs and deployments, not the branch you are standing
   * on, so Pull and Push have nothing to say there and do not appear.
   */
  /**
   * The row's remote actions apply to the branch you are standing on, which is
   * what the Deploys view is not about.
   */
  const remoteActionsApply = $derived(activeTab !== 'deployments')
  /**
   * Unresolved conflicts hand the row to the controls that end them, so the
   * remote buttons step out of the way and reappear in the git actions menu.
   * Pushing or pulling a half-resolved integration is not a step forward.
   */
  const conflictsOpen = $derived(conflicted.length > 0)
  /**
   * A worktree checkout keeps Pull and Push in the git actions menu beside
   * Fetch rather than handing them the row: the row is the panel's loudest
   * position, and a managed scope already owns the sync-to-main and
   * sync-from-main actions plus the pull request its branch exists for.
   */
  const remoteActionsInMenu = $derived(remoteActionsApply && (conflictsOpen || worktreeScope))
  const showsRemoteActions = $derived(
    remoteActionsApply && !conflictsOpen && !worktreeScope && (showsPull || showsPush)
  )

  /**
   * The working tree's staging controls: whatever the changes view can do to the
   * index right now. They used to sit in a bar of their own inside that view, and
   * they share this row with Pull and Push instead.
   */
  const showsStageControls = $derived(
    conflictsOpen ||
      unstaged.length + untracked.length > 0 ||
      staged.length > 0 ||
      (changes.length > 0 && selectedPathList.length > 0)
  )

  /**
   * The row under the header belongs to the view in focus: the commit or stash
   * being read, the pull request's identity and views, the PR list's filter, the
   * deployment being read, the staging controls, or the remote actions. It exists
   * only while at least one of those has something to say, so the common case is
   * still one line.
   */
  const showsViewContext = $derived(
    (activeTab === 'changes' &&
      (selectedCommit !== null || (status !== null && showsStageControls))) ||
      (activeTab === 'pulls' && githubConnected && githubIdentity !== null) ||
      (activeTab === 'deployments' && (selectedDeployment !== null || selectedRun !== null)) ||
      (activeTab === 'stashes' && selectedStash !== null)
  )
  const showsActionRow = $derived(showsViewContext || showsRemoteActions)

  /**
   * Working-tree state as the branch picker's leading glyph, in the order the
   * states ask for attention: conflicts first, then uncommitted changes, then
   * clean. Null while there is no status to describe.
   */
  const worktreeState = $derived.by((): 'clean' | 'dirty' | 'conflicted' | null => {
    if (!status) return null
    if (conflicted.length > 0) return 'conflicted'
    return status.clean ? 'clean' : 'dirty'
  })

  $effect(() => {
    // The board may not be in memory yet when the panel mounts first (remote
    // shell, deep link). Loading it is idempotent and never blocks rendering.
    void scopeState.ensureBoardLoaded(projectId)
  })

  function closePullStrategy(): void {
    if (gitState.isBusy('pull')) return
    pullStrategyOpen = false
    pullStrategyError = ''
  }

  function resolvePullTarget(): { remote: string; branch: string } | null {
    const currentStatus = status
    if (!currentStatus?.branch) return null
    const upstream = currentStatus.upstream
    if (upstream) {
      const trackedRemote = remotes.find((remote) => upstream.startsWith(`${remote.name}/`))
      if (trackedRemote) {
        return {
          remote: trackedRemote.name,
          branch: upstream.slice(trackedRemote.name.length + 1)
        }
      }
    }
    if (!primaryRemote) return null
    return { remote: primaryRemote.name, branch: currentStatus.branch }
  }

  async function performPull(strategy: GitPullStrategy): Promise<void> {
    const target = resolvePullTarget()
    if (!target) {
      pullStrategyError = 'No tracked branch is available to pull'
      pullStrategyOpen = true
      return
    }

    pullStrategyError = ''
    await gitState.pullIntegrate(projectId, target.remote, target.branch, strategy)
    if (gitState.error) {
      pullStrategyError = gitState.error
      gitState.error = null
      pullStrategyOpen = true
      return
    }
    pullStrategyOpen = false
  }

  async function pullAction(): Promise<void> {
    if (appConfigState.defaultPullStrategy === 'ask') {
      pullStrategyError = ''
      pullStrategyOpen = true
      return
    }
    await performPull(appConfigState.defaultPullStrategy)
  }

  /**
   * Sync this worktree with the project's main worktree branch, in either
   * direction. The strategy chooser follows the same `ask` preference as the
   * Pull button; folding work into main always confirms first, because it
   * mutates a branch the user is not looking at and pushes nothing. A
   * conflicted integration is handed to the existing conflict UI instead of
   * retrying.
   */
  async function performSyncMain(
    direction: GitSyncDirection,
    strategy: GitPullStrategy
  ): Promise<void> {
    // "Main" is the project root, so the peer is named rather than chosen.
    const result = await gitState.syncWith(projectId, scopeBucketId, {
      direction,
      peer: { kind: 'root' },
      strategy
    })
    if (gitState.error) {
      syncMainError = gitState.error
      gitState.error = null
      syncDirection = direction
      syncMainOpen = true
      // A refusal usually names a state this panel has not read yet   a rebase
      // the platform, an agent or a terminal left stopped is not in the status
      // the modal was rendered from. Re-reading it lets the modal show the state
      // and its strategies instead of a list of strategies that cannot run.
      void refreshStatus()
      return
    }
    if (!result) return
    syncMainOpen = false
    syncMainError = ''
    void refreshStatus()
    reportSyncResult(result)
  }

  function openSyncMain(direction: GitSyncDirection): void {
    syncDirection = direction
    syncMainError = ''
    syncMainOpen = true
  }

  async function syncMainAction(direction: GitSyncDirection): Promise<void> {
    if (direction === 'to' || appConfigState.defaultPullStrategy === 'ask') {
      openSyncMain(direction)
      return
    }
    await performSyncMain(direction, appConfigState.defaultPullStrategy)
  }

  function closeSyncMain(): void {
    if (gitState.isBusy('sync')) return
    syncMainOpen = false
    syncMainError = ''
  }

  /** The peer chooser has to be opened: the other end is the whole choice. */
  function openSyncPeer(direction: GitSyncDirection): void {
    syncPeerDirection = direction
    syncPeerOpen = true
  }

  function closeSyncPeer(): void {
    if (gitState.isBusy('sync')) return
    syncPeerOpen = false
  }

  function syncPeerDone(): void {
    syncPeerOpen = false
    void refreshStatus()
  }

  async function performPush(remote: { name: string; url: string }): Promise<void> {
    if (!status?.branch) return
    const result = await gitState.push(projectId, false, remote.name)
    // A non-fast-forward rejection becomes the recovery dialog, not an error.
    if (result.status === 'rejected') pushDiverged = true
  }

  async function pushAction(): Promise<void> {
    const remote = primaryRemote
    if (!remote || !status?.branch) {
      gitState.error = 'No remote is configured to push to'
      return
    }
    if (needsUpstreamPush) {
      pushConfirm = true
      return
    }
    // Known divergence from the last fetch   never attempt the doomed push.
    if (status.behind > 0) {
      pushDiverged = true
      return
    }
    await performPush(remote)
  }

  async function confirmPushUpstream(): Promise<void> {
    pushConfirm = false
    if (!primaryRemote || !status?.branch) return
    const result = await gitState.push(projectId, true, primaryRemote.name, status.branch)
    if (result.status === 'rejected') pushDiverged = true
  }

  /** Pull the remote into the local branch, then push once integration is clean. */
  async function recoverPush(mode: 'merge' | 'rebase'): Promise<void> {
    const remote = primaryRemote
    if (!remote || !status?.branch || pushRecoverMode) return
    pushDiverged = false
    pushRecoverMode = mode
    try {
      await gitState.pullIntegrate(projectId, remote.name, status.branch, mode)
      // Conflicts hand over to the conflict UI; never auto-push a half-merged tree.
      if (!gitState.error && gitState.conflicted.length === 0) {
        await performPush(remote)
      }
    } finally {
      pushRecoverMode = null
    }
  }

  /** Open the Add-origin modal (no remote configured yet). */
  function openAddOrigin(): void {
    originMode = 'add'
    originName = 'origin'
    originUrl = ''
    originReplaceConfirm = false
    originModalOpen = true
  }

  /** Open the Replace-origin modal, prefilled with the current primary remote URL. */
  function openReplaceOrigin(): void {
    originMode = 'replace'
    originName = primaryRemote?.name ?? 'origin'
    originUrl = primaryRemote?.url ?? ''
    originReplaceConfirm = false
    originModalOpen = true
  }

  function closeOriginModal(): void {
    if (originBusy) return
    originModalOpen = false
    originReplaceConfirm = false
  }

  /** First step of the save button: replace routes through a destructive
   *  confirmation first; add commits immediately. */
  function requestSetOrigin(): void {
    if (!originUrl.trim() || originBusy) return
    if (originMode === 'replace') {
      originReplaceConfirm = true
      return
    }
    void runSetOrigin()
  }

  /** `git remote add <name> <url>` or `git remote set-url <name> <url>`. */
  async function runSetOrigin(): Promise<void> {
    const name = originName.trim()
    const url = originUrl.trim()
    if (!url || !name || originBusy) return
    originBusy = true
    const mode = originMode
    try {
      if (mode === 'replace') {
        await gitState.setRemoteUrl(projectId, name, url)
      } else {
        await gitState.addRemote(projectId, name, url)
      }
      if (!gitState.error) {
        originModalOpen = false
        originReplaceConfirm = false
        originUrl = ''
        void refreshStatus()
      }
    } finally {
      originBusy = false
    }
  }

  const conflictState = $derived(gitState.conflictState)

  /**
   * Whether an integration is open in this worktree. While it is, nothing else
   * can move the branch: no sync strategy, and no remote action worth offering.
   */
  const integrationOpen = $derived(conflictState !== 'none')

  /**
   * The temporary `pr-<n>` branch a PR conflict resolution is staged on, while
   * its session is still open. `preparePrResolve` records the session and the
   * store drops it once the branch is gone, so this names the branch the finish
   * step still has to delete.
   */
  const prResolveBranch = $derived(
    gitState.prResolveSession ? `pr-${gitState.prResolveSession.pullNumber}` : null
  )

  /**
   * A merge is in progress (MERGE_HEAD exists) and every conflicted file has
   * been resolved and staged. Git is waiting for the merge commit, so the panel
   * surfaces the one next step   Complete merge   instead of leaving the user to
   * figure out that a normal commit finishes the merge.
   */
  const mergePending = $derived(conflictState === 'merge' && conflicted.length === 0)

  /**
   * Whether the integration still has a step left: the merge commit, or   when
   * that commit already exists on a temporary PR branch   the push back to the
   * pull request and the cleanup of that branch. Same next step, same control.
   * Held back while any conflict is still open: the row owns that state, and a
   * commit with unmerged paths would only be refused by git.
   */
  const prResolvePending = $derived(prResolveBranch !== null && conflicted.length === 0)
  const mergeAwaitsCompletion = $derived(mergePending || prResolvePending)

  /**
   * The Changes view's action row already renders this integration's Abort while
   * it is on screen, so the notice above it never offers the same destructive
   * button twice. The row keeps it wherever it shows: that is where the
   * resolution decisions live (Resolve all, the agent, the accept pair).
   */
  const conflictRowAborts = $derived(
    activeTab === 'changes' && selectedCommit === null && conflictsOpen
  )

  /** Complete-merge modal state: optional title/description, defaults auto-generated. */
  let completeMergeOpen = $state(false)
  let mergeTitle = $state('')
  let mergeDescription = $state('')
  const completeMergeBusy = $derived(gitState.isBusy(['commit', 'push']))

  function openCompleteMerge(): void {
    // Acting from the sync modal closes it first, so the merge's own controls are
    // never behind an overlay.
    syncMainOpen = false
    syncMainError = ''
    mergeTitle = ''
    mergeDescription = ''
    completeMergeOpen = true
  }

  /** The commit message actually used: user text when given, a generated default otherwise. */
  function mergeCommitMessage(): string {
    const title = mergeTitle.trim()
    const description = mergeDescription.trim()
    const resolvedTitle =
      title || `Merge ${status?.upstream ? `branch '${status.upstream}'` : 'changes'}`
    return description ? `${resolvedTitle}\n\n${description}` : resolvedTitle
  }

  /**
   * Complete the merge: write the merge commit when it is still pending, then
   * finish a recorded PR-conflict session   push the resolution back to the PR's
   * head branch, check out the branch the user came from, and delete the
   * temporary `pr-<n>` branch. A plain local merge is complete once committed.
   */
  async function confirmCompleteMerge(): Promise<void> {
    if (completeMergeBusy || !mergeAwaitsCompletion) return
    const temporaryBranch = prResolveBranch
    if (mergePending) {
      await gitState.commit(projectId, mergeCommitMessage())
      if (gitState.error) return
      if (!temporaryBranch) toast.success('Merge committed')
    }
    if (temporaryBranch) {
      const finished = await gitState.finishPrResolve(projectId)
      if (!finished) return
      toast.success(`Resolution pushed to the pull request; ${temporaryBranch} removed`)
    }
    completeMergeOpen = false
    mergeTitle = ''
    mergeDescription = ''
    void refreshStatus()
  }

  /**
   * Accept-all is destructive: the other side of every conflicted file is
   * discarded, so it asks before it runs, like Abort does.
   */
  let acceptConflictsSide = $state<GitConflictSide | null>(null)

  function requestAcceptAllConflicts(side: GitConflictSide): void {
    acceptConflictsSide = side
  }

  async function confirmAcceptAllConflicts(): Promise<void> {
    const side = acceptConflictsSide
    acceptConflictsSide = null
    if (!side) return
    await gitState.acceptConflictSide(projectId, side)
    if (gitState.error) return
    void refreshStatus()
  }

  const integrateBusy = $derived(
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
  const atRiskFiles = $derived(changes.length > 0 ? changes.map((change) => change.path) : [])

  function requestMergeOrRebase(kind: 'merge' | 'rebase'): void {
    const target = mergeTarget.trim()
    if (!target) return
    showIntegrateModal = false
    pendingOperation = { kind, target }
    acknowledgeActiveTurn = false
  }

  async function confirmPendingOperation(): Promise<void> {
    const operation = pendingOperation
    if (!operation) return
    pendingOperation = null
    const summary =
      operation.kind === 'merge'
        ? await gitState.merge(projectId, operation.target)
        : await gitState.rebase(projectId, operation.target)
    if (summary && summary.conflicted.length > 0) {
      mergeTarget = ''
    }
  }

  /** Abort is destructive   always ask before discarding the whole merge/rebase. */
  let abortConfirmOpen = $state(false)

  function requestAbortConflict(): void {
    syncMainOpen = false
    syncMainError = ''
    abortConfirmOpen = true
  }

  async function confirmAbortConflict(): Promise<void> {
    abortConfirmOpen = false
    if (conflictState === 'merge') {
      await gitState.abortMerge(projectId)
    } else if (conflictState === 'rebase') {
      await gitState.abortRebase(projectId)
    }
  }

  /**
   * Move a stopped rebase along. A rebase can stop again on the next commit's
   * conflict, which is a normal state rather than an error, so the refreshed
   * status is what the panel renders next.
   */
  async function runRebaseAction(action: GitRebaseAction): Promise<void> {
    syncMainOpen = false
    syncMainError = ''
    rebaseActionRunning = action
    try {
      await gitState.rebaseAction(projectId, action)
    } finally {
      rebaseActionRunning = null
    }
    if (gitState.error) return
    void refreshStatus()
  }

  /** Which rebase strategy is in flight, so each button spins for its own click. */
  let rebaseActionRunning = $state<GitRebaseAction | null>(null)

  /**
   * Hand focus to the integration's forward action when the sync modal swaps the
   * strategies out for it. The buttons the modal opened with are removed at that
   * moment   the worktree turned out to be mid-integration   and the one holding
   * focus goes with them, which would leave focus on the body. The same buttons
   * render in the panel's notice, so this acts inside an open modal only, and
   * only on whichever of them the modal's own ⌘+Enter pipeline would pick.
   */
  function focusSyncModalAction(node: HTMLElement): void {
    if (!syncMainOpen) return
    const dialog = node.closest<HTMLElement>('[role="dialog"]')
    if (!dialog || findPanelPrimaryAction(dialog) !== node) return
    node.focus({ preventScroll: true })
  }

  /**
   * Route conflict resolution to the file panel: enable the tree's Conflicts
   * filter and open the requested (or first) conflicted file, which the viewer
   * renders as the per-hunk resolution editor.
   */
  function routeConflictResolution(initial?: string): void {
    gitState.conflictsMode = true
    contextSidebarState.openFiles(projectId, threadId)
    const path = initial ?? gitState.conflicted[0]
    if (!path) return
    void projectFilesWorkspace.openFile(projectId, path).then(() => {
      projectFilesWorkspace.requestFullscreen(projectId)
    })
  }

  async function openInEditor(path: string): Promise<void> {
    await projectFilesWorkspace.openFile(projectId, path)
  }

  async function stashChanges(): Promise<void> {
    await gitState.stash(projectId, stashMessage.trim() || undefined, stashPaths ?? undefined)
    if (!gitState.error) {
      stashMessage = ''
      stashPaths = null
      showStashModal = false
      activeTab = 'stashes'
      void refreshStatus()
    }
  }

  function requestStashFor(paths: string[]): void {
    stashPaths = paths
    stashMessage = ''
    showStashModal = true
  }

  async function stagePathsAction(paths: string[], staged: boolean): Promise<void> {
    if (staged) {
      await gitState.unstage(projectId, paths)
    } else {
      await gitState.stage(projectId, paths)
    }
  }

  function toggleSelection(change: GitFileChange, additive: boolean): void {
    const next = { ...selectedPaths }
    if (additive && next[change.path]) {
      delete next[change.path]
    } else {
      next[change.path] = true
    }
    selectedPaths = next
  }

  function toggleSectionSelection(sectionFiles: GitFileChange[]): void {
    const allSelected = sectionFiles.length > 0 && sectionFiles.every((f) => selectedPaths[f.path])
    const next = { ...selectedPaths }
    for (const file of sectionFiles) {
      if (allSelected) {
        delete next[file.path]
      } else {
        next[file.path] = true
      }
    }
    selectedPaths = next
  }

  function clearSelection(): void {
    selectedPaths = {}
  }

  async function stageSelectedAction(stage: boolean): Promise<void> {
    const paths = selectedPathList
    if (paths.length === 0) return
    await stagePathsAction(paths, stage)
    if (gitState.error) return
    clearSelection()
    // Staging is followed by writing the message, never by the reverse.
    if (!stage) requestCommitMessageFocus()
  }

  async function ignoreSelectedAction(): Promise<void> {
    const paths = selectedPathList
    if (paths.length === 0) return
    await gitState.ignore(projectId, paths)
    if (!gitState.error) {
      clearSelection()
      void refreshStatus()
    }
  }

  async function ignorePathsAction(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await gitState.ignore(projectId, paths)
    if (!gitState.error) {
      clearSelection()
      void refreshStatus()
    }
  }

  function requestDiscard(paths: string[]): void {
    discardConfirm = paths
  }

  async function confirmDiscard(): Promise<void> {
    const paths = discardConfirm
    if (!paths) return
    discardConfirm = null
    await gitState.discard(projectId, paths)
    if (!gitState.error) {
      clearSelection()
      void refreshStatus()
    }
  }

  /** Restore a file's content from the commit or stash being viewed. Restoring
   *  to the working tree overwrites uncommitted local edits, so that target is
   *  confirmed by the user before it runs. */
  async function restoreFromSource(
    source: string,
    path: string,
    target: GitRestoreTarget
  ): Promise<void> {
    if (target === 'worktree') {
      restoreWorktreeConfirm = { source, path }
      return
    }
    await gitState.restoreFiles(projectId, source, [path], target)
    if (!gitState.error) void refreshStatus()
  }

  async function confirmRestoreWorktree(): Promise<void> {
    const pending = restoreWorktreeConfirm
    if (!pending) return
    restoreWorktreeConfirm = null
    await gitState.restoreFiles(projectId, pending.source, [pending.path], 'worktree')
    if (!gitState.error) void refreshStatus()
  }

  /**
   * Staging ends with the commit message, so the box takes the caret: the next
   * thing a user does after staging is type. The effect above waits for the pinned
   * composer to render, so this is a flag rather than a focus call.
   */
  function requestCommitMessageFocus(): void {
    commitSelection = true
  }

  function requestCommitSelected(): void {
    if (selectedPathList.length === 0) return
    void stageSelectedAction(false).then(() => {
      if (!gitState.error) {
        clearSelection()
        commitSelection = true
      }
    })
  }

  async function popStash(id?: string): Promise<void> {
    await gitState.popStash(projectId, id)
    if (!gitState.error) {
      clearSelectedStash()
      leaveStashesTabIfEmpty()
      void refreshStatus()
      void reloadHistory()
    }
  }

  /** The Stashes tab only exists while stashes do   fall back to Changes when the last one goes. */
  function leaveStashesTabIfEmpty(): void {
    if (activeTab === 'stashes' && gitState.stashes.length === 0) activeTab = 'changes'
  }

  function requestStashDrop(stash: GitStashEntry): void {
    stashDropTarget = stash
  }

  async function confirmStashDrop(): Promise<void> {
    const target = stashDropTarget
    if (!target) return
    stashDropTarget = null
    await gitState.dropStash(projectId, target.id)
    if (!gitState.error) {
      clearSelectedStash()
      leaveStashesTabIfEmpty()
      void refreshStatus()
    }
  }

  const tabs: Array<{
    id: GitPanelTabId
    label: string
    icon: typeof GitBranch
    count: number | null
  }> = $derived.by(() => {
    const list: Array<{
      id: GitPanelTabId
      label: string
      icon: typeof GitBranch
      count: number | null
    }> = [
      {
        id: 'changes',
        label: 'Changes',
        icon: FileDiff,
        count: changes.length > 0 ? changes.length : null
      },
      { id: 'history', label: 'History', icon: RotateCcwClock, count: null },
      { id: 'branches', label: 'Branches', icon: NetworkIcon, count: null },
      { id: 'pulls', label: 'PRs', icon: GitPullRequest, count: null }
    ]
    // Stash is just shelved work   it earns a tab only once something is shelved.
    if (gitState.stashes.length > 0) {
      list.push({
        id: 'stashes',
        label: 'Stashes',
        icon: Archive,
        count: gitState.stashes.length
      })
    }
    // Deployments earn a view only when the repo actually has deployment
    // activity (the flag is persisted in the DB and cached in localStorage).
    // While the panel is *on* that view the entry stays, so a cold cache cannot
    // leave the trigger naming a view the row is no longer showing.
    if (hasDeployments === true || activeTab === 'deployments') {
      list.push({ id: 'deployments', label: 'Deploys', icon: Rocket, count: null })
    }
    return list
  })

  const fileSections: Array<{ title: string; files: GitFileChange[] }> = $derived.by(() => {
    const sections: Array<{ title: string; files: GitFileChange[] }> = []
    if (conflicted.length > 0) sections.push({ title: 'Conflicts', files: conflicted })
    if (staged.length > 0) sections.push({ title: 'Staged', files: staged })
    if (unstaged.length > 0) sections.push({ title: 'Unstaged', files: unstaged })
    if (untracked.length > 0) sections.push({ title: 'Untracked', files: untracked })
    return sections
  })

  const conflictSections = $derived(fileSections.filter((section) => section.title === 'Conflicts'))
  const stagedSections = $derived(fileSections.filter((section) => section.title === 'Staged'))
  const workingSections = $derived(
    fileSections.filter((section) => section.title !== 'Staged' && section.title !== 'Conflicts')
  )
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
  const paneClass = 'flex flex-col p-1'
</script>

{#snippet branchStatusIcon()}
  {#if worktreeState === 'conflicted'}
    <TriangleAlert
      size={12}
      class="shrink-0 text-danger"
      role="img"
      aria-label="Conflicts to resolve"
      title="Conflicts to resolve"
    />
  {:else if worktreeState === 'dirty'}
    <!--
      A badge rather than a ring: at 12px an outlined circle reads as a bullet,
      where the amber chip reads as the state it names. The same snippet marks the
      dirty branch in the picker's own list.
    -->
    <span
      class="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-warning"
      title="Uncommitted changes in this branch">dirty</span
    >
  {:else}
    <CircleCheck
      size={12}
      class="shrink-0 text-success"
      role="img"
      aria-label="Working tree clean"
      title="Working tree clean"
    />
  {/if}
{/snippet}

{#snippet refreshStatusButton()}
  <!--
    Multipurpose on purpose: it refreshes the git status *and* whatever view is
    in focus, so one control is enough to trust the panel again.
  -->
  <button
    type="button"
    class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
    aria-label="Refresh the git status and the current view"
    title="Refresh the git status and the current view"
    disabled={busy}
    onclick={() => void refreshPanel()}
  >
    <RefreshCw
      size={12}
      class={gitState.isBusy(['refresh', 'pr-list', 'pr-detail', 'deployments'])
        ? 'animate-spin'
        : ''}
    />
  </button>
{/snippet}

<!--
  The view in focus's own action, drawn before Search in the header row. The
  icons carry the meaning and the labels appear only while the header is wide
  enough for them (the container query on `.git-panel-header`), so a narrow
  sidebar gets the same controls without the words.
-->
{#snippet viewActions()}
  {#if activeTab === 'changes'}
    {@render changesViewToggle()}
    {#if selectedCommit && isHeadCommit}
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Amend the latest commit message"
        aria-label="Amend the latest commit message"
        disabled={gitState.isBusy('reset') || gitState.isBusy('amend')}
        onclick={startAmend}
      >
        <GitGraph size={12} aria-hidden="true" />
        <span class="view-action-label">Amend</span>
      </button>
    {/if}
  {:else if activeTab === 'branches'}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Create a branch from the current one"
      aria-label="Create a branch from the current one"
      onclick={() => (creatingBranch = true)}
    >
      <Plus size={12} aria-hidden="true" />
      <span class="view-action-label">New branch</span>
    </button>
  {:else if activeTab === 'pulls'}
    {#if selectedPullRequest}
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Open this pull request in the full screen reader"
        aria-label="Open this pull request in the full screen reader"
        onclick={() => openPullRequestFullscreen(selectedPullRequest)}
      >
        <Maximize2 size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Open this pull request on GitHub"
        aria-label="Open this pull request on GitHub"
        data-external-url={selectedPullRequest?.url ?? ''}
        onclick={() => void openInBrowser(selectedPullRequest?.url ?? '')}
      >
        <ExternalLink size={12} aria-hidden="true" />
      </button>
    {:else}
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Open the pull request list in the full screen reader"
        aria-label="Open the pull request list in the full screen reader"
        onclick={() => openPullRequestFullscreen(null)}
      >
        <Maximize2 size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Create a pull request"
        aria-label="Create a pull request"
        onclick={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
      >
        <GitPullRequest size={12} aria-hidden="true" />
        <span class="view-action-label">New PR</span>
      </button>
    {/if}
  {:else if activeTab === 'deployments' && deploymentsExternal}
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title={deploymentsExternal.title}
      aria-label={deploymentsExternal.title}
      data-external-url={deploymentsExternal.url}
      onclick={() => void openInBrowser(deploymentsExternal.url)}
    >
      <ExternalLink size={12} aria-hidden="true" />
    </button>
  {/if}
{/snippet}

<!--
  How the changed files are laid out: one control with two tabs, in the same
  shape the rest of the app uses for a two-state view (`SourcesPanel`), rather
  than two loose buttons that only happen to sit next to each other. It lives
  with the view's actions because it describes the view, not the selection.
-->
{#snippet changesViewToggle()}
  <div
    class="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5"
    role="tablist"
    aria-label="Changed files layout"
  >
    <button
      type="button"
      class={[
        'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium transition-colors',
        changesView === 'list'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'
      ]}
      role="tab"
      aria-selected={changesView === 'list'}
      title="Show the changed files as a flat list"
      aria-label="Show the changed files as a flat list"
      onclick={() => (changesView = 'list')}
    >
      <GitCommitHorizontal size={12} aria-hidden="true" />
      <span class="view-action-label">List</span>
    </button>
    <button
      type="button"
      class={[
        'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium transition-colors',
        changesView === 'tree'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'
      ]}
      role="tab"
      aria-selected={changesView === 'tree'}
      title="Show the changed files as a folder tree"
      aria-label="Show the changed files as a folder tree"
      onclick={() => (changesView = 'tree')}
    >
      <FolderGit2 size={12} aria-hidden="true" />
      <span class="view-action-label">Tree</span>
    </button>
  </div>
{/snippet}

<!--
  Abort whatever integration is open, confirmed first: it discards the merge or
  rebase and restores the working tree. One snippet for both homes, the notice
  and the Changes row, which differ only in the height they have to fit and in
  how much room the label has   the row measures its four controls against a
  480px panel, so there it says `Abort` and the title names the integration.
-->
{#snippet abortIntegrationAction(compact: boolean)}
  <button
    type="button"
    class={[
      'flex shrink-0 cursor-pointer items-center gap-1.5 border border-danger/40 font-medium text-[0.625rem] text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40',
      compact ? 'h-6 rounded-xs px-2' : 'h-7 rounded-md px-2.5'
    ]}
    disabled={integrateBusy || conflictState === 'none'}
    title={`Discard the whole ${conflictState === 'merge' ? 'merge' : 'rebase'} and restore the working tree`}
    onclick={requestAbortConflict}
  >
    {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
      <Loader2 size={11} class="animate-spin" />
    {:else}
      <Trash2 size={11} />
    {/if}
    {#if compact}
      Abort
    {:else}
      Abort {conflictState === 'merge' ? 'merge' : 'rebase'}
    {/if}
  </button>
{/snippet}

<!--
  The strategies for whatever integration is open, in one place. A stopped rebase
  is continued or skipped, a resolved merge is completed, and either can be
  aborted. The rebase notice and the sync modal both render this, so the two can
  never offer different ways out of the same state. `withAbort` is false only
  where something else on screen already offers it.
-->
{#snippet integrationActions(withAbort = true)}
  {#if conflictState === 'rebase'}
    <!--
      Both forward actions carry `data-modal-primary`, so the modal's focus and
      ⌘+Enter pipeline lands on one of them. Continue is disabled while any
      conflict is still open, and then skip is the only way forward left; abort
      deliberately carries nothing, because the shortcut must never discard the
      integration.
    -->
    <button
      type="button"
      data-modal-primary
      {@attach focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title={conflicted.length > 0
        ? `Resolve and stage the ${String(conflicted.length)} remaining conflict${conflicted.length === 1 ? '' : 's'} before continuing`
        : 'Replay the rest of your commits on top of the new base'}
      disabled={integrateBusy || conflicted.length > 0}
      onclick={() => void runRebaseAction('continue')}
    >
      {#if rebaseActionRunning === 'continue'}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <Play size={11} />
      {/if}
      Continue rebase
    </button>
    <button
      type="button"
      data-modal-primary
      {@attach focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
      title="Drop the commit git stopped on and replay the rest"
      disabled={integrateBusy}
      onclick={() => void runRebaseAction('skip')}
    >
      {#if rebaseActionRunning === 'skip'}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <SkipForward size={11} />
      {/if}
      Skip this commit
    </button>
  {:else if mergePending}
    <button
      type="button"
      data-modal-primary
      {@attach focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title="Commit the resolved files to complete the merge"
      disabled={completeMergeBusy}
      onclick={openCompleteMerge}
    >
      {#if completeMergeBusy}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <GitMerge size={11} />
      {/if}
      Complete merge
    </button>
  {/if}
  {#if withAbort}
    {@render abortIntegrationAction(false)}
  {/if}
{/snippet}

<!--
  What the action row is about, per view: the context each per-view header used
  to carry, moved down beside Pull and Push, so the sidebar has one place to look
  for "where am I" and one for "what can I do here".
-->
{#snippet viewContext()}
  {#if activeTab === 'changes' && selectedCommit === null}
    {#if conflicted.length > 0}
      {@render abortIntegrationAction(true)}
      <!--
        The whole resolution, in the order it happens: open the per-hunk merge
        editor, or hand the files to an agent, or take one side of every file
        at once. They live here, beside Abort, because this row is where a
        conflicted integration is decided   the Conflicts section header used to
        carry Resolve all on its own, which the tree layout never showed.
      -->
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1.5 rounded-xs border border-warning/40 px-2 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-default disabled:opacity-40"
        disabled={integrateBusy}
        title="Open the merge editor on the conflicted files, starting with the first"
        onclick={() => routeConflictResolution()}
      >
        <GitMerge size={11} />
        Resolve all
      </button>
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1.5 rounded-xs border border-border px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        disabled={integrateBusy}
        title="Hand every conflicted file to an agent to resolve"
        onclick={() => void resolveConflictsWithAgent()}
      >
        <Bot size={11} />
        Resolve with agent
      </button>
      <!--
        One decision with two answers, so one control: which side of every
        conflicted file to keep. Its sides carry the merge editor's own names and
        colours   accent incoming, primary current   and the group's label plus
        each button's title spell out what they do, because the row cannot afford
        a third word. Both sides are destructive to the other, so both confirm.
      -->
      <div
        class="flex h-6 shrink-0 items-center gap-0.5 rounded-xs border border-border bg-elevated p-0.5"
        role="group"
        aria-label="Accept one side of every conflicted file"
      >
        <button
          type="button"
          class="h-5 shrink-0 rounded-sm px-1 text-[0.5625rem] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-default disabled:opacity-40"
          disabled={integrateBusy}
          title="Accept all incoming: replace every conflicted file with its incoming version"
          onclick={() => requestAcceptAllConflicts('incoming')}
        >
          incoming
        </button>
        <button
          type="button"
          class="h-5 shrink-0 rounded-sm px-1 text-[0.5625rem] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-default disabled:opacity-40"
          disabled={integrateBusy}
          title="Accept all current: replace every conflicted file with its current version"
          onclick={() => requestAcceptAllConflicts('current')}
        >
          current
        </button>
      </div>
    {:else if unstaged.length + untracked.length > 0}
      <button
        type="button"
        class="flex h-6 shrink-0 items-center rounded-xs border border-border px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        disabled={gitState.isBusy('stage')}
        onclick={() => void stageAll()}
      >
        Stage all
      </button>
    {:else if staged.length > 0}
      <button
        type="button"
        class="flex h-6 shrink-0 items-center rounded-xs border border-danger/30 px-2 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
        disabled={gitState.isBusy('unstage')}
        onclick={() => void unstageAll()}
      >
        Unstage all
      </button>
    {/if}
    {#if changes.length > 0 && selectedPathList.length > 0}
      <span class="shrink-0 text-[0.625rem] font-medium tabular-nums text-foreground">
        {selectedPathList.length} selected
      </span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          disabled={batchBusy}
          aria-label="Selected actions"
          title="Selected actions"
        >
          <ChevronDown size={12} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            class="z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
          >
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={() => void stageSelectedAction(false)}
            >
              <Check size={12} class="text-success" />
              Stage
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={() => void stageSelectedAction(true)}
            >
              <span class="inline-block w-3 text-center text-[0.625rem] text-danger">−</span>
              Unstage
            </DropdownMenu.Item>
            <DropdownMenu.Separator class="my-1 h-px bg-border" />
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={requestCommitSelected}
            >
              <GitCommit size={12} class="text-dimmed" />
              Commit…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={() => requestStashFor(selectedPathList)}
            >
              <Archive size={12} class="text-dimmed" />
              Stash…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={() => void ignoreSelectedAction()}
            >
              <span class="inline-block w-3 text-center text-[0.625rem]">⊘</span>
              Add to gitignore
            </DropdownMenu.Item>
            <DropdownMenu.Separator class="my-1 h-px bg-border" />
            <DropdownMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
              disabled={batchBusy}
              onSelect={() => requestDiscard(selectedPathList)}
            >
              <Trash2 size={12} />
              Discard changes
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/if}
  {:else if activeTab === 'changes' && selectedCommit !== null}
    {@const commit = selectedCommit}
    <button
      type="button"
      class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Back to history"
      aria-label="Back to history"
      onclick={() => {
        clearSelectedCommit()
        activeTab = 'history'
      }}
    >
      <ArrowLeft size={12} />
    </button>
    <div class="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        title="Newer commit"
        aria-label="Newer commit"
        disabled={!canGoNewer}
        onclick={() => navigateCommit(-1)}
      >
        <ChevronLeft size={12} />
      </button>
      <button
        type="button"
        class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        title="Older commit"
        aria-label="Older commit"
        disabled={!canGoOlder}
        onclick={() => navigateCommit(1)}
      >
        <ChevronRight size={12} />
      </button>
    </div>
    <div class="min-w-0 grow-2 basis-0">
      <p class="truncate text-[0.6875rem] font-medium text-foreground" title={commit.message}>
        {commit.message.split('\n')[0]}
      </p>
      <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span class="font-mono">{commit.shortHash}</span>
        <span>·</span>
        <span class="truncate">{commit.author}</span>
        <span>·</span>
        <span class="shrink-0">{relativeTime(commit.date)}</span>
      </div>
    </div>
  {:else if activeTab === 'stashes' && selectedStash !== null}
    {@const stash = selectedStash}
    <button
      type="button"
      class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Back to stash list"
      aria-label="Back to stash list"
      onclick={clearSelectedStash}
    >
      <ArrowLeft size={12} />
    </button>
    <div class="min-w-0 grow-2 basis-0">
      <p class="truncate text-[0.6875rem] font-medium text-foreground" title={stash.message}>
        {stash.message}
      </p>
      <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span class="font-mono">{stash.id}</span>
        {#if stash.branch}
          <span>·</span>
          <span class="truncate">{stash.branch}</span>
        {/if}
        <span>·</span>
        <span class="shrink-0">{relativeTime(stash.date)}</span>
      </div>
    </div>
  {:else if activeTab === 'pulls'}
    {#if selectedPullRequest && githubIdentity}
      <PrIdentityRow
        summary={selectedPullRequest}
        detail={pullRequestBundle?.detail ?? null}
        checks={pullRequestBundle?.checks ?? null}
        onBack={() => (selectedPullRequest = null)}
        onOpenChecks={() => (prDetailTab = 'checks')}
      />
      <!--
        Which part of the pull request you are reading, immediately ahead of the
        remote actions. The sidebar cannot hold a list of views of its own, and the
        row has the room the title row no longer needs.
      -->
      <PrViewSwitcher
        views={prDetailViews}
        active={prDetailTab}
        onSelect={(id) => (prDetailTab = id)}
      />
    {:else}
      <PrStateFilter state={prListState} onSelect={selectPrListState} />
      <PrListOptionsMenu
        filter={prListFilter}
        sort={prListSort}
        onFilterChange={selectPrListFilter}
        onSortChange={selectPrListSort}
      />
    {/if}
  {:else if activeTab === 'deployments' && selectedDeployment !== null}
    {@const DeploymentGlyph = stateGlyph(openDeploymentState)}
    <button
      type="button"
      class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Back to deployment activity"
      aria-label="Back to deployment activity"
      onclick={() => (selectedDeployment = null)}
    >
      <ArrowLeft size={12} />
    </button>
    <div class="min-w-0 grow-2 basis-0">
      <p
        class="truncate text-[0.6875rem] font-medium text-foreground"
        title={selectedDeployment.environment}
      >
        {selectedDeployment.environment}
      </p>
      <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span class="truncate font-mono">{selectedDeployment.ref}</span>
        <span>·</span>
        <span class="shrink-0 font-mono">{selectedDeployment.sha.slice(0, 7)}</span>
        <span>·</span>
        <span class="shrink-0">{relativeTime(Date.parse(selectedDeployment.updatedAt))}</span>
      </div>
    </div>
    <span
      class="flex shrink-0 items-center gap-1 {stateGlyphClass(openDeploymentState)}"
      role="img"
      title="Deployment {stateLabel(openDeploymentState).toLowerCase()}"
      aria-label="Deployment {stateLabel(openDeploymentState).toLowerCase()}"
    >
      <DeploymentGlyph size={13} />
      <span class="text-[0.5625rem] font-semibold uppercase tracking-wide">
        {stateLabel(openDeploymentState)}
      </span>
    </span>
  {:else if activeTab === 'deployments' && selectedRun !== null}
    {@const RunGlyph = stateGlyph(openRunState)}
    <button
      type="button"
      class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Back to deployment activity"
      aria-label="Back to deployment activity"
      onclick={() => (selectedRun = null)}
    >
      <ArrowLeft size={12} />
    </button>
    <div class="min-w-0 grow-2 basis-0">
      <p
        class="truncate text-[0.6875rem] font-medium text-foreground"
        title={selectedRun.displayTitle}
      >
        {selectedRun.displayTitle}
      </p>
      <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span class="truncate">{selectedRun.name} #{selectedRun.runNumber}</span>
        {#if selectedRun.branch}
          <span>·</span>
          <span class="truncate font-mono">{selectedRun.branch}</span>
        {/if}
        <span>·</span>
        <span class="shrink-0 font-mono">{selectedRun.headSha.slice(0, 7)}</span>
      </div>
    </div>
    <span
      class="flex shrink-0 items-center gap-1 {stateGlyphClass(openRunState)}"
      role="img"
      title="Run {stateLabel(openRunState).toLowerCase()}"
      aria-label="Run {stateLabel(openRunState).toLowerCase()}"
    >
      <RunGlyph size={13} />
      <span class="text-[0.5625rem] font-semibold uppercase tracking-wide">
        {stateLabel(openRunState)}
      </span>
    </span>
  {/if}
{/snippet}

<!--
  One commit menu, two doors: the History rows open it on right click, and the
  header's info control opens it for the commit being read. It was two lists that
  had drifted apart for no reason, so it is one snippet now.
-->
{#snippet commitActions(commit: GitCommitInfo, isHead: boolean)}
  <CommitActionsMenu
    {isHead}
    resetBusy={gitState.isBusy('reset')}
    deleteBusy={gitState.isBusy('delete-commit')}
    onReset={(mode) => requestReset(mode, commit.hash)}
    onDelete={() => requestDeleteCommit(commit)}
    onAmend={isHead ? startAmend : undefined}
    onCopyHash={() => void copyCommitHash(commit)}
    onCopyMessage={() => void copyCommitMessage(commit)}
    onShowInfo={() => (commitInfoTarget = commit)}
  />
{/snippet}

<div class="relative flex h-full min-h-0 flex-col bg-app" data-region="git-panel">
  <GitStatusPanelCommitSearch
    open={findNavState.gitFindOpen}
    query={commitSearchQuery}
    bind:activeIndex={commitSearchActiveIndex}
    focusTrigger={findNavState.gitFindFocusTrigger}
    loading={commitSearchLoading}
    results={commitSearchResults}
    onQueryChange={searchCommits}
    onNext={() => moveCommitSearch(1)}
    onPrev={() => moveCommitSearch(-1)}
    onSubmit={openActiveCommitSearchResult}
    onClose={closeCommitSearch}
    onSelectResult={selectCommitSearchResult}
  />

  <!--
    Header: identity, branch, the view you are in and its tools on one line. The
    view in focus takes a second line the moment it has something to say
    (`showsActionRow`), and that row is where the remote actions live too.
  -->
  <div class="flex shrink-0 flex-col">
    <div
      class="git-panel-header flex h-9 items-center gap-1 overflow-x-auto border-b border-border px-2"
    >
      {#if repoState === 'git'}
        <GitHubAccountMenu
          github={{ connected: githubConnected, configured: githubConfigured, user: githubUser }}
          {primaryRemote}
          onSignIn={() => (showGitHubSignIn = true)}
          onSignOut={() => void signOutGitHub()}
        />
      {/if}
      {#if repoState === 'git' && gitState.branches.length > 0}
        <BranchPicker
          branches={gitState.branches}
          currentBranch={status?.branch ?? null}
          isBusy={gitState.isBusy('checkout')}
          {primaryRemote}
          onSelect={requestCheckout}
          onCreate={(name) => void createBranchAction(name)}
          onDelete={(name) => void deleteBranchAction(name)}
          onAddOrigin={openAddOrigin}
          onReplaceOrigin={openReplaceOrigin}
          statusIcon={worktreeState ? branchStatusIcon : undefined}
          statusBadge={worktreeState === 'dirty' ? branchStatusIcon : undefined}
        />
      {:else}
        <div class="flex items-center gap-1.5 px-2">
          <GitBranch size={12} class="shrink-0 text-muted" />
          <span class="font-mono text-[0.6875rem] font-medium text-foreground">
            {status?.branch ?? (repoState === 'git' ? 'detached' : 'Repository')}
          </span>
        </div>
      {/if}

      {#if repoState === 'git'}
        <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <!--
          The views are a dropdown, not a strip: six of them never fit one row at
          every sidebar width, and a strip that scrolls sideways hides views
          behind a gesture. The trigger is the view in use, with its count.
        -->
        <GitViewMenu {tabs} {activeTab} onSelect={selectTab} />
        <span class="min-w-0 flex-1"></span>
        <!--
          The view's own action comes first, ahead of Search: it acts on what you
          are looking at, while Search, Refresh and the overflow act on the panel.
          Sync belongs to the same group   it trades commits with another
          checkout, it is not an action on this branch's own drift   and it is
          worktree-only, which `showsSync` decides.
        -->
        <div class="flex shrink-0 items-center gap-0.5">
          {@render viewActions()}
          {#if showsSync}
            <GitSyncButton
              busy={gitState.isBusy('sync')}
              blocked={branchSyncBusy || conflicted.length > 0}
              onSync={(direction) => void syncMainAction(direction)}
              onPickPeer={openSyncPeer}
            />
          {/if}
          <button
            type="button"
            class={[
              'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
              findNavState.gitFindOpen
                ? 'bg-elevated text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            aria-label="Search commits"
            title="Search commits"
            aria-pressed={findNavState.gitFindOpen}
            onclick={() => (findNavState.gitFindOpen ? closeCommitSearch() : openCommitSearch())}
          >
            <Search size={12} aria-hidden="true" />
          </button>
          {@render refreshStatusButton()}
          {#if activeTab === 'changes' && selectedCommit}
            <!--
              While a commit is open the overflow control *is* that commit's menu:
              the same snippet the History rows open on right click, because the
              two lists of actions were already identical in everything but the
              order they happened to be written in.
            -->
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                aria-label={`Actions for commit ${selectedCommit.shortHash}`}
                title={`Actions for commit ${selectedCommit.shortHash}`}
              >
                <Info size={13} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  collisionPadding={8}
                >
                  {@render commitActions(selectedCommit, isHeadCommit)}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {:else}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                aria-label="Git actions"
                title="Git actions"
              >
                {#if gitState.isBusy('fetch')}
                  <Loader2 size={12} class="animate-spin" />
                {:else}
                  <MoreHorizontal size={13} />
                {/if}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  collisionPadding={8}
                  class="z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
                >
                  <!--
                  Fetch is the one remote action with no control of its own: it
                  advertises no drift, so it stays here with the working-tree
                  actions. Pull, Push and the main-worktree sync each own a
                  header control, so the menu does not repeat them. They land
                  here instead while conflicts are open, when the row belongs to
                  the resolution controls, and in a worktree checkout, where a
                  managed scope keeps publishing out of the row.
                -->
                  {#if remoteActionsInMenu}
                    {#if showsPull}
                      <DropdownMenu.Item
                        class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                        disabled={branchSyncBusy}
                        onSelect={() => void pullAction()}
                      >
                        <ArrowDownToLine size={12} class="shrink-0 text-dimmed" />
                        Pull {commitsBehind}
                      </DropdownMenu.Item>
                    {/if}
                    {#if showsPush}
                      <DropdownMenu.Item
                        class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                        disabled={pushBlocked}
                        onSelect={() => void pushAction()}
                      >
                        <ArrowUpFromLine size={12} class="shrink-0 text-dimmed" />
                        Push{commitsAhead > 0 ? ` ${String(commitsAhead)}` : ''}
                      </DropdownMenu.Item>
                    {/if}
                  {/if}
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40"
                    disabled={remotes.length === 0 || fetching}
                    onSelect={() => void gitState.fetch(projectId)}
                  >
                    <Download size={12} class="shrink-0 text-dimmed" />
                    Fetch
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                    onSelect={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
                  >
                    <GitPullRequest size={12} class="shrink-0 text-dimmed" />
                    Create pull request…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
                    disabled={localBranches.length < 2}
                    onSelect={() => (showIntegrateModal = true)}
                  >
                    <GitMerge size={12} class="shrink-0 text-dimmed" />
                    Merge or rebase…
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator class="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
                    disabled={status?.clean ?? true}
                    onSelect={() => (showStashModal = true)}
                  >
                    <Archive size={12} class="shrink-0 text-dimmed" />
                    Stash changes…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </div>
      {:else}
        <span class="flex-1"></span>
        <!-- Off-git states render no tabs, so the refresh control stays on this row. -->
        {@render refreshStatusButton()}
      {/if}
    </div>

    {#if showsActionRow}
      <!--
        The row under the header belongs to the view in focus: the commit or
        stash being read, the pull request's identity, the PR list's filter, the
        conflict controls, and Pull and Push. Pull and Push are independent   a
        diverged branch needs both   so each gets a share of the row's width
        instead of one hiding the other, and they are the only items here that
        stretch. While conflicts are open they stand aside entirely (see
        `conflictsOpen`) so the row can hold the controls that end them.
      -->
      <div class="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
        {@render viewContext()}
        {#if showsRemoteActions}
          {#if showsPull}
            <button
              type="button"
              class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-sm bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
              title={`Pull ${String(commitsBehind)} commit(s) from the remote`}
              disabled={branchSyncBusy}
              onclick={() => void pullAction()}
            >
              {#if gitState.isBusy('pull')}
                <Loader2 size={11} class="animate-spin" />
              {:else}
                <ArrowDownToLine size={11} />
              {/if}
              <span class="min-w-0 truncate">Pull {commitsBehind}</span>
            </button>
          {/if}
          {#if showsPush}
            <button
              type="button"
              class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-sm bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
              title={pushTitle}
              disabled={pushBlocked}
              onclick={() => void pushAction()}
            >
              {#if gitState.isBusy('push')}
                <Loader2 size={11} class="animate-spin" />
              {:else}
                <ArrowUpFromLine size={11} />
              {/if}
              <span class="min-w-0 truncate">
                Push{commitsAhead > 0 ? ` ${String(commitsAhead)}` : ''}
              </span>
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Content (scrollable) -->
  <div class="min-h-0 flex-1 overflow-auto" onscroll={handleContentScroll}>
    {#if repoState === 'loading' || repoState === 'git_unavailable' || repoState === 'not_git'}
      <GitStatusPanelRepoStates
        {repoState}
        {preflightDetail}
        onInitialize={() => void initializeRepository()}
      />
    {:else}
      <GitStatusPanelNotices
        {scopeUnhealthy}
        {projectId}
        {scopeBucketId}
        {conflictState}
        {conflicted}
        {conflictRowAborts}
        {integrationActions}
        onRepaired={() => void refreshStatus()}
      />

      {#if identityNeeded}
        <div class="mx-2 mt-2 rounded-lg border border-border bg-surface px-3 py-2">
          <p class="text-[0.625rem] font-medium text-foreground">Commit identity not configured</p>
          {#if showIdentityForm}
            <div class="mt-2 space-y-1.5">
              <input
                class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Name"
                bind:value={identityName}
              />
              <input
                class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Email"
                type="email"
                bind:value={identityEmail}
              />
              <div class="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated"
                  onclick={() => (showIdentityForm = false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-md bg-primary px-2.5 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                  disabled={!identityName.trim() || !identityEmail.trim()}
                  onclick={() => void saveIdentity()}
                >
                  Save
                </button>
              </div>
            </div>
          {:else}
            <button
              type="button"
              class="mt-1.5 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
              onclick={() => {
                identityName = gitState.identity?.name ?? ''
                identityEmail = gitState.identity?.email ?? ''
                showIdentityForm = true
              }}
            >
              Set identity
            </button>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'changes'}
        <GitStatusPanelChangesView
          {selectedCommit}
          {status}
          {changes}
          {conflictSections}
          {stagedSections}
          {workingSections}
          {commitDiffChanges}
          {commitTree}
          {commitTreeCollapsedDirs}
          {changesView}
          {loadingCommitDiff}
          {diffs}
          {expanded}
          {loadingDiff}
          {diffErrors}
          {commitDiffs}
          {commitExpanded}
          {loadingCommitDiffFile}
          {commitDiffErrors}
          bind:selectedPaths
          {paneClass}
          {toggleDiff}
          {toggleStage}
          {toggleSelection}
          {toggleSectionSelection}
          {stagePathsAction}
          {requestStashFor}
          {openInEditor}
          {ignorePathsAction}
          {requestDiscard}
          {routeConflictResolution}
          {restoreFromSource}
          {toggleCommitDiff}
          {toggleCommitDir}
        />
      {:else if activeTab === 'history'}
        <GitGraphView
          commits={commitHistory}
          loading={loadingHistory}
          loadingMore={loadingMoreHistory}
          hasMore={historyHasMore}
          {unpushedCount}
          upstream={status?.upstream ?? null}
          {remoteUpdates}
          selectedHash={selectedCommit?.hash ?? null}
          onSelectCommit={(commit) => void selectCommit(commit)}
        >
          {#snippet menu({ commit, isHead }: { commit: GitCommitInfo; isHead: boolean })}
            {@render commitActions(commit, isHead)}
          {/snippet}
        </GitGraphView>
      {:else if activeTab === 'branches'}
        <GitStatusPanelBranchesView
          branches={gitState.branches}
          {localBranches}
          {worktreeBranches}
          {localBranchNames}
          bind:creatingBranch
          bind:newBranchName
          onCreateBranch={(name) => void createBranchAction(name)}
          onRequestCheckout={requestCheckout}
          onFetchBranch={(branch) => void fetchBranchAction(branch)}
          onRequestDeleteBranch={requestDeleteBranch}
          onRequestDeleteRemoteBranch={requestDeleteRemoteBranch}
        />
      {:else if activeTab === 'pulls'}
        <div class="h-full min-h-0">
          {#if selectedPullRequest && githubIdentity}
            <GitPullRequestDetail
              {projectId}
              identity={githubIdentity}
              summary={selectedPullRequest}
              bind:tab={prDetailTab}
              onBack={() => (selectedPullRequest = null)}
              onFullscreen={() => openPullRequestFullscreen(selectedPullRequest)}
              onAgentReview={(pr) => void startAgentReview(pr)}
              onOpenThread={(threadId) => void openReviewThread(threadId)}
              onOpenWorkflowRun={openWorkflowRunFromCheck}
              onResolveLocally={(pr) => void resolveConflictsLocally(pr)}
              onResolveWithAgent={(pr) => void startConflictResolution(pr)}
            />
          {:else}
            <!--
              The panel draws the filter and the actions for this list in its own
              rows, so the list renders rows and paging only (`showControls`).
            -->
            <GitPullRequestList
              {projectId}
              identity={githubIdentity}
              {githubConnected}
              state={prListState}
              filter={prListFilter}
              sort={prListSort}
              page={prListPage}
              showControls={false}
              onStateChange={selectPrListState}
              onFilterChange={selectPrListFilter}
              onSortChange={selectPrListSort}
              onPageChange={(next) => (prListPage = next)}
              onOpen={(pr) => (selectedPullRequest = pr)}
              onFullscreen={() => openPullRequestFullscreen(null)}
              onSignIn={() => (showGitHubSignIn = true)}
              onCreate={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
            />
          {/if}
        </div>
      {:else if activeTab === 'deployments'}
        <GitDeploymentsMonitor
          {projectId}
          identity={githubIdentity}
          {githubConnected}
          bind:selectedDeployment
          bind:selectedRun
          onSignIn={() => (showGitHubSignIn = true)}
          requestedRunId={requestedWorkflowRunId}
          onRequestedRunOpened={() => (requestedWorkflowRunId = null)}
          onAgentDiagnoseRun={startWorkflowDiagnosis}
          onAgentDiagnoseDeployment={startDeploymentDiagnosis}
        />
      {:else if activeTab === 'stashes'}
        <GitStatusPanelStashesView
          {selectedStash}
          {loadingStashDiff}
          {stashDiffChanges}
          {stashDiffs}
          {loadingStashDiffFile}
          {stashDiffErrors}
          {stashExpanded}
          stashes={gitState.stashes}
          {stashOpBusy}
          stashPopBusy={gitState.isBusy('stash-pop')}
          onSelectStash={(stash) => void selectStash(stash)}
          onToggleStashDiff={(change) => void toggleStashDiff(change)}
          onRestore={(path, target) =>
            void restoreFromSource(selectedStash?.id ?? 'HEAD', path, target)}
          onPopStash={(id) => void popStash(id)}
          onRequestStashDrop={requestStashDrop}
        />
      {/if}
    {/if}
  </div>

  <GitStatusPanelCommitComposer
    {repoState}
    {status}
    {selectedCommit}
    {activeTab}
    stagedCount={staged.length}
    bind:amendMode
    {mergeAwaitsCompletion}
    {commitBusy}
    bind:commitMessage
    bind:commitSelection
    onCommitInline={() => void commitInline()}
    {onCommitMessageKeydown}
  />
  <!-- Pinned action bar -->
  <GitStatusPanelDialogs
    {repoState}
    {status}
    {primaryRemote}
    {remoteBranchExists}
    {pushBlocked}
    {pullStrategyOpen}
    {pullStrategyError}
    {syncMainOpen}
    {syncDirection}
    {syncMainError}
    {integrationOpen}
    {conflictState}
    {conflicted}
    {mergeAwaitsCompletion}
    {mergePending}
    {prResolveBranch}
    {completeMergeBusy}
    {pushRecoverMode}
    {localBranches}
    {integrateBusy}
    {resetOptions}
    {atRiskFiles}
    {agentTurnActive}
    {originModalOpen}
    {originMode}
    {originName}
    {originBusy}
    bind:pushConfirm
    bind:pushDiverged
    bind:completeMergeOpen
    bind:mergeTitle
    bind:mergeDescription
    bind:showGitHubSignIn
    bind:showStashModal
    bind:stashPaths
    bind:stashMessage
    bind:showIntegrateModal
    bind:mergeTarget
    bind:pendingOperation
    bind:acknowledgeActiveTurn
    bind:resetConfirm
    bind:deleteCommitTarget
    bind:checkoutConfirm
    bind:deleteBranchConfirm
    bind:forceDeleteBranchConfirm
    bind:deleteRemoteBranchConfirm
    bind:originReplaceConfirm
    bind:originUrl
    {integrationActions}
    {confirmPushUpstream}
    {recoverPush}
    {closePullStrategy}
    {performPull}
    {closeSyncMain}
    {performSyncMain}
    {confirmCompleteMerge}
    {openCompleteMerge}
    {loadGitHubAuth}
    {stashChanges}
    {requestMergeOrRebase}
    {confirmPendingOperation}
    {confirmReset}
    {confirmDeleteCommit}
    {confirmCheckoutBranch}
    {confirmDeleteBranch}
    {confirmForceDeleteBranch}
    {confirmDeleteRemoteBranch}
    {closeOriginModal}
    {requestSetOrigin}
    {runSetOrigin}
  />
</div>

<!-- Peer chooser: the panel only says which direction the user started from. -->
{#if syncPeerOpen}
  <GitSyncPeerDialog
    {projectId}
    {scopeBucketId}
    initialDirection={syncPeerDirection}
    onClose={closeSyncPeer}
    onDone={syncPeerDone}
  />
{/if}

<GitStatusPanelConfirmDialogs
  bind:stashDropTarget
  bind:discardConfirm
  bind:restoreWorktreeConfirm
  bind:abortConfirmOpen
  bind:acceptConflictsSide
  bind:commitInfoTarget
  {conflictState}
  conflictedCount={conflicted.length}
  {commitInfoOnRemote}
  {commitInfoUrl}
  onConfirmStashDrop={() => void confirmStashDrop()}
  onConfirmDiscard={() => void confirmDiscard()}
  onConfirmRestoreWorktree={() => void confirmRestoreWorktree()}
  onConfirmAbortConflict={() => void confirmAbortConflict()}
  onConfirmAcceptAllConflicts={() => void confirmAcceptAllConflicts()}
  onCopyCommitHash={(commit) => void copyCommitHash(commit)}
  onOpenCommitInBrowser={(url) => void openInBrowser(url)}
/>

<!--
  Full screen pull request reader. It is a sibling of the panel's own layout so
  it can cover the whole window, and it is mounted only while a tab is active.
-->
{#if fullscreenPullRequestId}
  <FullscreenPanelDialog
    tabs={fullscreenPullRequestTabs}
    activeTabId={fullscreenPullRequestId}
    newLabel="New pull request"
    minimizeLabel="Close the full screen reader"
    onSelect={(id) => (fullscreenPullRequestId = id)}
    onCloseTab={closeFullscreenPullRequestTab}
    onNew={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
    onMinimize={() => (fullscreenPullRequestId = null)}
  >
    {#snippet icon()}
      <GitPullRequest size={12} class="shrink-0" aria-hidden="true" />
    {/snippet}
    <div class="flex min-h-0 flex-1 flex-col">
      {#if fullscreenActivePullRequest && githubIdentity}
        <GitPullRequestDetail
          {projectId}
          identity={githubIdentity}
          summary={fullscreenActivePullRequest}
          variant="fullscreen"
          onBack={() => (fullscreenPullRequestId = PR_READER_LIST_TAB)}
          onAgentReview={(pr) => void startAgentReview(pr)}
          onOpenThread={(threadId) => void openReviewThread(threadId)}
          onOpenWorkflowRun={openWorkflowRunFromCheck}
          onResolveLocally={(pr) => void resolveConflictsLocally(pr)}
          onResolveWithAgent={(pr) => void startConflictResolution(pr)}
        />
      {:else}
        <GitPullRequestList
          {projectId}
          identity={githubIdentity}
          {githubConnected}
          state={prListState}
          filter={prListFilter}
          sort={prListSort}
          page={prListPage}
          onStateChange={selectPrListState}
          onFilterChange={selectPrListFilter}
          onSortChange={selectPrListSort}
          onPageChange={(next) => (prListPage = next)}
          onOpen={(pr) => openPullRequestFullscreen(pr)}
          onSignIn={() => (showGitHubSignIn = true)}
          onCreate={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
        />
      {/if}
    </div>
  </FullscreenPanelDialog>
{/if}

<style>
  /*
    The header row is a query container so the action labels can retreat before
    the row runs out of room. The glyphs always say what the control does, and the
    tooltip names it in full, so dropping the word is a compress, not a loss.
  */
  .git-panel-header {
    container: git-header / inline-size;
  }

  @container git-header (max-width: 520px) {
    .view-action-label {
      display: none;
    }
  }
</style>
