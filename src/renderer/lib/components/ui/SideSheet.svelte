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
    /** Tailwind width class for the sheet panel. */
    width?: string
  }

  let { open, title, onClose, children, footer, width = 'max-w-md' }: Props = $props()

  // Let the Cmd/Ctrl+W "close the active surface" shortcut close this sheet.
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
  <div class="fixed inset-0 z-50">
    <button
      class="absolute inset-0 bg-overlay/70 backdrop-blur-[1px]"
      aria-label="Close panel"
      title="Close panel"
      onclick={onClose}
    ></button>

    <div
      class="absolute right-0 top-0 flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface shadow-xl {width}"
    >
      <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <h2 class="text-sm font-semibold text-foreground">{title}</h2>
        <button
          type="button"
          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close"
          title="Close"
          onclick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-5">{@render children()}</div>

      {#if footer}
        <div
          class="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-5 py-4"
        >
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
