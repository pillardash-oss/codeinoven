<script lang="ts">
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import {
    THREAD_GROUP_COLORS,
    THREAD_GROUP_ICONS
  } from '$lib/components/threads/thread-group-presentation'
  import { groupThreadsByStatus } from '$lib/components/workspace/workspace-thread-helpers'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { orchestrationCoordinatorState } from '$lib/stores/orchestration-coordinator.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadGroupingState } from '$lib/stores/thread-grouping.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { OrchestrateCoordinatorPanelProps, Thread } from '$shared/types'

  /**
   * The orchestrator board: every thread this one dispatched into any project.
   *
   * It is the workstation-control twin of the Assignment coordinator board, and
   * the one thing that differs is where its children live: a dispatched run is a
   * thread of another project, so a row carries that project's icon and opening
   * it takes the user there. Everything else is the Threads view itself: the
   * same status groups, in the user's own group order and fold state, drawn with
   * the same group headers and the same thread rows. Nothing here invents a
   * second way to describe a run, which is why the board cannot disagree with
   * the sidebar about what a thread is doing.
   */
  let { projectId, threadId }: OrchestrateCoordinatorPanelProps = $props()

  let threads = $derived(orchestrationCoordinatorState.rowsFor(projectId, threadId))
  let selectedThreadId = $derived(workspaceState.selectedThread?.id ?? null)
  /** The Threads view's own status grouping, in the user's configured order. */
  let groups = $derived(
    groupThreadsByStatus(threads).filter(
      (group) => group.threads.length > 0 && threadGroupingState.isVisible(group.label)
    )
  )

  /** A dispatched run carries the icon of the project it lives in, as its row does
   *  in the Threads view. */
  function projectIcon(thread: Thread): string | null {
    return scopeState.projects.find((project) => project.id === thread.projectId)?.iconUrl ?? null
  }

  /** A dispatched run opens where it lives, in whatever project that is. */
  function openRun(thread: Thread): void {
    void openThreadById(thread.projectId, thread.id)
  }
</script>

<!-- Docked into the context sidebar: the sidebar owns the width, the visibility
     and the tab chrome, so this panel is just a column that fills what it is
     given. -->
<div class="flex h-full min-h-0 flex-col" role="region" aria-label="Orchestrator: dispatched runs">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-foreground">
      <CioMonogram size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Orchestrator</h2>
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      Threads this one started in other projects. Opening one takes you to it.
    </p>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto pt-2">
    {#if threads.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <CioMonogram size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-foreground">No runs dispatched</p>
        <p class="max-w-[32ch] text-[0.625rem] leading-relaxed text-muted">
          When this thread starts work in another project, every run it dispatches is listed here by
          status, exactly as it reads in its own sidebar.
        </p>
      </div>
    {:else if groups.length === 0}
      <div class="px-4 py-6 text-center">
        <p class="text-[0.625rem] leading-relaxed text-muted">
          The status groups these runs belong to are hidden in the Threads view. Show them there to
          see the runs here.
        </p>
      </div>
    {:else}
      {#each groups as group (group.label)}
        {@const folded = threadGroupingState.isFolded(group.label)}
        <section>
          <div class="sticky -top-2 z-10 bg-surface">
            <PinnedSection
              sectionKey="threads"
              label={group.label}
              threads={group.threads}
              headerOnly
              icon={THREAD_GROUP_ICONS[group.label]}
              accent={THREAD_GROUP_COLORS[group.label]}
              {folded}
              onToggleFold={() => threadGroupingState.toggleFold(group.label)}
              activeThreadId={selectedThreadId}
              onOpen={openRun}
            />
          </div>
          {#if !folded}
            <div class="space-y-px pb-5" role="list">
              {#each group.threads as thread (thread.id)}
                <ThreadRow
                  {thread}
                  detailed
                  projectIconUrl={projectIcon(thread)}
                  selected={selectedThreadId === thread.id}
                  showChangeScope={false}
                  onOpen={openRun}
                />
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>
