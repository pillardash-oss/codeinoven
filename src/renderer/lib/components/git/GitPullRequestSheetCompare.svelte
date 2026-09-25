<script lang="ts">
  import { ArrowRight, CircleCheck, CircleSlash, Eye, Loader2, TriangleAlert } from '@lucide/svelte'
  import type { PullRequestCompare, PullRequestSummary } from '$shared/types'

  interface Props {
    head: string
    base: string
    branches: string[]
    comparing: boolean
    compareError: string
    compare: PullRequestCompare | null
    sameBranch: boolean
    willCreateCommit: boolean
    /** An open PR for the exact head to base pair; GitHub rejects a duplicate. */
    existingPr: PullRequestSummary | null
    onHeadChange: (event: Event) => void
    onBaseChange: (event: Event) => void
    onViewExistingPr: () => void
  }

  let {
    head,
    base,
    branches,
    comparing,
    compareError,
    compare,
    sameBranch,
    willCreateCommit,
    existingPr,
    onHeadChange,
    onBaseChange,
    onViewExistingPr
  }: Props = $props()
</script>

<!-- Compare first, like GitHub: pick the branches, then write about the change. -->
<div class="rounded-lg border border-border bg-surface p-2.5">
  <div class="flex items-end gap-2">
    <div class="min-w-0 flex-1">
      <label
        class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
        for="pr-head"
      >
        Head (from)
      </label>
      <select
        id="pr-head"
        class="h-8 w-full cursor-pointer rounded-lg border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary disabled:opacity-50"
        value={head}
        disabled={branches.length === 0}
        onchange={onHeadChange}
      >
        {#each branches as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </div>
    <ArrowRight size={14} class="mb-2.5 shrink-0 text-primary" />
    <div class="min-w-0 flex-1">
      <label
        class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
        for="pr-base"
      >
        Base (into)
      </label>
      <select
        id="pr-base"
        class="h-8 w-full cursor-pointer rounded-lg border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary disabled:opacity-50"
        value={base}
        disabled={branches.length === 0}
        onchange={onBaseChange}
      >
        {#each branches as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </div>
  </div>
  <div class="mt-2 flex min-h-4 items-center gap-1.5 text-[0.625rem]">
    {#if sameBranch}
      <CircleSlash size={12} class="shrink-0 text-dimmed" />
      <span class="text-dimmed">The head and base are the same branch pick a different head.</span>
    {:else if comparing}
      <Loader2 size={12} class="shrink-0 animate-spin text-dimmed" />
      <span class="text-dimmed">Comparing {head} into {base}</span>
    {:else if compareError}
      <TriangleAlert size={12} class="shrink-0 text-warning" />
      <span class="text-warning">{compareError}</span>
    {:else if compare && !compare.hasChanges}
      {#if willCreateCommit}
        <CircleCheck size={12} class="shrink-0 text-success" />
        <span class="text-success">The staged changes will be committed and pushed.</span>
      {:else}
        <CircleSlash size={12} class="shrink-0 text-dimmed" />
        <span class="text-dimmed">There isn't anything to compare.</span>
      {/if}
    {:else if compare}
      <CircleCheck size={12} class="shrink-0 text-success" />
      <span class="text-success">
        {compare.source === 'local' ? 'Local commits will be pushed' : 'Able to merge'}
        {compare.aheadBy} ahead · {compare.behindBy} behind ·
        {compare.totalCommits} commit{compare.totalCommits === 1 ? '' : 's'} ·
        {compare.filesChanged} file{compare.filesChanged === 1 ? '' : 's'} changed
      </span>
    {/if}
  </div>
  {#if existingPr}
    <div class="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
      <div class="flex items-start gap-2">
        <TriangleAlert size={13} class="mt-0.5 shrink-0 text-warning" />
        <div class="min-w-0 flex-1">
          <p class="text-[0.625rem] font-medium text-warning">
            A pull request already exists for {head} into {base}
          </p>
          <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-dimmed">
            #{existingPr.number}
            {existingPr.title} GitHub won't allow a second open PR for the same branches, so creation
            is disabled.
          </p>
          <button
            type="button"
            class="mt-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated"
            title="Open the existing pull request in the Git panel"
            onclick={onViewExistingPr}
          >
            <Eye size={11} />
            View PR #{existingPr.number}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
