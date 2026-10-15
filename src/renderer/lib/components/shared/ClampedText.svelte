<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { DEFAULT_APP_FONT_SIZE } from '$lib/app-typography'

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
rather than leaving a line sliced in half. -->
<div class={className}>
  <div class="relative">
    <div class="overflow-hidden" style:max-height={collapsed ? `${maxHeightRem}rem` : null}>
      <div {@attach measure}>{@render children()}</div>
    </div>
    {#if collapsed && overflowing}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent"
        aria-hidden="true"
      ></div>
    {/if}
  </div>
  {#if showToggle}
    <button
      type="button"
      class="mt-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
      aria-expanded={expanded}
      aria-label={collapsed ? `Show the full ${label}` : `Fold the ${label}`}
      title={collapsed ? `Show the full ${label}` : `Fold the ${label}`}
      onclick={() => onToggle(!expanded)}
    >
      {collapsed ? 'View more' : 'View less'}
    </button>
  {/if}
</div>
