<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import { orchestrationCoordinatorState } from '$lib/stores/orchestration-coordinator.svelte'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import type { OrchestrateCoordinatorPanelProps, OrchestrationDispatch } from '$shared/types'

  /**
   * The orchestrator board: every thread this one dispatched into any project.
   *
   * It is the workstation-control twin of the Assignment coordinator board, and
   * it differs in the one way that matters: its children are not in this thread's
   * project, so a row names the project it lives in and clicking it takes the
   * user to that thread rather than showing it here. The board owns no state of
   * its own beyond the read: main's dispatch ledger plus each child thread's own
   * status is the whole truth, which is why it survives a restart and why a row
   * can never claim a status the run does not have.
   */
  let { projectId, threadId }: OrchestrateCoordinatorPanelProps = $props()

  let rows = $derived(orchestrationCoordinatorState.rowsFor(projectId, threadId))
  let running = $derived(rows.filter((row) => isThreadBusyStatus(row.status)).length)
  let settled = $derived(rows.length - running)
  let failed = $derived(
    rows.filter((row) => row.status === 'failed' || row.status === 'interrupted').length
  )
  /** Rows grouped by the project they live in, so a board never mixes two projects. */
  let groups = $derived.by(() => {
    const byProject = new SvelteMap<string, { name: string; rows: OrchestrationDispatch[] }>()
    for (const row of rows) {
      const group = byProject.get(row.childProjectId)
      if (group) group.rows.push(row)
      else byProject.set(row.childProjectId, { name: row.childProjectName, rows: [row] })
    }
    return [...byProject.entries()].map(([id, group]) => ({
      id,
      name: group.name,
      rows: group.rows
    }))
  })

  function statusLabel(status: OrchestrationDispatch['status']): string {
    switch (status) {
      case 'completed':
        return 'Done'
      case 'failed':
        return 'Failed'
      case 'interrupted':
        return 'Interrupted'
      case 'working-paused':
        return 'Paused'
      case 'awaiting_approval':
        return 'Waiting'
      default:
        return isThreadBusyStatus(status) ? 'Working' : 'Queued'
    }
  }

  function statusClass(status: OrchestrationDispatch['status']): string {
    if (status === 'completed') return 'border-success/30 bg-success/10 text-success'
    if (status === 'failed' || status === 'interrupted') {
      return 'border-danger/30 bg-danger/10 text-danger'
    }
    if (status === 'awaiting_approval' || status === 'working-paused') {
      return 'border-warning/30 bg-warning/10 text-warning'
    }
    if (isThreadBusyStatus(status)) return 'border-info/30 bg-info/10 text-info'
    return 'border-border bg-elevated text-muted'
  }

  function modelLine(row: OrchestrationDispatch): string {
    const model = row.modelId.split('/').pop() ?? row.modelId
    const thinking = row.thinkingLevel ? ` · ${row.thinkingLevel}` : ''
    return `${row.harnessId} · ${model}${thinking}`
  }

  function machineLine(row: OrchestrationDispatch): string {
    return row.ovenId === 'local' ? 'This computer' : row.ovenName
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
      Threads this one started in other projects. Open one to read it where it lives.
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
          with its machine, model and live status.
        </p>
      </div>
    {:else}
      {#each groups as group (group.id)}
        <section class="border-b border-border" aria-label={`Runs in ${group.name}`}>
          <h3 class="px-4 pt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            {group.name}
          </h3>
          <div class="flex flex-col p-2">
            {#each group.rows as row (row.childThreadId)}
              <button
                type="button"
                class="flex w-full items-start justify-between gap-2 border-l-2 border-transparent px-2 py-2 text-left transition-colors hover:bg-elevated"
                title={`Open "${row.title}" in ${row.childProjectName}`}
                aria-label={`Open "${row.title}" in project ${row.childProjectName}`}
                onclick={() => void openThreadById(row.childProjectId, row.childThreadId)}
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium text-foreground">{row.title}</span
                  >
                  <span class="mt-0.5 block truncate text-[0.625rem] text-dimmed">
                    {modelLine(row)}
                  </span>
                  <span class="mt-0.5 block truncate text-[0.625rem] text-dimmed">
                    {machineLine(row)}
                  </span>
                </span>
                <span
                  class="shrink-0 border px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide {statusClass(
                    row.status
                  )}">{statusLabel(row.status)}</span
                >
              </button>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>
