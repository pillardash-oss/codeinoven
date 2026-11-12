<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import CoordinatorRunTimer from '$lib/components/threads/CoordinatorRunTimer.svelte'
  import {
    THREAD_GROUP_COLORS,
    THREAD_GROUP_ICONS
  } from '$lib/components/threads/thread-group-presentation'
  import { groupThreadsByStatus } from '$lib/components/workspace/workspace-thread-helpers'
  import { isThreadLiveWorking } from '$lib/thread-status-badge'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { orchestrationCoordinatorState } from '$lib/stores/orchestration-coordinator.svelte'
  import { pawnAgentsState } from '$lib/stores/pawn-agents.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadGroupingState } from '$lib/stores/thread-grouping.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { DelegationCoordinatorPanelProps, Thread } from '$shared/types'

  /**
   * The delegation board: every real thread this one started.
   *
   * Two shapes are listed here and they are the same thing to the reader, a
   * thread the agent created and answers for: pawns the thread spawned for
   * itself, which never appear in the thread list, and runs it dispatched into
   * any project. A nested sub-agent is deliberately absent: it has no thread of
   * its own, so it lives in the trace of the turn that spawned it, and this board
   * appears only when there is a thread to open.
   *
   * Both sections read the Threads view itself: the same status groups, in the
   * user's own group order and fold state, drawn with the same headers and rows.
   * A section header only appears when both kinds exist, because a single list
   * needs no label to say which one it is.
   */
  let { projectId, threadId }: DelegationCoordinatorPanelProps = $props()

  let pawns = $derived(pawnAgentsState.workersOf(threadId))
  let runs = $derived(orchestrationCoordinatorState.rowsFor(projectId, threadId))
  let selectedThreadId = $derived(workspaceState.selectedThread?.id ?? null)
  let bothKinds = $derived(pawns.length > 0 && runs.length > 0)
  let running = $derived(pawnAgentsState.runningCount(threadId))
  /** Every thread this board lists is part of its run, so the timer spans the
   *  earliest start and stays live while any of them is still working. */
  let runStartedAt = $derived.by(() => {
    const all = [...pawns, ...runs]
    return all.length > 0 ? Math.min(...all.map((thread) => thread.createdAt)) : undefined
  })
  let runLive = $derived([...pawns, ...runs].some((thread) => isThreadLiveWorking(thread)))
  let runEndedAt = $derived.by(() => {
    if (runLive) return undefined
    const all = [...pawns, ...runs]
    return all.length > 0 ? Math.max(...all.map((thread) => thread.updatedAt)) : undefined
  })

  /** The Threads view's own status grouping, in the user's configured order. */
  function visibleGroups(threads: Thread[]) {
    return groupThreadsByStatus(threads).filter(
      (group) => group.threads.length > 0 && threadGroupingState.isVisible(group.label)
    )
  }

  let pawnGroups = $derived(visibleGroups(pawns))
  let runGroups = $derived(visibleGroups(runs))

  /** A delegated thread carries the icon of the project it lives in. */
  function projectIcon(thread: Thread): string | null {
    return scopeState.projects.find((project) => project.id === thread.projectId)?.iconUrl ?? null
  }

  /** A delegated thread opens where it lives, in whatever project that is. */
  function openThread(thread: Thread): void {
    void openThreadById(thread.projectId, thread.id)
  }
</script>

{#snippet groupList(groups: ReturnType<typeof visibleGroups>)}
  <div class="px-2">
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
            onOpen={openThread}
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
                onOpen={openThread}
              />
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
{/snippet}

{#snippet hiddenGroups(noun: string)}
  <div class="px-4 py-6 text-center">
    <p class="text-[0.625rem] leading-relaxed text-muted">
      The status groups these {noun} belong to are hidden in the Threads view. Show them there to see
      them here.
    </p>
  </div>
{/snippet}

<!-- Docked into the context sidebar: the sidebar owns the width, the visibility
     and the tab chrome, so this panel is just a column that fills what it is
     given. -->
<div class="flex h-full min-h-0 flex-col" role="region" aria-label="Spawned agents">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-foreground">
      <CioSubagent size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Spawned agents</h2>
      <div class="ml-auto flex shrink-0 items-baseline gap-2">
        {#if running > 0}
          <span class="text-[0.625rem] font-medium text-thread-working">{running} running</span>
        {/if}
        <CoordinatorRunTimer
          startedAt={runStartedAt}
          endedAt={runEndedAt}
          live={runLive}
          label="Total run time of these agents"
        />
      </div>
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto pt-2">
    {#if pawns.length === 0 && runs.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <CioSubagent size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-foreground">Nothing delegated yet</p>
        <p class="max-w-[32ch] text-[0.625rem] leading-relaxed text-muted">
          When this thread spawns a helper agent or starts work in another project, every thread it
          creates is listed here by status, exactly as it reads in its own sidebar.
        </p>
      </div>
    {:else}
      {#if pawns.length > 0}
        <section class="pb-1">
          {#if bothKinds}
            <h3
              class="flex items-center gap-2 px-4 py-1 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase"
            >
              Helper agents
              <span class="text-dimmed">{pawns.length}</span>
            </h3>
          {/if}
          {#if pawnGroups.length === 0}
            {@render hiddenGroups('helper agents')}
          {:else}
            {@render groupList(pawnGroups)}
          {/if}
        </section>
      {/if}

      {#if runs.length > 0}
        <section class="pb-1">
          {#if bothKinds}
            <h3
              class="flex items-center gap-2 px-4 py-1 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase"
            >
              Dispatched runs
              <span class="text-dimmed">{runs.length}</span>
            </h3>
          {/if}
          {#if runGroups.length === 0}
            {@render hiddenGroups('runs')}
          {:else}
            {@render groupList(runGroups)}
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</div>
