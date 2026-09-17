<script lang="ts">
  import { Archive, GitBranch, GitMergeConflict, GitPullRequest } from '@lucide/svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    /** Git controls and polling exist only for local projects configured for Git tracking. */
    gitAvailable: boolean
  }

  let { gitAvailable }: Props = $props()

  let gitPanelActive = $derived(
    contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'git'
  )

  function openGitPanel(): void {
    const thread = workspaceState.selectedThread
    if (!thread || !gitAvailable) return
    if (gitPanelActive) {
      contextSidebarState.hide()
    } else {
      contextSidebarState.openGit(thread.projectId, thread.id)
    }
  }
</script>

<!-- Git status chip   only when a thread is open in a project view -->
<button
  class={[
    'relative flex h-8 max-w-40 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150',
    gitState.activePrConflictCount > 0
      ? 'text-danger hover:bg-danger/10'
      : gitState.conflicted.length > 0
        ? 'text-warning hover:bg-warning/10'
        : gitState.clean
          ? 'text-dimmed hover:bg-elevated hover:text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground',
    gitPanelActive ? 'bg-elevated' : ''
  ]}
  aria-label="Open Git panel"
  title={gitState.activePrConflictCount > 0
    ? `${gitState.activePrConflictCount} open pull request${gitState.activePrConflictCount === 1 ? '' : 's'} need${gitState.activePrConflictCount === 1 ? 's' : ''} conflict resolution   open Git panel`
    : 'Open Git panel'}
  onclick={openGitPanel}
>
  {#if gitState.activePrConflictCount > 0}
    <GitMergeConflict size={13} class="shrink-0" />
  {:else}
    <GitBranch size={13} class="shrink-0" />
  {/if}
  {#if gitState.branch}
    <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] font-medium">
      {gitState.branch}
    </span>
  {/if}
  {#if gitState.conflicted.length > 0}
    <span
      class="shrink-0 rounded-full bg-warning px-1.5 text-[0.5625rem] font-semibold tabular-nums text-on-primary"
    >
      {gitState.conflicted.length}
    </span>
  {:else if gitState.status && !gitState.clean}
    <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"></span>
  {/if}
  {#if gitState.activePrConflictCount > 0}
    <span
      class="flex shrink-0 items-center gap-0.5 rounded-full bg-danger/15 px-1.5 py-0.5 text-[0.5625rem] font-semibold tabular-nums text-danger"
      title={`${gitState.activePrConflictCount} open pull request${gitState.activePrConflictCount === 1 ? '' : 's'} need${gitState.activePrConflictCount === 1 ? 's' : ''} conflict resolution`}
    >
      <GitPullRequest size={9} class="shrink-0" />
      {gitState.activePrConflictCount}
    </span>
  {/if}
  {#if gitState.stashes.length > 0}
    <span
      class="absolute -bottom-1.5 left-2 flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.5 text-[0.5rem] font-semibold tabular-nums text-info ring-1 ring-info/30"
      title={`${gitState.stashes.length} stashed change${gitState.stashes.length === 1 ? '' : 's'}`}
    >
      <Archive size={8} class="shrink-0" />
      {gitState.stashes.length}
    </span>
  {/if}
</button>
