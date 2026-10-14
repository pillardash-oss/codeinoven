<script lang="ts">
  import { Download, Loader2, Trash2 } from '@lucide/svelte'
  import { onDestroy, onMount } from 'svelte'
  import { formatBytes } from '$lib/format/bytes'
  import { videoPackagesStore as packages } from '$lib/stores/video-packages.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DownloadProgress from '../ui/DownloadProgress.svelte'

  /**
   * The optional video inference pack.
   *
   * GPU background removal is the only video operation the base install does
   * not cover; every other operation runs on the bundled decoder. The pack is a
   * pinned set of matting libraries installed on demand into the app's own
   * folder, so the shipped installer never carries their hundreds of megabytes.
   */
  let pendingRemove = $state(false)
  let removing = $state(false)

  const pack = $derived(packages.state)
  const installing = $derived(pack?.phase === 'preparing' || pack?.phase === 'installing')
  const failure = $derived(pack?.phase === 'failed' ? (pack.error ?? '') : '')

  onMount(() => {
    void packages.load()
  })

  onDestroy(() => packages.dispose())

  async function confirmRemove(): Promise<void> {
    removing = true
    await packages.remove()
    removing = false
    pendingRemove = false
  }
</script>

<div id="settings-block-design-video-packages" class="rounded-xl border bg-surface p-4">
  <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Video pack</h3>
  <p class="mt-2 text-xs leading-relaxed text-dimmed">
    Background removal on the GPU is the only video operation the base install does not cover. It
    needs a separate pack of matting libraries, downloaded once into this app's own folder. Probe,
    filmstrip, waveform, listen, transcribe, cut, export, captions, runtime and tracking all run on
    the bundled decoder and need nothing else.
  </p>

  {#if packages.error}
    <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {packages.error}
    </p>
  {/if}

  {#if installing}
    <div class="mt-3">
      <DownloadProgress
        label={pack?.phase === 'preparing'
          ? 'Preparing the video pack…'
          : 'Installing the video pack…'}
        indeterminate
        ariaLabel="Installing the video pack"
        hint="This downloads native inference libraries and can take a few minutes."
        onCancel={() => void packages.cancel()}
        cancelLabel="Cancel install"
      />
    </div>
  {:else if pack?.installed}
    <div
      class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-elevated/40 p-3"
    >
      <div class="min-w-0">
        <p class="text-xs font-medium text-foreground">Installed</p>
        <p class="mt-0.5 text-xs tabular-nums text-dimmed">
          Version {pack.version} · {formatBytes(pack.sizeBytes)} on disk
        </p>
      </div>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-lg border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
        title="Remove the video pack and its downloaded model weights"
        aria-label="Remove the video pack and its downloaded model weights"
        onclick={() => (pendingRemove = true)}
      >
        <Trash2 size={13} aria-hidden="true" /> Remove
      </button>
    </div>
  {:else}
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        disabled={!pack}
        title="Download and install the optional video pack"
        aria-label="Install the optional video pack"
        onclick={() => void packages.install()}
      >
        {#if !pack}
          <Loader2 size={13} class="animate-spin" aria-hidden="true" />
        {:else}
          <Download size={13} aria-hidden="true" />
        {/if}
        Install
      </button>
      {#if pack?.phase === 'cancelled'}
        <p class="text-xs text-muted">Install cancelled.</p>
      {/if}
    </div>
  {/if}

  {#if failure}
    <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {failure}
    </p>
  {/if}
</div>

<ConfirmDialog
  open={pendingRemove}
  title="Remove the video pack?"
  confirmLabel="Remove pack"
  variant="danger"
  busy={removing}
  note="Background removal stops working until you install it again."
  onCancel={() => {
    pendingRemove = false
  }}
  onConfirm={() => void confirmRemove()}
>
  The matting libraries and the model weights they downloaded are deleted from this app's own
  folder. Project files are untouched.
</ConfirmDialog>
