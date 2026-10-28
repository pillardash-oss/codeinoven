<script lang="ts">
  import { onDestroy } from 'svelte'
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

<!-- The picture is the content: no frame, no caption, no border around it. It is
     drawn at its own shape inside the conversation column, and the whole picture
     is the expand target, which opens the viewer where it is seen big. -->
<figure class="min-w-0 max-w-full self-start">
  <div class="relative w-fit max-w-full">
    <img
      src={imageUrls.getUrl(url)}
      alt={filename}
      class="block max-h-96 w-auto max-w-full object-contain"
      loading="lazy"
      onerror={handleImageError}
      onload={clearRetryTimer}
    />
    <button
      type="button"
      class="absolute inset-0 cursor-zoom-in"
      title="Expand {filename}"
      aria-label="Expand {filename}"
      onclick={onExpand}
    ></button>
  </div>
</figure>
