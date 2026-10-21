<script lang="ts">
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    buildChangeBreakdown,
    formatChangeKinds,
    type ChangeBreakdown
  } from '$shared/change-breakdown'
  import type { PullRequestCommit, PullRequestFile } from '$shared/types'
  import PrDiffHunk from './PrDiffHunk.svelte'

  interface Props {
    mode: 'commits' | 'files'
    commits: PullRequestCommit[]
    files: PullRequestFile[]
    /** Fetch the changed files for one commit, cached by the caller's store. */
    loadCommitFiles: (sha: string) => Promise<PullRequestFile[]>
  }

  let { mode, commits, files, loadCommitFiles }: Props = $props()

  let expandedCommit = $state<string | null>(null)
  let commitFiles = $state<Record<string, PullRequestFile[]>>({})
  let loadingCommit = $state<string | null>(null)
  let expandedFile = $state<string | null>(null)

  /** Everything already fetched, so expanding a commit never refetches it. */
  const filesBySha = new SvelteMap<string, PullRequestFile[]>()
  /** Each commit's own composition, keyed by sha, filled as its files arrive. */
  const commitBreakdowns = new SvelteMap<string, ChangeBreakdown>()
  /** Concurrent commit fetches. A 60-commit pull request is still one API call each. */
  const FETCH_CONCURRENCY = 2
  /** The same commit requested twice, by a row and by an expand, reads once. */
  const inflight = new SvelteMap<string, Promise<void>>()

  function fetchCommit(sha: string): Promise<void> {
    const cached = filesBySha.get(sha)
    if (cached) {
      if (!commitBreakdowns.has(sha)) commitBreakdowns.set(sha, breakdownOf(cached))
      return Promise.resolve()
    }
    const running = inflight.get(sha)
    if (running) return running
    const task = loadCommitFiles(sha)
      .then((changed) => {
        filesBySha.set(sha, changed)
        commitBreakdowns.set(sha, breakdownOf(changed))
      })
      .catch(() => undefined)
      .finally(() => inflight.delete(sha))
    inflight.set(sha, task)
    return task
  }

  function breakdownOf(list: PullRequestFile[]): ChangeBreakdown {
    return buildChangeBreakdown(
      list.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions
      }))
    )
  }

  // A commit's composition needs that commit's files, and a pull request does not
  // carry them. They are read here, a couple at a time, and each row fills in when
  // its own files land; nothing waits for the whole list.
  $effect(() => {
    const shas = commits.map((commit) => commit.sha)
    let stopped = false
    let index = 0
    const run = async (): Promise<void> => {
      while (index < shas.length) {
        const sha = shas[index]
        index += 1
        if (stopped) return
        // A commit whose files cannot be read simply shows no composition.
        await fetchCommit(sha)
      }
    }
    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, shas.length) }, run)
    void Promise.all(workers)
    return () => {
      stopped = true
    }
  })

  async function toggleCommit(sha: string): Promise<void> {
    if (expandedCommit === sha) {
      expandedCommit = null
      return
    }
    expandedCommit = sha
    if (commitFiles[sha]) return
    const cached = filesBySha.get(sha)
    if (cached) {
      commitFiles = { ...commitFiles, [sha]: cached }
      return
    }
    loadingCommit = sha
    try {
      const changed = await loadCommitFiles(sha)
      filesBySha.set(sha, changed)
      if (!commitBreakdowns.has(sha)) commitBreakdowns.set(sha, breakdownOf(changed))
      commitFiles = { ...commitFiles, [sha]: changed }
    } finally {
      loadingCommit = null
    }
  }
</script>

{#snippet fileList(list: PullRequestFile[], keyPrefix: string)}
  {#each list as file (file.path)}
    {@const fileKey = `${keyPrefix}:${file.path}`}
    <div class="border-b border-border/50">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
        onclick={() => (expandedFile = expandedFile === fileKey ? null : fileKey)}
      >
        <CioDiff size={12} class="shrink-0 text-dimmed" />
        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-foreground">
          {file.path}
        </span>
        <span class="shrink-0 text-[0.5625rem] tabular-nums">
          <span class="text-success">+{file.additions}</span>
          <span class="text-danger">−{file.deletions}</span>
        </span>
      </button>
      {#if expandedFile === fileKey}
        {#if file.patch}
          <!-- The same code renderer an inline thread uses, unwindowed: a file's
               patch is the whole story, so there is no anchor to centre on. -->
          <PrDiffHunk
            patch={file.patch}
            context={null}
            class="border-t border-border/40 bg-elevated/20 py-1"
          />
        {:else}
          <p class="px-3 py-2 text-[0.625rem] text-dimmed">
            No inline diff for this file (binary or too large).
          </p>
        {/if}
      {/if}
    </div>
  {/each}
{/snippet}

{#if mode === 'files'}
  {#if files.length === 0}
    <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <CioDiff size={18} class="text-dimmed" />
      <p class="text-[0.6875rem] leading-relaxed text-dimmed">No changed files.</p>
    </div>
  {:else}
    {@render fileList(files, 'pr')}
  {/if}
{:else if commits.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <CioCommit size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">No commits on this branch.</p>
  </div>
{:else}
  {#each commits as commit (commit.sha)}
    {@const breakdown = commitBreakdowns.get(commit.sha)}
    <div class="border-b border-border/50">
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
        title="Show the files changed in {commit.shortSha}"
        onclick={() => void toggleCommit(commit.sha)}
      >
        <CioCommit size={12} class="mt-0.5 shrink-0 text-dimmed" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.6875rem] text-foreground">{commit.message}</p>
          <p class="truncate text-[0.5625rem] text-dimmed">
            <span class="font-mono">{commit.shortSha}</span>
            · {commit.authorName} · {formatCompactAge(commit.date)}
          </p>
        </div>
        <!-- The commit's own line totals, then what they are made of in brackets:
             a commit that only touched video reads "video 100%", one that mixed
             tests and components names both. -->
        {#if breakdown && breakdown.totalFiles > 0}
          <span class="mt-0.5 flex shrink-0 items-center gap-1.5 text-[0.5625rem] tabular-nums">
            <span class="text-success">+{breakdown.additions}</span>
            <span class="text-danger">−{breakdown.deletions}</span>
            <span class="text-dimmed">({formatChangeKinds(breakdown.kinds, 3)})</span>
          </span>
        {:else if loadingCommit === commit.sha}
          <CioSpinner size={12} class="mt-0.5 shrink-0 animate-spin text-dimmed" />
        {/if}
      </button>
      {#if expandedCommit === commit.sha}
        {@const changed = commitFiles[commit.sha] ?? []}
        {#if changed.length === 0 && loadingCommit !== commit.sha}
          <p class="px-3 py-2 text-[0.625rem] text-dimmed">No files in this commit.</p>
        {:else}
          <div class="border-t border-border/50 bg-elevated/20">
            {@render fileList(changed, commit.sha)}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
{/if}
