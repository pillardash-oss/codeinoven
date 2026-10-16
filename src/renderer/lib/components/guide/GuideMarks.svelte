<script lang="ts">
  import { GUIDE_DOCK_WIDTH_REM } from '$lib/guide/guide-stops'
  import { guideState } from '$lib/guide/guide-state.svelte'

  /**
   * The marks a stop draws inside the app: a marker on the element it is about,
   * a rule from that element to the dock, and the notch where the rule lands.
   *
   * This is the only thing a guide draws over the interface, and it draws
   * nothing at all when the element is off screen. A stop whose element is not
   * on screen keeps its words in the dock and drops its marker, because a
   * pointer to nothing is worse than no pointer.
   *
   * It is `pointer-events-none` throughout: the app under it stays fully usable
   * while a guide talks about it.
   */

  interface Box {
    top: number
    left: number
    width: number
    height: number
  }

  /** Below this gap between the element's right edge and the dock, the rule
   *  cannot run alongside the element, so it travels over its top edge instead.
   *  A rule that crosses the controls it points at is unreadable. */
  const WIDE_GAP = 96

  /** If the dock was already open, this is the edge the marker travels from. */
  let shown = $state<Box | null>(null)
  let tween: { from: Box; to: Box; start: number } | null = null

  /** The dock's left edge, computed rather than measured: it is a column of a
   *  known width at the window's right edge, and reading it from the DOM would
   *  make the marker wait on a component that may not have mounted yet. */
  function dockEdgePx(): number {
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    return Math.round(window.innerWidth - GUIDE_DOCK_WIDTH_REM * (rootSize || 16))
  }

  const shape = $derived(guideState.stop?.shape ?? 'control')

  function equal(a: Box | null, b: Box | null): boolean {
    if (a === null || b === null) return a === b
    return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
  }

  /** Long enough to read as a movement, short enough to arrive before the copy
   *  finishes changing. The design's own travel time. */
  const TRAVEL_MS = 300
  /** A jump smaller than this is the layout settling, not a new stop, so it is
   *  followed instead of tweened. */
  const SETTLED_PX = 6

  /** cubic-bezier(0.2, 0.7, 0.2, 1), the curve the app's panels move on. */
  function travelEase(progress: number): number {
    const p1x = 0.2
    const p1y = 0.7
    const p2x = 0.2
    const p2y = 1
    const cx = 3 * p1x
    const bx = 3 * (p2x - p1x) - cx
    const ax = 1 - cx - bx
    const cy = 3 * p1y
    const by = 3 * (p2y - p1y) - cy
    const ay = 1 - cy - by
    let t = Math.max(0, Math.min(1, progress))
    for (let i = 0; i < 6; i += 1) {
      const t2 = t * t
      const t3 = t2 * t
      const value = ax * t3 + bx * t2 + cx * t - progress
      const slope = 3 * ax * t2 + 2 * bx * t + cx
      if (Math.abs(slope) < 1e-6) break
      t -= value / slope
    }
    t = Math.max(0, Math.min(1, t))
    const t2 = t * t
    const t3 = t2 * t
    return ay * t3 + by * t2 + cy * t
  }

  const lerp = (from: number, to: number, p: number): number => from + (to - from) * p

  const distance = (a: Box, b: Box): number =>
    Math.max(
      Math.abs(a.top - b.top),
      Math.abs(a.left - b.left),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height)
    )

  /** One read per frame while a guide runs, so the marker follows the layout as
   *  the tool panel steps aside and as the window resizes, and nothing is
   *  written to state unless a rounded value actually changed. */
  function measure(): void {
    const active = guideState.stop
    if (!active) {
      if (shown !== null) shown = null
      tween = null
      return
    }
    const element = document.querySelector<HTMLElement>(`[data-guide="${active.anchor}"]`)
    const bounds = element && element.checkVisibility() ? element.getBoundingClientRect() : null
    if (!bounds) {
      // The element is not on screen: the stop keeps its words and drops the
      // marker rather than pointing at nothing.
      if (shown !== null) shown = null
      tween = null
      return
    }
    const target: Box = {
      top: Math.round(bounds.top),
      left: Math.round(bounds.left),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    }

    /* The marker travels: a new stop, or the element moving further than the
       layout can explain, starts a tween from wherever the marker is now. */
    if (!tween && (shown === null || distance(shown, target) > SETTLED_PX)) {
      tween = { from: shown ?? target, to: target, start: performance.now() }
    }
    if (!tween) {
      if (!equal(shown, target)) shown = target
      return
    }
    const progress = (performance.now() - tween.start) / TRAVEL_MS
    if (progress >= 1) {
      const end = tween.to
      tween = null
      if (!equal(shown, end)) shown = end
      return
    }
    const p = travelEase(progress)
    shown = {
      top: lerp(tween.from.top, tween.to.top, p),
      left: lerp(tween.from.left, tween.to.left, p),
      width: lerp(tween.from.width, tween.to.width, p),
      height: lerp(tween.from.height, tween.to.height, p)
    }
  }

  /**
   * Measured on the layout changes that can move the element, not only on the
   * next animation frame. A hidden or fully occluded window has its animation
   * frames throttled to nothing, and a guide must still show where it is
   * pointing; the frames are what animate a travel, not what makes the marker
   * exist.
   */
  $effect(() => {
    if (!guideState.visible) {
      shown = null
      tween = null
      return
    }
    measure()
    const remeasure = (): void => measure()
    window.addEventListener('resize', remeasure)
    const anchor = document.querySelector<HTMLElement>(
      `[data-guide="${guideState.stop?.anchor ?? ''}"]`
    )
    const observer = new ResizeObserver(remeasure)
    if (anchor) observer.observe(anchor)
    let frame = requestAnimationFrame(function follow() {
      measure()
      frame = requestAnimationFrame(follow)
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', remeasure)
      observer.disconnect()
    }
  })
</script>

{#if guideState.visible}
  <div class="pointer-events-none fixed inset-0 z-40" aria-hidden="true">
    {#if shown}
      {@const dockEdge = dockEdgePx()}
      {@const wide = dockEdge - (shown.left + shown.width) < WIDE_GAP}
      {@const ruleY = wide ? shown.top - 6 : shown.top + shown.height / 2}

      <div
        class="absolute border-t border-dashed border-accent opacity-90"
        data-guide-rule
        style:top="{ruleY}px"
        style:left="{shown.left + 2}px"
        style:width="{Math.max(0, dockEdge - shown.left - 3)}px"
      ></div>
      <div
        class="absolute h-1.5 w-1.5 bg-accent"
        style:top="{ruleY - 3}px"
        style:left="{dockEdge - 3}px"
      ></div>

      <div
        class="absolute"
        data-guide-marker
        style:top="{shown.top}px"
        style:left="{shown.left}px"
        style:width="{shown.width}px"
        style:height="{shown.height}px"
      >
        {#if shape === 'region'}
          <div class="absolute inset-y-0 -left-0.5 w-px bg-accent"></div>
          <div class="absolute inset-y-0 -right-0.5 w-px bg-accent"></div>
          <div class="absolute -left-0.5 top-1/2 h-4.5 w-0.5 -translate-y-1/2 bg-accent"></div>
          <div class="absolute -right-0.5 top-1/2 h-4.5 w-0.5 -translate-y-1/2 bg-accent"></div>
        {:else if shape === 'edge'}
          <div class="absolute inset-y-0 -right-2 w-0.5 bg-accent"></div>
          <div class="absolute -left-1 -right-2 top-0 h-px bg-accent"></div>
          <div class="absolute -left-1 -right-2 bottom-0 h-px bg-accent"></div>
        {:else}
          <div class="absolute -inset-px border border-accent"></div>
          <div class="absolute -top-1 -left-1 h-2 w-2 bg-accent"></div>
          <div class="absolute -top-1 -right-1 h-2 w-2 bg-accent"></div>
          <div class="absolute -bottom-1 -left-1 h-2 w-2 bg-accent"></div>
          <div class="absolute -bottom-1 -right-1 h-2 w-2 bg-accent"></div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
