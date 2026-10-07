<script lang="ts">
  import { Expand } from '@lucide/svelte'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte.ts'

  interface Props {
    /** Original `file://` URL of the image part. */
    url: string
    mime: string
    filename: string
    imageUrls: FileBlobUrlManager
    /** Open the fullscreen viewer (the caller owns the modal + pager). */
    onExpand: () => void
  }

  let { url, mime, filename, imageUrls, onExpand }: Props = $props()
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
    onerror={(e: Event) =>
      void imageUrls.bindImage(url, mime, e.currentTarget as HTMLImageElement)}
  />
  <span
    class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/0 px-2 py-1 text-[0.6875rem] font-medium text-white opacity-0 transition-all group-hover:bg-black/50 group-hover:opacity-100"
  >
    <span class="truncate">{filename}</span>
    <Expand size={13} class="shrink-0" />
  </span>
</button>
