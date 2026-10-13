<script lang="ts">
  import { LoaderCircle, Minus, Download } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import DockRow from '$lib/components/ui/DockRow.svelte'
  import { designExportState as state } from '$lib/stores/design-export.svelte'
  import { copyText } from '$lib/copy-text'
</script>

<Modal
  open={state.open && !state.minimized}
  title="Design export"
  modal={false}
  scrim={false}
  trapFocus={false}
  closeOnBackdrop={false}
  blocksBrowserView={false}
  nativeOverlay="design-export-progress"
  abovePage
  onClose={() => {
    if (state.running) state.minimized = true
    else state.open = false
  }}
>
  <div class="space-y-3 text-sm">
    <p class="text-foreground">{state.label}</p>
    {#if state.running}
      <p class="flex items-center gap-2 text-muted">
        <LoaderCircle size={16} class="animate-spin" />Exporting…
      </p>
    {:else if state.error}
      <p class="text-danger">{state.error}</p>
    {:else if state.result}
      <p class="text-muted">
        Export complete. Saved to <span class="font-mono">{state.result.directory}</span>
      </p>
      <ul class="space-y-1 text-foreground">
        {#each state.result.files as file (file)}<li>{file}</li>{/each}
      </ul>
    {/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={() => (state.minimized = true)}
      title="Dock the export progress panel"
      aria-label="Dock the export progress panel"><Minus size={14} /></button
    >
    {#if state.result}
      <button
        type="button"
        data-modal-primary
        class="rounded-lg bg-primary px-3 py-2 text-sm text-on-primary"
        onclick={() => void copyText(state.result!.directory, 'Export path copied')}
        >Copy export path</button
      >
    {:else}
      <button
        type="button"
        data-modal-primary
        class="rounded-lg bg-primary px-3 py-2 text-sm text-on-primary"
        onclick={() => (state.minimized = true)}>Dock</button
      >
    {/if}
  {/snippet}
</Modal>
{#if state.open && state.minimized}
  <DockRow storageKey="design-export-dock" label="Move docked design export">
    <button
      type="button"
      class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground shadow-lg"
      title="Show design export progress"
      aria-label="Show design export progress"
      onclick={() => (state.minimized = false)}
    >
      {#if state.running}<LoaderCircle size={14} class="animate-spin" />{:else}<Download
          size={14}
        />{/if}
      {state.running ? 'Exporting design' : state.error ? 'Export failed' : 'Design exported'}
    </button>
  </DockRow>
{/if}
