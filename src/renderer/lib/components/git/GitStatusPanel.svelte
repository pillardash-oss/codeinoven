<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { cachedHasDeployments, cacheHasDeployments } from '$lib/git-deployments-cache'
  import type {
    GitCommitInfo,
    GitDiff,
    GitFileChange,
    GitHubUser,
    GitResetMode,
    GitStashEntry
  } from '$shared/types'
  import {
    Archive,
    ArrowLeft,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    FileDiff,
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
    RefreshCw,
    RotateCcwClock,
    Trash2,
    Unplug
  } from '@lucide/svelte'
  import { AlertDialog, ContextMenu, DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import BranchPicker from './BranchPicker.svelte'
  import CommitActionsMenu from './CommitActionsMenu.svelte'
  import GitHubAccountMenu from './GitHubAccountMenu.svelte'
  import GitChangesTree from './GitChangesTree.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import GitHubSignInModal from './GitHubSignInModal.svelte'
  import GitPullRequestSheet from './GitPullRequestSheet.svelte'
  import GitPullRequestList from './GitPullRequestList.svelte'
  import GitPullRequestDetail from './GitPullRequestDetail.svelte'
  import GitDeploymentsMonitor from './GitDeploymentsMonitor.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import type { PullRequestSummary } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'
  type TabId = 'changes' | 'history' | 'branches' | 'pulls' | 'deployments' | 'stashes'

  let repoState = $state<RepoState>('loading')
  let preflightDetail = $state('')
  let diffs = $state<Record<string, GitDiff>>({})
  let expanded = $state<Record<string, boolean>>({})
  let loadingDiff = $state<Record<string, boolean>>({})
  let diffErrors = $state<Record<string, string | null>>({})
  let showPullRequestSheet = $state(false)
  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')
  let pushConfirm = $state(false)
  let showIntegrateModal = $state(false)
  let showStashModal = $state(false)
  let stashMessage = $state('')
  let stashPaths = $state<string[] | null>(null)
  let stashDropTarget = $state<GitStashEntry | null>(null)
  let mergeTarget = $state('')
  let pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)
  let acknowledgeActiveTurn = $state(false)
  let agentTurnActive = $state(false)
  let activeTab = $state<TabId>('changes')
  let changesView = $state<'list' | 'tree'>('list')
  let selectedPaths = $state<Record<string, boolean>>({})
  let discardConfirm = $state<string[] | null>(null)
  let commitSelection = $state(false)
  let commitTextarea = $state<HTMLTextAreaElement | null>(null)
  let commitHistory = $state<GitCommitInfo[]>([])
  let loadingHistory = $state(false)
  let commitMessage = $state('')
  let selectedCommit = $state<GitCommitInfo | null>(null)
  let commitDiffChanges = $state<GitFileChange[]>([])
  let deleteCommitTarget = $state<GitCommitInfo | null>(null)
  let showGitHubSignIn = $state(false)
  let selectedPullRequest = $state<PullRequestSummary | null>(null)
  let githubConnected = $state(false)
  let githubConfigured = $state(false)
  let githubUser = $state<GitHubUser | null>(null)
  /** Whether the repo is known to have GitHub deployments — gates the Deployments tab. */
  let hasDeployments = $state(false)
  /** Re-entrancy guard for the background deployment probe (not rendered). */
  let detectingDeployments = false
  let loadingCommitDiff = $state(false)
  let commitDiffs = $state<Record<string, GitDiff>>({})
  let commitExpanded = $state<Record<string, boolean>>({})
  let loadingCommitDiffFile = $state<Record<string, boolean>>({})
  let commitDiffErrors = $state<Record<string, string | null>>({})
  let amendMode = $state(false)
  let resetConfirm = $state<{ mode: GitResetMode; target: string } | null>(null)
  let selectedStash = $state<GitStashEntry | null>(null)
  let loadingStashDiff = $state(false)
  let stashDiffChanges = $state<GitFileChange[]>([])
  let stashDiffs = $state<Record<string, GitDiff>>({})
  let stashExpanded = $state<Record<string, boolean>>({})
  let loadingStashDiffFile = $state<Record<string, boolean>>({})
  let stashDiffErrors = $state<Record<string, string | null>>({})

  const resetOptions: Array<{ mode: GitResetMode; label: string; hint: string }> = [
    { mode: 'soft', label: 'Soft', hint: 'keep index + worktree' },
    { mode: 'mixed', label: 'Mixed', hint: 'reset index, keep worktree' },
    { mode: 'hard', label: 'Hard', hint: 'discard all local changes' }
  ]

  const status = $derived(gitState.status)
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

  const busy = $derived(gitState.isBusy(['refresh', 'init', 'commit', 'amend', 'reset']))
  const commitBusy = $derived(gitState.isBusy(['commit', 'amend']))
  const batchBusy = $derived(
    gitState.isBusy(['stage', 'unstage', 'commit', 'stash', 'ignore', 'discard'])
  )
  const stashOpBusy = $derived(gitState.isBusy(['stash-pop', 'stash-drop']))

  async function refreshStatus(): Promise<void> {
    gitState.ensureProjectEvents(projectId)
    await gitState.refresh(projectId)
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

  async function checkoutBranch(branch: string): Promise<void> {
    if (!branch || branch === status?.branch) return
    await gitState.checkout(projectId, branch)
  }

  async function createBranchAction(name: string): Promise<void> {
    await gitState.createBranch(projectId, name)
  }

  async function deleteBranchAction(name: string): Promise<void> {
    await gitState.deleteBranch(projectId, name)
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
      providerId: 'opencode',
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
    commitHistory = await gitState.getLog(projectId, 30)
    loadingHistory = false
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
    loadingCommitDiff = false
  }

  const selectedCommitIndex = $derived.by(() => {
    const current = selectedCommit
    if (!current) return -1
    return commitHistory.findIndex((commit) => commit.hash === current.hash)
  })
  const canGoNewer = $derived(selectedCommitIndex > 0)
  const canGoOlder = $derived(
    selectedCommitIndex >= 0 && selectedCommitIndex < commitHistory.length - 1
  )

  function navigateCommit(direction: -1 | 1): void {
    const index = selectedCommitIndex
    const next = index + direction
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
      commitHistory = []
      void loadHistory()
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
      commitHistory = []
      void loadHistory()
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
      void refreshStatus()
      void reloadHistory()
    }
  }

  async function reloadHistory(): Promise<void> {
    commitHistory = []
    await loadHistory()
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
    // Claim this project before reading/writing shared state so a previous
    // project's data can never be shown or overwrite the current view.
    gitState.activate(projectId)
    // Fast-render: show/hide the Deployments tab from the cache immediately,
    // long before the authoritative value comes back from the database.
    hasDeployments = cachedHasDeployments(projectId) ?? false
    void loadRepoState()
  })

  $effect(() => {
    void refreshAgentTurnState()
  })

  $effect(() => {
    if (activeTab === 'history') void loadHistory()
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

  onMount(() => {
    gitState.ensureProjectEvents(projectId)
    const timer = setInterval(() => {
      if (repoState === 'git' && !gitState.isBusy(['refresh', 'stage', 'commit', 'push', 'pull'])) {
        void gitState.refresh(projectId)
      }
      void refreshAgentTurnState()
    }, 8_000)
    return () => clearInterval(timer)
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
    await gitState.push(projectId, false, remote.name)
  }

  async function confirmPushUpstream(): Promise<void> {
    pushConfirm = false
    if (!primaryRemote || !status?.branch) return
    await gitState.push(projectId, true, primaryRemote.name, status.branch)
  }

  const conflictState = $derived(gitState.conflictState)
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

  async function abortConflict(): Promise<void> {
    if (conflictState === 'merge') {
      await gitState.abortMerge(projectId)
    } else if (conflictState === 'rebase') {
      await gitState.abortRebase(projectId)
    }
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
    if (staged.length > 0) sections.push({ title: 'Staged', files: staged })
    if (unstaged.length > 0) sections.push({ title: 'Unstaged', files: unstaged })
    if (untracked.length > 0) sections.push({ title: 'Untracked', files: untracked })
    return sections
  })

  const stagedSections = $derived(fileSections.filter((section) => section.title === 'Staged'))
  const workingSections = $derived(fileSections.filter((section) => section.title !== 'Staged'))
  /** When both panes exist they split 50/50; a lone pane fills the whole height. */
  const splitPanes = $derived(stagedSections.length > 0 && workingSections.length > 0)
  const paneClass = $derived(
    splitPanes ? 'min-h-0 max-h-[50%] overflow-y-auto' : 'min-h-0 flex-1 overflow-y-auto'
  )
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
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
          onSelect={(branch) => void checkoutBranch(branch)}
          onCreate={(name) => void createBranchAction(name)}
          onDelete={(name) => void deleteBranchAction(name)}
        />
      {:else}
        <div class="flex items-center gap-1.5 px-2">
          <GitBranch size={12} class="shrink-0 text-muted" />
          <span class="font-mono text-[11px] font-medium text-foreground">
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
                class="rounded bg-success/10 px-1 py-0.5 font-mono text-[9px] tabular-nums text-success"
              >
                ↑{status.ahead}
              </span>
            {/if}
            {#if status.behind > 0}
              <span
                class="rounded bg-danger/10 px-1 py-0.5 font-mono text-[9px] tabular-nums text-danger"
              >
                ↓{status.behind}
              </span>
            {/if}
          </span>
        {/if}
        <span
          class={[
            'shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide',
            status.clean ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
          ]}
        >
          {status.clean ? 'Clean' : 'Dirty'}
        </span>
      {/if}
      <DiffLayoutToggle title={diffLayoutToggleLabel('vertical')} size={12} />
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
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => (showPullRequestSheet = true)}
              >
                <GitPullRequest size={12} class="shrink-0 text-dimmed" />
                Create pull request…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
                disabled={gitState.branches.length < 2}
                onSelect={() => (showIntegrateModal = true)}
              >
                <GitMerge size={12} class="shrink-0 text-dimmed" />
                Merge or rebase…
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
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
              'flex shrink-0 items-center gap-1.5 border-b-2 pb-1.5 pt-0.5 text-[11px] font-medium transition-colors',
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
                  'rounded-full px-1.5 text-[9px] font-semibold tabular-nums leading-[1.15rem]',
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
  <div class="min-h-0 flex-1 overflow-auto">
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
        <p class="mt-1 max-w-[28ch] text-[10px] leading-relaxed text-dimmed">
          Install Git for your operating system, then restart CodeInOven.
        </p>
        {#if preflightDetail}
          <p class="mt-2 max-w-[30ch] break-words font-mono text-[9px] text-dimmed">
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
        <p class="mt-1 max-w-[28ch] text-[10px] leading-relaxed text-dimmed">
          Initialize a repository to track changes and manage pull requests.
        </p>
        <button
          type="button"
          class="mt-3 flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
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
      {#if gitState.error}
        <div class="mx-2 mt-2">
          <p
            class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
          >
            {gitState.error}
          </p>
        </div>
      {/if}

      {#if identityNeeded}
        <div class="mx-2 mt-2 rounded-lg border border-border bg-surface px-3 py-2">
          <p class="text-[10px] font-medium text-foreground">Commit identity not configured</p>
          {#if showIdentityForm}
            <div class="mt-2 space-y-1.5">
              <input
                class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Name"
                bind:value={identityName}
              />
              <input
                class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Email"
                type="email"
                bind:value={identityEmail}
              />
              <div class="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated"
                  onclick={() => (showIdentityForm = false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
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
              class="mt-1.5 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
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
                <p class="truncate text-[11px] font-medium text-foreground">
                  {commit.message.split('\n')[0]}
                </p>
                <div class="flex items-center gap-1.5 text-[9px] text-dimmed">
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
                  class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                  disabled={gitState.isBusy('reset') || gitState.isBusy('amend')}
                  onclick={startAmend}
                >
                  Amend
                </button>
              {/if}
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
                <p class="mt-1 text-[10px] text-dimmed">This commit has no changes.</p>
              </div>
            {:else}
              <div class="overflow-hidden rounded-lg border border-border bg-surface">
                <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                  <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">
                    Changed files
                  </span>
                  <span class="text-[8px] tabular-nums text-dimmed">
                    {commitDiffChanges.length}
                  </span>
                </div>
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
                  />
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <div class="flex h-full min-h-0 flex-col">
            <!-- Conflicts -->
            {#if conflicted.length > 0}
              <div
                class="mb-2 shrink-0 overflow-hidden rounded-lg border border-warning/30 bg-warning/10"
              >
                <div class="flex items-center gap-2 px-3 py-2">
                  <p class="text-[10px] font-semibold text-warning">
                    {conflicted.length} conflicted {conflicted.length === 1 ? 'file' : 'files'}
                  </p>
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="shrink-0 rounded-md border border-warning/40 px-2 py-1 text-[10px] font-medium text-warning hover:bg-warning/10 disabled:opacity-40"
                    disabled={integrateBusy || conflictState === 'none'}
                    onclick={() => void abortConflict()}
                  >
                    {#if gitState.isBusy('abortMerge') || gitState.isBusy('abortRebase')}
                      Aborting…
                    {:else}
                      Abort {conflictState === 'merge' ? 'merge' : 'rebase'}
                    {/if}
                  </button>
                </div>
                <div class="border-t border-warning/20">
                  {#each conflicted as change (change.path)}
                    <div class="flex h-8 items-center gap-2 px-3">
                      <FileTypeIcon path={change.path} size={13} class="shrink-0" />
                      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                        {change.path}
                      </span>
                      <button
                        type="button"
                        class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
                        onclick={() => void openInEditor(change.path)}
                      >
                        Resolve
                      </button>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if status && changes.length === 0 && status.clean}
              <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
                <div
                  class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10"
                >
                  <Check size={18} class="text-success" />
                </div>
                <p class="text-xs font-medium text-muted">Working tree is clean</p>
                <p class="mt-1 max-w-[26ch] text-[10px] leading-relaxed text-dimmed">
                  No staged, unstaged, or untracked changes.
                </p>
              </div>
            {:else if status}
              <!-- Stable header: selection + actions + view toggle -->
              <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                {#if changes.length > 0 && selectedPathList.length > 0}
                  <span class="shrink-0 text-[10px] font-medium tabular-nums text-foreground">
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
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
                          disabled={batchBusy}
                          onSelect={() => void stageSelectedAction(false)}
                        >
                          <Check size={12} class="text-success" />
                          Stage
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
                          disabled={batchBusy}
                          onSelect={() => void stageSelectedAction(true)}
                        >
                          <span class="inline-block w-3 text-center text-[10px] text-danger">−</span
                          >
                          Unstage
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator class="my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
                          disabled={batchBusy}
                          onSelect={requestCommitSelected}
                        >
                          <GitCommit size={12} class="text-dimmed" />
                          Commit…
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
                          disabled={batchBusy}
                          onSelect={() => requestStashFor(selectedPathList)}
                        >
                          <Archive size={12} class="text-dimmed" />
                          Stash…
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
                          disabled={batchBusy}
                          onSelect={() => void ignoreSelectedAction()}
                        >
                          <span class="inline-block w-3 text-center text-[10px]">⊘</span>
                          Add to gitignore
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator class="my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
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
                        'flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium transition-colors',
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
                        'flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium transition-colors',
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

              <!-- Staged / working panes — a lone pane fills the height; both split 50/50 -->
              <div class="flex h-full min-h-0 flex-col gap-2 px-2 pb-2">
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
                          {@const sectionSomeSelected = section.files.some(
                            (f) => selectedPaths[f.path]
                          )}
                          <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                            <span
                              role="checkbox"
                              tabindex="0"
                              aria-checked={sectionAllSelected
                                ? 'true'
                                : sectionSomeSelected
                                  ? 'mixed'
                                  : 'false'}
                              aria-label={sectionAllSelected
                                ? `Deselect all ${section.files.length} files in ${section.title}`
                                : `Select all ${section.files.length} files in ${section.title}`}
                              class={[
                                'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors',
                                sectionAllSelected
                                  ? 'border-primary bg-primary'
                                  : 'border-border bg-elevated'
                              ]}
                              onclick={(event: MouseEvent) => {
                                event.stopPropagation()
                                event.preventDefault()
                                toggleSectionSelection(section.files)
                              }}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  toggleSectionSelection(section.files)
                                }
                              }}
                            >
                              {#if sectionAllSelected}
                                <Check size={9} class="text-on-primary" />
                              {:else if sectionSomeSelected}
                                <span class="h-0.5 w-1.5 rounded-full bg-primary"></span>
                              {/if}
                            </span>
                            <span
                              class="text-[9px] font-semibold uppercase tracking-wide text-muted"
                            >
                              {section.title}
                            </span>
                            <span class="text-[8px] tabular-nums text-dimmed">
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
                          {@const sectionSomeSelected = section.files.some(
                            (f) => selectedPaths[f.path]
                          )}
                          <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                            <span
                              role="checkbox"
                              tabindex="0"
                              aria-checked={sectionAllSelected
                                ? 'true'
                                : sectionSomeSelected
                                  ? 'mixed'
                                  : 'false'}
                              aria-label={sectionAllSelected
                                ? `Deselect all ${section.files.length} files in ${section.title}`
                                : `Select all ${section.files.length} files in ${section.title}`}
                              class={[
                                'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors',
                                sectionAllSelected
                                  ? 'border-primary bg-primary'
                                  : 'border-border bg-elevated'
                              ]}
                              onclick={(event: MouseEvent) => {
                                event.stopPropagation()
                                event.preventDefault()
                                toggleSectionSelection(section.files)
                              }}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  toggleSectionSelection(section.files)
                                }
                              }}
                            >
                              {#if sectionAllSelected}
                                <Check size={9} class="text-on-primary" />
                              {:else if sectionSomeSelected}
                                <span class="h-0.5 w-1.5 rounded-full bg-primary"></span>
                              {/if}
                            </span>
                            <span
                              class="text-[9px] font-semibold uppercase tracking-wide text-muted"
                            >
                              {section.title}
                            </span>
                            <span class="text-[8px] tabular-nums text-dimmed">
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
              <p class="mt-1 text-[10px] text-dimmed">Make your first commit to see history.</p>
            </div>
          {:else}
            <div class="space-y-0.5">
              {#each commitHistory as commit, index (commit.hash)}
                {@const isCurrentHead = index === 0}
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
                        <div class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40"></div>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-[11px] leading-snug text-foreground">
                            {commit.message.split('\n')[0]}
                          </p>
                          <div class="mt-0.5 flex items-center gap-1.5 text-[9px] text-dimmed">
                            <span class="font-mono">{commit.shortHash}</span>
                            <span>·</span>
                            <span>{commit.author}</span>
                            <span>·</span>
                            <span>{relativeTime(commit.date)}</span>
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
            </div>
          {/if}
        </div>
      {:else if activeTab === 'branches'}
        <div class="p-2">
          <div class="space-y-0.5">
            {#each gitState.branches as branch (branch.name)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated/50 disabled:opacity-60"
                disabled={branch.current}
                onclick={() => void checkoutBranch(branch.name)}
              >
                <GitBranch size={11} class="shrink-0 text-dimmed" />
                <span class="min-w-0 flex-1 truncate text-[11px] text-foreground">
                  {branch.name}
                </span>
                {#if branch.current}
                  <span
                    class="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[8px] font-semibold text-primary"
                  >
                    current
                  </span>
                {:else}
                  {#if branch.ahead > 0 || branch.behind > 0}
                    <span class="flex shrink-0 items-center gap-0.5 text-[9px] tabular-nums">
                      {#if branch.ahead > 0}
                        <span class="text-success">+{branch.ahead}</span>
                      {/if}
                      {#if branch.behind > 0}
                        <span class="text-danger">−{branch.behind}</span>
                      {/if}
                    </span>
                  {/if}
                {/if}
              </button>
            {/each}
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
            />
          {:else}
            <GitPullRequestList
              {projectId}
              identity={githubIdentity}
              {githubConnected}
              onOpen={(pr) => (selectedPullRequest = pr)}
              onSignIn={() => (showGitHubSignIn = true)}
            />
          {/if}
        </div>
      {:else if activeTab === 'deployments'}
        <GitDeploymentsMonitor
          {projectId}
          identity={githubIdentity}
          {githubConnected}
          onSignIn={() => (showGitHubSignIn = true)}
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
                  <p class="truncate text-[11px] font-medium text-foreground">{stash.message}</p>
                  <div class="flex items-center gap-1.5 text-[9px] text-dimmed">
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
                  <p class="mt-1 text-[10px] text-dimmed">This stash has no changes.</p>
                </div>
              {:else}
                <div class="overflow-hidden rounded-lg border border-border bg-surface">
                  <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                    <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">
                      Changed files
                    </span>
                    <span class="text-[8px] tabular-nums text-dimmed">
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
                      <span class="block truncate text-[11px] leading-snug text-foreground">
                        {stash.message}
                      </span>
                      <span class="mt-0.5 flex items-center gap-1.5 text-[9px] text-dimmed">
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
                    class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
            <p class="mt-2 px-1 text-[9px] leading-relaxed text-dimmed">
              Click a stash to inspect its changes. Popping restores it to your working tree and
              removes it from this list.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <!-- Pinned composer: only while looking at working changes -->
  {#if repoState === 'git' && status && !selectedCommit && activeTab === 'changes' && (changes.length > 0 || amendMode)}
    <div class="shrink-0 border-t border-border bg-surface">
      {#if amendMode}
        <div class="flex items-center gap-2 border-b border-border bg-warning/10 px-3 py-1.5">
          <GitCommit size={11} class="shrink-0 text-warning" />
          <p class="min-w-0 flex-1 text-[9px] leading-relaxed text-warning">
            Amending the most recent commit — no new commit will be created.
          </p>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-muted hover:bg-elevated"
            onclick={() => (amendMode = false)}
          >
            Cancel
          </button>
        </div>
      {/if}
      <div class="px-2 pt-2">
        <textarea
          bind:this={commitTextarea}
          class="min-h-11 w-full resize-none rounded-md border border-border bg-elevated px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder={amendMode ? 'Amended commit message…' : 'Commit message…'}
          bind:value={commitMessage}></textarea>
      </div>
      <div class="flex items-center gap-1.5 px-2 py-2">
        <button
          type="button"
          class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          disabled={gitState.isBusy('stage') || unstaged.length + untracked.length === 0}
          onclick={() => void stageAll()}
        >
          Stage all
        </button>
        {#if !amendMode}
          <button
            type="button"
            class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Amend the most recent commit instead of creating a new one"
            aria-label="Amend the most recent commit instead of creating a new one"
            onclick={() => (amendMode = true)}
          >
            Amend
          </button>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-40"
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
      <p class="text-[10px] font-medium text-foreground">Push with upstream?</p>
      <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
        Set <span class="font-mono text-foreground">{primaryRemote?.name}/{status?.branch}</span> as upstream.
      </p>
      <div class="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated"
          onclick={() => (pushConfirm = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={syncBusy}
          onclick={() => void confirmPushUpstream()}
        >
          Push
        </button>
      </div>
    </div>
  {/if}

  <!--
    Fetch/pull/push act on the local working tree, so they only belong to the
    working-tree tabs. On the pull request tab they sat under a PR's own
    comment box implying they were part of reviewing it, which they are not.
  -->
  {#if repoState === 'git' && status && remotes.length > 0 && activeTab !== 'pulls'}
    <div class="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Fetch refs from the remote without changing the working tree"
        disabled={remotes.length === 0 || syncBusy}
        onclick={() => void gitState.fetch(projectId)}
      >
        {#if gitState.isBusy('fetch')}
          <Loader2 size={10} class="animate-spin" />
        {/if}
        Fetch
      </button>
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title={status.behind > 0
          ? `Pull ${String(status.behind)} commit(s) from the remote`
          : 'Pull from the remote'}
        disabled={remotes.length === 0 || syncBusy}
        onclick={() => void gitState.pull(projectId)}
      >
        {#if gitState.isBusy('pull')}
          <Loader2 size={10} class="animate-spin" />
        {/if}
        Pull{status.behind > 0 ? ` ${status.behind}` : ''}
      </button>
      <button
        type="button"
        class="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title={status.ahead > 0
          ? `Push ${String(status.ahead)} commit(s) to the remote`
          : 'Push to the remote'}
        disabled={remotes.length === 0 || syncBusy || gitState.isBusy('push')}
        onclick={() => void pushAction()}
      >
        {#if gitState.isBusy('push')}
          <Loader2 size={10} class="animate-spin" />
        {/if}
        Push{status.ahead > 0 ? ` ${status.ahead}` : ''}
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

  {#if showPullRequestSheet}
    <GitPullRequestSheet {projectId} onClose={() => (showPullRequestSheet = false)} />
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
            <p class="text-[10px] font-medium text-foreground">
              {stashPaths.length}
              {stashPaths.length === 1 ? 'file' : 'files'} to stash
            </p>
            <div class="mt-1 max-h-24 overflow-auto">
              {#each stashPaths as path (path)}
                <p class="truncate font-mono text-[9px] text-dimmed">{path}</p>
              {/each}
            </div>
          </div>
        {:else}
          <p class="text-[11px] leading-relaxed text-muted">
            Shelves your staged and unstaged changes so you can switch work. Restore them any time
            from the Stashes tab.
          </p>
        {/if}
        <input
          class="h-8 w-full rounded-md border border-border bg-elevated px-2.5 text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Describe this stash (optional)"
          bind:value={stashMessage}
        />
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => {
              showStashModal = false
              stashPaths = null
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
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
          class="block text-[10px] font-semibold uppercase tracking-wide text-muted"
          for="integrate-target"
        >
          Bring changes into {status?.branch ?? 'HEAD'} from
        </label>
        <select
          id="integrate-target"
          class="h-8 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
          bind:value={mergeTarget}
        >
          <option value="" disabled>Select a branch…</option>
          {#each gitState.branches as branch (branch.name)}
            {#if branch.name !== status?.branch}
              <option value={branch.name}>{branch.name}</option>
            {/if}
          {/each}
        </select>
        <p class="text-[10px] leading-relaxed text-dimmed">
          Merge keeps both histories and adds a merge commit. Rebase replays your commits on top of
          the selected branch for a straight history.
        </p>
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (showIntegrateModal = false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-8 rounded-lg border border-border px-3 text-[11px] font-medium text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
            disabled={!mergeTarget || integrateBusy}
            onclick={() => requestMergeOrRebase('rebase')}
          >
            Rebase
          </button>
          <button
            type="button"
            class="h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
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
        <p class="text-[11px] leading-relaxed text-muted">
          {operation.kind === 'merge'
            ? `Merge into ${status?.branch ?? 'HEAD'}.`
            : `Rebase ${status?.branch ?? 'HEAD'} onto the branch.`}
        </p>
        {#if atRiskFiles.length > 0}
          <div>
            <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Affected files
            </p>
            <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
              {#each atRiskFiles as path (path)}
                <div
                  class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0"
                >
                  <FileTypeIcon {path} size={12} class="shrink-0" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted"
                    >{path}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <p class="rounded-lg border border-border bg-surface px-3 py-1.5 text-[10px] text-muted">
            No local changes — should apply cleanly.
          </p>
        {/if}
        {#if agentTurnActive}
          <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p class="text-[10px] font-semibold text-warning">Agent turn in progress</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
              Acknowledge to continue anyway.
            </p>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <span class="text-[10px] text-muted">I understand the risk</span>
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
            class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (pendingOperation = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-8 items-center rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
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
        <p class="text-[11px] leading-relaxed text-muted">
          Reset <span class="font-mono text-foreground">{status?.branch ?? 'HEAD'}</span> to commit
          <span class="font-mono text-foreground"> {pendingReset.target.slice(0, 7)}</span>.
        </p>

        <div>
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Mode</p>
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
                    'block text-[10px] font-semibold',
                    pendingReset.mode === option.mode ? 'text-primary' : 'text-foreground'
                  ]}
                >
                  {option.label}
                </span>
                <span class="block text-[8px] leading-snug text-dimmed">{option.hint}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if pendingReset.mode === 'hard'}
          <div class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
            <p class="text-[10px] font-semibold text-danger">Hard reset discards changes</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
              Staged and unstaged changes since this commit will be permanently lost. This cannot be
              undone.
            </p>
          </div>
        {/if}

        {#if atRiskFiles.length > 0}
          <div>
            <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Affected files
            </p>
            <div class="max-h-40 overflow-auto rounded-lg border border-border bg-surface">
              {#each atRiskFiles as path (path)}
                <div
                  class="flex h-7 items-center gap-2 border-b border-border px-3 last:border-b-0"
                >
                  <FileTypeIcon {path} size={12} class="shrink-0" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted"
                    >{path}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if agentTurnActive}
          <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p class="text-[10px] font-semibold text-warning">Agent turn in progress</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
              Acknowledge to continue anyway.
            </p>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <span class="text-[10px] text-muted">I understand the risk</span>
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
            class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
            onclick={() => (resetConfirm = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class={[
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-on-primary transition-colors disabled:opacity-50',
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
              <p class="truncate font-mono text-[9px] text-dimmed">{path}</p>
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
