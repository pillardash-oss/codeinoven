<script lang="ts">
  import { Download, LoaderCircle } from '@lucide/svelte'
  import DockableModal from '$lib/components/ui/DockableModal.svelte'
  import DockRow from '$lib/components/ui/DockRow.svelte'
  import { exportProgressState as state } from '$lib/stores/export-progress.svelte'
  import { copyText } from '$lib/copy-text'
  import { APP_SLUG } from '$shared/brand'

  /**
   * The one panel every export reports through.
   *
   * Exporting anything for design or video opens this dockable panel rather than
   * a regular modal: it floats over the app, drags to any edge, and docks to a
   * chip while its work runs, so a long MP4 export never blocks the user. The
   * controller it reads owns the export; this component is only its face.
   */
  const STORAGE_KEY = `${APP_SLUG}.exportProgressPanel.v1`

  const title = $derived(
    state.kind === 'video' ? 'Video export' : state.kind === 'design' ? 'Design export' : 'Export'
  )
  const noun = $derived(state.kind === 'video' ? 'video' : 'design')
  const chipLabel = $derived(
    state.running ? `Exporting ${noun}` : state.error ? 'Export failed' : `${noun} exported`
  )

  /** The path the copy action offers: the design folder, or the video's own file. */
  function copyPath(): void {
    const outcome = state.result
    if (!outcome) return
    const path = outcome.directory || outcome.files[0]
    if (!path) return
    void copyText(path, 'Export path copied')
  }
</script>

<DockableModal
  open={state.open}
  {title}
  minimized={state.minimized}
  closable={!state.running}
  onMinimize={() => (state.minimized = true)}
  onClose={() => (state.open = false)}
  storageKey={STORAGE_KEY}
  dragLabel="Drag to move the export panel"
  defaultHeight={280}
>
  {#snippet dock()}
    <DockRow storageKey={STORAGE_KEY} label="Move docked export progress">
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground shadow-lg"
        title="Show export progress"
        aria-label="Show export progress"
        onclick={() => (state.minimized = false)}
      >
        {#if state.running}<LoaderCircle size={14} class="animate-spin" />{:else}<Download
            size={14}
          />{/if}
        {chipLabel}
      </button>
    </DockRow>
  {/snippet}

  <div class="space-y-3 text-sm">
    <p class="text-foreground">{state.label}</p>
    {#if state.running}
      <p class="flex items-center gap-2 text-muted" aria-live="polite">
        <LoaderCircle size={16} class="animate-spin" />
        {state.kind === 'video' && state.stage ? state.stage : 'Exporting…'}
      </p>
      {#if state.kind === 'video'}
        <progress
          class="h-1 w-full accent-primary"
          value={state.progress}
          max="1"
          aria-label="Video export progress"
        ></progress>
      {/if}
    {:else if state.error}
      <p class="text-danger" role="alert">{state.error}</p>
    {:else if state.result}
      {#if state.result.directory}
        <p class="text-muted">
          Export complete. Saved to <span class="font-mono">{state.result.directory}</span>
        </p>
      {:else}
        <p class="text-muted">Export complete.</p>
      {/if}
      <ul class="space-y-1 text-foreground">
        {#each state.result.files as file (file)}
          <li class="truncate font-mono text-xs" title={file}>{file}</li>
        {/each}
      </ul>
    {/if}
  </div>

  {#snippet footer()}
    {#if state.running}
      <!--
        Closing mid export would hide the only report of work the app is still
        doing, so the only action is to dock the panel and let it run.
      -->
      <button
        type="button"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => (state.minimized = true)}
      >
        Dock
      </button>
    {:else if state.result}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
        data-modal-dismiss
        onclick={() => (state.minimized = true)}
      >
        Dock
      </button>
      <button
        type="button"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover"
        onclick={copyPath}
      >
        Copy path
      </button>
    {:else}
      <button
        type="button"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => (state.open = false)}
      >
        Close
      </button>
    {/if}
  {/snippet}
</DockableModal>
