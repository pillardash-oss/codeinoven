<script lang="ts">
  import { TriangleAlert, Unplug } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitFileChange } from '$shared/types'
  import ScopeHealthNotice from '../scope/ScopeHealthNotice.svelte'

  interface Props {
    scopeUnhealthy: boolean
    projectId: string
    scopeBucketId: string
    conflictState: 'merge' | 'rebase' | 'none'
    conflicted: GitFileChange[]
    conflictRowAborts: boolean
    integrationActions: Snippet<[boolean?]>
    onRepaired: () => void
  }

  let {
    scopeUnhealthy,
    projectId,
    scopeBucketId,
    conflictState,
    conflicted,
    conflictRowAborts,
    integrationActions,
    onRepaired
  }: Props = $props()
</script>

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
{:else if scopeUnhealthy}
  <div class="mx-2 mt-2">
    <ScopeHealthNotice {projectId} {scopeBucketId} variant="panel" {onRepaired} />
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

<!--
  A stopped rebase has no other home in the panel: the conflict row only
  appears while files are conflicted, and the Complete merge bar belongs to
  a merge. Without this notice the state is invisible, Sync from main
  refuses for a reason the user cannot see, and `git rebase --continue` has
  no control anywhere. It sits above every view because the state blocks
  every view's next step.
-->
{#if conflictState === 'rebase'}
  <div class="mx-2 mt-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2">
    <div class="flex items-center gap-1.5">
      <TriangleAlert size={13} class="shrink-0 text-warning" />
      <p class="text-[0.625rem] font-semibold text-warning">Rebase in progress</p>
    </div>
    <p class="mt-1 text-[0.5625rem] leading-relaxed text-muted">
      {#if conflicted.length > 0}
        Git stopped on a commit that conflicts with the new base.
        <span class="font-medium text-foreground">{conflicted.length}</span>
        {conflicted.length === 1 ? 'file still needs' : 'files still need'} resolving, and the conflict
        controls in the Changes view take one side or open the merge editor. Continuing unlocks once nothing
        is left conflicted.
      {:else}
        Every conflict is resolved and staged. Continuing replays the rest of your commits on top of
        the new base, skipping drops the commit git stopped on, and aborting puts the branch back
        where it was.
      {/if}
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      {@render integrationActions(!conflictRowAborts)}
    </div>
  </div>
{/if}
