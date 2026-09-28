import { cubicOut } from 'svelte/easing'
import type { FlyParams } from 'svelte/transition'
import { motionDuration } from '$lib/motion'

/** Cross-fade time for a view entering or leaving the shell's content stage. */
const REVEAL_MS = 180
/** How far a view rises while it appears. Barely perceptible on its own, but it
 *  is what makes the switch read as movement instead of a hard swap. */
const REVEAL_RISE_PX = 6

/**
 * The shell's view switch, used as `transition:fly={pageReveal()}` on the
 * takeover pages (Scope, Settings) as they mount and unmount above the
 * workspace. The workspace matches it with its own opacity transition, so
 * out-going and in-coming views overlap instead of one blinking off before the
 * other appears.
 *
 * `motionDuration` zeroes the duration when the OS asks for reduced motion,
 * which turns the switch instant without a second code path.
 */
export function pageReveal(): FlyParams {
  return {
    y: REVEAL_RISE_PX,
    opacity: 0,
    duration: motionDuration(REVEAL_MS),
    easing: cubicOut
  }
}
