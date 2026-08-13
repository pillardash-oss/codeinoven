<script lang="ts">
  import { X, Download } from '@lucide/svelte'
  import { isVideoMime, isAudioMime } from '$lib/mime'

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
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }}
/>

<div
  role="presentation"
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
  onclick={onClose}
  onkeydown={(e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') onClose()
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
      <img
        {src}
        alt={filename}
        class="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
      />
    {/if}
    <div class="mt-3 flex items-center gap-3">
      <span class="text-xs text-white/70">{filename}</span>
    </div>
  </div>
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
