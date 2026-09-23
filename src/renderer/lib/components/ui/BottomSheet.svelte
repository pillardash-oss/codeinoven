<script lang="ts">
  import { X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import Modal from './Modal.svelte'

  /**
   * The bottom sheet variant of the canonical modal.
   *
   * It is a `Modal` anchored to the bottom edge, and it inherits the portal,
   * the scrim, the `z-60` layer, Escape, the backdrop, Cmd/Ctrl+W and the
   * browser-view suppression from the base. It draws its own compact header
   * (`chrome={false}`) because a touch sheet labels itself differently from a
   * dialog, but it never re-implements the shell.
   */
  interface Props {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
  }

  let { open, title, onClose, children }: Props = $props()
</script>

<Modal {open} {title} {onClose} placement="bottom" chrome={false}>
  <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
    <p class="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-dimmed">{title}</p>
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
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">{@render children()}</div>
</Modal>
