import { cubicOut } from 'svelte/easing'
import type { SlideParams } from 'svelte/transition'
import { motionDuration } from '$lib/motion'

/** Body fold/unfold time for a card above the composer. */
const FOLD_MS = 160
/** Collapse-out time for a card that leaves the composer stack. */
const DISMISS_MS = 140

/**
 * Fold body animation shared by every composer card, so folding lands on the
 * card's header row and expanding grows back out of it at one consistent speed.
 *
 * Use as `transition:slide={foldSlide()}` on the element inside the card's own
 * `{#if !folded}` block. `motionDuration` zeroes the duration when the OS asks
 * for reduced motion, which turns the animation into an instant show/hide.
 */
export function foldSlide(): SlideParams {
  return { duration: motionDuration(FOLD_MS), easing: cubicOut }
}

/**
 * Collapse-out animation for a card leaving the composer stack: closing it with
 * its own control, or the agent resolving what it asked for.
 *
 * Use as `out:slide={dismissSlide()}` on the card's root element. It is an
 * `out:` (not `transition:`) so a card arriving never animates, and Svelte only
 * plays it when the card's own block is removed: an ancestor block being
 * replaced (a thread switch, or the whole conversation view being dropped) tears
 * the card down in the same frame, so the outgoing view can never linger.
 */
export function dismissSlide(): SlideParams {
  return { duration: motionDuration(DISMISS_MS), easing: cubicOut }
}
