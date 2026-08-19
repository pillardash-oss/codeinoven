<script lang="ts">
  import { X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'

  interface Props {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
    footer?: Snippet
    headerExtra?: Snippet
    /** Tailwind max-height class for the sheet panel. */
    maxHeight?: string
    /** Use a fixed height instead of a max-height (e.g. for content that should always fill the sheet). */
    fixedHeight?: boolean
  }

  let {
    open,
    title,
    onClose,
    children,
    footer,
    headerExtra,
    maxHeight = 'max-h-[82dvh]',
    fixedHeight = false
  }: Props = $props()

  $effect(() => {
    if (!open) return
    return registerOverlayClose(onClose)
  })
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') onClose()
  }}
/>

{#if open}
  <div
    class="fixed inset-0 z-40 cursor-pointer bg-black/50"
    role="presentation"
    onclick={onClose}
  ></div>
  <aside
    class="fixed right-0 bottom-0 left-0 z-50 flex {fixedHeight
      ? maxHeight.replace('max-h-', 'h-')
      : maxHeight} flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
    aria-label={title}
  >
    <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
      <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">{title}</p>
      <div class="flex items-center gap-1">
        {#if headerExtra}
          {@render headerExtra()}
        {/if}
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close {title}"
          title="Close"
          onclick={onClose}
        >
          <X size={16} />
        </button>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">{@render children()}</div>
    {#if footer}
      <div class="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-3">
        {@render footer()}
      </div>
    {/if}
  </aside>
{/if}
