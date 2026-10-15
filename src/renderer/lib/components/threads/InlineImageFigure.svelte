<script lang="ts">
  import { onDestroy } from 'svelte'
  import InlineFigure from './InlineFigure.svelte'
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

<!-- The picture sets the frame's size, so it is drawn whole at its own shape: a
     tall picture is capped (the fullscreen viewer is where it is seen big) and a
     wide one takes the column, and neither leaves a box behind wider than
     itself. -->
<InlineFigure {filename} {onExpand}>
  <div class="relative">
    <img
      src={imageUrls.getUrl(url)}
      alt={filename}
      class="block max-h-96 w-auto max-w-full object-contain"
      loading="lazy"
      onerror={handleImageError}
      onload={clearRetryTimer}
    />
    <!-- The whole picture is the expand target as well as the caption's button.
         It is a second path to the same action, never the only one, so the
         affordance itself stays visible in the caption. -->
    <button
      type="button"
      class="absolute inset-0 cursor-zoom-in"
      title="Expand {filename}"
      aria-label="Expand {filename}"
      onclick={onExpand}
    ></button>
  </div>
</InlineFigure>
