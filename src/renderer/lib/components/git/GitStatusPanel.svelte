<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { gitState } from '$lib/stores/git.svelte'
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
    FileDiff,
    GitBranch,
    GitCommit,
    GitFork,
    GitMerge,
    GitPullRequest,
    History,
    Loader2,
    MoreHorizontal,
    NetworkIcon,
    RefreshCw,
    RotateCcwClock,
    Trash2,
    Unplug
  } from '@lucide/svelte'
  import { AlertDialog, DropdownMenu } from 'bits-ui'
  import { onMount } from 'svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import BranchPicker from './BranchPicker.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import GitHubSignInModal from './GitHubSignInModal.svelte'
  import GitPullRequestSheet from './GitPullRequestSheet.svelte'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'
  type TabId = 'changes' | 'history' | 'branches' | 'stashes'

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
  let stashDropTarget = $state<GitStashEntry | null>(null)
  let mergeTarget = $state('')
  let pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)
  let acknowledgeActiveTurn = $state(false)
  let agentTurnActive = $state(false)
  let activeTab = $state<TabId>('changes')
  let commitHistory = $state<GitCommitInfo[]>([])
  let loadingHistory = $state(false)
  let commitMessage = $state('')
  let selectedCommit = $state<GitCommitInfo | null>(null)
  let commitDiffChanges = $state<GitFileChange[]>([])
  let showGitHubSignIn = $state(false)
  let githubConnected = $state(false)
  let githubConfigured = $state(false)
  let githubUser = $state<GitHubUser | null>(null)
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

  async function refreshStatus(): Promise<void> {
    gitState.ensureProjectEvents(projectId)
    await gitState.refresh(projectId)
  }

  async function loadRepoState(): Promise<void> {
    repoState = 'loading'
    try {
      const project = await invoke('project:get', projectId)
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
    await invoke('projectFiles:openInEditor', projectId, path)
  }

  async function stashChanges(): Promise<void> {
    await gitState.stash(projectId, stashMessage.trim() || undefined)
    if (!gitState.error) {
      stashMessage = ''
      showStashModal = false
      activeTab = 'stashes'
      void refreshStatus()
    }
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
        { id: 'branches', label: 'Branches', icon: NetworkIcon, count: null }
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
      return list
    })

  const fileSections: Array<{ title: string; files: GitFileChange[] }> = $derived.by(() => {
    const sections: Array<{ title: string; files: GitFileChange[] }> = []
    if (staged.length > 0) sections.push({ title: 'Staged', files: staged })
    if (unstaged.length > 0) sections.push({ title: 'Unstaged', files: unstaged })
    if (untracked.length > 0) sections.push({ title: 'Untracked', files: untracked })
    return sections
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <!-- Header: branch picker + tabs + actions -->
  <div class="flex shrink-0 flex-col border-b border-border">
    <!-- Top row: branch + tabs + actions -->
    <div class="flex h-9 items-center gap-1 px-2">
      {#if repoState === 'git' && gitState.branches.length > 0}
        <BranchPicker
          branches={gitState.branches}
          currentBranch={status?.branch ?? null}
          isBusy={gitState.isBusy('checkout')}
          {primaryRemote}
          github={{ connected: githubConnected, configured: githubConfigured, user: githubUser }}
          onSelect={(branch) => void checkoutBranch(branch)}
          onCreate={(name) => void createBranchAction(name)}
          onDelete={(name) => void deleteBranchAction(name)}
          onSignIn={() => (showGitHubSignIn = true)}
          onSignOut={() => void signOutGitHub()}
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
      <!-- Tab row -->
      <div class="flex items-center gap-4 px-3">
        {#each tabs as tab (tab.id)}
          {@const TabIcon = tab.icon}
          <button
            type="button"
            class={[
              'flex items-center gap-1.5 border-b-2 pb-1.5 pt-0.5 text-[11px] font-medium transition-colors',
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
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                title="Back to working changes"
                aria-label="Back to working changes"
                onclick={clearSelectedCommit}
              >
                <ArrowLeft size={12} />
              </button>
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
                <button
                  type="button"
                  class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                  disabled={gitState.isBusy('reset') || gitState.isBusy('amend')}
                  onclick={() => requestReset('soft', commit.hash)}
                >
                  Reset
                </button>
              {/if}
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
          <div class="p-2">
            <!-- Conflicts -->
            {#if conflicted.length > 0}
              <div class="mb-2 overflow-hidden rounded-lg border border-warning/30 bg-warning/10">
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

            <!-- File list -->
            {#if status && changes.length === 0 && status.clean}
              <div class="flex flex-col items-center justify-center py-12 text-center">
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
              {#if fileSections.length > 0}
                <div class="mb-2 overflow-hidden rounded-lg border border-border bg-surface">
                  {#each fileSections as section, si (section.title)}
                    {#if si > 0}<div class="border-t border-border"></div>{/if}
                    <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
                      <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">
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
                        onToggleDiff={() => void toggleDiff(change)}
                        onToggleStage={() => void toggleStage(change)}
                      />
                    {/each}
                  {/each}
                </div>
              {/if}
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
              {#each commitHistory as commit (commit.hash)}
                <button
                  type="button"
                  class="group w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated/50"
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
                    disabled={gitState.isBusy(['stash-pop', 'stash-drop'])}
                    title="Restore stash {stash.id} into the working tree"
                    onclick={() => void popStash(stash.id)}
                  >
                    {gitState.isBusy('stash-pop') ? 'Popping…' : 'Pop'}
                  </button>
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                    disabled={gitState.isBusy(['stash-pop', 'stash-drop'])}
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
          disabled={!commitMessage.trim() ||
            gitState.isBusy(['commit', 'amend']) ||
            (!amendMode && staged.length === 0)}
          onclick={() => void commitInline()}
        >
          {#if gitState.isBusy(['commit', 'amend'])}
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

  {#if repoState === 'git' && status && remotes.length > 0}
    <div class="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5">
      <button
        type="button"
        class="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
        class="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
        class="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
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
    <Modal open title="Stash changes" onClose={() => (showStashModal = false)}>
      <div class="space-y-2">
        <p class="text-[11px] leading-relaxed text-muted">
          Shelves your staged and unstaged changes so you can switch work. Restore them any time
          from the Stashes tab.
        </p>
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
            onclick={() => (showStashModal = false)}
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
            Stash changes
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
