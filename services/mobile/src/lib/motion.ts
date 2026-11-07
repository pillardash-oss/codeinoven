import { cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'
import type { ScreenMotion } from './navigation'

/**
 * The app's motion, in one place: the concept's rates and its one easing, and
 * nothing that costs a layout pass beyond the box being folded.
 *
 * A fold grows out of its own edge, an arrival rises a quarter of a rem, and
 * both stop existing for a phone that asked for less motion.
 */

export const FOLD_MS = 160
export const DISMISS_MS = 140

export function prefersLessMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function slowed(): boolean {
  return prefersLessMotion()
}

/**
 * The two snapshots a screen change is drawn from: the animation the arriving
 * screen runs, the one the leaving screen runs, and how long the pair travels.
 * The names are the keyframes in `styles/base.css`; the rate and the direction are
 * decided here, once, so no screen carries its own copy of either.
 */
export interface ScreenTransition {
  in: string
  out: string
  ms: number
  /** The rate the pair travels at; a settle of a few pixels needs a slower start
   *  than a screen crossing the whole width does. */
  ease: string
}

const TRAVEL = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** A move of a few pixels reads as nothing if it is over before the eye catches it,
 *  so a settle travels evenly instead of spending its distance on the first frame. */
const SETTLE = 'cubic-bezier(0.4, 0, 0.2, 1)'

/**
 * How each kind of screen change moves. Hierarchy travels over hierarchy, the
 * dock's panels travel together, a list read the other way turns in place, and the
 * session settles in or out of the frame. Nothing here is a plain dissolve.
 */
export const SCREEN_MOTION: Readonly<Record<Exclude<ScreenMotion, 'none'>, ScreenTransition>> = {
  push: { in: 'screen-in-right', out: 'screen-out-left', ms: 300, ease: TRAVEL },
  pop: { in: 'screen-in-left', out: 'screen-out-right', ms: 280, ease: TRAVEL },
  next: { in: 'panel-in-right', out: 'panel-out-left', ms: 260, ease: TRAVEL },
  prev: { in: 'panel-in-left', out: 'panel-out-right', ms: 260, ease: TRAVEL },
  reread: { in: 'reread-in-up', out: 'reread-out-down', ms: 240, ease: SETTLE },
  'reread-back': { in: 'reread-in-down', out: 'reread-out-up', ms: 240, ease: SETTLE },
  enter: { in: 'session-in', out: 'frame-out', ms: 340, ease: SETTLE },
  leave: { in: 'frame-in', out: 'session-out', ms: 320, ease: SETTLE }
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

/**
 * A menu hanging from the control that opened it. It grows from its own top edge
 * downward, so the eye follows the same line the button already sits on, and it
 * leaves the same way instead of blinking out.
 */
export function drop(node: Element): TransitionConfig {
  return {
    duration: slowed() ? 0 : FOLD_MS,
    easing: cubicOut,
    css: (t) =>
      `opacity: ${t}; transform-origin: top left; transform: translateY(${(1 - t) * -0.375}rem) scale(${0.96 + 0.04 * t})`
  }
}
