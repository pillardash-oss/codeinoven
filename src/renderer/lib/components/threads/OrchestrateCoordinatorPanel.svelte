<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { orchestrationCoordinatorState } from '$lib/stores/orchestration-coordinator.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import type {
    OrchestrateCoordinatorPanelProps,
    OrchestrationDispatch,
    Thread
  } from '$shared/types'

  /**
   * The orchestrator board: every thread this one dispatched into any project.
   *
   * It is the workstation-control twin of the Assignment coordinator board, and
   * it differs in the one way that matters: its children are not in this thread's
   * project, so the board says which project each run lives in and opening a row
   * takes the user to that thread rather than showing it here. Each row is the
   * app's own thread row, so a dispatched run reads exactly as it does in the
   * Threads view. The board owns no state beyond the read: main's dispatch ledger
   * plus each child thread's own row is the whole truth, which is why it survives
   * a restart and why a row can never claim a status the run does not have.
   */
  let { projectId, threadId }: OrchestrateCoordinatorPanelProps = $props()

  let rows = $derived(orchestrationCoordinatorState.rowsFor(projectId, threadId))
  let running = $derived(rows.filter((row) => isThreadBusyStatus(row.thread.status)).length)
  let failed = $derived(
    rows.filter((row) => row.thread.status === 'failed' || row.thread.status === 'interrupted')
      .length
  )
  let settled = $derived(rows.length - running)
  let selectedThreadId = $derived(workspaceState.selectedThread?.id ?? null)
  /** Rows grouped by the project they live in, so a board never mixes two projects. */
  let groups = $derived.by(() => {
    const byProject = new SvelteMap<string, { name: string; rows: OrchestrationDispatch[] }>()
    for (const row of rows) {
      const group = byProject.get(row.thread.projectId)
      if (group) group.rows.push(row)
      else byProject.set(row.thread.projectId, { name: row.projectName, rows: [row] })
    }
    return [...byProject.entries()].map(([id, group]) => ({
      id,
      name: group.name,
      rows: group.rows
    }))
  })

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
      {#if running > 0}
        <span
          class="ml-auto shrink-0 border border-info/30 bg-info/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-info"
          >{running} running</span
        >
      {/if}
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      Threads this one started in other projects. Opening one takes you to it.
    </p>
    {#if rows.length > 0}
      <div class="mt-3 grid grid-cols-3 gap-1 text-center">
        <div>
          <div class="text-sm font-semibold tabular-nums text-info">{running}</div>
          <div class="text-[0.5625rem] uppercase tracking-wide text-dimmed">Running</div>
        </div>
        <div>
          <div class="text-sm font-semibold tabular-nums text-success">{settled - failed}</div>
          <div class="text-[0.5625rem] uppercase tracking-wide text-dimmed">Settled</div>
        </div>
        <div>
          <div class="text-sm font-semibold tabular-nums text-danger">{failed}</div>
          <div class="text-[0.5625rem] uppercase tracking-wide text-dimmed">Failed</div>
        </div>
      </div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if rows.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <CioMonogram size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-foreground">No runs dispatched</p>
        <p class="max-w-[32ch] text-[0.625rem] leading-relaxed text-muted">
          When this thread starts work in another project, every run it dispatches is listed here
          with its machine and model.
        </p>
      </div>
    {:else}
      {#each groups as group (group.id)}
        <section class="border-b border-border py-3" aria-label={`Runs in ${group.name}`}>
          <h3 class="px-4 pb-2 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            {group.name}
          </h3>
          <div class="space-y-0.5">
            {#each group.rows as row (row.thread.id)}
              <div class="px-2">
                <ThreadRow
                  thread={row.thread}
                  compact
                  selected={selectedThreadId === row.thread.id}
                  showChangeScope={false}
                  onOpen={openRun}
                />
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>
