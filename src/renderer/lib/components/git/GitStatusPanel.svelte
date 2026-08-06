<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitDiff, GitFileChange } from '$shared/types'
  import GitCommitSheet from './GitCommitSheet.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import { Check, GitBranch, GitCommit, GitFork, Loader2, RefreshCw } from '@lucide/svelte'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId: _threadId }: Props = $props()

  type RepoState = 'loading' | 'git_unavailable' | 'not_git' | 'git'

  let repoState = $state<RepoState>('loading')
  let preflightDetail = $state('')
  let diffs = $state<Record<string, GitDiff>>({})
  let expanded = $state<Record<string, boolean>>({})
  let loadingDiff = $state<Record<string, boolean>>({})
  let showCommitSheet = $state(false)
  let showIdentityForm = $state(false)
  let identityName = $state('')
  let identityEmail = $state('')

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

  async function toggleDiff(change: GitFileChange): Promise<void> {
    const path = change.path
    if (expanded[path]) {
      expanded = { ...expanded, [path]: false }
      return
    }
    expanded = { ...expanded, [path]: true }
    if (diffs[path]) return
    loadingDiff = { ...loadingDiff, [path]: true }
    try {
      const diff = await gitState.getDiff(projectId, path, change.staged)
      diffs = { ...diffs, [path]: diff }
    } finally {
      loadingDiff = { ...loadingDiff, [path]: false }
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
    const allPaths = [...new Set(changes.map((change) => change.path))]
    if (allPaths.length === 0) return
    await gitState.stage(projectId, allPaths)
  }

  async function saveIdentity(): Promise<void> {
    await gitState.setIdentity(projectId, identityName, identityEmail)
    if (!gitState.error) showIdentityForm = false
  }

  $effect(() => {
    void loadRepoState()
  })

  onMount(() => gitState.ensureProjectEvents(projectId))

  const identityNeeded = $derived(
    repoState === 'git' && gitState.identity !== null && !gitState.identity.configured
  )

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
        <span class="shrink-0 text-[10px] tabular-nums text-dimmed">
          {status.ahead > 0 ? `↑${status.ahead}` : ''}
          {status.ahead > 0 && status.behind > 0 ? ' ' : ''}
          {status.behind > 0 ? `↓${status.behind}` : ''}
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
        <GitBranch size={22} class="mx-auto mb-2 text-dimmed" />
        <p class="text-xs font-medium text-muted">Git is not available</p>
        <p class="mt-1 max-w-[26ch] text-[10px] leading-relaxed text-dimmed">
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
        <GitFork size={22} class="mx-auto mb-2 text-dimmed" />
        <p class="text-xs font-medium text-muted">This project is not a Git repository</p>
        <p class="mt-1 max-w-[26ch] text-[10px] leading-relaxed text-dimmed">
          Initialize a repository to track changes, commit, and open pull requests from the app.
        </p>
        <button
          type="button"
          class="mt-3 flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
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
        <p
          class="mb-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
        >
          {gitState.error}
        </p>
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
        <div class="mb-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <p class="text-[10px] font-semibold text-warning">
            {conflicted.length} conflicted {conflicted.length === 1 ? 'file' : 'files'}
          </p>
          <p class="mt-0.5 text-[9px] leading-relaxed text-muted">
            Resolve conflicts in your editor, then stage the files and commit.
          </p>
        </div>
      {/if}

      {#if status && changes.length === 0 && status.clean}
        <div class="flex h-full flex-col items-center justify-center px-6 text-center">
          <Check size={20} class="mx-auto mb-2 text-success" />
          <p class="text-xs font-medium text-muted">Working tree is clean</p>
          <p class="mt-1 max-w-[26ch] text-[10px] text-dimmed">
            Stage and commit changes, then push.
          </p>
        </div>
      {:else if status}
        {#each fileSections as section (section.title)}
          <p class="mb-1 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted">
            {section.title}
          </p>
          <div class="mb-2 overflow-hidden rounded-lg border border-border bg-surface">
            {#each section.files as change (change.path)}
              <GitFileRow
                {change}
                diff={diffs[change.path] ?? null}
                loadingDiff={loadingDiff[change.path] ?? false}
                expanded={expanded[change.path] ?? false}
                onToggleDiff={() => void toggleDiff(change)}
                onToggleStage={() => void toggleStage(change)}
              />
            {/each}
          </div>
        {/each}

        <div class="flex items-center gap-2 px-1 pb-1">
          {#if changes.length > 0}
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
              disabled={gitState.isBusy('stage')}
              onclick={() => void stageAll()}
            >
              Stage all
            </button>
          {/if}
          <span class="flex-1"></span>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
            disabled={staged.length === 0 || gitState.isBusy('commit')}
            onclick={() => (showCommitSheet = true)}
          >
            <GitCommit size={12} />
            Commit {staged.length > 0 ? `${staged.length}` : ''}
          </button>
        </div>
      {/if}
    {/if}
  </div>

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
