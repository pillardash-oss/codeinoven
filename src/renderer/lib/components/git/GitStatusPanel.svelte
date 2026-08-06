<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitDiff, GitFileChange } from '$shared/types'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import GitCommitSheet from './GitCommitSheet.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import GitPullRequestSheet from './GitPullRequestSheet.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import {
    Check,
    ChevronDown,
    ChevronRight,
    GitBranch,
    GitCommit,
    GitFork,
    GitPullRequest,
    Loader2,
    RefreshCw,
    Unplug
  } from '@lucide/svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'

  let repoState = $state<RepoState>('loading')
  let preflightDetail = $state('')
  let diffs = $state<Record<string, GitDiff>>({})
  let expanded = $state<Record<string, boolean>>({})
  let loadingDiff = $state<Record<string, boolean>>({})
  let diffErrors = $state<Record<string, string | null>>({})
  let showCommitSheet = $state(false)
  let showPullRequestSheet = $state(false)
  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')
  let showSync = $state(true)
  let showRemoteForm = $state(false)
  let remoteName = $state('')
  let remoteUrl = $state('')
  let showCredentialForm = $state(false)
  let tokenValue = $state('')
  let pushConfirm = $state(false)
  let showIntegrate = $state(true)
  let mergeTarget = $state('')
  let pendingOperation = $state<{ kind: 'merge' | 'rebase'; target: string } | null>(null)
  let acknowledgeActiveTurn = $state(false)
  let agentTurnActive = $state(false)

  const status = $derived(gitState.status)
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

  const busy = $derived(gitState.isBusy(['refresh', 'init', 'commit']))

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

  /** Key a file's diff cache by path AND staged-ness so an "MM" file can show
   *  both its staged snapshot and its further unstaged changes independently. */
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
    // Never stage unresolved conflict files — `git add` on a conflicted path
    // marks it resolved and commits the conflict markers as-is.
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

  async function saveIdentity(): Promise<void> {
    await gitState.setIdentity(projectId, identityName, identityEmail)
    if (!gitState.error) showIdentityForm = false
  }

  async function refreshAgentTurnState(): Promise<void> {
    if (!threadId) return
    const thread = await invoke('thread:get', projectId, threadId).catch(() => null)
    agentTurnActive = thread?.status === 'executing' || thread?.status === 'planning'
  }

  $effect(() => {
    void loadRepoState()
  })

  $effect(() => {
    void refreshAgentTurnState()
  })

  onMount(() => {
    gitState.ensureProjectEvents(projectId)
    // Lightweight periodic status poll while the panel is open so commits made
    // outside the app (terminal, IDE) surface within seconds without a raw
    // `.git` watcher. Also keeps the active-agent-turn gate current so a
    // destructive op started mid-turn still warns. Never runs when the tab is
    // hidden.
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
  const credentialConfigured = $derived(gitState.credentialStatus?.configured ?? false)
  const secureStorageAvailable = $derived(gitState.credentialStatus?.secureStorageAvailable ?? true)
  const needsUpstreamPush = $derived(
    Boolean(status?.branch) && !status?.detached && status?.upstream === null
  )
  const syncBusy = $derived(gitState.isBusy(['fetch', 'pull', 'push']))

  async function addRemoteAction(): Promise<void> {
    await gitState.addRemote(projectId, remoteName.trim(), remoteUrl.trim())
    if (!gitState.error) {
      showRemoteForm = false
      remoteName = ''
      remoteUrl = ''
    }
  }

  async function setCredentialAction(): Promise<void> {
    await gitState.setCredential(projectId, tokenValue)
    if (!gitState.error) {
      showCredentialForm = false
      tokenValue = ''
    }
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
    await gitState.push(projectId, false, remote.name)
  }

  async function confirmPushUpstream(): Promise<void> {
    pushConfirm = false
    if (!primaryRemote || !status?.branch) return
    await gitState.push(projectId, true, primaryRemote.name, status.branch)
  }

  async function removeRemoteAction(name: string): Promise<void> {
    await gitState.removeRemote(projectId, name)
  }

  const conflictState = $derived(gitState.conflictState)
  const integrateBusy = $derived(
    gitState.isBusy(['merge', 'rebase', 'stash', 'abortMerge', 'abortRebase'])
  )
  const atRiskFiles = $derived(changes.length > 0 ? changes.map((change) => change.path) : [])

  function requestMergeOrRebase(kind: 'merge' | 'rebase'): void {
    const target = mergeTarget.trim()
    if (!target) return
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
    await gitState.stash(projectId)
  }

  const fileSections: Array<{ title: string; files: GitFileChange[] }> = $derived.by(() => {
    const sections: Array<{ title: string; files: GitFileChange[] }> = []
    if (staged.length > 0) sections.push({ title: 'Staged', files: staged })
    if (unstaged.length > 0) sections.push({ title: 'Unstaged', files: unstaged })
    if (untracked.length > 0) sections.push({ title: 'Untracked', files: untracked })
    return sections
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
    <GitBranch size={13} class="shrink-0 text-muted" />
    <span class="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
      {status?.branch ?? (repoState === 'git' ? 'detached' : 'Repository')}
    </span>
    {#if repoState === 'git' && status}
      {#if status.ahead > 0 || status.behind > 0}
        <span class="flex shrink-0 items-center gap-1">
          {#if status.ahead > 0}
            <span
              class="rounded bg-success/10 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-success"
            >
              ↑{status.ahead}
            </span>
          {/if}
          {#if status.behind > 0}
            <span
              class="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-danger"
            >
              ↓{status.behind}
            </span>
          {/if}
        </span>
      {/if}
      <span
        class={[
          'shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
          status.clean ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
        ]}
      >
        {status.clean ? 'Clean' : 'Dirty'}
      </span>
    {/if}
    <span class="flex-1"></span>
    <DiffLayoutToggle title={diffLayoutToggleLabel('vertical')} size={13} />
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label="Refresh git status"
      title="Refresh git status"
      disabled={busy}
      onclick={() => void refreshStatus()}
    >
      <RefreshCw size={13} class={gitState.isBusy('refresh') ? 'animate-spin' : ''} />
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto p-2">
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
          Install Git for your operating system, then restart CodeInOven to manage repositories
          in-app.
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
        <p class="text-xs font-medium text-muted">This project is not a Git repository</p>
        <p class="mt-1 max-w-[28ch] text-[10px] leading-relaxed text-dimmed">
          Initialize a repository to track changes, commit, and open pull requests from the app.
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
        <p class="mt-3 max-w-[30ch] text-[9px] leading-relaxed text-dimmed">
          Next: add a <span class="font-mono text-muted">.gitignore</span>, then stage and commit
          your first changes from the Git panel.
        </p>
      </div>
    {:else}
      {#if gitState.error}
        <p
          class="mb-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
        >
          {gitState.error}
        </p>
      {/if}

      {#if gitState.branches.length > 0}
        <div
          class="mb-2 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5"
        >
          <GitBranch size={12} class="shrink-0 text-muted" />
          <select
            class="h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-border bg-elevated px-2 font-mono text-[10px] text-foreground outline-none transition-colors hover:border-primary/40 focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            value={status?.branch ?? ''}
            disabled={gitState.isBusy('checkout')}
            aria-label="Check out a branch"
            title="Check out a branch"
            onchange={(event: Event) =>
              void checkoutBranch((event.currentTarget as HTMLSelectElement).value)}
          >
            {#each gitState.branches as branch (branch.name)}
              <option value={branch.name}>{branch.name}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if identityNeeded}
        <div class="mb-2 rounded-lg border border-border bg-surface px-3 py-2">
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
                  Save identity
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
              title={conflictState === 'merge'
                ? 'Abort the current merge'
                : 'Abort the current rebase'}
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
                  title={`Open ${change.path} in your editor to resolve the conflict`}
                  onclick={() => void openInEditor(change.path)}
                >
                  Open in editor
                </button>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Integrate (merge, rebase, stash) -->
      <div class="mb-2 overflow-hidden rounded-lg border border-border bg-surface">
        <button
          type="button"
          class="flex h-8 w-full items-center gap-2 px-3 text-left"
          aria-expanded={showIntegrate}
          onclick={() => (showIntegrate = !showIntegrate)}
        >
          <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">Integrate</span
          >
          <span class="flex-1"></span>
          {#if showIntegrate}
            <ChevronDown size={12} class="text-dimmed" />
          {:else}
            <ChevronRight size={12} class="text-dimmed" />
          {/if}
        </button>
        {#if showIntegrate}
          <div class="border-t border-border px-3 py-2">
            <div class="flex items-center gap-1.5">
              <input
                class="h-7 min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Branch to merge / rebase onto"
                bind:value={mergeTarget}
              />
              <button
                type="button"
                class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={!mergeTarget.trim() || integrateBusy}
                title="Merge the target branch into the current branch"
                onclick={() => requestMergeOrRebase('merge')}
              >
                Merge
              </button>
              <button
                type="button"
                class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={!mergeTarget.trim() || integrateBusy}
                title="Rebase the current branch onto the target"
                onclick={() => requestMergeOrRebase('rebase')}
              >
                Rebase
              </button>
            </div>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <p class="text-[9px] leading-relaxed text-dimmed">
                Merge/rebase can overwrite local changes. You will confirm the affected files first.
              </p>
              <button
                type="button"
                class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={(status?.clean ?? true) || integrateBusy}
                title="Stash uncommitted changes"
                onclick={() => void stashChanges()}
              >
                {gitState.isBusy('stash') ? 'Stashing…' : 'Stash'}
              </button>
            </div>
          </div>
        {/if}
      </div>

      <!-- Sync (remotes, fetch/pull/push, credentials) -->
      <div class="mb-2 overflow-hidden rounded-lg border border-border bg-surface">
        <button
          type="button"
          class="flex h-8 w-full items-center gap-2 px-3 text-left"
          aria-expanded={showSync}
          onclick={() => (showSync = !showSync)}
        >
          <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">Sync</span>
          <span class="flex-1"></span>
          {#if status && status.upstream}
            <span class="font-mono text-[9px] text-dimmed">{status.upstream}</span>
          {/if}
          {#if showSync}
            <ChevronDown size={12} class="text-dimmed" />
          {:else}
            <ChevronRight size={12} class="text-dimmed" />
          {/if}
        </button>
        {#if showSync}
          <div class="border-t border-border px-3 py-2">
            {#if remotes.length === 0}
              <p class="mb-1.5 text-[9px] text-dimmed">No remotes configured.</p>
            {:else}
              <div class="mb-1.5 space-y-1">
                {#each remotes as remote (remote.name)}
                  <div class="flex items-center gap-2">
                    <span class="w-16 shrink-0 truncate font-mono text-[10px] text-muted">
                      {remote.name}
                    </span>
                    <span class="min-w-0 flex-1 truncate font-mono text-[9px] text-dimmed">
                      {remote.url}
                    </span>
                    <button
                      type="button"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-danger hover:bg-danger/10"
                      aria-label={`Remove remote ${remote.name}`}
                      title={`Remove remote ${remote.name}`}
                      onclick={() => void removeRemoteAction(remote.name)}
                    >
                      Remove
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
            {#if showRemoteForm}
              <div class="mb-1.5 space-y-1.5">
                <input
                  class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                  placeholder="Remote name (e.g. origin)"
                  bind:value={remoteName}
                />
                <input
                  class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                  placeholder="https://github.com/acme/app.git"
                  bind:value={remoteUrl}
                />
                <div class="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    class="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated"
                    onclick={() => (showRemoteForm = false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                    disabled={!remoteName.trim() || !remoteUrl.trim()}
                    onclick={() => void addRemoteAction()}
                  >
                    Add remote
                  </button>
                </div>
              </div>
            {:else}
              <button
                type="button"
                class="mb-1.5 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
                onclick={() => (showRemoteForm = true)}
              >
                Add remote
              </button>
            {/if}

            {#if pushConfirm}
              <div class="mb-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2">
                <p class="text-[10px] font-medium text-foreground">Push with upstream?</p>
                <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
                  This branch has no upstream. Push to
                  <span class="font-mono text-foreground">{primaryRemote?.name}</span> and set
                  <span class="font-mono text-foreground"
                    >{primaryRemote?.name}/{status?.branch}</span
                  >
                  as its upstream.
                </p>
                <div class="mt-1.5 flex items-center justify-end gap-1.5">
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
                    Push and set upstream
                  </button>
                </div>
              </div>
            {/if}

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={remotes.length === 0 || syncBusy}
                onclick={() => void gitState.fetch(projectId)}
              >
                {#if gitState.isBusy('fetch')}
                  <Loader2 size={10} class="animate-spin" />
                {/if}
                {gitState.isBusy('fetch') ? 'Fetching…' : 'Fetch'}
              </button>
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={remotes.length === 0 || syncBusy}
                onclick={() => void gitState.pull(projectId)}
              >
                {#if gitState.isBusy('pull')}
                  <Loader2 size={10} class="animate-spin" />
                {/if}
                {gitState.isBusy('pull') ? 'Pulling…' : 'Pull'}
              </button>
              <button
                type="button"
                class="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={remotes.length === 0 || syncBusy || gitState.isBusy('push')}
                onclick={() => void pushAction()}
              >
                {#if gitState.isBusy('push')}
                  <Loader2 size={10} class="animate-spin" />
                {/if}
                {gitState.isBusy('push') ? 'Pushing…' : 'Push'}
              </button>
            </div>

            <div class="mt-2 border-t border-border pt-2">
              <p class="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted">
                Credentials
              </p>
              {#if !secureStorageAvailable}
                <p class="mb-1.5 text-[9px] leading-relaxed text-warning">
                  Secure credential storage is unavailable on this device, so tokens cannot be
                  stored safely.
                </p>
              {/if}
              {#if credentialConfigured}
                <div class="flex items-center gap-2">
                  <span class="flex-1 text-[10px] text-success">Token stored (vaulted)</span>
                  <button
                    type="button"
                    class="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10"
                    onclick={() => void gitState.removeCredential(projectId)}
                  >
                    Remove
                  </button>
                </div>
              {:else if showCredentialForm}
                <div class="space-y-1.5">
                  <input
                    class="h-7 w-full rounded-md border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary disabled:opacity-50"
                    placeholder="GitHub personal access token"
                    type="password"
                    disabled={!secureStorageAvailable}
                    bind:value={tokenValue}
                  />
                  <div class="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated"
                      onclick={() => (showCredentialForm = false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                      disabled={!tokenValue.trim() || !secureStorageAvailable}
                      onclick={() => void setCredentialAction()}
                    >
                      Save token
                    </button>
                  </div>
                </div>
              {:else}
                <button
                  type="button"
                  class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
                  disabled={!secureStorageAvailable}
                  onclick={() => (showCredentialForm = true)}
                >
                  Add token
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      {#if status && changes.length === 0 && status.clean}
        <div class="flex h-full flex-col items-center justify-center px-6 text-center">
          <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
            <Check size={18} class="text-success" />
          </div>
          <p class="text-xs font-medium text-muted">Working tree is clean</p>
          <p class="mt-1 max-w-[26ch] text-[10px] leading-relaxed text-dimmed">
            No staged, unstaged, or untracked changes.
          </p>
        </div>
      {:else if status}
        {#each fileSections as section (section.title)}
          <p
            class="mb-1 flex items-center gap-1.5 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted"
          >
            {section.title}
            <span class="rounded bg-elevated px-1 py-0.5 text-[8px] tabular-nums text-dimmed">
              {section.files.length}
            </span>
          </p>
          <div class="mb-2 overflow-hidden rounded-lg border border-border bg-surface">
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
          </div>
        {/each}

        <div class="flex items-center gap-2 border-t border-border px-1 pt-2 pb-1">
          {#if changes.length > 0}
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
              disabled={gitState.isBusy('stage')}
              onclick={() => void stageAll()}
            >
              Stage all
            </button>
          {/if}
          <span class="flex-1"></span>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
            disabled={!status?.branch || gitState.isBusy('pr-create')}
            title="Create or merge a pull request"
            onclick={() => (showPullRequestSheet = true)}
          >
            <GitPullRequest size={12} />
            Pull request
          </button>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-40"
            disabled={staged.length === 0 || gitState.isBusy('commit')}
            onclick={() => (showCommitSheet = true)}
          >
            <GitCommit size={12} />
            Commit {staged.length > 0 ? `(${staged.length})` : ''}
          </button>
        </div>
      {/if}
    {/if}
  </div>

  {#if showPullRequestSheet}
    <GitPullRequestSheet {projectId} onClose={() => (showPullRequestSheet = false)} />
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
            ? `Merge the branch into the current branch (${status?.branch ?? 'HEAD'}).`
            : `Rebase the current branch (${status?.branch ?? 'HEAD'}) onto the branch.`}
        </p>
        {#if atRiskFiles.length > 0}
          <div>
            <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Local changes that may be affected
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
            No uncommitted local changes — this operation should apply cleanly.
          </p>
        {/if}
        {#if agentTurnActive}
          <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p class="text-[10px] font-semibold text-warning">Agent turn in progress</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
              An agent is actively working in this project. Running a destructive git operation now
              can interfere with its checkpoint snapshots. Acknowledge to continue anyway.
            </p>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <span class="text-[10px] text-muted">I understand the risk</span>
              <Switch
                checked={acknowledgeActiveTurn}
                onchange={(value) => (acknowledgeActiveTurn = value)}
                aria-label="Acknowledge active agent turn risk"
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

  {#if showCommitSheet}
    <GitCommitSheet
      {projectId}
      stagedCount={staged.length}
      onClose={() => (showCommitSheet = false)}
      onCommitted={() => {
        showCommitSheet = false
      }}
    />
  {/if}
</div>
