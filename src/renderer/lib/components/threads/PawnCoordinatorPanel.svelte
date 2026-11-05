<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import {
    THREAD_GROUP_COLORS,
    THREAD_GROUP_ICONS
  } from '$lib/components/threads/thread-group-presentation'
  import { groupThreadsByStatus } from '$lib/components/workspace/workspace-thread-helpers'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { pawnAgentsState } from '$lib/stores/pawn-agents.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadGroupingState } from '$lib/stores/thread-grouping.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { PawnCoordinatorPanelProps, Thread } from '$shared/types'

  /**
   * The pawn board: every worker thread this thread spawned for itself.
   *
   * A pawn runs on a thread of its own, which is what makes it stronger than a
   * nested sub-agent and what hides it: pawn threads never appear in the thread
   * list, so without this board the work an agent delegated to one is only
   * reachable through the card in its own trace. The board is the spawner's
   * delegation surface, and it reads the same rows, groups and marks the Threads
   * view does, so it cannot describe a pawn differently from the sidebar.
   */
  let { threadId }: PawnCoordinatorPanelProps = $props()

  let threads = $derived(pawnAgentsState.workersOf(threadId))
  let running = $derived(pawnAgentsState.runningCount(threadId))
  let selectedThreadId = $derived(workspaceState.selectedThread?.id ?? null)
  /** The Threads view's own status grouping, in the user's configured order. */
  let groups = $derived(
    groupThreadsByStatus(threads).filter(
      (group) => group.threads.length > 0 && threadGroupingState.isVisible(group.label)
    )
  )

  /** A pawn runs in its spawner's project, and carries that project's icon. */
  function projectIcon(thread: Thread): string | null {
    return scopeState.projects.find((project) => project.id === thread.projectId)?.iconUrl ?? null
  }

  /** A pawn opens where it lives: its own thread, which the user can then read. */
  function openPawn(thread: Thread): void {
    void openThreadById(thread.projectId, thread.id)
  }
</script>

<!-- Docked into the context sidebar: the sidebar owns the width, the visibility
     and the tab chrome, so this panel is just a column that fills what it is
     given. -->
<div class="flex h-full min-h-0 flex-col" role="region" aria-label="Pawn agents">
  <header class="shrink-0 border-b border-border p-4">
    <div class="flex min-w-0 items-center gap-2 text-foreground">
      <CioSubagent size={15} class="shrink-0" />
      <h2 class="text-xs font-semibold uppercase tracking-wide">Pawn agents</h2>
      {#if running > 0}
        <span class="ml-auto shrink-0 text-[0.625rem] font-medium text-thread-working">
          {running} running
        </span>
      {/if}
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      Worker threads this thread spawned for itself. They run on their own threads, report back
      here, and never commit; opening one shows the work it did.
    </p>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto pt-2">
    {#if threads.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <CioSubagent size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-foreground">No pawn agents</p>
        <p class="max-w-[32ch] text-[0.625rem] leading-relaxed text-muted">
          When this thread needs work done in a context of its own, the pawn it spawns is listed
          here by status, exactly as a thread reads in its own sidebar.
        </p>
      </div>
    {:else if groups.length === 0}
      <div class="px-4 py-6 text-center">
        <p class="text-[0.625rem] leading-relaxed text-muted">
          The status groups these pawns belong to are hidden in the Threads view. Show them there to
          see the pawns here.
        </p>
      </div>
    {:else}
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
                onOpen={openPawn}
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
                    onOpen={openPawn}
                  />
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>
