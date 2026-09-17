<script lang="ts">
  import { Archive, GitBranch, GitMergeConflict, GitPullRequest } from '@lucide/svelte'
  import { scheduleDeferredWork } from '$lib/deferred-work'
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

  /**
   * Warm the panel for a pointer resting on the chip, since almost every visit to
   * this control ends in the panel being opened and every visit is otherwise a
   * cold start: the sidebar unmounts its content when it collapses, so opening
   * the panel re-imports the component and re-asks the repository what it is.
   *
   * Routed through the idle scheduler so neither the module import nor the git
   * spawn lands on a frame that is drawing the chip's hover state, and keyed so a
   * pointer crossing the header leaves one warm-up behind rather than one per
   * pass.
   *
   * A panel that is already open is left alone. Its data is current from the
   * refresh that opened it, and a hover there is far more likely to be the
   * prelude to closing it than to opening it again.
   */
  function warmPanel(): void {
    const thread = workspaceState.selectedThread
    if (!thread || !gitAvailable || gitPanelActive) return
    const projectId = thread.projectId
    scheduleDeferredWork(`git:panel-warm:${projectId}`, () => {
      // The panel is code-split, so its chunk is part of the open path too.
      void import('../git/GitStatusPanel.svelte').catch(() => undefined)
      gitState.warmGitPanel(projectId)
    })
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
  onpointerenter={warmPanel}
  onfocus={warmPanel}
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
