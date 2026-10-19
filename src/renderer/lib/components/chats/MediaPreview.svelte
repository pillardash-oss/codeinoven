<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import type { Snippet } from 'svelte'
  import { isVideoMime, isAudioMime } from '$lib/mime'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import Modal from '../ui/Modal.svelte'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'
  import PreviewPager, { type PreviewPagerState } from '../ui/PreviewPager.svelte'
  import { revealAttachmentFile } from '$lib/reveal-file'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'

  interface Props {
    src: string
    filename: string
    mime: string
    onClose: () => void
    /** Repair hook for a media element that failed to load (blob not ready yet). */
    onLoadError?: (element: HTMLMediaElement) => void
    /**
     * Original `file://` url of the media being shown, when the caller has one.
     * `src` is usually a blob url, which has no path on disk, so the reveal
     * action needs the untouched source url instead.
     */
    revealUrl?: string
    /** Sibling navigation when the caller opened this lightbox over more than
     *  one previewable attachment. Absent for a lone file. */
    pager?: PreviewPagerState
    /**
     * Reveal hook for media that has no `file://` URL of its own, such as an
     * inline thread artifact served over `appfile://`. The caller maps the
     * serve URL back to the file on disk; when present the reveal button shows
     * even though `revealUrl` is not a real file path.
     */
    onReveal?: () => void
    /**
     * An annotatable surface to draw in place of the plain media element.
     *
     * An artifact picture is the material a user answers by pointing at, and
     * the lightbox is where it is big enough to point at, so the caller that
     * owns the marks supplies the picture and its layer instead of the plain
     * element. It owns the whole media area, and the lightbox drops the zoom
     * toolbar it would otherwise offer, because a pan gesture and a stroke
     * cannot share the same pointer.
     */
    annotate?: Snippet
  }

  let { src, filename, mime, onClose, onLoadError, revealUrl, pager, onReveal, annotate }: Props =
    $props()

  const kind = $derived(isVideoMime(mime) ? 'video' : isAudioMime(mime) ? 'audio' : 'image')

  const downloadLabel = $derived(
    kind === 'image' ? 'Download image' : kind === 'video' ? 'Download video' : 'Download audio'
  )
  /** Only media that is a real file on disk has a path to reveal, unless the
   *  caller supplied its own reveal mapping (inline thread artifacts). */
  const revealable = $derived((revealUrl?.startsWith('file://') ?? false) || onReveal !== undefined)

  function revealFromButton(event: MouseEvent): void {
    event.stopPropagation()
    if (onReveal) onReveal()
    else if (revealUrl) void revealAttachmentFile(revealUrl)
    // The reveal lands behind this overlay (the file tree, or the OS file
    // manager), so the lightbox closes itself: staying open hides the result
    // and reads as a button that did nothing.
    onClose()
  }

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
  <!-- A media lightbox is chrome-less, so nothing would otherwise keep its
       content out of the window controls drawn over the top-left corner. The
       band doubles as the lightbox header: it reserves the same inset the app
       header occupies, stays draggable like every other full screen surface,
       and names the file with its actions here instead of below the content. -->
  <div
    class="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pr-3"
    style={trafficLightInsetStyle()}
  >
    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">
      {filename}
    </span>
    {#if revealable}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        aria-label={`Reveal path of ${filename}`}
        title="Reveal path"
        onclick={revealFromButton}
      >
        <CioFolderOpen size={14} />
      </button>
    {/if}
    <a
      href={src}
      download={filename}
      class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      aria-label={downloadLabel}
      title={downloadLabel}
    >
      <CioDownload size={14} />
    </a>
    <button
      type="button"
      class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      aria-label="Close preview"
      title="Close (Esc)"
      onclick={onClose}
    >
      <CioClose size={14} />
    </button>
  </div>
  <div
    role="presentation"
    class="relative flex min-h-0 flex-1 items-center justify-center"
    onclick={onClose}
    onkeydown={(e: KeyboardEvent) => {
      if (keymapState.matches('ui-activate', e)) onClose()
    }}
  >
    <div
      role="presentation"
      class="relative flex h-full min-h-0 w-full flex-col items-center"
      onclick={(e: MouseEvent) => e.stopPropagation()}
    >
      {#if annotate}
        {@render annotate()}
      {:else if kind === 'video'}
        <video
          {src}
          controls
          preload="metadata"
          class="min-h-0 w-full flex-1 object-contain"
          onerror={mediaError}
        >
          <track kind="captions" />
        </video>
      {:else if kind === 'audio'}
        <audio
          {src}
          controls
          preload="metadata"
          class="w-full max-w-xl shadow-2xl"
          onerror={mediaError}
        ></audio>
      {:else}
        <div
          {@attach imageViewportAttachment}
          role="group"
          aria-label={`Zoomable preview of ${filename}`}
          class={[
            'flex min-h-0 w-full flex-1 touch-none items-center justify-center overflow-hidden',
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
            class="max-h-full max-w-full object-contain"
            style={panZoom.transform}
          />
        </div>
      {/if}
    </div>
    {#if pager || (kind === 'image' && !annotate)}
      <!-- The floating controls belong to the content, not to the backdrop behind
           it: the lightbox dismisses on a press of its backdrop, so the cluster's
           own box and the gap between its controls must not read as one, and an
           activation key pressed on a focused control must not reach the
           lightbox's activate handler either. -->
      <div
        class="absolute right-4 bottom-4 flex items-center gap-2"
        role="presentation"
        onclick={(event: MouseEvent) => event.stopPropagation()}
        onkeydown={(event: KeyboardEvent) => {
          if (keymapState.matches('ui-activate', event)) event.stopPropagation()
        }}
      >
        {#if pager}
          <PreviewPager {pager} />
        {/if}
        {#if kind === 'image' && !annotate}
          <PanZoomToolbar {panZoom} viewport={imageViewport} />
        {/if}
      </div>
    {/if}
  </div>
</Modal>
