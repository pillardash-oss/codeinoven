<script lang="ts">
  import { X } from '@lucide/svelte'
  import { Portal } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'

  interface Props {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
    footer?: Snippet
    size?: 'md' | 'lg' | 'xl'
    /** Clicking the backdrop calls onClose. Off for surfaces that hold drafts. */
    closeOnBackdrop?: boolean
  }

  let {
    open,
    title,
    onClose,
    children,
    footer,
    size = 'md',
    closeOnBackdrop = true
  }: Props = $props()

  const widths = {
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-5xl'
  } as const

  // Let the Cmd/Ctrl+W "close the active surface" shortcut close this modal.
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
  <!-- Rendered through a portal so the overlay escapes ancestor stacking
       contexts (e.g. the app header's z-40) and always paints above the
       underlying view. -->
  <Portal>
    <div class="fixed inset-0 z-60 flex items-center justify-center">
      <!-- Backdrop — 13% opacity so the workspace stays visible behind -->
      <button
        class="absolute inset-0 bg-overlay/70 backdrop-blur-[1px]"
        aria-label="Close modal"
        onclick={closeOnBackdrop ? onClose : undefined}
      ></button>

      <!-- Panel -->
      <div
        class="relative mx-6 flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-2xl border bg-surface shadow-xl {widths[
          size
        ]}"
      >
        <div class="flex shrink-0 items-center justify-between border-b px-6 py-4">
          <h2 class="text-base font-semibold">{title}</h2>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close"
            title="Close"
            onclick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-6">
          {@render children()}
        </div>

        {#if footer}
          <div class="flex shrink-0 items-center justify-end gap-2 border-t bg-surface px-6 py-4">
            {@render footer()}
          </div>
        {/if}
      </div>
    </div>
  </Portal>
{/if}
