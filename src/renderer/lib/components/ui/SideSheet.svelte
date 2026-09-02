<script lang="ts">
  import { X } from '@lucide/svelte'
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'

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

  // A sheet is a full-window DOM surface; the browser's native view floats above
  // every DOM surface, so it must be suppressed while the sheet is open or it
  // would cover the sheet and swallow its clicks. Keyed per instance so stacked
  // sheets don't clear each other's suppression.
  const suppressionKey = `sheet-${Math.random().toString(36).slice(2)}`
  $effect(() => {
    contextSidebarState.setFullscreenSurfaceActive(suppressionKey, open)
    return () => contextSidebarState.setFullscreenSurfaceActive(suppressionKey, false)
  })
</script>

<Dialog.Root {open} onOpenChange={(next) => !next && onClose()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70 backdrop-blur-[1px]" />
    <Dialog.Content
      class="fixed right-0 top-0 z-50 flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface shadow-xl {width}"
    >
      <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <Dialog.Title class="text-sm font-semibold text-foreground">{title}</Dialog.Title>
        <Dialog.Close
          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close"
          title="Close"
        >
          <X size={16} />
        </Dialog.Close>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-5">{@render children()}</div>

      {#if footer}
        <div
          class="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-5 py-4"
        >
          {@render footer()}
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
