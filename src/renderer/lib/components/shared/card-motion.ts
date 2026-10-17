import { cubicOut } from 'svelte/easing'
import type { FlyParams, SlideParams } from 'svelte/transition'
import { motionDuration, prefersReducedMotion } from '$lib/motion'

/** Body fold/unfold time for a card above the composer. */
const FOLD_MS = 160
/** Opening time for a card landing on the composer's top edge. */
const OPEN_MS = 160
/** Collapse-out time for a card that leaves the composer stack. */
const DISMISS_MS = 140
/** Entry-to-entry time for a card that walks through several entries. */
const STEP_MS = 190
/** How far the arriving entry travels, and the opacity it starts from. */
const STEP_TRAVEL = 16
const STEP_FROM_OPACITY = 0.35
/** A short reading that lands with a step, e.g. `2/3`. */
const TICK_MS = 130
const TICK_TRAVEL = 3
/** A row arriving inside a card body: a notice, a task, a changed file. */
const ARRIVE_MS = 160
const ARRIVE_TRAVEL = 4

/** easeOutCubic as a CSS easing, so an animation scripted by hand moves at the
 *  same rate as the transitions beside it. */
const CUBIC_OUT = 'cubic-bezier(0.215, 0.61, 0.355, 1)'

/** Which way a card moved between two of its entries: forward, or back. */
export type StepDirection = 1 | -1

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
 * The fold a body plays as its own clip height opens or closes, scripted rather
 * than left to a CSS transition on `max-height`.
 *
 * A `transition` would keep replaying on changes that are not a fold: the body's
 * measured height is re-read on every reflow, so a window or panel resize would
 * animate `max-height` frame after frame and trail the content, briefly clipping
 * a long body while it is being resized. Scripting it from the toggle runs the
 * motion only when the reader opens or closes the body, and leaves the resting
 * states to plain CSS, so a resize is a reflow and nothing more.
 *
 * `from` and `to` are the painted heights either side of the flip, in px. The
 * animation fills neither end: the resting `max-height` is already correct on
 * each side, so dropping the animation at the end lands on it exactly.
 */
export function playFoldClip(node: HTMLElement, from: number, to: number): void {
  if (prefersReducedMotion()) return
  node.animate([{ maxHeight: `${from}px` }, { maxHeight: `${to}px` }], {
    duration: FOLD_MS,
    easing: CUBIC_OUT
  })
}

/**
 * The opening a card plays as it lands on the composer's top edge: the space it
 * takes grows out of the surface below it, so the transcript above gives ground
 * frame by frame instead of the whole stack jumping by a card's height in one
 * paint.
 *
 * Use as `in:slide={cardArrive()}` on the block that appears   the composer-stack
 * slot that holds the card. Height only, no travel and no fade: the card is
 * revealed by its own growing clip, so it reads as rising out of the composer's
 * edge while the composer (which is anchored to the bottom) stays put. A `fly`
 * beside the clip would move the card inside a box that is still opening, which
 * reads as two motions fighting over the same edge.
 */
export function cardArrive(): SlideParams {
  return { duration: motionDuration(OPEN_MS), easing: cubicOut }
}

/**
 * Collapse-out animation for a card leaving the composer stack: closing it with
 * its own control, or the agent resolving what it asked for.
 *
 * Use as `out:slide={dismissSlide()}` on the card's root element. It stays an
 * `out:` rather than a `transition:` because the arrival is its own motion with
 * its own trigger (`cardArrive`): a card re-created by something that is not a
 * landing   a keyed remount, a thread switch   must not replay a dismissal on
 * its way in. Svelte only plays it when the card's own block is removed: an
 * ancestor block being replaced (a thread switch, or the whole conversation view
 * being dropped) tears the card down in the same frame, so the outgoing view can
 * never linger.
 */
export function dismissSlide(): SlideParams {
  return { duration: motionDuration(DISMISS_MS), easing: cubicOut }
}

/**
 * The motion a card's body plays when it steps to another entry, on the body
 * every entry shares.
 *
 * It is scripted rather than a Svelte transition because it is the one animation
 * that must not replay. A transition on keyed entry content runs on every insert
 * of that content, which includes the card's own first render and every unfold,
 * and both of those are not a step. This runs from the step handler instead, so
 * a card that was folded open sits still, and only a real step moves.
 *
 * Called synchronously in the step handler, before the DOM swaps: the element is
 * the body the entries share, so the travel carries across the swap instead of
 * restarting on the arriving content. It animates transform and opacity only, so
 * it composites off the main thread and never touches the layout of a card that
 * is mid-fold.
 */
export function playEntryStep(body: HTMLElement, direction: StepDirection): void {
  if (prefersReducedMotion()) return
  body.animate(
    [
      { transform: `translateX(${direction * STEP_TRAVEL}px)`, opacity: STEP_FROM_OPACITY },
      { transform: 'none', opacity: 1 }
    ],
    { duration: STEP_MS, easing: CUBIC_OUT }
  )
}

/**
 * Arrival for the short reading that changes with a step, such as the `2/3` a
 * stepper shows. Used as `in:fly` on a block keyed by the entry index, so the
 * count lands from the direction the step went rather than blinking to its next
 * value.
 */
export function tickArrive(): FlyParams {
  return { y: -TICK_TRAVEL, duration: motionDuration(TICK_MS), easing: cubicOut }
}

/**
 * Arrival for a row that appears inside a card body: a notice, an error, a task
 * the agent added, a file the turn changed. Used as `in:fly` (or `transition:fly`
 * where the row can also leave), never with a stagger, so a long list settles as
 * one block instead of a procession.
 */
export function rowArrive(): FlyParams {
  return { y: ARRIVE_TRAVEL, duration: motionDuration(ARRIVE_MS), easing: cubicOut }
}
