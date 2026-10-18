<script lang="ts">
  import CioRefresh from '@pillardash-oss/cio-icon/CioRefresh.svelte'
  import { onMount } from 'svelte'

  import { invoke } from '$lib/ipc.svelte'
  import type { DesignModelRanking } from '$shared/design/design-review'
  import DataTable, { type DataTableColumn } from '$lib/components/ui/DataTable.svelte'
  const columns: DataTableColumn<DesignModelRanking, 'model' | 'score' | 'samples'>[] = [
    { key: 'model', header: 'Thread model', sortValue: (row) => row.model },
    { key: 'score', header: 'Score', sortValue: (row) => row.score, cellClass: 'tabular-nums' },
    {
      key: 'samples',
      header: 'Samples',
      sortValue: (row) => row.samples,
      cellClass: 'tabular-nums'
    }
  ]
  let { startAt, endAt }: { startAt: number; endAt: number } = $props()
  let rows = $state<DesignModelRanking[]>([])
  let loading = $state(false)
  let error = $state('')
  async function refresh(): Promise<void> {
    if (loading) return
    loading = true
    error = ''
    try {
      const result = await invoke('design:rankings', startAt, endAt)
      rows = Array.isArray(result) ? result : []
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : 'Could not read design rankings.'
    } finally {
      loading = false
    }
  }
  onMount(() => {
    void refresh()
  })
</script>

<section class="mt-4 overflow-hidden border border-border" aria-labelledby="design-ranking-heading">
  <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div>
      <h2 id="design-ranking-heading" class="text-sm font-semibold">Design quality</h2>
      <p class="mt-1 text-xs text-muted">
        Agent-assessed screen critiques, scored out of 10. Up to 5,000 recent screen revisions;
        repeated reviews of the same content count once.
      </p>
    </div>
    <button
      type="button"
      class="p-2 text-muted hover:bg-elevated"
      title="Refresh design quality rankings"
      aria-label="Refresh design quality rankings"
      disabled={loading}
      onclick={() => void refresh()}
      ><CioRefresh size={14} class={loading ? 'animate-spin' : ''} /></button
    >
  </div>
  {#if error}<p class="p-4 text-sm text-danger">{error}</p>
  {:else if rows.length}
    <DataTable
      {rows}
      {columns}
      getRowId={(row) => `${row.harness}:${row.provider}:${row.model}`}
      label="Design quality rankings"
      initialSortKey="score"
    >
      {#snippet cell(row, column)}
        {#if column.key === 'model'}{row.model}<span class="ml-2 text-dimmed"
            >{row.harness} / {row.provider}</span
          >
        {:else if column.key === 'score'}{row.score.toFixed(2)}{:else}{row.samples}{/if}
      {/snippet}
    </DataTable>
  {:else}<p class="p-4 text-sm text-muted">
      {loading
        ? 'Reading design critiques…'
        : 'Design critiques will appear here as models review screens.'}
    </p>{/if}
</section>
