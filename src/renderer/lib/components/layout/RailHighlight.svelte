<script lang="ts">
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /**
     * Any value that changes when the current item   or the rail's items   change.
     * A rail's own box never resizes when one item takes over, so the host has to
     * hand in the identity that did change for the surface to re-measure.
     */
    revision: unknown
    /** `aria-current` value the rail puts on the item that is current, e.g.
     *  `page` for a view or `true` for a tool. */
    currentValue: string
    /** Edge the accent bar hugs, so it faces the content the item belongs to. */
    accentSide: 'left' | 'right'
  }

  let { revision, currentValue, accentSide }: Props = $props()

  let railEl = $state<HTMLElement | null>(null)
  /** Where the current-item surface sits right now; null when no item is current. */
  let surface = $state<{ top: number; height: number } | null>(null)
  /** Last measured box, kept while no item is current so the surface fades in
   *  place instead of snapping back to the top of the rail. */
  let lastSurface = $state({ top: 0, height: 32 })

  /**
   * The surface follows whichever item carries the current state, so switching
   * slides one highlight across the rail rather than fading two separate ones.
   *
   * Measured into a local before it is stored: assigning `lastSurface` straight
   * into `surface` would read the state this effect writes, which Svelte treats
   * as a loop (`effect_update_depth_exceeded`).
   */
  function syncSurface(): void {
    const root = railEl
    const current = root?.querySelector<HTMLElement>(`[aria-current="${currentValue}"]`)
    if (!root || !current) {
      surface = null
      return
    }
    const rootBox = root.getBoundingClientRect()
    const itemBox = current.getBoundingClientRect()
    const box = { top: itemBox.top - rootBox.top, height: itemBox.height }
    lastSurface = box
    surface = box
  }

  /**
   * Measures against the rail this surface is rendered into, which is its own
   * parent: a host only has to place it as a child of the rail it marks. The
   * observer covers layout resizes, such as a shorter window moving a
   * bottom-anchored group; `revision` covers item changes.
   */
  const measureRail: Attachment<HTMLElement> = (element) => {
    // Bound to a local: reading `railEl` straight after writing it would make the
    // attachment's own effect depend on the state it sets, which Svelte treats as
    // a loop (`effect_update_depth_exceeded`).
    const root = element.parentElement
    railEl = root
    const observer = new ResizeObserver(syncSurface)
    if (root) observer.observe(root)
    return () => {
      observer.disconnect()
      railEl = null
    }
  }

  $effect(() => {
    void revision
    void railEl
    syncSurface()
  })
</script>

<!--
  The current-item surface shared by both rails. It is anchored to the rail's
  padding box with `top-0`: without it the absolute box would fall back to its
  static position, which already sits inside the rail's own vertical padding, and
  the measured offset would land the surface padding-height below its item.
-->
<span
  class="pointer-events-none absolute left-1 right-1 top-0 rounded-lg bg-elevated transition-[transform,height,opacity] duration-200 ease-out motion-reduce:transition-none {surface
    ? 'opacity-100'
    : 'opacity-0'}"
  style:transform="translateY({surface?.top ?? lastSurface.top}px)"
  style:height="{surface?.height ?? lastSurface.height}px"
  aria-hidden="true"
  {@attach measureRail}
>
  <span
    class="absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary {accentSide === 'left'
      ? 'left-0'
      : 'right-0'}"
  ></span>
</span>
