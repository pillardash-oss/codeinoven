<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte'
  import { Expand } from '@lucide/svelte'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte.ts'

  const APPFILE_RETRY_DELAYS = [250, 500, 1000, 2000] as const

  interface Props {
    /** Source URL of the image part, including appfile URLs for thread artifacts. */
    url: string
    mime: string
    filename: string
    imageUrls: FileBlobUrlManager
    /** Open the fullscreen viewer (the caller owns the modal + pager). */
    onExpand: () => void
    /**
     * Anything drawn over the picture by the caller: a mark overlay, its
     * numbered badges and its toolbar. The figure is a plain box sized by the
     * image, so an overlay is positioned by `absolute inset-0` and needs to
     * manage its own pointer events (the expand affordance sits underneath it).
     */
    overlay?: Snippet
  }

  let { url, mime, filename, imageUrls, onExpand, overlay }: Props = $props()
  let appfileRetryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function clearRetryTimer(): void {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  function handleImageError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement
    if (!url.startsWith('appfile://')) {
      void imageUrls.bindImage(url, mime, image)
      return
    }

    const delay = APPFILE_RETRY_DELAYS[appfileRetryCount]
    if (delay === undefined) return
    appfileRetryCount += 1
    clearRetryTimer()
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!image.isConnected) return
      const retryUrl = new URL(url)
      retryUrl.searchParams.set('cio-retry', String(appfileRetryCount))
      image.src = retryUrl.toString()
    }, delay)
  }

  onDestroy(clearRetryTimer)
</script>

<div
  class="group relative block max-w-full overflow-hidden rounded-lg border border-border bg-elevated transition-shadow hover:shadow-md"
>
  <!-- The picture, its expand affordance and a caller's overlay live in one box
       sized to the picture rather than to the card. The card fills the message
       column, so a narrow picture would otherwise leave a wider box behind it,
       and a mark normalized to that box lands off the picture it was drawn on. -->
  <div class="relative w-fit max-w-full">
    <img
      src={imageUrls.getUrl(url)}
      alt={filename}
      class="block max-h-80 w-auto max-w-full object-contain"
      loading="lazy"
      onerror={handleImageError}
      onload={clearRetryTimer}
    />
    <!-- The expand affordance is a real button laid over the picture rather than
         the box itself, so a caller's overlay can sit above it and take its own
         clicks. -->
    <button
      type="button"
      class="absolute inset-0"
      title="Expand {filename}"
      aria-label="Expand {filename}"
      onclick={onExpand}
    ></button>
    {#if overlay}
      {@render overlay()}
    {/if}
  </div>
  <span
    class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/0 px-2 py-1 text-[0.6875rem] font-medium text-white opacity-0 transition-all group-hover:bg-black/50 group-hover:opacity-100"
  >
    <span class="truncate">{filename}</span>
    <Expand size={13} class="shrink-0" />
  </span>
</div>
