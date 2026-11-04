import { cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'

/**
 * The app's motion, in one place: the concept's rates and its one easing, and
 * nothing that costs a layout pass beyond the box being folded.
 *
 * A fold grows out of its own edge, an arrival rises a quarter of a rem, and
 * both stop existing for a phone that asked for less motion.
 */

export const FOLD_MS = 160
export const DISMISS_MS = 140

function slowed(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** A box that opens in place: height and opacity, on the folds' own rate. */
export function fold(node: Element): TransitionConfig {
  const element = node as HTMLElement
  return {
    duration: slowed() ? 0 : FOLD_MS,
    easing: cubicOut,
    css: (t) => `overflow: hidden; height: ${t * element.scrollHeight}px; opacity: ${t}`
  }
}

/** A list, a row or a menu taking its place: one short rise, no reflow. */
export function arrive(node: Element): TransitionConfig {
  return {
    duration: slowed() ? 0 : FOLD_MS,
    easing: cubicOut,
    css: (t) => `opacity: ${t}; transform: translateY(${(1 - t) * 0.25}rem)`
  }
}
