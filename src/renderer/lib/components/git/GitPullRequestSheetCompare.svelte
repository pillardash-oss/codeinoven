<script lang="ts">
  import CioArrowRight from 'cio-icon/CioArrowRight.svelte'
  import CioAttention from 'cio-icon/CioAttention.svelte'
  import CioBan from 'cio-icon/CioBan.svelte'
  import CioCheckCircle from 'cio-icon/CioCheckCircle.svelte'
  import CioEye from 'cio-icon/CioEye.svelte'
  import CioSpinner from 'cio-icon/CioSpinner.svelte'
  import type { PullRequestCompare, PullRequestSummary } from '$shared/types'

  interface Props {
    head: string
    base: string
    branches: string[]
    comparing: boolean
    compareError: string
    /**
     * The compare came back signed out rather than failing: the branches have
     * not been judged at all, and signing in is what judges them.
     */
    loginRequired: boolean
    compare: PullRequestCompare | null
    sameBranch: boolean
    willCreateCommit: boolean
    /** An open PR for the exact head to base pair; GitHub rejects a duplicate. */
    existingPr: PullRequestSummary | null
    onHeadChange: (event: Event) => void
    onBaseChange: (event: Event) => void
    onSignIn: () => void
    onViewExistingPr: () => void
  }

  let {
    head,
    base,
    branches,
    comparing,
    compareError,
    loginRequired,
    compare,
    sameBranch,
    willCreateCommit,
    existingPr,
    onHeadChange,
    onBaseChange,
    onSignIn,
    onViewExistingPr
  }: Props = $props()
</script>

<!-- Compare first, like GitHub: pick the branches, then write about the change. -->
<div class="border border-border bg-surface p-2.5">
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
        class="h-8 w-full cursor-pointer border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary disabled:opacity-50"
        value={head}
        disabled={branches.length === 0}
        onchange={onHeadChange}
      >
        {#each branches as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    </div>
    <CioArrowRight size={14} class="mb-2.5 shrink-0 text-primary" />
    <div class="min-w-0 flex-1">
      <label
        class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
        for="pr-base"
      >
        Base (into)
      </label>
      <select
        id="pr-base"
        class="h-8 w-full cursor-pointer border border-border bg-elevated px-2 font-mono text-[0.6875rem] text-foreground outline-none focus:border-primary disabled:opacity-50"
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
      <CioBan size={12} class="shrink-0 text-dimmed" />
      <span class="text-dimmed">The head and base are the same branch pick a different head.</span>
    {:else if comparing}
      <CioSpinner size={12} class="shrink-0 animate-spin text-dimmed" />
      <span class="text-dimmed">Comparing {head} into {base}</span>
    {:else if compareError}
      <CioAttention size={12} class="shrink-0 text-warning" />
      <span class="text-warning">{compareError}</span>
    {:else if compare && !compare.hasChanges}
      {#if willCreateCommit}
        <CioCheckCircle size={12} class="shrink-0 text-success" />
        <span class="text-success">The staged changes will be committed and pushed.</span>
      {:else}
        <CioBan size={12} class="shrink-0 text-dimmed" />
        <span class="text-dimmed">There isn't anything to compare.</span>
      {/if}
    {:else if compare}
      <CioCheckCircle size={12} class="shrink-0 text-success" />
      <span class="text-success">
        {compare.source === 'local' ? 'Local commits will be pushed' : 'Able to merge'}
        {compare.aheadBy} ahead · {compare.behindBy} behind ·
        {compare.totalCommits} commit{compare.totalCommits === 1 ? '' : 's'} ·
        {compare.filesChanged} file{compare.filesChanged === 1 ? '' : 's'} changed
      </span>
    {/if}
  </div>
  {#if loginRequired}
    <!--
      Not a comparison failure: nothing was compared, because there is no signed-in
      account to compare against GitHub with. So the form says what is missing and
      hands over the same sign-in control every other GitHub surface offers.
    -->
    <div class="mt-2 flex items-center gap-2">
      <p class="min-w-0 flex-1 text-[0.625rem] leading-relaxed text-dimmed">
        Sign in to GitHub to create a pull request.
      </p>
      <button
        type="button"
        class="h-8 shrink-0 cursor-pointer bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
        title="Sign in to GitHub"
        onclick={onSignIn}
      >
        Sign in to GitHub
      </button>
    </div>
  {/if}
  {#if existingPr}
    <div class="mt-2 border border-warning/30 bg-warning/10 px-3 py-2">
      <div class="flex items-start gap-2">
        <CioAttention size={13} class="mt-0.5 shrink-0 text-warning" />
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
            class="mt-2 flex h-7 cursor-pointer items-center gap-1.5 border border-border px-2.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated"
            title="Open the existing pull request in the Git panel"
            onclick={onViewExistingPr}
          >
            <CioEye size={11} />
            View PR #{existingPr.number}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
