<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { tick } from 'svelte'
  import { fade } from 'svelte/transition'
  import { DEFAULT_APP_FONT_SIZE } from '$lib/app-typography'
  import { playFoldClip } from './card-motion'
  import { motionDuration } from '$lib/motion'

  interface Props {
    /** Whether the reader has asked for the rest of the body. Owned by the
     *  caller so a transcript that unmounts and remounts (windowed history, a
     *  thread switch) keeps the reader's choice. */
    expanded: boolean
    /**
     * Whether clamping applies at all. A reader who is searching the surface
     * gets the whole body, because a match inside the folded part would
     * otherwise be highlighted off-screen.
     */
    clamp?: boolean
    /** The collapsed height, in rem, so it scales with the base font size. */
    maxHeightRem?: number
    /** Readable name of what is clamped, used in the toggle's label and title. */
    label: string
    /** Ask for the rest of the body, or to fold it back. */
    onToggle: (expanded: boolean) => void
    class?: string
    children: Snippet
  }

  let {
    expanded,
    clamp = true,
    maxHeightRem = 20,
    label,
    onToggle,
    class: className = '',
    children
  }: Props = $props()

  /** The base font size in px, read from the document root that rem text scales
   *  from, and the body's inherent height. Both come from the measurement
   *  attachment below, so the clamp is judged in the same pixels it paints in. */
  let baseFontPx = $state(DEFAULT_APP_FONT_SIZE)
  let bodyHeightPx = $state(0)

  const collapsed = $derived(clamp && !expanded)
  const overflowing = $derived(bodyHeightPx > maxHeightRem * baseFontPx + 1)
  const showToggle = $derived(clamp && overflowing)

  /** The height the body paints at: the collapsed cap while folded, and its own
   *  measured height once opened. Opening to the measured height rather than to
   *  `none` keeps `max-height` out of the way of the body's own height, so
   *  nothing is clipped once the fold has settled, and the reader can resize the
   *  window without the clip pinching the text. */
  const clipHeight = $derived(
    collapsed ? `${maxHeightRem}rem` : bodyHeightPx > 0 ? `${bodyHeightPx}px` : null
  )

  /** The clip box, so the toggle can read its painted height and run the fold
   *  animation from it. */
  let clipEl: HTMLElement | null = null

  /** Binds the clip box to `clipEl` and clears it on teardown. */
  const bindClip: Attachment<HTMLElement> = (element) => {
    clipEl = element
    return () => {
      clipEl = null
    }
  }

  /**
   * Open or fold the body, animating the clip height between the two.
   *
   * The motion is scripted rather than a CSS `transition` on `max-height`,
   * because the resting `max-height` tracks the body's measured height and that
   * is re-read on every reflow: a transition would replay on each resize tick
   * and leave a long body trailing behind the drag. Here the heights either side
   * of the flip are read around it and handed to `playFoldClip`, so only a real
   * open or fold moves.
   */
  async function toggleBody(): Promise<void> {
    const next = !expanded
    if (!clipEl) {
      onToggle(next)
      return
    }
    const from = clipEl.getBoundingClientRect().height
    onToggle(next)
    // Let the parent's state land, so the clip's resting height is its new one
    // before the end of the motion is read.
    await tick()
    if (!clipEl) return
    playFoldClip(clipEl, from, clipEl.getBoundingClientRect().height)
  }

  /** Compares the body's intrinsic height against the clamp. The content keeps
   *  its own height while clipped, so the reading is the same folded or
   *  expanded and the toggle never flickers on expand. Re-measured on any
   *  reflow (a base font-size change, a resized window), never on a scroll. */
  const measure: Attachment<HTMLElement> = (element) => {
    const update = (): void => {
      const base = parseFloat(getComputedStyle(document.documentElement).fontSize)
      baseFontPx = Number.isFinite(base) && base > 0 ? base : DEFAULT_APP_FONT_SIZE
      bodyHeightPx = element.offsetHeight
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }
</script>

<!-- A tall body is clipped to a fixed height and the rest is one click away. The
full content stays in the DOM, so copying, citing, and finding in the
transcript keep working; only the paint is bounded. The fade marks the cut
rather than leaving a line sliced in half.

The clip height is animated on the toggle rather than by a CSS transition: the
resting `max-height` tracks the body's measured height, so a transition would
replay on every resize tick. `clipHeight` is null only before the measurement
lands, when there is nothing to animate. -->
<div class={className}>
  <div class="relative">
    <div class="overflow-hidden" {@attach bindClip} style:max-height={clipHeight}>
      <div {@attach measure}>{@render children()}</div>
    </div>
    {#if collapsed && overflowing}
      <!-- The gradient marks where the body is cut. It fades with the fold rather
           than popping in and out, so opening does not flash a shadow over the
           first lines as they grow. -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent"
        transition:fade={{ duration: motionDuration(120) }}
      ></div>
    {/if}
  </div>
  {#if showToggle}
    <!-- The whole row under the fold is the target, not just the words in it. -->
    <button
      type="button"
      class="mt-1 block w-full cursor-pointer text-left text-xs font-medium text-muted transition-colors hover:text-foreground"
      aria-expanded={expanded}
      aria-label={collapsed ? `Show the full ${label}` : `Fold the ${label}`}
      title={collapsed ? `Show the full ${label}` : `Fold the ${label}`}
      onclick={() => void toggleBody()}
    >
      {collapsed ? 'View more' : 'View less'}
    </button>
  {/if}
</div>
