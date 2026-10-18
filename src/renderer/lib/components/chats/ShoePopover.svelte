<script lang="ts">
  import type { Snippet } from 'svelte'
  import { trackEscapeMenu } from '$lib/overlay-close.svelte'
  import { POPOVER_EDGE_GAP, sizeUpwardPopover } from '$lib/popover-room'

  interface Props {
    /** Accessible name of the panel, and the subject of the close control. */
    label: string
    /**
     * Whether hovering the trigger opens the panel. Reads that a hover already
     * restores elsewhere   a custom tooltip, a title   turn this off and let a tap
     * be the only way in, so the two never stack on top of each other.
     */
    openOnHover?: boolean
    /** Called as the panel is shown, for readings that are fetched on reveal. */
    onReveal?: () => void
    /** Called as the panel is hidden. */
    onHide?: () => void
    /** The panel frame's own padding, since its content is what differs. */
    panelClass?: string
    /** The trigger's own box, for the segments that sit in the shoe's row. */
    class?: string
    /** The control that opens the panel; the toggle and the open state come from here. */
    trigger: Snippet<[{ open: boolean; toggle: () => void }]>
    children: Snippet
  }

  let {
    label,
    openOnHover = true,
    onReveal,
    onHide,
    panelClass = 'p-3',
    class: className = '',
    trigger,
    children
  }: Props = $props()

  /** Hovering opens the panel; a tap opens it and keeps it open, because a finger
   *  has no hover to hold it there. */
  let hovered = $state(false)
  let pinned = $state(false)
  let open = $derived(hovered || pinned)

  /**
   * The panel's room is re-measured every time it is about to be shown: the dock
   * column it sits in is dragged rather than resized, so a window resize listener
   * alone would leave the panel sized from the column's previous width.
   */
  let panel: HTMLElement | null = null

  function measureRoom(): void {
    if (panel) sizeUpwardPopover(panel, { gap: POPOVER_EDGE_GAP })
  }

  function attachPanel(node: HTMLElement): () => void {
    panel = node
    measureRoom()
    window.addEventListener('resize', measureRoom)
    return () => {
      panel = null
      window.removeEventListener('resize', measureRoom)
    }
  }

  function reveal(): void {
    if (open) return
    hovered = true
    measureRoom()
    onReveal?.()
  }

  function hide(): void {
    if (pinned) return
    hovered = false
    onHide?.()
  }

  function toggle(): void {
    if (pinned) {
      dismiss()
      return
    }
    pinned = true
    measureRoom()
    onReveal?.()
  }

  function dismiss(): void {
    const wasOpen = open
    pinned = false
    hovered = false
    if (wasOpen) onHide?.()
  }

  trackEscapeMenu(() => pinned, dismiss)

  const panelWrapperClass = $derived(
    `absolute bottom-full right-0 z-40 w-72 pb-1.5 ${
      open ? 'visible opacity-100' : 'invisible opacity-0'
    }`
  )
</script>

<div
  class="group relative {className}"
  role="group"
  aria-label={label}
  onpointerenter={openOnHover ? reveal : undefined}
  onpointerleave={openOnHover ? hide : undefined}
>
  {@render trigger({ open, toggle })}

  <!-- A tap keeps the panel open with no pointer to hold it there, so the next tap
       anywhere else closes it the way a menu does. -->
  {#if pinned}
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close {label}"
      onclick={dismiss}
    ></button>
  {/if}

  <!-- The panel opens above the trigger with a gap, and that gap is this wrapper's own
       bottom padding, never a margin: a margin is a dead band the pointer crosses on
       its way up, and the panel would close under the user's hand as they reached for
       it. The wrapper is also what `sizeUpwardPopover` caps, so the panel keeps the
       right edge it hangs from while its width follows the room it has. -->
  <div {@attach attachPanel} class={panelWrapperClass} role="dialog" aria-label={label}>
    <div
      class="popover-panel w-full overflow-y-auto border border-border bg-surface shadow-lg {panelClass}"
    >
      {@render children()}
    </div>
  </div>
</div>

<style>
  /* The height the trigger has above it, published by `sizeUpwardPopover`, is the
     cap; the fallback covers the first frame before that measurement lands. */
  .popover-panel {
    max-height: var(--popover-max-height, min(26rem, 60vh));
  }
</style>
