<script lang="ts">
  import type { Snippet } from 'svelte'
  import Modal from './Modal.svelte'

  /**
   * The side sheet variant of the canonical modal.
   *
   * It is a `Modal` anchored to the right edge, and it inherits everything the
   * base owns: the portal, the scrim, the `z-60` layer, initial focus, Escape,
   * the backdrop, Cmd/Ctrl+W and Cmd/Ctrl+Enter, the browser-view suppression,
   * the header, and a footer that never scrolls. Only the placement differs, so
   * a sheet can never drift from the modals it stacks with.
   */
  interface Props {
    open: boolean
    title: string
    onClose: () => void
    children: Snippet
    footer?: Snippet
    /** Panel width. */
    size?: 'md' | 'lg' | 'xl'
  }

  let { open, title, onClose, children, footer, size = 'md' }: Props = $props()
</script>

<Modal {open} {title} {onClose} placement="right" {size} {footer}>
  {@render children()}
</Modal>
