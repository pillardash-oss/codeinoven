<script lang="ts">
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import { formatChangeSummary, type ChangeBreakdown } from '$shared/change-breakdown'
  import type { PullRequestCommit, PullRequestFile } from '$shared/types'
  import PrDiffHunk from './PrDiffHunk.svelte'
  import ChangeAreaSummary from '../shared/ChangeAreaSummary.svelte'
  import { RunChangesState } from '../threads/run-changes-state.svelte'

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

  // The same worker pass the changes panel uses: the pull request's own files for
  // the files tab, and one commit's files while it is expanded. Both arrays are
  // stable, so the grouping a surface already computed is reused instead of
  // scanned again.
  const filesSummary = new RunChangesState(() => ({ changes: files }), true)
  const commitSummary = new RunChangesState(
    () => ({ changes: expandedCommit ? (commitFiles[expandedCommit] ?? []) : [] }),
    true
  )
  const filesBreakdown = $derived(filesSummary.summary?.breakdown)
  const commitBreakdown = $derived(commitSummary.summary?.breakdown)

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

{#snippet totalsBar(breakdown: ChangeBreakdown | undefined, count: number)}
  {@const areas = breakdown?.areas ?? []}
  <!-- The tab's own summary: the line totals the files add up to, then the areas
       they came from, so a reader knows which part of the tree moved before
       opening a single file. -->
  <div
    class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-[0.5625rem] tabular-nums text-dimmed"
    title={formatChangeSummary(breakdown, breakdown ?? null, count)}
  >
    <span class="text-success">+{breakdown?.additions ?? 0}</span>
    <span class="text-danger">−{breakdown?.deletions ?? 0}</span>
    <span class="shrink-0">
      {count}
      {count === 1 ? 'file' : 'files'}
    </span>
    {#if areas.length > 0}
      <ChangeAreaSummary {areas} limit={4} class="text-[0.5625rem]" />
    {/if}
  </div>
{/snippet}

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
    {@render totalsBar(filesBreakdown, files.length)}
    {@render fileList(files, 'pr')}
  {/if}
{:else if commits.length === 0}
  <div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
    <CioCommit size={18} class="text-dimmed" />
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
        <CioCommit size={12} class="mt-0.5 shrink-0 text-dimmed" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.6875rem] text-foreground">{commit.message}</p>
          <p class="truncate text-[0.5625rem] text-dimmed">
            <span class="font-mono">{commit.shortSha}</span>
            · {commit.authorName} · {formatCompactAge(commit.date)}
          </p>
        </div>
        {#if loadingCommit === commit.sha}
          <CioSpinner size={12} class="mt-0.5 shrink-0 animate-spin text-dimmed" />
        {/if}
      </button>
      {#if expandedCommit === commit.sha}
        {@const changed = commitFiles[commit.sha] ?? []}
        {#if changed.length === 0 && loadingCommit !== commit.sha}
          <p class="px-3 py-2 text-[0.625rem] text-dimmed">No files in this commit.</p>
        {:else}
          <div class="border-t border-border/50 bg-elevated/20">
            {@render totalsBar(commitBreakdown, changed.length)}
            {@render fileList(changed, commit.sha)}
          </div>
        {/if}
      {/if}
    </div>
  {/each}
{/if}
