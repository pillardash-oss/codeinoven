<script lang="ts">
  import { Expand } from '@lucide/svelte'

  interface Props {
    src: string
    kind: 'audio' | 'video'
    filename: string
    onExpand: () => void
  }

  let { src, kind, filename, onExpand }: Props = $props()
</script>

<figure class="w-full min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
  <figcaption class="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted">
    <span class="truncate">{filename}</span>
    <button
      type="button"
      class="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-foreground"
      title={`Expand ${filename}`}
      aria-label={`Expand ${filename}`}
      onclick={onExpand}><Expand size={14} /></button
    >
  </figcaption>
  {#if kind === 'video'}
    <video class="max-h-96 w-full" {src} controls preload="none" playsinline>
      <track kind="captions" />
    </video>
  {:else}
    <audio class="w-full" {src} controls preload="none"></audio>
  {/if}
</figure>
