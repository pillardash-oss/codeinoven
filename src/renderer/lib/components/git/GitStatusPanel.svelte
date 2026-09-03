<script lang="ts">
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { openInBrowser } from '$lib/open-in-browser'
  import { diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { cachedHasDeployments, cacheHasDeployments } from '$lib/git-deployments-cache'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import type {
    GitBranchInfo,
    GitCommitInfo,
    GitDiff,
    GitFileChange,
    GitPullStrategy,
    GitHubDeployment,
    GitHubDeploymentJob,
    GitHubDeploymentJobLog,
    GitHubUser,
    GitHubWorkflowRun,
    GitResetMode,
    GitRestoreTarget,
    GitStashEntry,
    ThreadStatus
  } from '$shared/types'
  import {
    Archive,
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpFromLine,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    FileDiff,
    Folder,
    FolderOpen,
    FolderTree,
    GitBranch,
    GitCommit,
    GitFork,
    GitMerge,
    GitPullRequest,
    Rocket,
    History,
    Loader2,
    MoreHorizontal,
    NetworkIcon,
    Plus,
    RefreshCw,
    RotateCcwClock,
    Search,
    Trash2,
    Unplug
  } from '@lucide/svelte'
  import { AlertDialog, ContextMenu, DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import BranchActionsMenu from './BranchActionsMenu.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import BranchPicker from './BranchPicker.svelte'
  import CommitActionsMenu from './CommitActionsMenu.svelte'
  import GitHubAccountMenu from './GitHubAccountMenu.svelte'
  import GitChangesTree from './GitChangesTree.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import GitHubSignInModal from './GitHubSignInModal.svelte'
  import GitPullRequestList from './GitPullRequestList.svelte'
  import GitPullRequestDetail from './GitPullRequestDetail.svelte'
  import GitDeploymentsMonitor from './GitDeploymentsMonitor.svelte'
  import FindInBar from '../files/FindInBar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { gitPanelView } from '$lib/stores/git-panel-view.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import type { PullRequestSummary } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    scopeBucketId?: string
  }

  let { projectId, threadId, scopeBucketId = DEFAULT_SCOPE_BUCKET_ID }: Props = $props()

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'
  type TabId = 'changes' | 'history' | 'branches' | 'pulls' | 'deployments' | 'stashes'

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
  /** Bumped after a PR is created so the open-PR list refetches. */
  let prListRefresh = $state(0)
  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')
  let pushConfirm = $state(false)
  /** Pull strategy chooser, opened by the default `ask` preference or a failed strategy. */
  let pullStrategyOpen = $state(false)
  let pullStrategyError = $state('')
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
  let activeTab = $state<TabId>(savedView.activeTab)
  let changesView = $state<'list' | 'tree'>(savedView.changesView)
  let selectedPaths = $state<Record<string, boolean>>({})
  let discardConfirm = $state<string[] | null>(null)
  let restoreWorktreeConfirm = $state<{ source: string; path: string } | null>(null)
  let commitSelection = $state(false)
  let commitTextarea = $state<HTMLTextAreaElement | null>(null)
  let newBranchInput = $state<HTMLInputElement | null>(null)
  let checkoutConfirmButton = $state<HTMLButtonElement | null>(null)
  let commitHistory = $state<GitCommitInfo[]>([])
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
  /** False once a page comes back shorter than requested — there's nothing older left. */
  let historyHasMore = $state(true)
  const HISTORY_PAGE_SIZE = 30
  let commitMessage = $state('')
  let selectedCommit = $state<GitCommitInfo | null>(savedView.selectedCommit)
  let commitDiffChanges = $state<GitFileChange[]>([])
  let deleteCommitTarget = $state<GitCommitInfo | null>(null)
  let showGitHubSignIn = $state(false)
  let selectedPullRequest = $state<PullRequestSummary | null>(savedView.selectedPullRequest)
  let githubConnected = $state(false)
  let githubConfigured = $state(false)
  let githubUser = $state<GitHubUser | null>(null)
  /** Whether the repo is known to have GitHub deployments — gates the Deployments tab. */
  let hasDeployments = $state(false)
  /** One PR check-directed workflow run to reveal in the Deployments tab. */
  let requestedWorkflowRunId = $state<number | null>(null)
  /** Re-entrancy guard for the background deployment probe (not rendered). */
  let detectingDeployments = false
  let loadingCommitDiff = $state(false)
  let commitDiffs = $state<Record<string, GitDiff>>({})
  let commitExpanded = $state<Record<string, boolean>>({})
  let loadingCommitDiffFile = $state<Record<string, boolean>>({})
  let commitDiffErrors = $state<Record<string, string | null>>({})
  /** Directories collapsed by the user in the commit diff's tree view — expanded by default. */
  let commitTreeCollapsedDirs = $state<Record<string, boolean>>({})
  let amendMode = $state(false)
  let resetConfirm = $state<{ mode: GitResetMode; target: string } | null>(null)
  let selectedStash = $state<GitStashEntry | null>(savedView.selectedStash)
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
      selectedStash
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
  /** Local commits not yet on the upstream remote, oldest-first-among-them — matches history order. */
  const unpushedCount = $derived(status?.upstream ? Math.max(0, status.ahead) : 0)

  const busy = $derived(gitState.isBusy(['refresh', 'init', 'commit', 'amend', 'reset']))
  const commitBusy = $derived(gitState.isBusy(['commit', 'amend']))
  const batchBusy = $derived(
    gitState.isBusy(['stage', 'unstage', 'commit', 'stash', 'ignore', 'discard'])
  )
  const stashOpBusy = $derived(gitState.isBusy(['stash-pop', 'stash-drop']))

  async function refreshStatus(): Promise<void> {
    gitState.ensureProjectEvents(projectId)
    await gitState.refresh(projectId)
    // The refresh button must bring the whole panel up to date, including the
    // History tab — its pages are cached client-side and would otherwise keep
    // showing stale commits until a mutation happens to reload them.
    if (activeTab === 'history' || commitHistory.length > 0) await reloadHistory()
  }

  async function loadRepoState(): Promise<void> {
    repoState = 'loading'
    try {
      const project = await invoke('project:get', projectId)
      if (project?.hasDeployments !== undefined) {
        // Authoritative database value; reconcile the fast-render cache with it.
        hasDeployments = project.hasDeployments
        cacheHasDeployments(projectId, project.hasDeployments)
      }
      if (!project?.path) {
        repoState = 'not_git'
        return
      }
      const preflight = await invoke('repository:preflight', project.path)
      if (preflight.status === 'git_unavailable') {
        repoState = 'git_unavailable'
        preflightDetail = preflight.detail ?? ''
        return
      }
      if (preflight.status === 'not_git') {
        repoState = 'not_git'
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
    if (gitState.status) repoState = 'git'
  }

  function fileDiffKey(change: GitFileChange): string {
    return `${change.staged ? 's:' : 'w:'}${change.path}`
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
    } else {
      await gitState.stage(projectId, [change.path])
    }
  }

  async function stageAll(): Promise<void> {
    const allPaths = [...new Set(changes.map((change) => change.path))].filter(
      (path) => !(gitState.status?.conflicted ?? []).includes(path)
    )
    if (allPaths.length === 0) return
    await gitState.stage(projectId, allPaths)
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

  /** `git fetch <remote> <name>` — updates that branch's tracking ref without touching HEAD. */
  async function fetchBranchAction(branch: GitBranchInfo): Promise<void> {
    const remote = branch.remote
    if (!remote) return
    await gitState.fetchBranch(projectId, remote, branch.name)
  }

  async function submitNewBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!name) return
    creatingBranch = false
    newBranchName = ''
    await createBranchAction(name)
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
   * cache the Deployments tab reads — first visit renders instantly.
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
      // Sign-in or network failure — keep the current flag and try again later.
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

  /** Open a new agent thread with bounded deployment evidence prefilled. */
  async function createDeploymentDiagnosisThread(title: string, prompt: string): Promise<void> {
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return
    const thread = await invoke('thread:create', {
      projectId,
      providerId: 'pi',
      title,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return
    rendererRecovery.setDraft(projectId, thread.id, prompt, [], [])
    workspaceState.openThread(thread, project)
  }

  /** Keep one failed job's evidence useful without overfilling the composer. */
  function failedJobEvidence(
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): string[] {
    const failedSteps = job.steps
      .filter(
        (step) =>
          step.status === 'completed' &&
          step.conclusion !== 'success' &&
          step.conclusion !== 'neutral' &&
          step.conclusion !== 'skipped' &&
          step.conclusion !== 'cancelled'
      )
      .map((step) => step.name)
    const lines = [
      `Failed job: ${job.name}`,
      `Job ID: ${job.id}`,
      `Job status: ${job.status}${job.conclusion ? ` / ${job.conclusion}` : ''}`,
      `Failed steps: ${failedSteps.length > 0 ? failedSteps.join(', ') : '(not reported)'}`,
      ...(job.url ? [`Job URL: ${job.url}`] : [])
    ]
    if (!log) {
      return [
        ...lines,
        'Job log: unavailable; diagnose from the supplied metadata and local files.'
      ]
    }
    const maxChars = 24_000
    const excerpt =
      log.log.length > maxChars ? `[earlier output omitted]\n${log.log.slice(-maxChars)}` : log.log
    return [...lines, '', 'Failed job log excerpt:', '```text', excerpt, '```']
  }

  function startWorkflowDiagnosis(
    run: GitHubWorkflowRun,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    const prompt = [
      `Review and resolve the failed GitHub Actions job "${job.name}" only.`,
      `Workflow: ${run.name} #${run.runNumber}`,
      `Run ID: ${run.id}`,
      `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`,
      `Branch: ${run.branch || '(unknown)'}`,
      `Commit: ${run.headSha || '(unknown)'}`,
      ...(run.url ? [`Workflow URL: ${run.url}`] : []),
      '',
      ...failedJobEvidence(job, log),
      '',
      'Use the supplied job metadata and log as the primary evidence. Do not assume GitHub or the remote repository is accessible.',
      'If local repository files are available, inspect only what is relevant to this failed job and reproduce the failure where practical.',
      'If the cause is in this repository, implement the smallest correct fix, run the relevant checks/tests, and commit the completed change.',
      'If repository access is unavailable, diagnose from the evidence and give the exact file/configuration change or operator action required.',
      'If the cause is external infrastructure, permissions, or secrets, do not guess or expose credentials.',
      'Do not push, rerun workflows, or deploy.'
    ].join('\n')
    void createDeploymentDiagnosisThread(`Review failed job: ${job.name}`, prompt)
  }

  function startDeploymentDiagnosis(
    deployment: GitHubDeployment,
    run: GitHubWorkflowRun | null,
    job: GitHubDeploymentJob,
    log: GitHubDeploymentJobLog | null
  ): void {
    const deploymentUrl = `https://github.com/${encodeURIComponent(githubIdentity?.owner ?? '')}/${encodeURIComponent(githubIdentity?.repo ?? '')}/deployments/${deployment.id}`
    const prompt = [
      `Review and resolve the failed deployment job "${job.name}" only.`,
      `Deployment ID: ${deployment.id}`,
      `Status: ${deployment.latestStatus?.state ?? 'unknown'}`,
      `Ref: ${deployment.ref || '(unknown)'}`,
      `Commit: ${deployment.sha || '(unknown)'}`,
      `Deployment URL: ${deploymentUrl}`,
      ...(run ? [`Linked workflow run: ${run.name} #${run.runNumber} (ID ${run.id})`] : []),
      '',
      ...failedJobEvidence(job, log),
      '',
      'Use the supplied job metadata and log as the primary evidence. Do not assume GitHub or the remote repository is accessible.',
      'If local repository files are available, inspect only what is relevant to this failed job and reproduce the failure where practical.',
      'If the cause is in this repository, implement the smallest correct fix, run the relevant checks/tests, and commit the completed change.',
      'If repository access is unavailable, diagnose from the evidence and give the exact file/configuration change or operator action required.',
      'If the cause is external infrastructure, permissions, or secrets, do not guess or expose credentials.',
      'Do not push, rerun workflows, or deploy.'
    ].join('\n')
    void createDeploymentDiagnosisThread(`Review failed job: ${job.name}`, prompt)
  }

  /**
   * Hand a pull request to an agent.
   *
   * The agent gets a fresh thread whose first message tells it to review the PR
   * in a throwaway worktree and leave its report in `.cio/git/pr/<number>/`, so
   * the working tree the user is sitting in never gets touched.
   */
  async function startAgentReview(pr: PullRequestSummary): Promise<void> {
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return
    const reportDirectory = await gitState.createPrReviewWorkspace(projectId, pr.number)
    if (!reportDirectory) return

    const thread = await invoke('thread:create', {
      projectId,
      providerId: 'pi',
      title: `Review PR #${pr.number}`,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return

    // Record the owning thread so the PR's Agent tab can jump back into it later.
    await gitState.createPrReviewWorkspace(projectId, pr.number, thread.id)
    await gitState.loadAgentReport(projectId, pr.number)
    rendererRecovery.setDraft(projectId, thread.id, agentReviewPrompt(pr, reportDirectory), [], [])
    workspaceState.openThread(thread, project)
  }

  /** Reopen the thread that owns a PR's agent review. */
  async function openReviewThread(threadId: string): Promise<void> {
    const [project, thread] = await Promise.all([
      invoke('project:get', projectId).catch(() => null),
      invoke('thread:get', projectId, threadId).catch(() => null)
    ])
    if (thread) workspaceState.openThread(thread, project)
  }

  /** The first message the review agent receives — explicit about isolation and output. */
  function agentReviewPrompt(pr: PullRequestSummary, reportDirectory: string): string {
    return [
      `Review pull request #${pr.number} — "${pr.title}" (${pr.headRef} → ${pr.baseRef}) by ${pr.authorLogin}.`,
      `PR URL: ${pr.url}`,
      '',
      'Work in isolation so my current working tree is never modified:',
      `1. \`git fetch origin pull/${pr.number}/head:pr-${pr.number}\``,
      `2. \`git worktree add ${reportDirectory}/worktree pr-${pr.number}\``,
      `3. Review the diff against \`${pr.baseRef}\` inside that worktree — correctness, edge cases,`,
      '   security, test coverage, and anything that would break existing behavior.',
      '4. Run the project checks/tests that are relevant to the changed files.',
      '',
      `Write your findings to \`${reportDirectory}/review.md\`: a short verdict line, then findings`,
      'ordered most severe first with file:line references and concrete failure scenarios.',
      `When you are done, remove the worktree with \`git worktree remove ${reportDirectory}/worktree --force\``,
      `and delete the local branch \`pr-${pr.number}\`. Do not push anything and do not merge the PR.`
    ].join('\n')
  }

  /**
   * Resolve a PR's online conflicts manually: check out the PR head locally,
   * merge the base in, and hand the resulting conflicts to the changes-tab
   * conflict UI so the user can fix each file, commit, and push.
   */
  async function resolveConflictsLocally(pr: PullRequestSummary): Promise<void> {
    const remote = primaryRemote?.name ?? 'origin'
    const returnBranch = gitState.status?.branch ?? 'main'
    await gitState.preparePrResolve(projectId, {
      remote,
      pullNumber: pr.number,
      baseBranch: pr.baseRef,
      headBranch: pr.headRef,
      returnBranch
    })
    if (gitState.error) return
    selectedPullRequest = null
    activeTab = 'changes'
    void refreshStatus()
  }

  /**
   * Resolve a PR's online conflicts with the agent's help: check out the PR head
   * and merge the base in (so conflicts land in the tree), then hand the agent a
   * thread to resolve the conflict markers and commit. The agent never pushes —
   * the user finishes with the app's authenticated push to update the PR.
   */
  async function startConflictResolution(pr: PullRequestSummary): Promise<void> {
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return
    const remote = primaryRemote?.name ?? 'origin'
    const returnBranch = gitState.status?.branch ?? 'main'
    await gitState.preparePrResolve(projectId, {
      remote,
      pullNumber: pr.number,
      baseBranch: pr.baseRef,
      headBranch: pr.headRef,
      returnBranch
    })
    if (gitState.error) return
    const conflictedPaths = [...gitState.conflicted]

    const thread = await invoke('thread:create', {
      projectId,
      providerId: 'pi',
      title: `Resolve conflicts in PR #${pr.number}`,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return

    selectedPullRequest = null
    activeTab = 'changes'
    rendererRecovery.setDraft(
      projectId,
      thread.id,
      conflictResolutionPrompt(pr, conflictedPaths),
      [],
      []
    )
    workspaceState.openThread(thread, project)
  }

  /** The first message the conflict-resolution agent receives. */
  function conflictResolutionPrompt(pr: PullRequestSummary, conflictedPaths: string[]): string {
    return [
      `Resolve the merge conflicts in pull request #${pr.number} — "${pr.title}" (${pr.headRef} → ${pr.baseRef}).`,
      `The head branch \`pr-${pr.number}\` is already checked out and \`${pr.baseRef}\` has been merged into it, so the conflicts are in the working tree.`,
      '',
      conflictedPaths.length > 0
        ? `Conflicted files: ${conflictedPaths.map((path) => `\`${path}\``).join(', ')}`
        : 'There are no conflicted files remaining in the working tree.',
      '',
      'For each conflicted file:',
      '1. Read it and resolve the `<<<<<<<`, `=======`, and `>>>>>>>` conflict markers, keeping the correct merged content.',
      '2. Run the relevant project checks/tests to make sure the resolution is sound.',
      '',
      'Then stage and commit the resolutions:',
      '1. `git add -A`',
      `2. \`git commit -m "Resolve merge conflicts with ${pr.baseRef}"\``,
      '',
      'Do NOT push — after committing, the user finishes in the Git panel with the Resolve merge button, which pushes the resolution to the pull request and cleans up the temporary branch.'
    ].join('\n')
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

  /** Infinite scroll for the History tab — the panel's tabs share one scroll container. */
  function handleContentScroll(event: Event): void {
    if (activeTab !== 'history') return
    const el = event.currentTarget as HTMLDivElement
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMoreHistory()
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

  interface CommitTreeNode {
    name: string
    path: string
    dirs: Map<string, CommitTreeNode>
    files: GitFileChange[]
  }

  /** Groups a flat commit diff into a folder tree — read-only mirror of GitChangesTree's layout. */
  function buildCommitTree(files: GitFileChange[]): CommitTreeNode {
    const root: CommitTreeNode = { name: '', path: '', dirs: new Map(), files: [] }
    for (const change of files) {
      const segments = change.path.split('/')
      let node = root
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] ?? ''
        let child = node.dirs.get(seg)
        if (!child) {
          child = {
            name: seg,
            path: segments.slice(0, i + 1).join('/'),
            dirs: new Map(),
            files: []
          }
          node.dirs.set(seg, child)
        }
        node = child
      }
      node.files.push(change)
    }
    return root
  }

  function sortCommitDirs(dirs: Map<string, CommitTreeNode>): CommitTreeNode[] {
    return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
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
      // The committed files have left the panel — drop their selection so the
      // "N selected" counter next to "Stage all" doesn't point at ghosts.
      clearSelection()
      void refreshStatus()
      void reloadHistory()
    }
  }

  function onCommitMessageKeydown(event: KeyboardEvent): void {
    // Enter never commits by itself — only Cmd/Ctrl+Enter does, so writing a
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
   * untouched — they belong to the project, not the bucket — which is what
   * keeps scoped thread switches free of a full loading flash.
   */
  function resetForScopeSwap(): void {
    historyRequestId += 1
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
    creatingBranch = false
    newBranchName = ''
    discardConfirm = null
    resetConfirm = null
    pushConfirm = false
    pushDiverged = false
    pushRecoverMode = null
    pullStrategyOpen = false
    pullStrategyError = ''
    showIntegrateModal = false
    showStashModal = false
    stashMessage = ''
    stashPaths = null
    void refreshStatus()
    void reloadHistory()
  }

  /** Stable background colour for a branch's avatar, keyed off its name. */
  const branchAvatarPalette = [
    'bg-primary/20 text-primary',
    'bg-success/20 text-success',
    'bg-warning/20 text-warning',
    'bg-danger/20 text-danger',
    'bg-accent/20 text-accent'
  ]
  function branchAvatarClass(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0
    return branchAvatarPalette[Math.abs(hash) % branchAvatarPalette.length]
  }

  function relativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  $effect(() => {
    // Claim this project+scope before anything else reads/writes shared state
    // so a previous target's data can never be shown or overwrite this view.
    // Runs for scope swaps too — the shared git store targets exactly one
    // worktree at a time, so switching threads must retarget it even though
    // this component stays mounted.
    gitState.activate(projectId, scopeBucketId)
  })

  /** Project-scope bootstrap. Runs on mount and when the panel is aimed at a
   *  different project. Deliberately NOT re-run when only the scope bucket
   *  changes: repo/git availability is a property of the project path, and
   *  re-running it would flash the full-panel loading state on every scoped
   *  thread switch. */
  $effect(() => {
    hasDeployments = cachedHasDeployments(projectId) ?? false
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
      // First run — the bootstrap effect above owns initial loading.
      appliedProjectId = projectId
      appliedScopeBucketId = scopeBucketId
      return
    }
    if (projectId !== appliedProjectId) {
      // Project change — full reload is handled by the bootstrap effect.
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
    void loadGitHubAuth()
  })

  $effect(() => {
    // When the user is signed in and the repo points at GitHub, probe for
    // deployment activity in the background and surface the tab if found.
    if (repoState === 'git' && githubConnected && !hasDeployments && githubIdentity) {
      void detectDeployments()
    }
  })

  $effect(() => {
    // The Deployments tab only exists while the flag does — fall back to
    // Changes when it goes (e.g. after switching to a project without them).
    if (activeTab === 'deployments' && !hasDeployments) activeTab = 'changes'
  })

  $effect(() => {
    if (commitSelection) {
      commitTextarea?.focus()
      commitSelection = false
    }
  })

  $effect(() => {
    if (creatingBranch) newBranchInput?.focus()
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
  /** `owner/repo` when origin points at GitHub — the PR tab needs it to query. */
  const githubIdentity = $derived.by(() => {
    const url = primaryRemoteUrl
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
    const owner = match?.[1] ?? ''
    const repo = match?.[2] ?? ''
    return owner && repo ? { owner, repo } : null
  })
  const needsUpstreamPush = $derived(
    Boolean(status?.branch) && !status?.detached && status?.upstream === null
  )
  const syncBusy = $derived(gitState.isBusy(['fetch', 'pull', 'push']))

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
    // Known divergence from the last fetch — never attempt the doomed push.
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
   * A merge is in progress (MERGE_HEAD exists) and every conflicted file has
   * been resolved and staged. Git is waiting for the merge commit, so the
   * panel surfaces a dedicated Resolve button instead of leaving the user to
   * figure out that a normal commit finishes the merge.
   */
  const mergePending = $derived(conflictState === 'merge' && conflicted.length === 0)

  /** Resolve-merge modal state: optional title/description, defaults auto-generated. */
  let resolveMergeOpen = $state(false)
  let mergeTitle = $state('')
  let mergeDescription = $state('')
  const resolveMergeBusy = $derived(gitState.isBusy(['commit', 'push']))

  function openResolveMerge(): void {
    mergeTitle = ''
    mergeDescription = ''
    resolveMergeOpen = true
  }

  /** The commit message actually used: user text when given, a generated default otherwise. */
  function mergeCommitMessage(): string {
    const title = mergeTitle.trim()
    const description = mergeDescription.trim()
    const resolvedTitle =
      title || `Merge ${status?.upstream ? `branch '${status.upstream}'` : 'changes'}`
    return description ? `${resolvedTitle}\n\n${description}` : resolvedTitle
  }

  async function confirmResolveMerge(): Promise<void> {
    if (resolveMergeBusy) return
    await gitState.commit(projectId, mergeCommitMessage())
    if (gitState.error) return
    // A recorded PR-conflict session finishes itself: push the resolution back
    // to the PR head branch, check out the original branch, delete pr-<n>.
    // A plain local merge is already complete once committed.
    const finished = await gitState.finishPrResolve(projectId)
    if (!finished && gitState.prResolveSession) return
    resolveMergeOpen = false
    mergeTitle = ''
    mergeDescription = ''
    void refreshStatus()
  }

  const integrateBusy = $derived(
    gitState.isBusy(['merge', 'rebase', 'stash', 'abortMerge', 'abortRebase'])
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

  /** Abort is destructive — always ask before discarding the whole merge/rebase. */
  let abortConfirmOpen = $state(false)

  function requestAbortConflict(): void {
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

  const selectedPathList = $derived(Object.keys(selectedPaths))

  async function stageSelectedAction(stage: boolean): Promise<void> {
    const paths = selectedPathList
    if (paths.length === 0) return
    await stagePathsAction(paths, stage)
    if (!gitState.error) clearSelection()
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

  /** The Stashes tab only exists while stashes do — fall back to Changes when the last one goes. */
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

  const tabs: Array<{ id: TabId; label: string; icon: typeof GitBranch; count: number | null }> =
    $derived.by(() => {
      const list: Array<{
        id: TabId
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
        { id: 'pulls', label: 'Pull requests', icon: GitPullRequest, count: null }
      ]
      // Stash is just shelved work — it earns a tab only once something is shelved.
      if (gitState.stashes.length > 0) {
        list.push({
          id: 'stashes',
          label: 'Stashes',
          icon: Archive,
          count: gitState.stashes.length
        })
      }
      // Deployments earn a tab only when the repo actually has deployment
      // activity (the flag is persisted in the DB and cached in localStorage).
      if (hasDeployments) {
        list.push({ id: 'deployments', label: 'Deployments', icon: Rocket, count: null })
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
   * Panes: Conflicts (if any) shares the stack with Staged/Unstaged/Untracked.
   * Each pane gets equal flex space when several exist; a lone pane fills it all.
   */
  const paneClass = 'min-h-0 flex-1 overflow-y-auto'
</script>

{#snippet commitTreeNode(node: CommitTreeNode, depth: number)}
  {#each sortCommitDirs(node.dirs) as dir (dir.path)}
    {@const dirCollapsed = commitTreeCollapsedDirs[dir.path] ?? false}
    <button
      type="button"
      class="flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left transition-colors hover:bg-elevated/50"
      style={`padding-left: ${8 + depth * 14}px`}
      onclick={() => toggleCommitDir(dir.path)}
    >
      {#if dirCollapsed}
        <ChevronRight size={12} class="shrink-0 text-dimmed" />
        <Folder size={13} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronDown size={12} class="shrink-0 text-dimmed" />
        <FolderOpen size={13} class="shrink-0 text-dimmed" />
      {/if}
      <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">{dir.name}</span>
    </button>
    {#if !dirCollapsed}
      {@render commitTreeNode(dir, depth + 1)}
    {/if}
  {/each}
  {#each node.files as change (change.path)}
    <div style={`padding-left: ${8 + depth * 14}px`}>
      <GitFileRow
        {change}
        displayPath={change.path.split('/').pop() ?? change.path}
        diff={commitDiffs[change.path] ?? null}
        loadingDiff={loadingCommitDiffFile[change.path] ?? false}
        error={commitDiffErrors[change.path] ?? null}
        expanded={commitExpanded[change.path] ?? false}
        readonly
        onToggleDiff={() => void toggleCommitDiff(change)}
        onToggleStage={() => {}}
      />
    </div>
  {/each}
{/snippet}

<div class="relative flex h-full min-h-0 flex-col bg-app" data-region="git-panel">
  {#if findNavState.gitFindOpen}
    <div data-find-exclude class="absolute right-3 top-3 z-30 w-[min(26rem,calc(100%-1.5rem))]">
      <FindInBar
        query={commitSearchQuery}
        matches={commitSearchResults.length}
        activeIndex={commitSearchActiveIndex}
        placeholder="Search commit title or hash…"
        label="Search commits"
        focusTrigger={findNavState.gitFindFocusTrigger}
        onQueryChange={searchCommits}
        onNext={() => moveCommitSearch(1)}
        onPrev={() => moveCommitSearch(-1)}
        onSubmit={openActiveCommitSearchResult}
        onClose={closeCommitSearch}
      />
      {#if commitSearchQuery}
        <div
          class="mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
          aria-live="polite"
        >
          {#if commitSearchLoading}
            <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-dimmed">
              <Loader2 size={13} class="animate-spin" aria-hidden="true" />
              Searching commits…
            </div>
          {:else if commitSearchResults.length === 0}
            <p class="px-3 py-6 text-center text-xs text-dimmed">No matching commits</p>
          {:else}
            {#each commitSearchResults as commit, index (commit.hash)}
              <button
                type="button"
                class={[
                  'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  index === commitSearchActiveIndex
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted hover:bg-elevated'
                ]}
                aria-current={index === commitSearchActiveIndex ? 'true' : undefined}
                onclick={() => selectCommitSearchResult(commit)}
                onmouseenter={() => (commitSearchActiveIndex = index)}
              >
                <Search size={12} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[0.6875rem] leading-snug">
                    {commit.message.split('\n')[0]}
                  </span>
                  <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                    <span class="font-mono">{commit.shortHash}</span>
                    <span>·</span>
                    <span class="truncate">{commit.author}</span>
                    <span>·</span>
                    <span class="shrink-0">{relativeTime(commit.date)}</span>
                  </span>
                </span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Header: branch picker + tabs + actions -->
  <div class="flex shrink-0 flex-col border-b border-border">
    <!-- Top row: branch + tabs + actions -->
    <div class="flex h-9 items-center gap-1 px-2">
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
        />
      {:else}
        <div class="flex items-center gap-1.5 px-2">
          <GitBranch size={12} class="shrink-0 text-muted" />
          <span class="font-mono text-[0.6875rem] font-medium text-foreground">
            {status?.branch ?? (repoState === 'git' ? 'detached' : 'Repository')}
          </span>
        </div>
      {/if}

      <span class="flex-1"></span>

      {#if repoState === 'git' && status}
        {#if status.ahead > 0 || status.behind > 0}
          <span class="flex shrink-0 items-center gap-1">
            {#if status.ahead > 0}
              <span
                class="rounded bg-success/10 px-1 py-0.5 font-mono text-[0.5625rem] tabular-nums text-success"
              >
                ↑{status.ahead}
              </span>
            {/if}
            {#if status.behind > 0}
              <span
                class="rounded bg-danger/10 px-1 py-0.5 font-mono text-[0.5625rem] tabular-nums text-danger"
              >
                ↓{status.behind}
              </span>
            {/if}
          </span>
        {/if}
        <span
          class={[
            'shrink-0 rounded-full px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide',
            status.clean ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
          ]}
        >
          {status.clean ? 'Clean' : 'Dirty'}
        </span>
      {/if}
      <DiffLayoutToggle title={diffLayoutToggleLabel('vertical')} size={12} />
      {#if repoState === 'git'}
        <button
          type="button"
          class={[
            'flex h-6 w-6 items-center justify-center rounded transition-colors',
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
      {/if}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        aria-label="Refresh git status"
        title="Refresh git status"
        disabled={busy}
        onclick={() => void refreshStatus()}
      >
        <RefreshCw size={12} class={gitState.isBusy('refresh') ? 'animate-spin' : ''} />
      </button>

      {#if repoState === 'git'}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
            aria-label="More git actions"
            title="More git actions"
          >
            <MoreHorizontal size={13} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              class="z-50 w-52 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
            >
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

    {#if repoState === 'git'}
      <!-- Tab row — never wraps; scrolls horizontally when the tabs overflow -->
      <div class="flex items-center gap-4 overflow-x-auto px-3">
        {#each tabs as tab (tab.id)}
          {@const TabIcon = tab.icon}
          <button
            type="button"
            class={[
              'flex shrink-0 items-center gap-1.5 border-b-2 pb-1.5 pt-0.5 text-[0.6875rem] font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-dimmed hover:text-muted'
            ]}
            onclick={() => {
              activeTab = tab.id
              if (tab.id === 'history') void loadHistory()
            }}
          >
            <TabIcon size={11} class="shrink-0" />
            {tab.label}
            {#if tab.count !== null}
              <span
                class={[
                  'rounded-full px-1.5 text-[0.5625rem] font-semibold tabular-nums leading-[1.15rem]',
                  activeTab === tab.id ? 'bg-primary/15 text-primary' : 'bg-elevated text-dimmed'
                ]}
              >
                {tab.count}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Content (scrollable) -->
  <div class="min-h-0 flex-1 overflow-auto" onscroll={handleContentScroll}>
    {#if repoState === 'loading'}
      <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Checking repository
      </div>
    {:else if repoState === 'git_unavailable'}
      <div class="flex h-full flex-col items-center justify-center px-6 text-center">
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-elevated">
          <Unplug size={18} class="text-dimmed" />
        </div>
        <p class="text-xs font-medium text-muted">Git is not available</p>
        <p class="mt-1 max-w-[28ch] text-[0.625rem] leading-relaxed text-dimmed">
          Install Git for your operating system, then restart CodeInOven.
        </p>
        {#if preflightDetail}
          <p class="mt-2 max-w-[30ch] break-words font-mono text-[0.5625rem] text-dimmed">
            {preflightDetail}
          </p>
        {/if}
      </div>
    {:else if repoState === 'not_git'}
      <div class="flex h-full flex-col items-center justify-center px-6 text-center">
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-elevated">
          <GitFork size={18} class="text-dimmed" />
        </div>
        <p class="text-xs font-medium text-muted">Not a Git repository</p>
        <p class="mt-1 max-w-[28ch] text-[0.625rem] leading-relaxed text-dimmed">
          Initialize a repository to track changes and manage pull requests.
        </p>
        <button
          type="button"
          class="mt-3 flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={gitState.isBusy('init')}
          onclick={() => void initializeRepository()}
        >
          {#if gitState.isBusy('init')}
            <Loader2 size={12} class="animate-spin" />
          {:else}
            <GitFork size={12} />
          {/if}
          Initialize repository
        </button>
      </div>
    {:else}
      {#if gitState.githubPermission}
        <div
          class="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2"
        >
          <Unplug size={13} class="shrink-0 text-warning" />
          <p class="min-w-0 flex-1 text-[0.625rem] leading-relaxed text-muted">
            {gitState.githubPermission.message}
          </p>
          <button
            type="button"
            class="h-7 shrink-0 rounded-md border border-border bg-surface px-2.5 text-[0.625rem] font-medium text-foreground hover:bg-elevated"
            onclick={() => void openInBrowser(gitState.githubPermission?.settingsUrl ?? '')}
          >
            Update GitHub access
          </button>
        </div>
      {:else if gitState.error}
        <div class="mx-2 mt-2">
          <p
            class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[0.625rem] leading-relaxed text-danger"
          >
            {gitState.error}
          </p>
        </div>
      {/if}

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
        {#if selectedCommit}
          {@const commit = selectedCommit}
          <!-- Commit diff view -->
          <div class="sticky top-0 z-10 border-b border-border bg-app px-3 py-2">
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                title="Back to history"
                aria-label="Back to history"
                onclick={() => {
                  clearSelectedCommit()
                  activeTab = 'history'
                }}
              >
                <ArrowLeft size={12} />
              </button>
              <div class="flex items-center gap-0.5">
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
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.6875rem] font-medium text-foreground">
                  {commit.message.split('\n')[0]}
                </p>
                <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                  <span class="font-mono">{commit.shortHash}</span>
                  <span>·</span>
                  <span>{commit.author}</span>
                  <span>·</span>
                  <span>{relativeTime(commit.date)}</span>
                </div>
              </div>
              {#if isHeadCommit}
                <button
                  type="button"
                  class="shrink-0 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                  disabled={gitState.isBusy('reset') || gitState.isBusy('amend')}
                  onclick={startAmend}
                >
                  Amend
                </button>
              {/if}
              <div
                class="flex shrink-0 items-center rounded-md bg-elevated/50 p-0.5"
                role="group"
                aria-label="Changed files view"
              >
                <button
                  type="button"
                  class={[
                    'flex h-5 items-center gap-1 rounded px-2 text-[0.625rem] font-medium transition-colors',
                    changesView === 'list'
                      ? 'bg-surface text-foreground shadow-sm'
                      : 'text-dimmed hover:text-foreground'
                  ]}
                  aria-pressed={changesView === 'list'}
                  onclick={() => (changesView = 'list')}
                >
                  List
                </button>
                <button
                  type="button"
                  class={[
                    'flex h-5 items-center gap-1 rounded px-2 text-[0.625rem] font-medium transition-colors',
                    changesView === 'tree'
                      ? 'bg-surface text-foreground shadow-sm'
                      : 'text-dimmed hover:text-foreground'
                  ]}
                  aria-pressed={changesView === 'tree'}
                  onclick={() => (changesView = 'tree')}
                >
                  Tree
                </button>
              </div>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  aria-label={`More actions for commit ${commit.shortHash}`}
                  title={`More actions for commit ${commit.shortHash}`}
                >
                  <MoreHorizontal size={13} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                    side="bottom"
                    align="end"
                    sideOffset={4}
                    collisionPadding={8}
                  >
                    <CommitActionsMenu
                      isHead={isHeadCommit}
                      resetBusy={gitState.isBusy('reset')}
                      deleteBusy={gitState.isBusy('delete-commit')}
                      onReset={(mode) => requestReset(mode, commit.hash)}
                      onDelete={() => requestDeleteCommit(commit)}
                      onAmend={startAmend}
                      onCopyHash={() => void copyCommitHash(commit)}
                      onCopyMessage={() => void copyCommitMessage(commit)}
                    />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
          <div class="p-2">
            {#if loadingCommitDiff}
              <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
                <Loader2 size={14} class="animate-spin" />
                Loading diff
              </div>
            {:else if commitDiffChanges.length === 0}
              <div class="flex flex-col items-center justify-center py-12 text-center">
                <GitCommit size={22} class="mx-auto mb-2 text-dimmed" />
                <p class="text-xs font-medium text-muted">No file changes</p>
                <p class="mt-1 text-[0.625rem] text-dimmed">This commit has no changes.</p>
              </div>
            {:else}
              <div class="overflow-hidden rounded-lg border border-border bg-surface">
                <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                  <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                    Changed files
                  </span>
                  <span class="text-[0.5rem] tabular-nums text-dimmed">
                    {commitDiffChanges.length}
                  </span>
                </div>
                {#if changesView === 'tree'}
                  {@render commitTreeNode(commitTree, 0)}
                {:else}
                  {#each commitDiffChanges as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={commitDiffs[change.path] ?? null}
                      loadingDiff={loadingCommitDiffFile[change.path] ?? false}
                      error={commitDiffErrors[change.path] ?? null}
                      expanded={commitExpanded[change.path] ?? false}
                      readonly
                      onToggleDiff={() => void toggleCommitDiff(change)}
                      onToggleStage={() => {}}
                      onRestore={(path, target) =>
                        void restoreFromSource(selectedCommit?.hash ?? 'HEAD', path, target)}
                    />
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <div class="flex h-full min-h-0 flex-col">
            {#if status && changes.length === 0 && status.clean}
              <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
                <div
                  class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10"
                >
                  <Check size={18} class="text-success" />
                </div>
                <p class="text-xs font-medium text-muted">Working tree is clean</p>
                <p class="mt-1 max-w-[26ch] text-[0.625rem] leading-relaxed text-dimmed">
                  No staged, unstaged, or untracked changes.
                </p>
              </div>
            {:else if status}
              <!-- Stable header: abort control (when merging) or stage all + selection + view toggle -->
              <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                {#if conflicted.length > 0}
                  <button
                    type="button"
                    class="flex shrink-0 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 py-1 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
                    disabled={integrateBusy || conflictState === 'none'}
                    onclick={requestAbortConflict}
                  >
                    {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
                      <Loader2 size={11} class="animate-spin" />
                    {:else}
                      <Trash2 size={11} />
                    {/if}
                    Abort {conflictState === 'merge' ? 'merge' : 'rebase'}
                  </button>
                  <span
                    class="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tabular-nums text-warning"
                  >
                    {conflicted.length}
                    {conflicted.length === 1 ? 'conflict' : 'conflicts'}
                  </span>
                {:else if unstaged.length + untracked.length > 0}
                  <button
                    type="button"
                    class="shrink-0 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                    disabled={gitState.isBusy('stage')}
                    onclick={() => void stageAll()}
                  >
                    Stage all
                  </button>
                {:else if staged.length > 0}
                  <button
                    type="button"
                    class="shrink-0 rounded-md border border-danger/30 px-2 py-1 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
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
                      class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
                          <span class="inline-block w-3 text-center text-[0.625rem] text-danger">−</span
                          >
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
                <span class="flex-1"></span>
                {#if changes.length > 0}
                  <div
                    class="flex items-center rounded-md bg-elevated/50 p-0.5"
                    role="group"
                    aria-label="Changes view"
                  >
                    <button
                      type="button"
                      class={[
                        'flex h-5 items-center gap-1 rounded px-2 text-[0.625rem] font-medium transition-colors',
                        changesView === 'list'
                          ? 'bg-surface text-foreground shadow-sm'
                          : 'text-dimmed hover:text-foreground'
                      ]}
                      aria-pressed={changesView === 'list'}
                      onclick={() => (changesView = 'list')}
                    >
                      List
                    </button>
                    <button
                      type="button"
                      class={[
                        'flex h-5 items-center gap-1 rounded px-2 text-[0.625rem] font-medium transition-colors',
                        changesView === 'tree'
                          ? 'bg-surface text-foreground shadow-sm'
                          : 'text-dimmed hover:text-foreground'
                      ]}
                      aria-pressed={changesView === 'tree'}
                      onclick={() => (changesView = 'tree')}
                    >
                      Tree
                    </button>
                  </div>
                {/if}
              </div>

              <!-- Staged / working panes — conflicts sit on top; each pane shares the height -->
              <div class="flex h-full min-h-0 flex-col gap-2 px-2 pb-2">
                {#if conflictSections.length > 0}
                  <div class={paneClass}>
                    {#if changesView === 'tree'}
                      <GitChangesTree
                        sections={conflictSections}
                        {diffs}
                        {expanded}
                        {loadingDiff}
                        {diffErrors}
                        bind:selectedPaths
                        onToggleDiff={(change) => void toggleDiff(change)}
                        onToggleStage={(change) => void toggleStage(change)}
                        onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                        onStagePaths={(paths, staged) => void stagePathsAction(paths, staged)}
                        onStashPaths={(paths) => requestStashFor(paths)}
                        onOpenInEditor={(path) => void openInEditor(path)}
                        onIgnorePaths={(paths) => void ignorePathsAction(paths)}
                        onDiscardPaths={(paths) => requestDiscard(paths)}
                        onResolveConflict={(path) => routeConflictResolution(path)}
                      />
                    {:else}
                      <div class="overflow-hidden rounded-lg border border-warning/25 bg-surface">
                        {#each conflictSections as section, si (section.title)}
                          {#if si > 0}<div class="border-t border-border"></div>{/if}
                          <div class="flex items-center gap-2 bg-warning/10 px-3 py-1.5">
                            <span
                              class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
                            >
                              {section.title}
                            </span>
                            <span class="text-[0.5rem] tabular-nums text-dimmed">
                              {section.files.length}
                            </span>
                            <span class="flex-1"></span>
                            <button
                              type="button"
                              class="rounded px-1.5 py-0.5 text-[0.5625rem] font-medium text-warning transition-colors hover:bg-warning/10"
                              title="Open the conflict resolution panel"
                              onclick={() => routeConflictResolution(section.files[0]?.path)}
                            >
                              Resolve all
                            </button>
                          </div>
                          {#each section.files as change (change.path)}
                            <GitFileRow
                              {change}
                              diff={diffs[fileDiffKey(change)] ?? null}
                              loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                              error={diffErrors[fileDiffKey(change)] ?? null}
                              expanded={expanded[fileDiffKey(change)] ?? false}
                              onToggleDiff={() => void toggleDiff(change)}
                              onToggleStage={() => void toggleStage(change)}
                              onOpenInEditor={(path) => void openInEditor(path)}
                              onResolveConflict={(path) => routeConflictResolution(path)}
                            />
                          {/each}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if stagedSections.length > 0}
                  <div class={paneClass}>
                    {#if changesView === 'tree'}
                      <GitChangesTree
                        sections={stagedSections}
                        {diffs}
                        {expanded}
                        {loadingDiff}
                        {diffErrors}
                        bind:selectedPaths
                        onToggleDiff={(change) => void toggleDiff(change)}
                        onToggleStage={(change) => void toggleStage(change)}
                        onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                        onStagePaths={(paths, staged) => void stagePathsAction(paths, staged)}
                        onStashPaths={(paths) => requestStashFor(paths)}
                        onOpenInEditor={(path) => void openInEditor(path)}
                        onIgnorePaths={(paths) => void ignorePathsAction(paths)}
                        onDiscardPaths={(paths) => requestDiscard(paths)}
                      />
                    {:else}
                      <div class="overflow-hidden rounded-lg border border-border bg-surface">
                        {#each stagedSections as section, si (section.title)}
                          {#if si > 0}<div class="border-t border-border"></div>{/if}
                          {@const sectionAllSelected =
                            section.files.length > 0 &&
                            section.files.every((f) => selectedPaths[f.path])}
                          <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                            <span
                              class="shrink-0"
                              role="presentation"
                              onclick={(event: MouseEvent) => {
                                event.stopPropagation()
                                event.preventDefault()
                              }}
                              onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
                            >
                              <Switch
                                checked={sectionAllSelected}
                                onchange={() => toggleSectionSelection(section.files)}
                                title={sectionAllSelected
                                  ? `Deselect all ${section.files.length} files in ${section.title}`
                                  : `Select all ${section.files.length} files in ${section.title}`}
                                aria-label={sectionAllSelected
                                  ? `Deselect all ${section.files.length} files in ${section.title}`
                                  : `Select all ${section.files.length} files in ${section.title}`}
                                activeClass="border-primary bg-primary"
                              />
                            </span>
                            <span
                              class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
                            >
                              {section.title}
                            </span>
                            <span class="text-[0.5rem] tabular-nums text-dimmed">
                              {section.files.length}
                            </span>
                          </div>
                          {#each section.files as change (change.path)}
                            <GitFileRow
                              {change}
                              diff={diffs[fileDiffKey(change)] ?? null}
                              loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                              error={diffErrors[fileDiffKey(change)] ?? null}
                              expanded={expanded[fileDiffKey(change)] ?? false}
                              selected={Boolean(selectedPaths[change.path])}
                              selectable
                              onToggleDiff={() => void toggleDiff(change)}
                              onToggleStage={() => void toggleStage(change)}
                              onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                              onStash={(path) => requestStashFor([path])}
                              onOpenInEditor={(path) => void openInEditor(path)}
                              onIgnore={(path) => void ignorePathsAction([path])}
                              onDiscard={(path) => requestDiscard([path])}
                            />
                          {/each}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if workingSections.length > 0}
                  <div class={paneClass}>
                    {#if changesView === 'tree'}
                      <GitChangesTree
                        sections={workingSections}
                        {diffs}
                        {expanded}
                        {loadingDiff}
                        {diffErrors}
                        bind:selectedPaths
                        onToggleDiff={(change) => void toggleDiff(change)}
                        onToggleStage={(change) => void toggleStage(change)}
                        onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                        onStagePaths={(paths, staged) => void stagePathsAction(paths, staged)}
                        onStashPaths={(paths) => requestStashFor(paths)}
                        onOpenInEditor={(path) => void openInEditor(path)}
                        onIgnorePaths={(paths) => void ignorePathsAction(paths)}
                        onDiscardPaths={(paths) => requestDiscard(paths)}
                      />
                    {:else}
                      <div class="overflow-hidden rounded-lg border border-border bg-surface">
                        {#each workingSections as section, si (section.title)}
                          {#if si > 0}<div class="border-t border-border"></div>{/if}
                          {@const sectionAllSelected =
                            section.files.length > 0 &&
                            section.files.every((f) => selectedPaths[f.path])}
                          <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                            <span
                              class="shrink-0"
                              role="presentation"
                              onclick={(event: MouseEvent) => {
                                event.stopPropagation()
                                event.preventDefault()
                              }}
                              onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
                            >
                              <Switch
                                checked={sectionAllSelected}
                                onchange={() => toggleSectionSelection(section.files)}
                                title={sectionAllSelected
                                  ? `Deselect all ${section.files.length} files in ${section.title}`
                                  : `Select all ${section.files.length} files in ${section.title}`}
                                aria-label={sectionAllSelected
                                  ? `Deselect all ${section.files.length} files in ${section.title}`
                                  : `Select all ${section.files.length} files in ${section.title}`}
                                activeClass="border-primary bg-primary"
                              />
                            </span>
                            <span
                              class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
                            >
                              {section.title}
                            </span>
                            <span class="text-[0.5rem] tabular-nums text-dimmed">
                              {section.files.length}
                            </span>
                          </div>
                          {#each section.files as change (change.path)}
                            <GitFileRow
                              {change}
                              diff={diffs[fileDiffKey(change)] ?? null}
                              loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                              error={diffErrors[fileDiffKey(change)] ?? null}
                              expanded={expanded[fileDiffKey(change)] ?? false}
                              selected={Boolean(selectedPaths[change.path])}
                              selectable
                              onToggleDiff={() => void toggleDiff(change)}
                              onToggleStage={() => void toggleStage(change)}
                              onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                              onStash={(path) => requestStashFor([path])}
                              onOpenInEditor={(path) => void openInEditor(path)}
                              onIgnore={(path) => void ignorePathsAction([path])}
                              onDiscard={(path) => requestDiscard([path])}
                            />
                          {/each}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {:else if activeTab === 'history'}
        <div class="p-2">
          {#if loadingHistory}
            <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
              <Loader2 size={14} class="animate-spin" />
              Loading history
            </div>
          {:else if commitHistory.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <History size={22} class="mx-auto mb-2 text-dimmed" />
              <p class="text-xs font-medium text-muted">No commits yet</p>
              <p class="mt-1 text-[0.625rem] text-dimmed">Make your first commit to see history.</p>
            </div>
          {:else}
            <div class="space-y-0.5">
              {#each commitHistory as commit, index (commit.hash)}
                {@const isCurrentHead = index === 0}
                {@const isUnpushed = index < unpushedCount}
                {#if unpushedCount > 0 && index === unpushedCount}
                  <div class="flex items-center gap-2 px-2 py-1">
                    <span class="h-px flex-1 bg-border"></span>
                    <span class="shrink-0 text-[0.5625rem] font-medium text-dimmed">
                      Pushed to {status?.upstream}
                    </span>
                    <span class="h-px flex-1 bg-border"></span>
                  </div>
                {/if}
                <ContextMenu.Root>
                  <ContextMenu.Trigger
                    class="block w-full"
                    aria-label={`Actions for commit ${commit.shortHash}`}
                  >
                    <button
                      type="button"
                      class={[
                        'group w-full rounded-lg px-2 py-1.5 text-left transition-colors',
                        selectedCommit?.hash === commit.hash
                          ? 'bg-primary/10'
                          : 'hover:bg-elevated/50'
                      ]}
                      onclick={() => void selectCommit(commit)}
                    >
                      <div class="flex items-start gap-2">
                        <div
                          class={[
                            'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                            isUnpushed ? 'bg-warning' : 'bg-primary/40'
                          ]}
                          title={isUnpushed
                            ? `Not pushed to ${status?.upstream ?? 'the remote'} yet`
                            : undefined}
                        ></div>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-[0.6875rem] leading-snug text-foreground">
                            {commit.message.split('\n')[0]}
                          </p>
                          <div class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                            <span class="font-mono">{commit.shortHash}</span>
                            <span>·</span>
                            <span>{commit.author}</span>
                            <span>·</span>
                            <span>{relativeTime(commit.date)}</span>
                            {#if isUnpushed}
                              <span
                                class="rounded px-1 py-px text-[0.5rem] font-medium uppercase tracking-wide text-warning"
                              >
                                local
                              </span>
                            {/if}
                          </div>
                        </div>
                      </div>
                    </button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content
                      class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                      side="bottom"
                      align="start"
                      sideOffset={4}
                      collisionPadding={8}
                    >
                      <CommitActionsMenu
                        isHead={isCurrentHead}
                        resetBusy={gitState.isBusy('reset')}
                        deleteBusy={gitState.isBusy('delete-commit')}
                        onReset={(mode) => requestReset(mode, commit.hash)}
                        onDelete={() => requestDeleteCommit(commit)}
                        onAmend={isCurrentHead ? startAmend : undefined}
                        onCopyHash={() => void copyCommitHash(commit)}
                        onCopyMessage={() => void copyCommitMessage(commit)}
                      />
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
              {/each}
              {#if loadingMoreHistory}
                <div class="flex items-center justify-center gap-2 py-4 text-[0.625rem] text-dimmed">
                  <Loader2 size={12} class="animate-spin" />
                  Loading older commits
                </div>
              {:else if !historyHasMore}
                <p class="py-4 text-center text-[0.5625rem] text-dimmed">Start of history</p>
              {/if}
            </div>
          {/if}
        </div>
      {:else if activeTab === 'branches'}
        <div class="flex h-full min-h-0 flex-col">
          <!-- New branch -->
          <div class="shrink-0 border-b border-border px-3 py-1.5">
            {#if creatingBranch}
              <div class="flex items-center gap-1.5">
                <input
                  bind:this={newBranchInput}
                  class="min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                  placeholder="new-feature"
                  bind:value={newBranchName}
                  onkeydown={(event: KeyboardEvent) => {
                    if (event.key === 'Enter') void submitNewBranch()
                    if (event.key === 'Escape') {
                      creatingBranch = false
                      newBranchName = ''
                    }
                  }}
                />
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
                  disabled={!newBranchName.trim() || gitState.isBusy('checkout')}
                  onclick={() => void submitNewBranch()}
                >
                  Create
                </button>
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
                  onclick={() => {
                    creatingBranch = false
                    newBranchName = ''
                  }}
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[0.6875rem] font-medium text-muted transition-colors hover:text-foreground"
                onclick={() => (creatingBranch = true)}
              >
                <Plus size={12} class="shrink-0" />
                New branch
              </button>
            {/if}
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {#if gitState.branches.length === 0}
              <div class="flex flex-col items-center justify-center py-12 text-center">
                <GitBranch size={22} class="mx-auto mb-2 text-dimmed" />
                <p class="text-xs font-medium text-muted">No branches</p>
              </div>
            {:else}
              {@const branchSections = [
                {
                  key: 'local',
                  label: 'Local',
                  branches: [...localBranches].sort((a, b) => {
                    if (a.current !== b.current) return a.current ? -1 : 1
                    return a.ref.localeCompare(b.ref)
                  })
                },
                {
                  key: 'worktrees',
                  label: 'Worktrees',
                  branches: [...worktreeBranches].sort((a, b) => a.ref.localeCompare(b.ref))
                },
                {
                  key: 'remote',
                  label: 'Remote',
                  branches: [...gitState.branches]
                    .filter((branch) => branch.kind === 'remote')
                    .sort((a, b) => a.ref.localeCompare(b.ref))
                }
              ].filter((section) => section.branches.length > 0)}
              <div class="space-y-0.5">
                {#each branchSections as section (section.key)}
                  <p
                    class="px-2 pb-1 pt-2 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
                  >
                    {section.label}
                  </p>
                  {#each section.branches as branch (branch.ref)}
                    {@const canFetch = Boolean(branch.remote)}
                    {@const inWorktree = branch.worktreePath !== null}
                    {@const hasLocalCounterpart =
                      branch.kind === 'remote' && localBranchNames.has(branch.name)}
                    <ContextMenu.Root>
                      <ContextMenu.Trigger
                        class="block w-full"
                        aria-label={`Actions for branch ${branch.ref}`}
                      >
                        <div
                          class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated/50"
                        >
                          <span
                            class={[
                              'flex size-5 shrink-0 items-center justify-center rounded-full',
                              inWorktree
                                ? 'bg-warning/10 text-warning'
                                : branchAvatarClass(branch.ref)
                            ]}
                          >
                            {#if inWorktree}
                              <FolderTree size={11} />
                            {:else}
                              <GitBranch size={11} />
                            {/if}
                          </span>
                          <span class="min-w-0 flex-1">
                            <button
                              type="button"
                              class="block w-full cursor-pointer truncate text-left text-[0.6875rem] text-foreground disabled:cursor-default"
                              disabled={branch.current || hasLocalCounterpart || inWorktree}
                              title={branch.current
                                ? undefined
                                : inWorktree
                                  ? `Checked out in worktree ${branch.worktreePath ?? ''} — git allows a branch in only one worktree`
                                  : hasLocalCounterpart
                                    ? `${branch.ref} already has a local branch`
                                    : branch.kind === 'local'
                                      ? `Check out ${branch.name}`
                                      : `Create local branch ${branch.name} from ${branch.ref}`}
                              onclick={() => requestCheckout(branch)}
                            >
                              {branch.kind === 'local' ? branch.name : branch.ref}
                            </button>
                            {#if branch.kind === 'local' && branch.upstream}
                              <span class="block truncate text-[0.5625rem] text-dimmed">
                                tracks {branch.upstream}
                              </span>
                            {:else if inWorktree}
                              <span class="block truncate text-[0.5625rem] text-dimmed">
                                checked out in worktree
                              </span>
                            {:else if branch.kind === 'remote'}
                              <span class="block truncate text-[0.5625rem] text-dimmed">
                                {hasLocalCounterpart ? 'local branch exists' : 'remote branch'}
                              </span>
                            {/if}
                          </span>
                          {#if inWorktree}
                            <span
                              class="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-warning"
                            >
                              worktree
                            </span>
                          {/if}
                          {#if branch.ahead > 0 || branch.behind > 0}
                            <span
                              class="flex shrink-0 items-center gap-0.5 text-[0.5625rem] tabular-nums"
                            >
                              {#if branch.ahead > 0}
                                <span class="text-success">+{branch.ahead}</span>
                              {/if}
                              {#if branch.behind > 0}
                                <span class="text-danger">−{branch.behind}</span>
                              {/if}
                            </span>
                          {/if}
                          <div class="relative h-6 w-16 shrink-0">
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                class="peer absolute inset-y-0 right-0 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-elevated hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label={`More actions for branch ${branch.ref}`}
                                title={`More actions for branch ${branch.ref}`}
                              >
                                <MoreHorizontal size={13} />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                  class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                                  side="bottom"
                                  align="end"
                                  sideOffset={4}
                                  collisionPadding={8}
                                >
                                  <BranchActionsMenu
                                    isCurrent={branch.current}
                                    canCheckout={!hasLocalCounterpart && !inWorktree}
                                    canDelete={branch.kind === 'local'}
                                    {canFetch}
                                    checkoutLabel={branch.kind === 'local'
                                      ? 'Check out'
                                      : 'Create local branch'}
                                    busy={gitState.isBusy('checkout') || gitState.isBusy('fetch')}
                                    onCheckout={() => requestCheckout(branch)}
                                    onFetch={() => void fetchBranchAction(branch)}
                                    onDelete={() => requestDeleteBranch(branch.name)}
                                  />
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                            {#if branch.current}
                              <span
                                class="pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap rounded bg-primary/15 px-1.5 text-[0.5rem] font-semibold text-primary opacity-100 transition-opacity group-hover:opacity-0 peer-hover:opacity-0 peer-data-[state=open]:opacity-0"
                              >
                                current
                              </span>
                            {/if}
                          </div>
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenu.Portal>
                        <ContextMenu.Content
                          class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                          side="bottom"
                          align="start"
                          sideOffset={4}
                          collisionPadding={8}
                        >
                          <BranchActionsMenu
                            isCurrent={branch.current}
                            canCheckout={!hasLocalCounterpart && !inWorktree}
                            canDelete={branch.kind === 'local'}
                            {canFetch}
                            checkoutLabel={branch.kind === 'local'
                              ? 'Check out'
                              : 'Create local branch'}
                            busy={gitState.isBusy('checkout') || gitState.isBusy('fetch')}
                            onCheckout={() => requestCheckout(branch)}
                            onFetch={() => void fetchBranchAction(branch)}
                            onDelete={() => requestDeleteBranch(branch.name)}
                          />
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>
                  {/each}
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else if activeTab === 'pulls'}
        <div class="h-full min-h-0">
          {#if selectedPullRequest && githubIdentity}
            <GitPullRequestDetail
              {projectId}
              identity={githubIdentity}
              summary={selectedPullRequest}
              onBack={() => (selectedPullRequest = null)}
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
              onOpen={(pr) => (selectedPullRequest = pr)}
              onSignIn={() => (showGitHubSignIn = true)}
              onCreate={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
              refreshSignal={prListRefresh}
            />
          {/if}
        </div>
      {:else if activeTab === 'deployments'}
        <GitDeploymentsMonitor
          {projectId}
          identity={githubIdentity}
          {githubConnected}
          onSignIn={() => (showGitHubSignIn = true)}
          requestedRunId={requestedWorkflowRunId}
          onRequestedRunOpened={() => (requestedWorkflowRunId = null)}
          onAgentDiagnoseRun={startWorkflowDiagnosis}
          onAgentDiagnoseDeployment={startDeploymentDiagnosis}
        />
      {:else if activeTab === 'stashes'}
        <div class="p-2">
          {#if selectedStash}
            {@const stash = selectedStash}
            <!-- Stash diff view -->
            <div class="sticky top-0 z-10 border-b border-border bg-app px-3 py-2">
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Back to stash list"
                  aria-label="Back to stash list"
                  onclick={clearSelectedStash}
                >
                  <ArrowLeft size={12} />
                </button>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[0.6875rem] font-medium text-foreground">{stash.message}</p>
                  <div class="flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                    <span class="font-mono">{stash.id}</span>
                    {#if stash.branch}
                      <span>·</span>
                      <span class="truncate">{stash.branch}</span>
                    {/if}
                    <span>·</span>
                    <span>{relativeTime(stash.date)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="p-2">
              {#if loadingStashDiff}
                <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
                  <Loader2 size={14} class="animate-spin" />
                  Loading changes
                </div>
              {:else if stashDiffChanges.length === 0}
                <div class="flex flex-col items-center justify-center py-12 text-center">
                  <Archive size={22} class="mx-auto mb-2 text-dimmed" />
                  <p class="text-xs font-medium text-muted">No file changes</p>
                  <p class="mt-1 text-[0.625rem] text-dimmed">This stash has no changes.</p>
                </div>
              {:else}
                <div class="overflow-hidden rounded-lg border border-border bg-surface">
                  <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                      Changed files
                    </span>
                    <span class="text-[0.5rem] tabular-nums text-dimmed">
                      {stashDiffChanges.length}
                    </span>
                  </div>
                  {#each stashDiffChanges as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={stashDiffs[change.path] ?? null}
                      loadingDiff={loadingStashDiffFile[change.path] ?? false}
                      error={stashDiffErrors[change.path] ?? null}
                      expanded={stashExpanded[change.path] ?? false}
                      readonly
                      onToggleDiff={() => void toggleStashDiff(change)}
                      onToggleStage={() => {}}
                      onRestore={(path, target) =>
                        void restoreFromSource(selectedStash?.id ?? 'HEAD', path, target)}
                    />
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div class="overflow-hidden rounded-lg border border-border bg-surface">
              {#each gitState.stashes as stash (stash.id)}
                <div
                  class="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-elevated/40"
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:text-foreground"
                    title="View changes in stash {stash.id}"
                    aria-label="View changes in stash {stash.id}"
                    onclick={() => void selectStash(stash)}
                  >
                    <Archive size={12} class="shrink-0 text-dimmed" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[0.6875rem] leading-snug text-foreground">
                        {stash.message}
                      </span>
                      <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                        <span class="font-mono">{stash.id}</span>
                        {#if stash.branch}
                          <span>·</span>
                          <span class="truncate">{stash.branch}</span>
                        {/if}
                        <span>·</span>
                        <span>{relativeTime(stash.date)}</span>
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="shrink-0 rounded-md border border-border px-2 py-1 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    disabled={stashOpBusy}
                    title="Restore stash {stash.id} into the working tree"
                    onclick={() => void popStash(stash.id)}
                  >
                    {gitState.isBusy('stash-pop') ? 'Popping…' : 'Pop'}
                  </button>
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                    disabled={stashOpBusy}
                    title="Discard stash {stash.id}"
                    aria-label="Discard stash {stash.id}"
                    onclick={() => requestStashDrop(stash)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              {/each}
            </div>
            <p class="mt-2 px-1 text-[0.5625rem] leading-relaxed text-dimmed">
              Click a stash to inspect its changes. Popping restores it to your working tree and
              removes it from this list.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <!-- Pinned composer: only once something is staged (or an amend was started from History) -->
  {#if repoState === 'git' && status && !selectedCommit && activeTab === 'changes' && (staged.length > 0 || amendMode)}
    <div class="shrink-0 border-t border-border bg-surface">
      {#if amendMode}
        <div class="flex items-center gap-2 border-b border-border bg-warning/10 px-3 py-1.5">
          <GitCommit size={11} class="shrink-0 text-warning" />
          <p class="min-w-0 flex-1 text-[0.5625rem] leading-relaxed text-warning">
            Amending the most recent commit — no new commit will be created.
          </p>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted hover:bg-elevated"
            onclick={() => (amendMode = false)}
          >
            Cancel
          </button>
        </div>
      {/if}
      <div class="px-2 pt-2">
        <textarea
          bind:this={commitTextarea}
          class="min-h-11 w-full resize-none rounded-md border border-border bg-elevated px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder={amendMode ? 'Amended commit message…' : 'Commit message…'}
          bind:value={commitMessage}
          onkeydown={onCommitMessageKeydown}></textarea>
      </div>
      <div class="flex items-center gap-1.5 px-2 py-2">
        <span class="flex-1"></span>
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-40"
          disabled={!commitMessage.trim() || commitBusy || (!amendMode && staged.length === 0)}
          onclick={() => void commitInline()}
        >
          {#if commitBusy}
            <Loader2 size={11} class="animate-spin" />
          {:else}
            <GitCommit size={11} />
          {/if}
          {amendMode ? 'Amend commit' : `Commit${staged.length > 0 ? ` (${staged.length})` : ''}`}
        </button>
      </div>
    </div>
  {/if}

  <!-- Pinned action bar -->
  {#if pushConfirm}
    <div class="shrink-0 border-t border-border bg-warning/10 px-3 py-2">
      <p class="text-[0.625rem] font-medium text-foreground">Push with upstream?</p>
      <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
        Set <span class="font-mono text-foreground">{primaryRemote?.name}/{status?.branch}</span> as upstream.
      </p>
      <div class="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated"
          onclick={() => (pushConfirm = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-2.5 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={syncBusy}
          onclick={() => void confirmPushUpstream()}
        >
          Push
        </button>
      </div>
    </div>
  {/if}

  {#if pushDiverged}
    <Modal open title="Push blocked — branch has diverged" onClose={() => (pushDiverged = false)}>
      <div class="space-y-2">
        <p class="text-[0.625rem] leading-relaxed text-muted">
          The remote branch has commits you don't have locally, so Git will not let you push over
          them. Integrate the remote changes first, then push again.
        </p>
        <p class="rounded-lg border border-border bg-surface px-3 py-2 text-[0.625rem] text-dimmed">
          {status?.branch && primaryRemote
            ? `${primaryRemote.name}/${status.branch}`
            : 'Remote branch'}
          {#if (status?.behind ?? 0) > 0 || (status?.ahead ?? 0) > 0}
            — <span class="font-medium text-muted">{status?.ahead ?? 0} ahead</span> ·
            <span class="font-medium text-muted">{status?.behind ?? 0} behind</span>
          {/if}
        </p>
        <p class="text-[0.5625rem] leading-relaxed text-dimmed">
          Merge keeps both histories and adds a merge commit. Rebase replays your commits on top of
          the remote for a straight history. Conflicts pause integration so you can resolve them
          here before anything is pushed.
        </p>
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (pushDiverged = false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={pushRecoverMode !== null}
            onclick={() => void recoverPush('rebase')}
          >
            {#if pushRecoverMode === 'rebase'}
              <Loader2 size={11} class="animate-spin" />
            {/if}
            Rebase &amp; push
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
            disabled={pushRecoverMode !== null}
            onclick={() => void recoverPush('merge')}
          >
            {#if pushRecoverMode === 'merge'}
              <Loader2 size={11} class="animate-spin" />
            {/if}
            Pull &amp; push
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if pullStrategyOpen}
    <Modal open title="Choose pull strategy" onClose={closePullStrategy}>
      <div class="space-y-3">
        <div class="rounded-lg border border-border bg-elevated px-3 py-2">
          <p class="text-[0.625rem] font-medium text-foreground">
            Pull into <span class="font-mono">{status?.branch ?? 'current branch'}</span>
          </p>
          <p class="mt-0.5 text-[0.5625rem] text-dimmed">
            {status?.ahead ?? 0} ahead, {status?.behind ?? 0} behind
            <span class="font-mono">{status?.upstream ?? 'its remote'}</span>
          </p>
        </div>
        {#if pullStrategyError}
          <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2" role="alert">
            <p class="text-[0.625rem] font-semibold text-danger">That pull strategy could not finish</p>
            <p
              class="mt-0.5 whitespace-pre-wrap break-words text-[0.5625rem] leading-relaxed text-danger"
            >
              {pullStrategyError}
            </p>
            <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
              Choose another strategy below, or cancel without changing the branch further.
            </p>
          </div>
        {/if}
        <div class="space-y-1 text-[0.5625rem] leading-relaxed text-dimmed">
          <p>
            <span class="font-medium text-foreground">Merge</span> keeps both histories and may create
            a merge commit.
          </p>
          <p>
            <span class="font-medium text-foreground">Rebase</span> replays local commits on top of the
            remote branch.
          </p>
          <p>
            <span class="font-medium text-foreground">Fast-forward only</span> pulls only when no reconciliation
            is needed.
          </p>
        </div>
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
            disabled={gitState.isBusy('pull')}
            onclick={closePullStrategy}
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={gitState.isBusy('pull')}
            onclick={() => void performPull('ff-only')}
          >
            Fast-forward only
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            disabled={gitState.isBusy('pull')}
            onclick={() => void performPull('rebase')}
          >
            Rebase
          </button>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
            data-modal-primary
            disabled={gitState.isBusy('pull')}
            onclick={() => void performPull('merge')}
          >
            Merge
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  <!-- Completing a resolved merge: optional title/description, auto-generated when skipped -->
  {#if resolveMergeOpen}
    <Modal
      open
      title="Resolve merge"
      onClose={() => (resolveMergeOpen = false)}
    >
      <div class="space-y-2">
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          All conflicts are resolved. Give the merge commit a title and description, or leave them
          empty to generate one automatically. Resolving also pushes the result back to the pull
          request, restores your previous branch, and removes the temporary conflict branch.
        </p>
        <input
          class="h-8 w-full rounded-md border border-border bg-elevated px-2.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Title (e.g. Merge branch '{status?.upstream ?? 'main'}')"
          bind:value={mergeTitle}
          disabled={resolveMergeBusy}
        />
        <textarea
          class="min-h-16 w-full resize-y rounded-md border border-border bg-elevated px-2.5 py-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Description (optional)"
          bind:value={mergeDescription}
          disabled={resolveMergeBusy}
        ></textarea>
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (resolveMergeOpen = false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-foreground px-3 text-[0.6875rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            data-modal-primary
            disabled={resolveMergeBusy}
            onclick={() => void confirmResolveMerge()}
          >
            {#if resolveMergeBusy}<Loader2 size={11} class="animate-spin" />{:else}<GitMerge size={11} />{/if}
            Resolve
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  <!--
    Fetch/pull/push act on the local working tree, so they only belong to the
    working-tree tabs. On the pull request tab they sat under a PR's own
    comment box implying they were part of reviewing it, which they are not.
  -->
  {#if repoState === 'git' && status && remotes.length > 0 && activeTab !== 'pulls' && !mergePending}
    <div class="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Fetch refs from the remote without changing the working tree"
        disabled={remotes.length === 0 || syncBusy}
        onclick={() => void gitState.fetch(projectId)}
      >
        {#if gitState.isBusy('fetch')}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <Download size={11} />
        {/if}
        Fetch
      </button>
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title={status.behind > 0
          ? `Pull ${String(status.behind)} commit(s) from the remote`
          : 'Pull from the remote'}
        disabled={remotes.length === 0 || syncBusy}
        onclick={() => void pullAction()}
      >
        {#if gitState.isBusy('pull')}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <ArrowDownToLine size={11} />
        {/if}
        Pull{status.behind > 0 ? ` ${status.behind}` : ''}
      </button>
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title={status.ahead > 0
          ? `Push ${String(status.ahead)} commit(s) to the remote`
          : 'Push to the remote'}
        disabled={remotes.length === 0 || syncBusy || gitState.isBusy('push')}
        onclick={() => void pushAction()}
      >
        {#if gitState.isBusy('push')}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <ArrowUpFromLine size={11} />
        {/if}
        Push{status.ahead > 0 ? ` ${status.ahead}` : ''}
      </button>
    </div>
  {:else if repoState === 'git' && status && mergePending}
    <div class="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-foreground text-[0.625rem] font-semibold text-app transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        title="Commit the resolved files to complete the merge"
        disabled={resolveMergeBusy}
        onclick={openResolveMerge}
      >
        {#if resolveMergeBusy}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <GitMerge size={11} />
        {/if}
        Resolve merge
      </button>
    </div>
  {/if}

  <!-- Modals -->
  {#if showGitHubSignIn}
    <GitHubSignInModal
      onClose={() => (showGitHubSignIn = false)}
      onConnected={() => {
        // Reload the full status so the avatar/name land in the branch picker
        // instead of leaving a stale "Sign in" button behind.
        void loadGitHubAuth()
      }}
    />
  {/if}

  {#if showStashModal}
    <Modal
      open
      title={stashPaths ? 'Stash selected changes' : 'Stash changes'}
      onClose={() => (showStashModal = false)}
    >
      <div class="space-y-2">
        {#if stashPaths}
          <div class="rounded-lg border border-border bg-elevated/50 px-3 py-2">
            <p class="text-[0.625rem] font-medium text-foreground">
              {stashPaths.length}
              {stashPaths.length === 1 ? 'file' : 'files'} to stash
            </p>
            <div class="mt-1 max-h-24 overflow-auto">
              {#each stashPaths as path (path)}
                <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
              {/each}
            </div>
          </div>
        {:else}
          <p class="text-[0.6875rem] leading-relaxed text-muted">
            Shelves your staged and unstaged changes so you can switch work. Restore them any time
            from the Stashes tab.
          </p>
        {/if}
        <input
          class="h-8 w-full rounded-md border border-border bg-elevated px-2.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Describe this stash (optional)"
          bind:value={stashMessage}
        />
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => {
              showStashModal = false
              stashPaths = null
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={(status?.clean ?? true) || gitState.isBusy('stash')}
            onclick={() => void stashChanges()}
          >
            {#if gitState.isBusy('stash')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            {stashPaths ? 'Stash selected' : 'Stash changes'}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if showIntegrateModal}
    <Modal open title="Merge or rebase" onClose={() => (showIntegrateModal = false)}>
      <div class="space-y-2">
        <label
          class="block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
          for="integrate-target"
        >
          Bring changes into {status?.branch ?? 'HEAD'} from
        </label>
        <select
          id="integrate-target"
          class="h-8 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary"
          bind:value={mergeTarget}
        >
          <option value="" disabled>Select a branch…</option>
          {#each localBranches as branch (branch.ref)}
            {#if branch.name !== status?.branch}
              <option value={branch.name}>{branch.name}</option>
            {/if}
          {/each}
        </select>
        <p class="text-[0.625rem] leading-relaxed text-dimmed">
          Merge keeps both histories and adds a merge commit. Rebase replays your commits on top of
          the selected branch for a straight history.
        </p>
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (showIntegrateModal = false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-8 rounded-lg border border-border px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
            disabled={!mergeTarget || integrateBusy}
            onclick={() => requestMergeOrRebase('rebase')}
          >
            Rebase
          </button>
          <button
            type="button"
            class="h-8 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={!mergeTarget || integrateBusy}
            onclick={() => requestMergeOrRebase('merge')}
          >
            Merge
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if pendingOperation}
    {@const operation = pendingOperation}
    <Modal
      open
      title={operation.kind === 'merge' ? 'Merge branch' : 'Rebase onto branch'}
      onClose={() => (pendingOperation = null)}
    >
      <div class="space-y-3">
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          {operation.kind === 'merge'
            ? `Merge into ${status?.branch ?? 'HEAD'}.`
            : `Rebase ${status?.branch ?? 'HEAD'} onto the branch.`}
        </p>
        {#if atRiskFiles.length > 0}
          <div>
            <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
              Affected files
            </p>
            <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
              {#each atRiskFiles as path (path)}
                <div
                  class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0"
                >
                  <FileTypeIcon {path} size={12} class="shrink-0" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted"
                    >{path}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <p class="rounded-lg border border-border bg-surface px-3 py-1.5 text-[0.625rem] text-muted">
            No local changes — should apply cleanly.
          </p>
        {/if}
        {#if agentTurnActive}
          <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p class="text-[0.625rem] font-semibold text-warning">Agent turn in progress</p>
            <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
              Acknowledge to continue anyway.
            </p>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <span class="text-[0.625rem] text-muted">I understand the risk</span>
              <Switch
                checked={acknowledgeActiveTurn}
                onchange={(value) => (acknowledgeActiveTurn = value)}
                aria-label="Acknowledge risk"
              />
            </div>
          </div>
        {/if}
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (pendingOperation = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-8 items-center rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={integrateBusy || (agentTurnActive && !acknowledgeActiveTurn)}
            onclick={() => void confirmPendingOperation()}
          >
            {#if gitState.isBusy('merge') || gitState.isBusy('rebase')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            {operation.kind === 'merge' ? 'Merge' : 'Rebase'}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if resetConfirm}
    {@const pendingReset = resetConfirm}
    <Modal open title="Reset branch" onClose={() => (resetConfirm = null)}>
      <div class="space-y-3">
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          Reset <span class="font-mono text-foreground">{status?.branch ?? 'HEAD'}</span> to commit
          <span class="font-mono text-foreground"> {pendingReset.target.slice(0, 7)}</span>.
        </p>

        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Mode</p>
          <div class="grid grid-cols-3 gap-1.5">
            {#each resetOptions as option (option.mode)}
              <button
                type="button"
                class={[
                  'rounded-md border px-2 py-1.5 text-left transition-colors',
                  pendingReset.mode === option.mode
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border hover:bg-elevated'
                ]}
                onclick={() => (resetConfirm = { mode: option.mode, target: pendingReset.target })}
              >
                <span
                  class={[
                    'block text-[0.625rem] font-semibold',
                    pendingReset.mode === option.mode ? 'text-primary' : 'text-foreground'
                  ]}
                >
                  {option.label}
                </span>
                <span class="block text-[0.5rem] leading-snug text-dimmed">{option.hint}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if pendingReset.mode === 'hard'}
          <div class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
            <p class="text-[0.625rem] font-semibold text-danger">Hard reset discards changes</p>
            <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
              Staged and unstaged changes since this commit will be permanently lost. This cannot be
              undone.
            </p>
          </div>
        {/if}

        {#if atRiskFiles.length > 0}
          <div>
            <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
              Affected files
            </p>
            <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
              {#each atRiskFiles as path (path)}
                <div
                  class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0"
                >
                  <FileTypeIcon {path} size={12} class="shrink-0" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted"
                    >{path}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if agentTurnActive}
          <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p class="text-[0.625rem] font-semibold text-warning">Agent turn in progress</p>
            <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-muted">
              Acknowledge to continue anyway.
            </p>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <span class="text-[0.625rem] text-muted">I understand the risk</span>
              <Switch
                checked={acknowledgeActiveTurn}
                onchange={(value) => (acknowledgeActiveTurn = value)}
                aria-label="Acknowledge risk"
              />
            </div>
          </div>
        {/if}
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (resetConfirm = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class={[
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[0.6875rem] font-medium text-on-primary transition-colors disabled:opacity-50',
              pendingReset.mode === 'hard'
                ? 'bg-danger hover:bg-danger/90'
                : 'bg-primary hover:bg-primary-hover'
            ]}
            disabled={gitState.isBusy('reset') || (agentTurnActive && !acknowledgeActiveTurn)}
            onclick={() => void confirmReset()}
          >
            {#if gitState.isBusy('reset')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            {pendingReset.mode === 'hard' ? 'Reset hard' : 'Reset'}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if deleteCommitTarget}
    {@const deleteCommit = deleteCommitTarget}
    <AlertDialog.Root open onOpenChange={() => (deleteCommitTarget = null)}>
      <AlertDialog.Portal>
        <AlertDialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
        >
          <AlertDialog.Title class="text-sm font-semibold text-foreground">
            Delete commit?
          </AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
            Drop
            <strong class="font-medium text-foreground">
              “{deleteCommit.message.split('\n')[0]}”
            </strong>
            ({deleteCommit.shortHash}) from history. Commits after it are replayed and get new
            hashes, so this is safest for commits that have not been pushed yet. This cannot be
            undone.
          </AlertDialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
              disabled={gitState.isBusy('delete-commit')}
              onclick={() => void confirmDeleteCommit()}
            >
              {#if gitState.isBusy('delete-commit')}
                <Loader2 size={12} class="animate-spin" />
              {/if}
              Delete commit
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}

  {#if checkoutConfirm}
    {@const target = checkoutConfirm}
    <AlertDialog.Root open onOpenChange={() => (checkoutConfirm = null)}>
      <AlertDialog.Portal>
        <AlertDialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            checkoutConfirmButton?.focus()
          }}
        >
          <AlertDialog.Title class="text-sm font-semibold text-foreground">
            {target.kind === 'local'
              ? `Check out “${target.name}”?`
              : `Create local branch “${target.name}”?`}
          </AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
            {#if target.kind === 'local'}
              This switches the working tree to <strong class="font-medium text-foreground"
                >{target.name}</strong
              >. Any uncommitted changes come with you if they don't conflict.
            {:else}
              This creates and checks out <strong class="font-medium text-foreground"
                >{target.name}</strong
              >
              as a local branch that tracks
              <strong class="font-medium text-foreground">{target.ref}</strong>.
            {/if}
          </AlertDialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              bind:ref={checkoutConfirmButton}
              class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={gitState.isBusy('checkout')}
              onclick={() => void confirmCheckoutBranch()}
            >
              {#if gitState.isBusy('checkout')}
                <Loader2 size={12} class="animate-spin" />
              {/if}
              {target.kind === 'local' ? 'Check out' : 'Create and check out'}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}

  {#if deleteBranchConfirm}
    {@const target = deleteBranchConfirm}
    <AlertDialog.Root open onOpenChange={() => (deleteBranchConfirm = null)}>
      <AlertDialog.Portal>
        <AlertDialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
        >
          <AlertDialog.Title class="text-sm font-semibold text-foreground">
            Delete branch “{target}”?
          </AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
            Branch <strong class="font-medium text-foreground">{target}</strong> will be permanently deleted.
            This cannot be undone.
          </AlertDialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
              disabled={gitState.isBusy('checkout')}
              onclick={() => void confirmDeleteBranch()}
            >
              {#if gitState.isBusy('checkout')}
                <Loader2 size={12} class="animate-spin" />
              {/if}
              Delete branch
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}

  {#if forceDeleteBranchConfirm}
    {@const target = forceDeleteBranchConfirm}
    <AlertDialog.Root open onOpenChange={() => (forceDeleteBranchConfirm = null)}>
      <AlertDialog.Portal>
        <AlertDialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
        >
          <AlertDialog.Title class="text-sm font-semibold text-foreground">
            Force delete branch “{target}”?
          </AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
            Branch <strong class="font-medium text-foreground">{target}</strong> is not fully merged.
            Are you sure you want to delete it? Unmerged commits may become unreachable.
          </AlertDialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
              disabled={gitState.isBusy('checkout')}
              onclick={() => void confirmForceDeleteBranch()}
            >
              {#if gitState.isBusy('checkout')}
                <Loader2 size={12} class="animate-spin" />
              {/if}
              Delete branch
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}

  <!-- Add / Replace Git Origin -->
  {#if originModalOpen}
    <Modal
      open
      title={originMode === 'replace' ? 'Replace Git Origin' : 'Add Git Origin'}
      onClose={closeOriginModal}
    >
      <div class="space-y-3">
        <p class="text-[0.6875rem] leading-relaxed text-muted">
          {#if originMode === 'replace'}
            Update the URL of the <span class="font-mono text-foreground">{originName}</span> remote.
            This is the address the repository fetches from and pushes to.
          {:else}
            Add the <span class="font-mono text-foreground">{originName}</span> remote so you can pull
            from and push to a hosted repository.
          {/if}
        </p>
        <div>
          <p class="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
            Remote URL
          </p>
          <input
            class="w-full rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
            placeholder="https://github.com/your-name/repo.git"
            bind:value={originUrl}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !originBusy) requestSetOrigin()
            }}
          />
        </div>
        {#if gitState.error}
          <p class="text-[0.625rem] leading-relaxed text-danger">{gitState.error}</p>
        {/if}
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
            disabled={originBusy}
            onclick={closeOriginModal}
          >
            Cancel
          </button>
          <button
            type="button"
            data-modal-primary
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={originBusy || !originUrl.trim()}
            onclick={requestSetOrigin}
          >
            {#if originBusy}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            {originMode === 'replace' ? 'Replace Origin' : 'Add Origin'}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if originReplaceConfirm}
    <AlertDialog.Root open onOpenChange={() => (originReplaceConfirm = false)}>
      <AlertDialog.Portal>
        <AlertDialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-danger/30 bg-surface p-5 shadow-xl"
        >
          <AlertDialog.Title class="text-sm font-semibold text-foreground">
            Replace {originName}?
          </AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
            Changing the <span class="font-mono text-foreground">{originName}</span> remote URL
            permanently redirects future <strong class="font-medium text-foreground">pull</strong>
            and <strong class="font-medium text-foreground">push</strong> operations to the new address.
            Your local history is preserved, but the current remote target is replaced. This cannot be
            undone automatically — make sure this is the repository you want to use.
          </AlertDialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </AlertDialog.Cancel>
            <AlertDialog.Action
              class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
              disabled={originBusy}
              onclick={() => void runSetOrigin()}
            >
              {#if originBusy}
                <Loader2 size={12} class="animate-spin" />
              {/if}
              Replace {originName}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  {/if}
</div>

{#if stashDropTarget}
  {@const dropTarget = stashDropTarget}
  <AlertDialog.Root open onOpenChange={() => (stashDropTarget = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Discard stash?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          Stash
          <strong class="font-medium text-foreground">
            “{dropTarget.message}”
          </strong>
          ({dropTarget.id}) will be permanently discarded. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={() => void confirmStashDrop()}
          >
            Discard
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if discardConfirm}
  <AlertDialog.Root open onOpenChange={() => (discardConfirm = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Discard changes?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          Changes to
          {discardConfirm.length}
          {discardConfirm.length === 1 ? 'file' : 'files'} will be permanently discarded. This cannot
          be undone.
        </AlertDialog.Description>
        {#if discardConfirm.length > 4}
          <div
            class="mt-3 max-h-24 overflow-auto rounded-lg border border-border bg-elevated/50 p-2"
          >
            {#each discardConfirm as path (path)}
              <p class="truncate font-mono text-[0.5625rem] text-dimmed">{path}</p>
            {/each}
          </div>
        {/if}
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={() => void confirmDiscard()}
          >
            Discard changes
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if restoreWorktreeConfirm}
  <AlertDialog.Root open onOpenChange={() => (restoreWorktreeConfirm = null)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Restore {restoreWorktreeConfirm.path}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          The file on disk will be overwritten with its content from this history entry. Any
          uncommitted local edits to it are lost. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
            onclick={() => void confirmRestoreWorktree()}
          >
            Restore file
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}

{#if abortConfirmOpen}
  <AlertDialog.Root open onOpenChange={() => (abortConfirmOpen = false)}>
    <AlertDialog.Portal>
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Abort {conflictState === 'merge' ? 'merge' : 'rebase'}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          This cancels the in-progress
          <strong class="font-medium text-foreground">{conflictState}</strong> operation and restores
          the working tree to how it was before it started. Any partially resolved files will be lost.
          This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            disabled={gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
            onclick={() => void confirmAbortConflict()}
          >
            {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
              <Loader2 size={12} class="animate-spin" />
            {/if}
            Abort {conflictState === 'merge' ? 'merge' : 'rebase'}
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
{/if}
