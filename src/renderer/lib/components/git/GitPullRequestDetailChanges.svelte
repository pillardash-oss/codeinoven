<script lang="ts">
  import { FileDiff, GitCommitHorizontal, Loader2 } from '@lucide/svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import type { PullRequestCommit, PullRequestFile } from '$shared/types'
  import { patchLineClass } from './git-pull-request-detail-format'

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

  async function toggleCommit(sha: string): Promise<void> {
    if (expandedCommit === sha) {
      expandedCommit = null
      return
    }
    expandedCommit = sha
    if (commitFiles[sha]) return
    loadingCommit = sha
    try {
      const changed = await loadCommitFiles(sha)
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
        <FileDiff size={12} class="shrink-0 text-dimmed" />
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
          <pre
            class="overflow-x-auto bg-elevated/40 px-3 py-1.5 font-mono text-[0.5625rem] leading-relaxed"><!--
         -->{#each file.patch.split('\n') as line, index (index)}<span
                class="block {patchLineClass(line)}">{line || ' '}</span
              >{/each}</pre>
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
      <FileDiff size={18} class="text-dimmed" />
      <p class="text-[0.6875rem] leading-relaxed text-dimmed">No changed files.</p>
    </div>
  {:else}
    {@render fileList(files, 'pr')}
  {/if}
{:else if commits.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <GitCommitHorizontal size={18} class="text-dimmed" />
    <p class="text-[0.6875rem] leading-relaxed text-dimmed">No commits on this branch.</p>
  </div>
{:else}
  {#each commits as commit (commit.sha)}
    <div class="border-b border-border/50">
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
        title="Show the files changed in {commit.shortSha}"
        onclick={() => void toggleCommit(commit.sha)}
      >
        <GitCommitHorizontal size={12} class="mt-0.5 shrink-0 text-dimmed" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.6875rem] text-foreground">{commit.message}</p>
          <p class="truncate text-[0.5625rem] text-dimmed">
            <span class="font-mono">{commit.shortSha}</span>
            · {commit.authorName} · {relativeTime(commit.date)}
          </p>
        </div>
        {#if loadingCommit === commit.sha}
          <Loader2 size={12} class="mt-0.5 shrink-0 animate-spin text-dimmed" />
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
