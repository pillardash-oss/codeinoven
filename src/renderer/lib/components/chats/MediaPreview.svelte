<script lang="ts">
  import { X, Download } from '@lucide/svelte'
  import { isVideoMime, isAudioMime } from '$lib/mime'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import Modal from '../ui/Modal.svelte'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'

  interface Props {
    src: string
    filename: string
    mime: string
    onClose: () => void
    /** Repair hook for a media element that failed to load (blob not ready yet). */
    onLoadError?: (element: HTMLMediaElement) => void
  }

  let { src, filename, mime, onClose, onLoadError }: Props = $props()

  const kind = $derived(isVideoMime(mime) ? 'video' : isAudioMime(mime) ? 'audio' : 'image')

  const downloadLabel = $derived(
    kind === 'image' ? 'Download image' : kind === 'video' ? 'Download video' : 'Download audio'
  )

  function mediaError(event: Event): void {
    onLoadError?.(event.currentTarget as HTMLMediaElement)
  }

  const panZoom = new PanZoom()
  let imageViewport = $state<HTMLDivElement>()
  const imageViewportAttachment = (node: HTMLDivElement): (() => void) => {
    imageViewport = node
    return () => {
      if (imageViewport === node) imageViewport = undefined
    }
  }
  // A reused overlay showing a different image must not inherit the previous
  // zoom/pan, so reset whenever the media source changes.
  $effect(() => {
    void src
    panZoom.reset()
  })
</script>

<!--
  A media lightbox is a chrome-less full screen modal: it inherits Escape, the
  backdrop, Cmd/Ctrl+W, the browser-view suppression, and a focus trap from the
  canonical shell instead of registering each one itself, and it paints its own
  translucent backdrop over the panel.
-->
<Modal
  open
  title={`Preview of ${filename}`}
  {onClose}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-black/70"
  claimInitialFocus={(panel) => {
    panel.querySelector<HTMLElement>('button')?.focus()
    return true
  }}
>
  <div
    role="presentation"
    class="relative flex flex-1 items-center justify-center"
    onclick={onClose}
    onkeydown={(e: KeyboardEvent) => {
      if (keymapState.matches('ui-activate', e)) onClose()
    }}
  >
    <div
      role="presentation"
      class="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center"
      onclick={(e: MouseEvent) => e.stopPropagation()}
    >
      {#if kind === 'video'}
        <video
          {src}
          controls
          preload="metadata"
          class="max-h-[80vh] max-w-[85vw] rounded-lg shadow-2xl"
          onerror={mediaError}
        >
          <track kind="captions" />
        </video>
      {:else if kind === 'audio'}
        <audio
          {src}
          controls
          preload="metadata"
          class="w-full max-w-xl rounded-lg shadow-2xl"
          onerror={mediaError}
        ></audio>
      {:else}
        <div
          {@attach imageViewportAttachment}
          role="group"
          aria-label={`Zoomable preview of ${filename}`}
          class={[
            'flex touch-none items-center justify-center overflow-hidden',
            panZoom.zoom > 1 && (panZoom.isPanning ? 'cursor-grabbing' : 'cursor-grab')
          ]}
          onwheel={panZoom.onWheel}
          onpointerdown={panZoom.onPointerDown}
          onpointermove={panZoom.onPointerMove}
          onpointerup={panZoom.onPointerUp}
          onpointercancel={panZoom.onPointerUp}
          ondblclick={() => panZoom.reset()}
        >
          <img
            {@attach panZoom.bindTarget}
            {src}
            alt={filename}
            draggable="false"
            class="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            style={panZoom.transform}
          />
        </div>
      {/if}
      <div class="mt-3 flex items-center gap-3">
        <span class="text-xs text-white/70">{filename}</span>
      </div>
    </div>
    {#if kind === 'image'}
      <PanZoomToolbar {panZoom} viewport={imageViewport} class="absolute right-4 bottom-4" />
    {/if}
    <button
      type="button"
      class="absolute right-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
      aria-label="Close preview"
      title="Close (Esc)"
      onclick={onClose}
    >
      <X size={18} />
    </button>
    <a
      href={src}
      download={filename}
      class="absolute right-4 top-16 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
      aria-label={downloadLabel}
      title={downloadLabel}
      onclick={(e: MouseEvent) => e.stopPropagation()}
    >
      <Download size={16} />
    </a>
  </div>
</Modal>
