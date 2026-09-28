import { cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'

/** Zeroes out a transition duration when the user has asked the OS for reduced
 *  motion, so panel/tree animations become instant show/hide instead of skipped
 *  entirely (which would otherwise require a second code path per component). */
export function motionDuration(ms: number): number {
  if (typeof window === 'undefined') return ms
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
}

/**
 * Animates an element's layout width between 0 and its own width, so whatever
 * sits beside it in a flex row is pushed (or released) frame by frame and the
 * panel reads as being widened rather than as a box that slides over the page.
 *
 * `fly` cannot express that: it translates the element while its layout box
 * stays at full size, so the neighbour jumps to its final position on the first
 * frame and the panel then slides across it. This keeps the box in the flow and
 * animates its width instead, which is the same reflow a width drag produces.
 */
export function slideWidth(
  node: HTMLElement,
  { duration = 200, easing = cubicOut }: { duration?: number; easing?: (t: number) => number } = {}
): TransitionConfig {
  // Measured once, while the element still has its own width (the inline width
  // its owner sets). The initial keyframe then starts it at zero.
  const width = node.getBoundingClientRect().width
  return {
    duration,
    easing,
    css: (t: number) => `overflow: hidden; width: ${t * width}px;`
  }
}
