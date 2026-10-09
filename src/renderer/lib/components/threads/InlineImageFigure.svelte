<script lang="ts">
  import { onDestroy } from 'svelte'
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
  }

  let { url, mime, filename, imageUrls, onExpand }: Props = $props()
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

<button
  type="button"
  class="group relative block max-w-full overflow-hidden rounded-lg border border-border bg-elevated transition-shadow hover:shadow-md"
  title="Expand {filename}"
  aria-label="Expand {filename}"
  onclick={onExpand}
>
  <img
    src={imageUrls.getUrl(url)}
    alt={filename}
    class="block max-h-80 w-auto max-w-full object-contain"
    loading="lazy"
    onerror={handleImageError}
    onload={clearRetryTimer}
  />
  <span
    class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/0 px-2 py-1 text-[0.6875rem] font-medium text-white opacity-0 transition-all group-hover:bg-black/50 group-hover:opacity-100"
  >
    <span class="truncate">{filename}</span>
    <Expand size={13} class="shrink-0" />
  </span>
</button>
