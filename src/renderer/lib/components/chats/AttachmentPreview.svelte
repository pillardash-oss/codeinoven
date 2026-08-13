<script lang="ts">
  import { X, Download, FileQuestion } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { PromptAttachment } from '$shared/types'
  import { attachmentPreviewKind } from '$lib/mime'

  interface Props {
    attachment: PromptAttachment
    /** blob: URL for image/pdf previews, keyed by the attachment url. */
    src?: string
    /** Decoded text content for markdown/plain-text previews. */
    text?: string
    onClose: () => void
  }

  let { attachment, src, text, onClose }: Props = $props()

  const filename = $derived(attachment.filename ?? 'file')
  const kind = $derived(attachmentPreviewKind(attachment.mime, filename))

  function triggerDownload(url: string, name: string): void {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function handleDownload(): void {
    if (kind === 'markdown' || kind === 'text') {
      if (text === undefined) return
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      triggerDownload(URL.createObjectURL(blob), filename)
      return
    }
    if (src) triggerDownload(src, filename)
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
    class="relative flex flex-col items-center {kind === 'image'
      ? 'max-h-[90vh] max-w-[90vw]'
      : 'h-[85vh] w-[85vw]'}"
    onclick={(e: MouseEvent) => e.stopPropagation()}
  >
    {#if kind === 'image' && src}
      <img
        {src}
        alt={filename}
        class="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
      />
    {:else if kind === 'video' && src}
      <video
        {src}
        controls
        preload="metadata"
        class="max-h-[75vh] max-w-[85vw] rounded-lg shadow-2xl"
      >
        <track kind="captions" />
      </video>
    {:else if kind === 'audio' && src}
      <audio {src} controls preload="metadata" class="w-full max-w-xl"></audio>
    {:else if kind === 'pdf' && src}
      <iframe
        {src}
        class="h-full w-full rounded-lg border-0 shadow-2xl"
        title={`Preview ${filename}`}
      ></iframe>
    {:else if kind === 'markdown' && text !== undefined}
      <div
        class="flex min-h-0 w-full flex-1 flex-col overflow-auto rounded-lg bg-surface p-4 shadow-2xl"
      >
        <MarkdownView {text} class="text-sm text-foreground" />
      </div>
    {:else if kind === 'text' && text !== undefined}
      <pre
        class="min-h-0 w-full flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed text-foreground shadow-2xl break-words">{text}</pre>
    {:else}
      <div
        class="flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg bg-surface text-muted shadow-2xl"
      >
        <FileQuestion size={32} class="text-dimmed" />
        <span class="text-xs">No preview available for this file type</span>
      </div>
    {/if}
    <div class="mt-3 flex items-center gap-3">
      <span class="max-w-full truncate text-xs text-white/70">{filename}</span>
    </div>
  </div>
  <button
    type="button"
    class="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
    aria-label="Close preview"
    title="Close (Esc)"
    onclick={onClose}
  >
    <X size={18} />
  </button>
  <button
    type="button"
    class="absolute right-4 top-16 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
    aria-label="Download file"
    title="Download"
    onclick={handleDownload}
  >
    <Download size={16} />
  </button>
</div>
