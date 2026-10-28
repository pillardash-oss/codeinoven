<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioDot from '@pdslng/cio-icon/CioDot.svelte'
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
  import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioRocket from '@pdslng/cio-icon/CioRocket.svelte'
  import CioSkipForward from '@pdslng/cio-icon/CioSkipForward.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    invalidateRepositoryPreflight,
    loadRepositoryPreflight
  } from '$lib/repository-preflight-cache'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { gitState, GitState } from '$lib/stores/git.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { cachedHasDeployments, cacheHasDeployments } from '$lib/git-deployments-cache'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import { buildCommitTree } from './git-status-panel-format'
  import {
    assignAgentToPullRequest as assignAgentToPullRequestAction,
    diagnoseDeployment,
    diagnoseWorkflowJob,
    openAgentThread as openAgentThreadAction,
    preparePrConflictSession,
    resolveCurrentConflictsWithAgent,
    resolvePrConflictsWithAgent
  } from './git-status-panel-agent-actions'
  import type {
    GitCommitInfo,
    GitConflictSide,
    GitDiff,
    GitFileChange,
    GitPullStrategy,
    GitPullPreference,
    GitSyncDirection,
    GitRebaseAction,
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubAuthStatus,
    GitHubWorkflowRun,
    GitResetMode,
    GitRemoteUpdate,
    ThreadStatus
  } from '$shared/types'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import CommitActionsMenu from './CommitActionsMenu.svelte'
  import GitStatusPanelConfirmDialogs from './GitStatusPanelConfirmDialogs.svelte'
  import GitStatusPanelCommitComposer from './GitStatusPanelCommitComposer.svelte'
  import GitStatusPanelFind from './GitStatusPanelFind.svelte'
  import { GitStatusPanelFindController } from './GitStatusPanel/git-status-panel-find-controller.svelte'
  import { GitStatusPanelBranchesController } from './GitStatusPanel/git-status-panel-branches-controller.svelte'
  import { GitStatusPanelStashesController } from './GitStatusPanel/git-status-panel-stashes-controller.svelte'
  import { GitStatusPanelChangesController } from './GitStatusPanel/git-status-panel-changes-controller.svelte'
  import GitStatusPanelHeader from './GitStatusPanel/GitStatusPanelHeader.svelte'
  import GitStatusPanelViewContext from './GitStatusPanel/GitStatusPanelViewContext.svelte'
  import GitStatusPanelContent from './GitStatusPanel/GitStatusPanelContent.svelte'
  import { gitFindScopeFor } from './git-panel-find'
  import GitStatusPanelDialogs from './GitStatusPanelDialogs.svelte'
  import GitPullButton from './GitPullButton.svelte'
  import GitSyncPeerDialog from './GitSyncPeerDialog.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { gitPullJobs } from '$lib/stores/git-pull-jobs.svelte'
  import GitPullRequestList from './GitPullRequestList.svelte'
  import GitPullRequestDetail from './GitPullRequestDetail.svelte'
  import { isFailedJob } from '$shared/github-job-log'
  import PrBatchDialog from './PrBatchDialog.svelte'
  import PrMergeConfirmDialog from './PrMergeConfirmDialog.svelte'
  import PrMetadataDialog from './PrMetadataDialog.svelte'
  import { prSummaryChatContext, prSummaryExplainPrompt } from './git-status-panel-prompts'
  import {
    PR_DETAIL_VIEWS,
    prViewCount,
    type PrDetailTabId,
    type PrListAction,
    type PrMetadataMode
  } from './pr-view'
  import {
    notificationIssueSummary,
    notificationPullRequestSummary,
    notificationTargetFor
  } from './notification-view'

  import FullscreenPanelDialog from '../workspace/FullscreenPanelDialog.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { gitPanelView, type GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import type {
    PrListFilter,
    PrListSort,
    PrMergeMethod,
    PrState,
    PullRequestBundle,
    PullRequestSummary
  } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    scopeBucketId?: string
  }

  let { projectId, threadId, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID }: Props = $props()

  /**
   * The Find bar's own state and answers. The panel supplies where a result
   * opens; the bar stays a reader of results rather than a second navigator.
   */
  const find = new GitStatusPanelFindController({
    get projectId() {
      return projectId
    },
    get activeTab() {
      return activeTab
    },
    get githubIdentity() {
      return githubIdentity
    },
    get prListState() {
      return prListState
    },
    openCommit: (commit) => void selectCommit(commit),
    requestCheckout: (branch) => branches.requestCheckout(branch),
    openPullRequest: (pr) => {
      selectedPullRequest = pr
      prDetailTab = 'conversation'
    },
    openRun: (run) => {
      selectedRun = run
      selectedDeployment = null
    },
    openDeployment: (deployment) => {
      selectedDeployment = deployment
      selectedRun = null
    },
    openStash: (stash) => void stashes.selectStash(stash)
  })

  /**
   * The Branches view's state and operations, including the confirmations a
   * checkout and a delete ask for before they touch the working tree.
   */
  const branches = new GitStatusPanelBranchesController({
    get projectId() {
      return projectId
    },
    get status() {
      return status
    },
    get localBranchNames() {
      return localBranchNames
    }
  })

  /** The working tree: the diffs, the selection, and the index edits. */
  const workingTree = new GitStatusPanelChangesController({
    get projectId() {
      return projectId
    },
    get changes() {
      return changes
    },
    get staged() {
      return staged
    },
    refreshStatus: () => refreshStatus(),
    requestCommitMessageFocus: () => (commitSelection = true)
  })

  /** The Stashes view: the stash being read, its file diffs, and the list edits. */
  const stashes = new GitStatusPanelStashesController({
    get projectId() {
      return projectId
    },
    get activeTab() {
      return activeTab
    },
    setActiveTab: (id) => (activeTab = id),
    refreshStatus: () => refreshStatus(),
    reloadHistory: () => reloadHistory()
  })

  /**
   * Health of the scope this panel is attached to. A managed checkout that is
   * gone (or otherwise unhealthy) is why every Git operation here fails, so the
   * panel offers the repair instead of the raw failure text.
   */
  let scopeHealth = $derived(scopeState.healthFor(scopeBucketId, projectId))
  let scopeUnhealthy = $derived(scopeHealth !== undefined && scopeHealth.category !== 'healthy')

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'

  /**
   * Whether this panel's Git state comes from an Oven, and which one. The store
   * resolves it from the active scope it already reads against, so the panel
   * never has to re-derive the thread's Oven at render time.
   */
  let ovenTarget = $derived(gitState.remoteTarget)
  /**
   * Why the repository check itself failed, or null.
   *
   * A preflight that never answered leaves the working-tree read with nothing
   * to report from, so this carries the reason for the remote case; a local
   * project keeps its existing "not a repository" answer.
   */
  let preflightError = $state<string | null>(null)
  /** Why the Oven could not answer, for the surface overlay, or null. */
  let ovenError = $derived(ovenTarget ? (gitState.workingTreeError ?? preflightError) : null)

  // Hiding the sidebar destroys and recreates this component, so the tab/
  // selection state is seeded from (and mirrored back into) a persisted
  // view-state store keyed by project+thread to survive that remount.
  function initialViewState(): ReturnType<typeof gitPanelView.get> {
    return gitPanelView.get(projectId, threadId)
  }

  const savedView = initialViewState()

  let repoState = $state<RepoState>('loading')
  let preflightDetail = $state('')

  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')
  let pushConfirm = $state(false)
  /** Pull strategy chooser, opened by the default `ask` preference. */
  let pullStrategyOpen = $state(false)
  /**
   * Main-sync strategy chooser, opened by the `ask` preference, a failure, or
   * always when sending commits out of this checkout (that mutates a branch the
   * user is not looking at).
   */
  let syncMainOpen = $state(false)
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
  let mergeTarget = $state('')
  let pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)
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
  /**
   * The commit and paths waiting on the rewrite confirmation: taking a file's
   * change out of a commit moves the branch, so it is asked for first.
   */
  let removeCommitChangesConfirm = $state<{ hash: string; paths: string[] } | null>(null)
  /** Commit whose full record is open in the info dialog. */
  let commitInfoTarget = $state<GitCommitInfo | null>(null)
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
   * Which rows of the PR list are selected.
   *
   * Panel state, like the filter and the page, because the list is mounted twice
   * (dock and full screen reader) and both mounts draw the same listing: a selection
   * held inside the list would let the two disagree about what a batch acts on.
   */
  let prListSelection = $state<Record<number, boolean>>({})
  /**
   * The lifecycle batch waiting on its confirmation. It is only ever the pending
   * question: the run itself leaves as a background job (`prBatchJobs`), so nothing
   * here holds the window while twenty pull requests are written.
   */
  let prBatch = $state<{ mode: 'close' | 'reopen'; targets: PullRequestSummary[] } | null>(null)
  /** The pull request a metadata picker is editing, or null when none is open. */
  let prMetadata = $state<{ pr: PullRequestSummary; mode: PrMetadataMode } | null>(null)
  /** The merge a row menu asked for, with the method the user chose. */
  let prMerge = $state<{ pr: PullRequestSummary; method: PrMergeMethod } | null>(null)
  let prMergeOpen = $state(false)
  let prMergeTitle = $state('')
  let prMergeMessage = $state('')
  let prMergeBusy = $state(false)
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
  /**
   * The GitHub accounts, as one status.
   *
   * One state rather than a derived boolean, a configured flag and a user: the
   * panel also has to hand the account list to the account menu, and three loose
   * copies of one answer is how they end up disagreeing.
   */
  let githubStatus = $state<GitHubAuthStatus | null>(null)
  const githubConnected = $derived(githubStatus?.connected === true)
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
  /**
   * The deployment or workflow run open in the Deploys view. The panel owns the
   * selection, like every other view's, so its action row can name what is open
   * and its external link can follow it.
   */
  let selectedDeployment = $state<GitHubDeployment | null>(null)
  let selectedRun = $state<GitHubWorkflowRun | null>(null)

  $effect(() => {
    gitPanelView.set(projectId, threadId, {
      activeTab,
      changesView,
      selectedCommit,
      selectedPullRequest,
      selectedStash: stashes.selectedStash,
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
  const commitTree = $derived(buildCommitTree(commitDiffChanges))
  /** Local commits not yet on the upstream remote, oldest-first-among-them   matches history order. */
  const unpushedCount = $derived(status?.upstream ? Math.max(0, status.ahead) : 0)

  const busy = $derived(
    gitState.isBusy(['refresh', 'init', 'commit', 'amend', 'reset', 'remove-commit-changes'])
  )
  const commitBusy = $derived(gitState.isBusy(['commit', 'amend']))
  const batchBusy = $derived(
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
  const stashOpBusy = $derived(gitState.isBusy(['stash-pop', 'stash-drop']))

  /**
   * The refresh button: the view in focus, then the repository behind it.
   *
   * The view's reload goes through the store rather than through a signal the
   * view watches. A view that watched a signal had to call a store method that
   * reads the very record it writes, so a forced reload re-ran its own effect:
   * the PR list and the deployments view refetched forever. The store is what
   * every view renders from, so reloading it is enough.
   *
   * Only the view is awaited, because it is the answer the click was about and
   * the one the control reports on. The repository half (working tree, chrome,
   * remote-tracking refs) is started first and left to land on its own: every
   * step of it publishes through the store, so a late answer still repaints the
   * panel instead of being dropped, and a slow network round trip can never turn
   * Refresh into a stalled control.
   */
  async function refreshPanel(): Promise<void> {
    void refreshRepository().catch(() => undefined)
    await refreshFocusedView()
  }

  /**
   * The repository half of Refresh, deliberately never awaited by the button.
   *
   * `loadRepoState` re-asks whether this is still a repository at all (the one
   * thing a cache can be wrong about), then reads the working tree, the
   * branches and the History pages, which is what the Changes, History and
   * Branches views render from. The fetch then makes `ahead`/`behind` true
   * again. An explicit click skips the age gate that throttles the automatic
   * fetch, because the user asked for the newest answer there is; only a
   * repository with no remote is skipped, since there is nothing to ask.
   */
  async function refreshRepository(): Promise<void> {
    await loadRepoState(true)
    // A fetch already in flight is already answering this click, and a
    // repository with no remote has nothing to ask: either way a second round
    // trip would only repeat a question that is being asked.
    if (remotes.length === 0 || gitState.isBusy('fetch')) return
    await gitState.fetch(projectId)
  }

  /** Force a reload of whatever the active view shows, when the store has it. */
  async function refreshFocusedView(): Promise<void> {
    if (activeTab === 'notifications') {
      // Notifications are account-wide, so the panel's refresh button reloads
      // them from GitHub as the active account, the same way it refreshes every
      // other view.
      if (githubConnected) await githubNotifications.load()
      return
    }
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
      // The view's page and filter live in the view, so the store re-reads the
      // pages it holds for this repository instead: one per view in practice.
      await gitState.refreshDeploymentPages(projectId, identity.owner, identity.repo)
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
    // refresh of one. A remote checkout's last-known read counts as data, so a
    // cached tree stays on screen, dimmed by the surface overlay, until the new
    // preflight answers.
    if (!force) repoState = gitState.showingCachedStatus ? 'git' : 'loading'
    preflightError = null
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
    } catch (reason) {
      // A preflight that could not answer is not the same as "this is not a
      // repository". On an Oven the round trip itself may have failed, and
      // claiming otherwise would show a git-less panel for a healthy checkout
      // at exactly the moment the user needs to see its last-known state. The
      // surface overlay states the real reason.
      preflightError = reason instanceof Error ? reason.message : 'Git could not be read.'
      repoState = gitState.remoteTarget ? 'git' : 'not_git'
    }
  }

  async function initializeRepository(): Promise<void> {
    await gitState.initialize(projectId)
    // The cached preflight still says "not a repository". Without this the panel
    // would keep reporting that for the rest of the cache's life.
    invalidateRepositoryPreflight(projectId)
    if (gitState.status) repoState = 'git'
  }

  async function loadGitHubAuth(): Promise<void> {
    applyGitHubStatus(await gitState.githubAuthStatus())
  }

  /** Adopt a GitHub status, and the active account's data with it. */
  async function applyGitHubStatus(status: GitHubAuthStatus): Promise<void> {
    const previousAccountId = githubStatus?.activeAccountId ?? null
    githubStatus = status
    // Notifications are account-wide, so they are the one view whose data belongs
    // to the account rather than to the repository the panel is standing in. A
    // view that was never opened is left alone: it loads when it is opened.
    // An open thread was read as the account that just left, so a different
    // account closes it; the same account signing in again keeps it, which is
    // what an unchecked remount does when the sidebar is hidden and shown.
    if (previousAccountId !== status.activeAccountId) githubNotifications.closeNotification()
    if (githubNotifications.hasLoaded) await githubNotifications.load()
  }

  /**
   * Make another signed-in account the one GitHub calls run as.
   *
   * The view is reloaded afterwards: everything on screen was read with the
   * previous account's token, so leaving it up would present one account's pull
   * requests, issues or deployments as another's.
   */
  async function switchGitHubAccount(accountId: string): Promise<void> {
    await applyGitHubStatus(await gitState.switchGitHubAccount(accountId))
    await refreshFocusedView()
  }

  /**
   * Discover whether the repo has GitHub deployment activity so the Deployments
   * tab can appear on its own. Only meaningful while signed in with a GitHub
   * origin remote, and only the fact is asked for: the view reads its own pages
   * when it opens, so the probe must not pay for a listing it will not show.
   */
  async function detectDeployments(): Promise<void> {
    const identity = githubIdentity
    if (!githubConnected || !identity || detectingDeployments) return
    detectingDeployments = true
    try {
      const hasActivity = await gitState.ensureDeploymentActivity(
        projectId,
        identity.owner,
        identity.repo
      )
      if (hasActivity !== null) {
        hasDeployments = hasActivity
        cacheHasDeployments(projectId, hasActivity)
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

  /**
   * Review the open run's failed job.
   *
   * The job's own log is read first so the agent opens with the evidence rather
   * than a request to fetch it again.
   */
  async function reviewOpenRunFailedJob(): Promise<void> {
    const run = selectedRun
    const identity = githubIdentity
    const job = openRunFailedJob
    if (!run || !identity || !job || preparingRunDiagnosis) return
    preparingRunDiagnosis = true
    try {
      const log = await gitState
        .ensureDeploymentJobLog(projectId, identity.owner, identity.repo, job.id)
        .catch(() => null)
      startWorkflowDiagnosis(
        gitState.deploymentRunDetails[
          GitState.workflowRunKey(identity.owner, identity.repo, run.id)
        ]?.detail.run ?? run,
        job,
        log
      )
    } finally {
      preparingRunDiagnosis = false
    }
  }

  /** Re-read the open run after a cancel or a re-run changed its state. */
  async function reloadOpenRun(): Promise<void> {
    const run = selectedRun
    const identity = githubIdentity
    if (!run || !identity) return
    await gitState
      .ensureWorkflowRunDetail(projectId, identity.owner, identity.repo, run.id, true)
      .catch(() => null)
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

  function assignAgentToPullRequest(pr: PullRequestSummary): void {
    void assignAgentToPullRequestAction(projectId, pr)
  }

  function openAgentThread(threadId: string): void {
    void openAgentThreadAction(projectId, threadId)
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
      scopeBucketId,
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
    await resolveCurrentConflictsWithAgent(
      projectId,
      scopeBucketId,
      status?.branch ?? 'this worktree'
    )
  }

  async function signOutGitHub(): Promise<void> {
    // Signing out of the active account hands GitHub calls to the next one, so
    // the panel adopts the status that comes back rather than assuming none is
    // signed in.
    await applyGitHubStatus(await gitState.logoutGitHub())
    await refreshFocusedView()
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
    // The find bar follows the view, so a subject change drops the answers that
    // belonged to the old one while leaving the bar open if it was open.
    const subjectChanged = gitFindScopeFor(id) !== find.scope
    activeTab = id
    if (subjectChanged && findNavState.gitFindOpen) find.resetResults()
    if (id === 'history') void loadHistory()
    // Notifications arrive from GitHub rather than the repository, so the view
    // asks for its own data the first time it is shown.
    if (id === 'notifications') void githubNotifications.ensureLoaded()
  }

  /**
   * Take the branch trigger's status badge to the work it names: the Changes view
   * with any commit that was open closed, so the click lands on the working tree
   * instead of the commit sheet the view would otherwise still be showing. The
   * click itself is left to bubble to the trigger, which closes a picker that
   * was already open before the view beneath it changes.
   */
  function openWorkingChanges(): void {
    clearSelectedCommit()
    selectTab('changes')
  }

  /**
   * Switch which pull requests the PR view lists. The filter is the panel's, so
   * the page it belonged to goes with it: page 4 of the closed list has nothing
   * to do with page 4 of the open one. The selection goes with it for the same
   * reason: "close 5 selected" must never mean five rows the user can no longer see.
   */
  function selectPrListState(next: PrState): void {
    if (next === prListState) return
    prListState = next
    prListPage = 1
    prListSelection = {}
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
    prListSelection = {}
  }

  function selectPrListSort(next: PrListSort): void {
    if (next === prListSort) return
    prListSort = next
    prListPage = 1
    prListSelection = {}
  }

  /** A different page is a different set of rows, so the selection goes with it. */
  function selectPrListPage(next: number): void {
    if (next === prListPage) return
    prListPage = next
    prListSelection = {}
  }

  /**
   * Where a pull request list action becomes something real.
   *
   * The list hands over one action plus the rows it applies to and knows nothing
   * else, which is what keeps the two mounts of the list identical and keeps every
   * confirmation, picker, and batch in the panel that owns the state behind them.
   */
  function handlePrListAction(action: PrListAction): void {
    if (action.kind === 'open') {
      const target = action.targets[0]
      if (target) selectedPullRequest = target
      return
    }
    if (action.kind === 'open-in-browser') {
      const target = action.targets[0]
      if (target) void openInBrowser(target.url)
      return
    }
    if (action.kind === 'copy-links' || action.kind === 'copy-branches') {
      const text = action.targets
        .map((target) => (action.kind === 'copy-links' ? target.url : target.headRef))
        .join('\n')
      void copyText(text).catch(() => undefined)
      return
    }
    if (action.kind === 'close' || action.kind === 'reopen') {
      if (action.targets.length === 0) return
      prBatch = { mode: action.kind, targets: action.targets }
      return
    }
    const target = action.targets[0]
    if (!target) return
    if (action.kind === 'explain' || action.kind === 'quick-chat') {
      openPrChat(target, action.kind === 'explain' ? 'explain' : 'quick')
      return
    }
    if (action.kind === 'assign-agent') {
      assignAgentToPullRequest(target)
      return
    }
    if (action.kind === 'open-agent-thread') {
      openAgentThread(action.threadId)
      return
    }
    if (action.kind === 'mark-ready') {
      void markPrReady(target)
      return
    }
    if (action.kind === 'merge') {
      openPrMerge(target, action.method)
      return
    }
    prMetadata = { pr: target, mode: action.kind }
  }

  function confirmPrBatch(comment: string | null): void {
    const pending = prBatch
    if (!pending || !githubIdentity) return
    prBatchJobs.start({
      projectId,
      owner: githubIdentity.owner,
      repo: githubIdentity.repo,
      mode: pending.mode,
      targets: pending.targets,
      comment
    })
    prBatch = null
    // The selection has been acted on, so it goes with the batch rather than
    // inviting a second close of the same rows.
    prListSelection = {}
  }

  /**
   * Anchor a read-only side chat on one pull request, the same panel the comment
   * actions open.
   *
   * The visible row is the selection and the pull request's own facts are the
   * pinned context, because a list row carries no transcript to ride and no diff to
   * quote. That gap is named in the context rather than papered over, so the agent
   * says what it cannot see instead of guessing.
   */
  function openPrChat(pr: PullRequestSummary, mode: 'explain' | 'quick'): void {
    const identity = githubIdentity
    if (!identity) return
    contextSidebarState.openTemporaryChat(
      projectId,
      threadId,
      mode === 'explain' ? 'elaborate' : 'quick',
      [
        `#${pr.number} ${pr.title}`,
        `by ${githubDisplayLogin(pr.authorLogin)} · ${pr.headRef} → ${pr.baseRef}`,
        pr.url
      ].join('\n'),
      prSummaryChatContext(pr, `${identity.owner}/${identity.repo}`),
      threadSettings.lastUsed,
      true,
      mode === 'explain' ? prSummaryExplainPrompt(pr) : undefined
    )
  }

  async function markPrReady(pr: PullRequestSummary): Promise<void> {
    const identity = githubIdentity
    if (!identity) return
    await gitState.markPullRequestReadyForReview(
      projectId,
      identity.owner,
      identity.repo,
      pr.number
    )
  }

  /**
   * Open the merge confirmation with the method the row menu chose.
   *
   * The title is seeded the way GitHub seeds it and the message is left empty: the
   * list never fetched the pull request body, and an empty message is what tells
   * GitHub to keep its own. Both are then the user's to edit before merging.
   */
  function openPrMerge(pr: PullRequestSummary, method: PrMergeMethod): void {
    prMergeTitle =
      method === 'merge' ? `Merge pull request #${pr.number} from ${pr.headRef}` : pr.title
    prMergeMessage = ''
    prMerge = { pr, method }
    prMergeOpen = true
  }

  async function confirmPrMerge(): Promise<void> {
    const pending = prMerge
    const identity = githubIdentity
    if (!pending || !identity) return
    prMergeBusy = true
    try {
      const merged = await gitState.mergePullRequest(
        projectId,
        identity.owner,
        identity.repo,
        pending.pr.number,
        pending.method,
        pending.method === 'rebase' ? undefined : prMergeTitle.trim() || undefined,
        pending.method === 'rebase' ? undefined : prMergeMessage.trim() || undefined
      )
      if (merged) {
        // The row has left every open listing, so the selection it may have been
        // part of no longer describes anything on screen.
        prListSelection = {}
        prMerge = null
      }
    } finally {
      prMergeBusy = false
      prMergeOpen = false
    }
  }

  async function selectCommit(commit: GitCommitInfo): Promise<void> {
    selectedCommit = commit
    activeTab = 'changes'
    // The selection belongs to the commit that was open, never to the next one.
    workingTree.clearSelection()
    loadingCommitDiff = true
    commitDiffChanges = await gitState.getCommitDiff(projectId, commit.hash)
    commitDiffs = {}
    commitExpanded = {}
    loadingCommitDiffFile = {}
    commitDiffErrors = {}
    commitTreeCollapsedDirs = {}
    loadingCommitDiff = false
  }

  /**
   * Open one commit named from outside the history list, addressed by its hash.
   *
   * An issue's history knows a referenced commit only by hash, and `git log` resolves
   * a hash-like query against the object database rather than the commit message, so
   * a commit that was fetched but never checked out still opens. A commit this
   * checkout has never fetched is a miss worth saying out loud: a click that silently
   * does nothing reads as a broken link.
   */
  async function openCommitByHash(hash: string): Promise<void> {
    const [commit] = await gitState.getLog(projectId, 1, 0, hash)
    // The pin above any message matches is what makes the hash trustworthy, so a
    // result that is not the hash itself is a commit whose message happens to
    // contain it, which is not the commit the reader asked for.
    if (!commit || !commit.hash.startsWith(hash)) {
      reportErrorWithDetails(
        `Commit ${hash.slice(0, 7)} is not in this repository. Fetch the branch it was pushed to, then open it again.`
      )
      return
    }
    void selectCommit(commit)
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
    workingTree.clearSelection()
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

  /** Take files out of the commit the panel has open. Destructive, so asked first. */
  function requestRemoveCommitChanges(paths: string[]): void {
    const commit = selectedCommit
    if (!commit || paths.length === 0) return
    removeCommitChangesConfirm = { hash: commit.hash, paths }
  }

  async function confirmRemoveCommitChanges(): Promise<void> {
    const pending = removeCommitChangesConfirm
    if (!pending) return
    removeCommitChangesConfirm = null
    await gitState.removeCommitChanges(projectId, pending.hash, pending.paths)
    if (gitState.error) return
    // The commit that was open carries a new hash now, so its diff describes a
    // commit that no longer exists: leave the rewritten history in History
    // rather than an inspector pinned to a hash that is gone.
    clearSelectedCommit()
    void reloadHistory()
    void refreshStatus()
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
      workingTree.clearSelection()
      void refreshStatus()
      void reloadHistory()
    }
  }

  function onCommitMessageKeydown(event: KeyboardEvent): void {
    // Enter never commits by itself   only Cmd/Ctrl+Enter does, so writing a
    // multi-line message can never fire the commit early.
    if (!keymapState.matches('git-commit', event)) return
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
    find.close()
    selectedCommit = null
    amendMode = false
    commitSelection = false
    commitDiffChanges = []
    commitDiffs = {}
    commitExpanded = {}
    loadingCommitDiff = false
    loadingCommitDiffFile = {}
    commitDiffErrors = {}
    commitTreeCollapsedDirs = {}
    deleteCommitTarget = null
    stashes.resetForScopeSwap()
    pendingOperation = null
    branches.resetForScopeSwap()
    resetConfirm = null
    pushConfirm = false
    pushDiverged = false
    pushRecoverMode = null
    pullStrategyOpen = false
    syncMainOpen = false
    showIntegrateModal = false
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
    // The sign-in panel is app-level (it keeps polling while the user authorizes
    // in a browser), so its result reaches this panel as a report rather than as
    // a callback on the panel's own control.
    const unsubscribeGitHubSignIn = githubSignIn.onAuthorized(() => void loadGitHubAuth())
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
      unsubscribeGitHubSignIn()
      if (findNavState.gitFindOpen) find.close()
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
   * Whether the commit waiting to be rewritten is already upstream. Rewriting it
   * moves the branch, so an upstream copy means the next push has to force, and
   * the confirmation says so before the user commits to it.
   */
  const removeCommitOnRemote = $derived.by(() => {
    const target = removeCommitChangesConfirm
    if (!target) return false
    const commit = commitHistory.find((entry) => entry.hash === target.hash)
    if (!commit) return false
    if (commit.refs.some((ref) => remoteTrackingRefs.has(ref.name))) return true
    if (!status?.upstream) return false
    return commitHistory.findIndex((entry) => entry.hash === target.hash) >= unpushedCount
  })
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
    const selected = selectedRun
    const identity = githubIdentity
    if (!selected || !identity) return 'unknown'
    const run =
      gitState.deploymentRunDetails[
        GitState.workflowRunKey(identity.owner, identity.repo, selected.id)
      ]?.detail.run ?? selected
    return run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
  })
  /**
   * The open run's loaded jobs, so the header can count them and name the job
   * that failed. Empty until the detail read lands, which is why the count and
   * the failed-job control appear a beat after the run itself.
   */
  const openRunJobs = $derived.by(() => {
    const selected = selectedRun
    const identity = githubIdentity
    if (!selected || !identity) return []
    return (
      gitState.deploymentRunDetails[
        GitState.workflowRunKey(identity.owner, identity.repo, selected.id)
      ]?.detail.jobs ?? []
    )
  })
  const openRunFailedJob = $derived(openRunJobs.find(isFailedJob) ?? null)
  /** Opens the failed job's review thread: true while its log is being read. */
  let preparingRunDiagnosis = $state(false)
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
   * The notification the Notifications view has open, and what it points at.
   *
   * A notification names a thread by repository and number, which is exactly how
   * the panel's own pull request and issue readers address one, so what is open
   * here is read by those readers rather than by a surface built for
   * notifications alone. The thread's repository need not be the one the panel is
   * standing in, which is why the readers are handed their own identity.
   */
  let notificationStackSelection = $state<{
    notificationId: string
    pr: PullRequestSummary
  } | null>(null)
  const openNotification = $derived(githubNotifications.openNotification)
  const notificationTarget = $derived(
    openNotification ? notificationTargetFor(openNotification) : null
  )
  const notificationIdentity = $derived(
    notificationTarget ? { owner: notificationTarget.owner, repo: notificationTarget.repo } : null
  )
  const notificationPullRequest = $derived(
    openNotification && notificationTarget?.kind === 'pull-request'
      ? notificationStackSelection?.notificationId === openNotification.id
        ? notificationStackSelection.pr
        : notificationPullRequestSummary(openNotification, notificationTarget)
      : null
  )
  const notificationIssue = $derived(
    openNotification && notificationTarget?.kind === 'issue'
      ? notificationIssueSummary(openNotification, notificationTarget)
      : null
  )
  const notificationBundle = $derived(
    pullRequestBundleFor(notificationIdentity, notificationPullRequest)
  )
  const notificationPrDetailViews = $derived(
    prDetailViewsFor(notificationBundle, notificationPullRequest)
  )
  /**
   * The reader's views with their counts, for the switcher in the action row. The
   * counts come from the same bundle the reader renders, so the switcher and the
   * rail agree.
   */
  const prDetailViews = $derived(
    prDetailViewsFor(pullRequestBundleFor(githubIdentity, selectedPullRequest), selectedPullRequest)
  )
  /**
   * The open pull request's fetched record. The reader reads the same bundle
   * from the store, so the panel's identity row and its pills cannot show one
   * thing while the reader shows another.
   */
  const pullRequestBundle = $derived(pullRequestBundleFor(githubIdentity, selectedPullRequest))
  /** Whether a notification action is in flight, so its controls can hold still. */
  const notificationBusy = $derived(githubNotifications.busyThreadId !== null)
  /** The notification action style, shared by the header group's controls. */
  const notificationActionClass =
    'flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40'

  function prDetailViewsFor(
    bundle: PullRequestBundle | undefined,
    summary: PullRequestSummary | null
  ) {
    return PR_DETAIL_VIEWS.filter(
      (view) => view.id !== 'stacks' || (bundle?.stack?.length ?? 0) > 1
    ).map((view) => ({
      ...view,
      count: prViewCount(
        view.id,
        bundle,
        summary ? (gitState.prAgentReports[String(summary.number)]?.length ?? 0) : 0
      )
    }))
  }

  /**
   * One pull request's fetched record, for whoever is reading it.
   *
   * A function rather than a second derived value because two readers ask for it:
   * the Pulls view for the pull request it has open, and the Notifications view for
   * the one a notification names, which lives in the repository the notification
   * came from. The store keys bundles by repository and number, so the same call
   * serves both.
   */
  function pullRequestBundleFor(
    identity: { owner: string; repo: string } | null,
    summary: PullRequestSummary | null
  ): PullRequestBundle | undefined {
    return identity && summary
      ? gitState.prBundles[GitState.bundleKey(identity.owner, identity.repo, summary.number)]
      : undefined
  }

  /**
   * Whether a repository is the one this panel stands in.
   *
   * The panel's own operations   checking a pull request out to resolve it here,
   * reading one of its commits, revealing one of its workflow runs   all act on the
   * local checkout, so a thread from anywhere else takes the github.com route
   * instead of pointing the local view at somebody else's repository.
   */
  function isPanelRepository(identity: { owner: string; repo: string } | null): boolean {
    return (
      identity !== null &&
      githubIdentity !== null &&
      identity.owner === githubIdentity.owner &&
      identity.repo === githubIdentity.repo
    )
  }

  /** Reveal a check's workflow run: here for the panel's repository, there for any other. */
  function openWorkflowRunFor(identity: { owner: string; repo: string }, runId: number): void {
    if (isPanelRepository(identity)) {
      openWorkflowRunFromCheck(runId)
      return
    }
    void openInBrowser(
      `https://github.com/${identity.owner}/${identity.repo}/actions/runs/${runId}`
    )
  }

  /** Open a commit a thread names: in the panel's own history, or on github.com. */
  function openCommitFor(identity: { owner: string; repo: string }, hash: string): void {
    if (isPanelRepository(identity)) {
      void openCommitByHash(hash)
      return
    }
    void openInBrowser(`https://github.com/${identity.owner}/${identity.repo}/commit/${hash}`)
  }
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
  const remoteActionsApply = $derived(activeTab !== 'deployments' && activeTab !== 'notifications')
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
      (changes.length > 0 && workingTree.selectedPathList.length > 0)
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
      (activeTab === 'notifications' && openNotification !== null) ||
      (activeTab === 'deployments' && (selectedDeployment !== null || selectedRun !== null)) ||
      (activeTab === 'stashes' && stashes.selectedStash !== null)
  )
  const showsActionRow = $derived(showsViewContext || showsRemoteActions)

  /** The working tree's state as a badge names it, most urgent first. */
  type WorktreeState = 'clean' | 'dirty' | 'conflicted'

  /**
   * Working-tree state as the branch picker's leading glyph, in the order the
   * states ask for attention: conflicts first, then uncommitted changes, then
   * clean. Null while there is no status to describe.
   */
  const worktreeState = $derived.by((): WorktreeState | null => {
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
    pullStrategyOpen = false
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

  /**
   * Remember the preference the user just chose, so the next pull uses it without
   * asking. `ask` is a preference too: it puts the chooser back.
   */
  function savePullPreference(preference: GitPullPreference): void {
    if (appConfigState.defaultPullStrategy === preference) return
    void invoke('config:update', { defaultPullStrategy: preference }).catch(() => undefined)
  }

  /**
   * A pull leaves the panel as a background job the moment a strategy is chosen,
   * exactly like a sync between checkouts: the round trip and the integration
   * report in the docked run panel, so the chooser never holds the window and a
   * conflict is answered where the work continues.
   */
  function startPull(strategy: GitPullStrategy): void {
    const target = resolvePullTarget()
    if (!target) {
      toast.error('No tracked branch is available to pull')
      return
    }

    savePullPreference(strategy)
    pullStrategyOpen = false
    gitPullJobs.start({
      projectId,
      remote: target.remote,
      branch: target.branch,
      strategy,
      incoming: commitsBehind,
      onSettled: () => void refreshStatus()
    })
  }

  /** The wide half of the Pull control: the saved strategy, or the chooser. */
  function pullAction(): void {
    const target = resolvePullTarget()
    if (!target) {
      toast.error('No tracked branch is available to pull')
      return
    }
    if (appConfigState.defaultPullStrategy === 'ask') {
      pullStrategyOpen = true
      return
    }
    startPull(appConfigState.defaultPullStrategy)
  }

  /**
   * Stop choosing for the user: the next pull opens the chooser again, the same
   * preference the Settings page writes.
   */
  function askEveryPull(): void {
    savePullPreference('ask')
  }

  /**
   * Sync this worktree with the project's main worktree branch, in either
   * direction. The strategy chooser follows the same `ask` preference as the
   * Pull button; folding work into main always asks first, because it mutates a
   * branch the user is not looking at and pushes nothing.
   *
   * The run itself leaves as a background job (`gitSyncJobs`): a refusal or a
   * conflicted integration is answered in the docked panel, never in a modal the
   * user has to dismiss, and a run they started still reports after they have
   * navigated away.
   */
  function performSyncMain(direction: GitSyncDirection, strategy: GitPullStrategy): void {
    syncMainOpen = false
    // "Main" is the project root, so the peer is named rather than chosen.
    gitSyncJobs.start({
      projectId,
      scopeBucketId,
      direction,
      strategy,
      peer: { kind: 'root' },
      peerLabel: 'the project root',
      // A sync adds commits to this checkout's history, which the panel keeps
      // rendered client-side, so the list is re-read when the run settles.
      onSettled: () => void refreshStatus()
    })
  }

  function openSyncMain(direction: GitSyncDirection): void {
    syncDirection = direction
    syncMainOpen = true
  }

  function syncMainAction(direction: GitSyncDirection): void {
    if (direction === 'to' || appConfigState.defaultPullStrategy === 'ask') {
      openSyncMain(direction)
      return
    }
    performSyncMain(direction, appConfigState.defaultPullStrategy)
  }

  function closeSyncMain(): void {
    syncMainOpen = false
  }

  /** The peer chooser has to be opened: the other end is the whole choice. */
  function openSyncPeer(direction: GitSyncDirection): void {
    syncPeerDirection = direction
    syncPeerOpen = true
  }

  function closeSyncPeer(): void {
    syncPeerOpen = false
  }

  /** The chooser is gone the moment a strategy is chosen: the run has its own panel. */
  function syncPeerStarted(): void {
    syncPeerOpen = false
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
      // Conflicts hand over to the conflict UI; never auto-push a half-merged
      // tree, and never push after a pull that never reached the remote either:
      // the push would fail with the very same verdict, which the panel is
      // already showing as its notice.
      if (
        !gitState.error &&
        !gitState.remoteIssueFor(projectId) &&
        gitState.conflicted.length === 0
      ) {
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

  /** First step of the save button: Replace routes through a destructive
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

  async function openDirectory(path: string): Promise<void> {
    contextSidebarState.openFiles(projectId, threadId)
    await projectFilesWorkspace.ensureState(projectId)
    await projectFilesWorkspace.loadDirectory(projectId, '')
    await projectFilesWorkspace.revealDirectory(projectId, path)
  }

  const tabs: Array<{
    id: GitPanelTabId
    label: string
    icon: typeof CioTabGit
    count: number | null
  }> = $derived.by(() => {
    const list: Array<{
      id: GitPanelTabId
      label: string
      icon: typeof CioTabGit
      count: number | null
    }> = [
      {
        id: 'changes',
        label: 'Changes',
        icon: CioDiff,
        count: changes.length > 0 ? changes.length : null
      },
      { id: 'history', label: 'History', icon: CioUndo, count: null },
      { id: 'branches', label: 'Branches', icon: CioNetwork, count: null },
      { id: 'pulls', label: 'PRs', icon: CioPullRequest, count: null },
      { id: 'issues', label: 'Issues', icon: CioDot, count: null }
    ]
    // Notifications are account-wide, so the view earns a place only once a
    // GitHub account is signed in. Its badge is the unread count of what the
    // panel has loaded, since GitHub has no total-count endpoint.
    if (githubConnected) {
      list.push({
        id: 'notifications',
        label: 'Notifications',
        icon: CioNotifications,
        count: githubNotifications.counts.inbox > 0 ? githubNotifications.counts.inbox : null
      })
    }
    // Stash is just shelved work   it earns a tab only once something is shelved.
    if (gitState.stashes.length > 0) {
      list.push({
        id: 'stashes',
        label: 'Stashes',
        icon: CioArchive,
        count: gitState.stashes.length
      })
    }
    // Deployments earn a view only when the repo actually has deployment
    // activity (the flag is persisted in the DB and cached in localStorage).
    // While the panel is *on* that view the entry stays, so a cold cache cannot
    // leave the trigger naming a view the row is no longer showing.
    if (hasDeployments === true || activeTab === 'deployments') {
      list.push({ id: 'deployments', label: 'Deploys', icon: CioRocket, count: null })
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
      compact ? 'h-6 px-2' : 'h-7 px-2.5'
    ]}
    disabled={integrateBusy || conflictState === 'none'}
    title={`Discard the whole ${conflictState === 'merge' ? 'merge' : 'rebase'} and restore the working tree`}
    onclick={requestAbortConflict}
  >
    {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
      <CioSpinner size={11} class="animate-spin" />
    {:else}
      <CioTrash size={11} />
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
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title={conflicted.length > 0
        ? `Resolve and stage the ${String(conflicted.length)} remaining conflict${conflicted.length === 1 ? '' : 's'} before continuing`
        : 'Replay the rest of your commits on top of the new base'}
      disabled={integrateBusy || conflicted.length > 0}
      onclick={() => void runRebaseAction('continue')}
    >
      {#if rebaseActionRunning === 'continue'}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioPlay size={11} />
      {/if}
      Continue rebase
    </button>
    <button
      type="button"
      data-modal-primary
      {@attach focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40"
      title="Drop the commit git stopped on and replay the rest"
      disabled={integrateBusy}
      onclick={() => void runRebaseAction('skip')}
    >
      {#if rebaseActionRunning === 'skip'}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioSkipForward size={11} />
      {/if}
      Skip this commit
    </button>
  {:else if mergePending}
    <button
      type="button"
      data-modal-primary
      {@attach focusSyncModalAction}
      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 bg-foreground px-2.5 text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
      title="Commit the resolved files to complete the merge"
      disabled={completeMergeBusy}
      onclick={openCompleteMerge}
    >
      {#if completeMergeBusy}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioMerge size={11} />
      {/if}
      Complete merge
    </button>
  {/if}
  {#if withAbort}
    {@render abortIntegrationAction(false)}
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
  <GitStatusPanelFind
    open={findNavState.gitFindOpen}
    scope={find.scope}
    query={find.query}
    bind:activeIndex={find.activeIndex}
    focusTrigger={findNavState.gitFindFocusTrigger}
    loading={find.loading}
    rows={find.rows}
    error={find.error}
    onQueryChange={(query) => void find.run(query)}
    onNext={() => find.move(1)}
    onPrev={() => find.move(-1)}
    onSubmit={() => find.openActiveResult()}
    onClose={() => find.close()}
    onSelectResult={(row) => find.selectRow(row)}
  />

  <!--
    Header: identity, branch, the view you are in and its tools on one line. The
    view in focus takes a second line the moment it has something to say
    (`showsActionRow`), and that row is where the remote actions live too.
  -->
  <div class="flex shrink-0 flex-col">
    <GitStatusPanelHeader
      {repoState}
      {githubStatus}
      {primaryRemote}
      {remotes}
      {status}
      {conflicted}
      {worktreeState}
      {tabs}
      {activeTab}
      bind:changesView
      {showsSync}
      {branchSyncBusy}
      {remoteActionsInMenu}
      {showsPull}
      {showsPush}
      {commitsBehind}
      {commitsAhead}
      {pushBlocked}
      {fetching}
      {busy}
      {localBranches}
      {selectedCommit}
      {isHeadCommit}
      {selectedPullRequest}
      {deploymentsExternal}
      {openNotification}
      {notificationActionClass}
      {notificationBusy}
      {githubConnected}
      {projectId}
      {threadId}
      {scopeBucketId}
      findWords={find.words}
      {commitActions}
      {selectTab}
      {signOutGitHub}
      {switchGitHubAccount}
      requestCheckout={(branch) => branches.requestCheckout(branch)}
      createBranchAction={(name) => branches.createBranch(name)}
      deleteBranchAction={(name, force) => branches.deleteBranch(name, force)}
      {openAddOrigin}
      {openReplaceOrigin}
      {syncMainAction}
      {openSyncPeer}
      openFind={() => find.open()}
      closeFind={() => find.close()}
      {refreshPanel}
      {startAmend}
      {openPullRequestFullscreen}
      {pullAction}
      {pushAction}
      onOpenWorkingChanges={openWorkingChanges}
      onShowIntegrateModal={() => (showIntegrateModal = true)}
      onShowStashModal={() => (stashes.showStashModal = true)}
      onRequestCreateBranch={() => (branches.creatingBranch = true)}
    />

    {#if showsActionRow}
      <!--
        The row under the header belongs to the view in focus: the commit or
        stash being read, the pull request's identity, the PR list's filter, the
        conflict controls, and Pull and Push. Pull and Push are independent   a
        diverged branch needs both   so each gets a share of the row's width
        instead of one hiding the other, and they are the only items here that
        stretch. Pull is split at its right edge so a one-off strategy is a
        click away from the saved one. While conflicts are open they stand aside
        entirely (see `conflictsOpen`) so the row can hold the controls that end
        them.
      -->
      <div
        class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-2"
      >
        <GitStatusPanelViewContext
          bind:activeTab
          {selectedCommit}
          selectedStash={stashes.selectedStash}
          bind:selectedPullRequest
          bind:selectedDeployment
          bind:selectedRun
          bind:prDetailTab
          {conflicted}
          {changes}
          {staged}
          {unstaged}
          {untracked}
          selectedPathList={workingTree.selectedPathList}
          {integrateBusy}
          {batchBusy}
          {canGoNewer}
          {canGoOlder}
          {openNotification}
          {notificationPrDetailViews}
          {notificationBundle}
          {notificationPullRequest}
          {notificationIdentity}
          {prDetailViews}
          {pullRequestBundle}
          {prListState}
          {prListFilter}
          {prListSort}
          {primaryRemote}
          {githubIdentity}
          {projectId}
          {openDeploymentState}
          {openRunState}
          {openRunJobs}
          {openRunFailedJob}
          {preparingRunDiagnosis}
          {abortIntegrationAction}
          {clearSelectedCommit}
          clearSelectedStash={() => stashes.clearSelectedStash()}
          {navigateCommit}
          stageAll={() => void workingTree.stageAll()}
          unstageAll={() => void workingTree.unstageAll()}
          stageSelectedAction={(stage) => void workingTree.stageSelectedAction(stage)}
          requestCommitSelected={() => workingTree.requestCommitSelected()}
          requestStashFor={(paths) => stashes.requestStashFor(paths)}
          ignoreSelectedAction={() => void workingTree.ignoreSelectedAction()}
          requestDiscard={(paths) => workingTree.requestDiscard(paths)}
          {requestRemoveCommitChanges}
          {routeConflictResolution}
          {resolveConflictsWithAgent}
          {requestAcceptAllConflicts}
          {reviewOpenRunFailedJob}
          {reloadOpenRun}
          {isPanelRepository}
          {selectPrListState}
          {selectPrListFilter}
          {selectPrListSort}
        />
        {#if showsRemoteActions}
          {#if showsPull}
            <GitPullButton
              behind={commitsBehind}
              busy={gitState.isBusy('pull')}
              blocked={branchSyncBusy}
              preference={appConfigState.defaultPullStrategy}
              onPull={pullAction}
              onPullWith={startPull}
              onAskEveryPull={askEveryPull}
            />
          {/if}
          {#if showsPush}
            <button
              type="button"
              class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
              title={pushTitle}
              disabled={pushBlocked}
              onclick={() => void pushAction()}
            >
              {#if gitState.isBusy('push')}
                <CioSpinner size={11} class="animate-spin" />
              {:else}
                <CioUpload size={11} />
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
  <GitStatusPanelContent
    {activeTab}
    {ovenTarget}
    {ovenError}
    {repoState}
    {preflightDetail}
    {scopeUnhealthy}
    {projectId}
    {threadId}
    {scopeBucketId}
    {conflictState}
    {conflicted}
    {conflictRowAborts}
    {integrationActions}
    {commitActions}
    {status}
    {identityNeeded}
    bind:showIdentityForm
    bind:identityName
    bind:identityEmail
    {changes}
    {conflictSections}
    {stagedSections}
    {workingSections}
    {selectedCommit}
    {commitDiffChanges}
    {commitTree}
    {commitTreeCollapsedDirs}
    {changesView}
    {loadingCommitDiff}
    diffs={workingTree.diffs}
    expanded={workingTree.expanded}
    loadingDiff={workingTree.loadingDiff}
    diffErrors={workingTree.diffErrors}
    {commitDiffs}
    {commitExpanded}
    {loadingCommitDiffFile}
    {commitDiffErrors}
    bind:selectedPaths={workingTree.selectedPaths}
    {paneClass}
    {commitHistory}
    {loadingHistory}
    {loadingMoreHistory}
    {historyHasMore}
    {unpushedCount}
    {remoteUpdates}
    {localBranches}
    {worktreeBranches}
    {localBranchNames}
    bind:creatingBranch={branches.creatingBranch}
    bind:newBranchName={branches.newBranchName}
    bind:selectedPullRequest
    bind:prDetailTab
    {githubIdentity}
    {githubConnected}
    {prListState}
    {prListFilter}
    {prListSort}
    {prListPage}
    bind:prListSelection
    {openNotification}
    {notificationIdentity}
    {notificationPullRequest}
    {notificationIssue}
    onNotificationStackSelection={(selection) => (notificationStackSelection = selection)}
    onNotificationStackSelectionReset={() => (notificationStackSelection = null)}
    bind:selectedDeployment
    bind:selectedRun
    bind:requestedWorkflowRunId
    selectedStash={stashes.selectedStash}
    loadingStashDiff={stashes.loadingStashDiff}
    stashDiffChanges={stashes.stashDiffChanges}
    stashDiffs={stashes.stashDiffs}
    loadingStashDiffFile={stashes.loadingStashDiffFile}
    stashDiffErrors={stashes.stashDiffErrors}
    stashExpanded={stashes.stashExpanded}
    {stashOpBusy}
    {loadRepoState}
    {handleContentScroll}
    {initializeRepository}
    {refreshStatus}
    {saveIdentity}
    toggleDiff={(change) => workingTree.toggleDiff(change)}
    toggleStage={(change) => workingTree.toggleStage(change)}
    toggleSelection={(change, additive) => workingTree.toggleSelection(change, additive)}
    toggleSectionSelection={(files) => workingTree.toggleSectionSelection(files)}
    stagePathsAction={(paths, staged) => workingTree.stagePaths(paths, staged)}
    requestStashFor={(paths) => stashes.requestStashFor(paths)}
    {openInEditor}
    {openDirectory}
    ignorePathsAction={(paths) => workingTree.ignorePathsAction(paths)}
    requestDiscard={(paths) => workingTree.requestDiscard(paths)}
    {routeConflictResolution}
    restoreFromSource={(source, path, target) =>
      workingTree.restoreFromSource(source, path, target)}
    {toggleCommitDiff}
    {toggleCommitDir}
    {requestRemoveCommitChanges}
    {selectCommit}
    createBranchAction={(name) => branches.createBranch(name)}
    requestCheckout={(branch) => branches.requestCheckout(branch)}
    fetchBranchAction={(branch) => branches.fetchBranch(branch)}
    requestDeleteBranch={(name) => branches.requestDeleteBranch(name)}
    requestDeleteRemoteBranch={(branch) => branches.requestDeleteRemoteBranch(branch)}
    {openPullRequestFullscreen}
    {handlePrListAction}
    {selectPrListState}
    {selectPrListFilter}
    {selectPrListSort}
    {selectPrListPage}
    {openCommitByHash}
    {openCommitFor}
    {openWorkflowRunFor}
    {isPanelRepository}
    {startDeploymentDiagnosis}
    selectStash={(stash) => stashes.selectStash(stash)}
    toggleStashDiff={(change) => stashes.toggleStashDiff(change)}
    popStash={(id) => stashes.popStash(id)}
    requestStashDrop={(stash) => stashes.requestStashDrop(stash)}
    {assignAgentToPullRequest}
    {openAgentThread}
    {resolveConflictsLocally}
    {startConflictResolution}
  />

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
    {syncMainOpen}
    {syncDirection}
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
    bind:showStashModal={stashes.showStashModal}
    bind:stashPaths={stashes.stashPaths}
    bind:stashMessage={stashes.stashMessage}
    bind:showIntegrateModal
    bind:mergeTarget
    bind:pendingOperation
    bind:acknowledgeActiveTurn
    bind:resetConfirm
    bind:deleteCommitTarget
    bind:checkoutConfirm={branches.checkoutConfirm}
    bind:deleteBranchConfirm={branches.deleteBranchConfirm}
    bind:forceDeleteBranchConfirm={branches.forceDeleteBranchConfirm}
    bind:deleteRemoteBranchConfirm={branches.deleteRemoteBranchConfirm}
    bind:originReplaceConfirm
    bind:originUrl
    {integrationActions}
    {confirmPushUpstream}
    {recoverPush}
    {closePullStrategy}
    {startPull}
    {closeSyncMain}
    {performSyncMain}
    {confirmCompleteMerge}
    {openCompleteMerge}
    stashChanges={() => stashes.stashChanges()}
    {requestMergeOrRebase}
    {confirmPendingOperation}
    {confirmReset}
    {confirmDeleteCommit}
    confirmCheckoutBranch={() => void branches.confirmCheckoutBranch()}
    confirmDeleteBranch={() => void branches.confirmDeleteBranch()}
    confirmForceDeleteBranch={() => void branches.confirmForceDeleteBranch()}
    confirmDeleteRemoteBranch={() => void branches.confirmDeleteRemoteBranch()}
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
    onStarted={syncPeerStarted}
    onSettled={() => void refreshStatus()}
  />
{/if}

<GitStatusPanelConfirmDialogs
  bind:stashDropTarget={stashes.stashDropTarget}
  bind:discardConfirm={workingTree.discardConfirm}
  bind:restoreWorktreeConfirm={workingTree.restoreWorktreeConfirm}
  bind:abortConfirmOpen
  bind:acceptConflictsSide
  bind:commitInfoTarget
  bind:removeCommitChangesConfirm
  {conflictState}
  conflictedCount={conflicted.length}
  {commitInfoOnRemote}
  {removeCommitOnRemote}
  {commitInfoUrl}
  onConfirmStashDrop={() => void stashes.confirmStashDrop()}
  onConfirmDiscard={() => void workingTree.confirmDiscard()}
  onConfirmRestoreWorktree={() => void workingTree.confirmRestoreWorktree()}
  onConfirmAbortConflict={() => void confirmAbortConflict()}
  onConfirmAcceptAllConflicts={() => void confirmAcceptAllConflicts()}
  onConfirmRemoveCommitChanges={() => void confirmRemoveCommitChanges()}
  onCopyCommitHash={(commit) => void copyCommitHash(commit)}
  onOpenCommitInBrowser={(url) => void openInBrowser(url)}
/>

<!--
  Row-menu surfaces. They are siblings of the panel's own layout for the same
  reason the full screen reader is: a confirmation has to sit above the sidebar it
  was opened from rather than inside its clipping column.
-->
{#if githubIdentity}
  {#if prBatch}
    <PrBatchDialog batch={prBatch} onConfirm={confirmPrBatch} onClose={() => (prBatch = null)} />
  {/if}

  {#if prMetadata}
    <PrMetadataDialog
      pr={prMetadata.pr}
      mode={prMetadata.mode}
      {projectId}
      owner={githubIdentity.owner}
      repo={githubIdentity.repo}
      onClose={() => (prMetadata = null)}
    />
  {/if}

  {#if prMerge}
    <PrMergeConfirmDialog
      number={prMerge.pr.number}
      summary={prMerge.pr}
      method={prMerge.method}
      fieldSuffix="pr-list"
      busy={prMergeBusy}
      bind:open={prMergeOpen}
      bind:commitTitle={prMergeTitle}
      bind:commitMessage={prMergeMessage}
      onConfirm={() => void confirmPrMerge()}
    />
  {/if}
{/if}

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
      <CioPullRequest size={12} class="shrink-0" aria-hidden="true" />
    {/snippet}
    <div class="flex min-h-0 flex-1 flex-col">
      {#if fullscreenActivePullRequest && githubIdentity}
        <GitPullRequestDetail
          {projectId}
          {threadId}
          identity={githubIdentity}
          summary={fullscreenActivePullRequest}
          reviewRemote={primaryRemote?.name}
          onOpenPullRequest={openPullRequestFullscreen}
          variant="fullscreen"
          onBack={() => (fullscreenPullRequestId = PR_READER_LIST_TAB)}
          onAssignAgent={(pr) => void assignAgentToPullRequest(pr)}
          onOpenThread={(threadId) => void openAgentThread(threadId)}
          onOpenWorkflowRun={openWorkflowRunFromCheck}
          onOpenCommit={(hash) => void openCommitByHash(hash)}
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
          selected={prListSelection}
          onSelectionChange={(next) => (prListSelection = next)}
          onAction={handlePrListAction}
          onStateChange={selectPrListState}
          onFilterChange={selectPrListFilter}
          onSortChange={selectPrListSort}
          onPageChange={selectPrListPage}
          onOpen={(pr) => openPullRequestFullscreen(pr)}
          onSignIn={() => githubSignIn.start()}
          onCreate={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
        />
      {/if}
    </div>
  </FullscreenPanelDialog>
{/if}
