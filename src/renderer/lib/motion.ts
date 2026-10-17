import { cubicOut } from 'svelte/easing'
import { flip, type AnimationConfig } from 'svelte/animate'
import type { FlyParams, TransitionConfig } from 'svelte/transition'

/** True when the user has asked the OS for reduced motion. Shared by the
 *  transitions (`motionDuration`) and by the few animations scripted by hand,
 *  so both read the same signal from one place. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Zeroes out a transition duration when the user has asked the OS for reduced
 *  motion, so panel/tree animations become instant show/hide instead of skipped
 *  entirely (which would otherwise require a second code path per component). */
export function motionDuration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms
}

/** How far a prompt rises as it lands, and over how long. The rate matches the
 *  other arrivals in the app (a row inside a card, a step reading): 160 ms of
 *  easeOutCubic, a few pixels of travel. */
const PROMPT_ARRIVE_MS = 160
const PROMPT_ARRIVE_TRAVEL = 4

/**
 * Arrival for a prompt landing in the transcript: the message the reader just
 * sent, one the queue released for them, or one another window pushed into the
 * thread. Used as `in:fly` on the user message block, so it rises the last few
 * pixels into place instead of blinking on.
 *
 * A message created before the view attached gets no duration at all: a thread
 * mounts its history a page at a time, and the pages that land after the first
 * paint would otherwise all rise, which reads as the transcript replaying itself
 * rather than as something arriving. The two stamps are compared here rather than
 * at each call site, so every surface that mounts a message follows one rule.
 *
 * Transform and opacity only, so the block's layout box is final on its first
 * frame and neither the scroll position nor the tail lock waits on the motion.
 */
export function promptArrive(createdAt: number, viewAttachedAt: number): FlyParams {
  return {
    y: PROMPT_ARRIVE_TRAVEL,
    duration: createdAt > viewAttachedAt ? motionDuration(PROMPT_ARRIVE_MS) : 0,
    easing: cubicOut
  }
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

/**
 * The travel a row makes when a keyed list reorders it, for use as
 * `animate:listRowMove` on the element that is the only child of its keyed
 * `{#each}` block.
 *
 * It exists so every reordering list moves at the same rate and skips the same
 * work: a row that is offscreen in either its old or its new position moves
 * instantly instead of animating for nobody, and the OS reduced-motion setting
 * turns the travel into a jump. Both guards read here rather than at each call
 * site, so a list cannot accidentally animate offscreen rows or ignore the
 * user's motion preference.
 */
export function listRowMove(
  node: HTMLElement,
  positions: { from: DOMRect; to: DOMRect },
  { duration = 160 }: { duration?: number } = {}
): AnimationConfig {
  const visible = [positions.from, positions.to].some(
    (rect) => rect.bottom > 0 && rect.top < window.innerHeight
  )
  return flip(node, positions, { duration: visible ? motionDuration(duration) : 0 })
}
