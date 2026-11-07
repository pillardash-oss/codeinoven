<script lang="ts">
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'

  /**
   * A sheet or a drawer, on bits-ui's dialog primitive. The primitive owns the
   * parts a hand-written overlay gets wrong: the focus trap, Escape, the
   * `aria-modal` wiring, and locking the page behind it. The motion here is CSS
   * only, on transform and opacity, and it is skipped entirely when the device
   * asks for reduced motion.
   *
   * Mounting is kept one beat past `open` so the closing animation is seen
   * instead of the node disappearing before it runs.
   */
  interface Props {
    open: boolean
    onclose: () => void
    /** Where the panel sits: a bottom sheet, or a drawer from the right edge. */
    placement?: 'bottom' | 'right'
    /** A name for the panel, announced when it opens. */
    label: string
    children: Snippet
  }

  const CLOSE_MS = 180

  let { open, onclose, placement = 'bottom', label, children }: Props = $props()

  let mounted = $state(false)
  let closing = $state(false)

  $effect(() => {
    if (open) {
      mounted = true
      closing = false
      return
    }
    if (!mounted) return
    closing = true
    const timer = setTimeout(() => {
      mounted = false
      closing = false
    }, CLOSE_MS)
    return () => clearTimeout(timer)
  })

  function handleOpenChange(next: boolean): void {
    if (!next) onclose()
  }
</script>

{#if mounted}
  <!-- `open` stays true while the closing animation runs, so the primitive keeps
       the panel mounted; the timer above then takes it out of the tree. -->
  <Dialog.Root open={open || closing} onOpenChange={handleOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay class={['scrim', { closing }]} />
      <Dialog.Content
        class={[placement === 'bottom' ? 'sheet' : 'drawer', { closing }]}
        aria-label={label}
      >
        {@render children()}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}
