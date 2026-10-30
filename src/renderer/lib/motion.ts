import { cubicOut } from 'svelte/easing'
import { flip, type AnimationConfig } from 'svelte/animate'
import type { FadeParams, FlyParams, TransitionConfig } from 'svelte/transition'

/** `cubicOut` as a CSS easing, so an animation scripted by hand over the Web
 *  Animations API moves at the same rate as the transitions beside it. */
export const CUBIC_OUT_CSS = 'cubic-bezier(0.215, 0.61, 0.355, 1)'
/** How long a row travels when a restructure moves it, and how long a row takes
 *  to arrive in a list that owns its own travel. One rate for both, so a list
 *  does not read as two motions running at different speeds. */
const ROW_REFLOW_MS = 160
export const LIST_ROW_ARRIVE_MS = 120

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

/**
 * Arrival for a row that appears in a list whose travel is scripted by
 * {@link ListRowReflow}, for use as `in:` on the row whose owner just created it.
 *
 * Opacity only, deliberately: the list's own reflow reads every row's box before
 * and after an update, and a transform animating through a `fly` would be read
 * back as the row's position, so an arriving row would hand the next move a
 * starting point it never had. A row that is only fading is exactly where its box
 * says it is.
 */
export function listRowArrive(): FadeParams {
  return { duration: motionDuration(LIST_ROW_ARRIVE_MS) }
}

/**
 * The arrangement string a {@link ListRowReflow} compares between passes: the
 * rows a list is about to draw, grouped into its sections, in render order.
 *
 * Callers hand the same settled lists they render, so a capture and its play
 * always describe the list on screen: reading the string is what subscribes the
 * caller's effect to the list, and comparing it is what keeps a recompute that
 * moved no row off the layout. One builder for every list, so a new list cannot
 * invent its own format and compare unequal against itself every tick.
 */
export function rowArrangement(
  sections: readonly { key: string; rowKeys: readonly string[] }[]
): string {
  return sections.map((section) => `${section.key}#${section.rowKeys.join(',')}`).join('|')
}

/** How long a page of history takes to settle into place after a load. The rate
 *  is the app's single arrival rate (160 ms of easeOutCubic). There is no travel
 *  of its own: a page of history arrives ABOVE the reader's viewport and the
 *  layout is held still across the whole arrival, so the only thing a page may
 *  do is fade in   anything that moved as well would read as the transcript
 *  jumping under them. */
const HISTORY_ARRIVE_MS = 160
/** The most blocks one load ever animates. The reader's viewport already bounds
 *  the selection, so this only caps a pathological pane of one-line blocks; past
 *  it the blocks nearest the reader (the end of the list) are the ones kept. */
const HISTORY_ARRIVE_MAX = 12

/**
 * Arrival for the blocks a history load mounted, for use once they are in the
 * document and the reader's viewport has been restored.
 *
 * A transition cannot express this one. An `in:` intro's parameters are computed
 * before its element exists, so an intro on the transcript plays for every block
 * a load mounts   a three-page load mounts well over a hundred   and an opacity
 * animation promotes each of them to its own compositor layer. That layer churn
 * is what `src/renderer/app.css` removed from `.message-block` for good reason.
 * Here the blocks are in the document first, so only the ones inside the reader's
 * viewport fade: everything above it mounts without motion, which is where nobody
 * can watch it. The fade is the whole of the motion   the blocks never move, and
 * the layout above the reader is held still across the arrival.
 *
 * `blocks` are in document order (top to bottom) and `scroller` is the element
 * that clips them. Nothing plays under reduced motion, and a block outside the
 * scroller's viewport is left alone.
 *
 * Returns how many blocks played.
 */
export function playHistoryArrive(
  blocks: readonly HTMLElement[],
  scroller: HTMLElement | null
): number {
  if (blocks.length === 0 || prefersReducedMotion()) return 0
  const frame = scroller?.getBoundingClientRect()
  const viewTop = frame ? frame.top : 0
  const viewBottom = frame ? frame.bottom : window.innerHeight
  // The reader reads at the seam, which is the BOTTOM of what just arrived, so
  // the list is walked from its end: when the cap bites, the blocks that keep
  // the motion are the ones nearest the reader.
  const playing: HTMLElement[] = []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (playing.length >= HISTORY_ARRIVE_MAX) break
    const node = blocks[index]
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= viewTop || rect.top >= viewBottom) continue
    playing.push(node)
  }
  // Every box is read before the first animation starts: one layout for the whole
  // arrival instead of one per block.
  for (const node of playing) {
    node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: HISTORY_ARRIVE_MS,
      easing: CUBIC_OUT_CSS
    })
  }
  return playing.length
}

/**
 * The travel a row makes when the list around it is rebuilt, for lists whose rows
 * can move *between* containers.
 *
 * `animate:listRowMove` covers a row reordered inside one keyed list: Svelte's
 * own flip measures that list before and after the update. A sidebar that draws
 * its rows inside one keyed list per status group has no such single list - a
 * regrouping, or a project filter, tears rows out of one group's list and builds
 * them inside another's, so Svelte sees the row leave and a different row arrive
 * and there is nothing to travel from: the rows pop into their new place.
 *
 * This pairs the two measurements Svelte cannot take across containers. `capture`
 * records where every row is before the DOM updates, `play` walks the rows after
 * it and moves each one from its recorded place to where it now is, keyed by the
 * row's own id rather than by element identity - which is what makes a
 * brand-new element for an existing row travel instead of appearing. Both
 * measurements are taken relative to the list's scroller, so a list that scrolls
 * in the same frame carries no scroll delta into the travel.
 *
 * One instance per list. `capture` belongs in `$effect.pre` and `play` in
 * `$effect`, both reading the same list derivation so they run on exactly the
 * same passes, and `play` only moves a row a capture for this arrangement
 * actually holds. That derivation is the arrangement string: a tick that
 * recomputes the list without changing it costs one string compare, and the
 * measurements - and the layout they force - happen only when rows really do
 * change place.
 */
export class ListRowReflow {
  #before = new Map<string, { top: number; left: number }>()
  /** Whether a capture is waiting for its play. */
  #captured = false
  /** The arrangement the held capture was taken for. Compared by value, so a list
   *  that recomputed without changing costs one string compare and no measurement
   *  - the case that matters, because a live sidebar recomputes on every tick. */
  #arrangement = ''

  /**
   * Snapshot where this pass's rows are, before the DOM updates.
   *
   * `arrangement` is the caller's description of what it is about to render
   * (its sections and their rows, in order). Reading it is what subscribes the
   * caller's effect to the list, and comparing it is what keeps a recompute that
   * changed nothing off the layout: nothing past this line runs unless the rows
   * really are being arranged differently than the last pass.
   */
  capture(root: HTMLElement | null, scroller: HTMLElement | null, arrangement: string): void {
    const unchanged = arrangement === this.#arrangement
    this.#arrangement = arrangement
    this.#before.clear()
    this.#captured = false
    if (unchanged || !root) return
    this.#captured = true
    for (const node of root.querySelectorAll<HTMLElement>('[data-row-key]')) {
      const key = node.dataset.rowKey
      if (key === undefined || !isRowVisible(node)) continue
      this.#before.set(key, rowOffset(node, scroller))
    }
  }

  /** Move every row the capture holds from where it was to where it now is. */
  play(root: HTMLElement | null, scroller: HTMLElement | null, arrangement: string): void {
    if (!this.#captured || arrangement !== this.#arrangement) return
    this.#captured = false
    const before = this.#before
    this.#before = new Map()
    if (!root || prefersReducedMotion()) return
    // Every box is read before the first animation starts, so one pass of moves
    // costs one layout instead of one per row.
    const moves: { node: HTMLElement; dx: number; dy: number }[] = []
    for (const node of root.querySelectorAll<HTMLElement>('[data-row-key]')) {
      const key = node.dataset.rowKey
      const from = key === undefined ? undefined : before.get(key)
      if (from === undefined || !isRowVisible(node)) continue
      const to = rowOffset(node, scroller)
      const dx = from.left - to.left
      const dy = from.top - to.top
      if (dx === 0 && dy === 0) continue
      moves.push({ node, dx, dy })
    }
    for (const { node, dx, dy } of moves) {
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: ROW_REFLOW_MS,
        easing: CUBIC_OUT_CSS
      })
    }
  }
}

/** Whether a row is on screen, so a move nobody can see is not animated. */
function isRowVisible(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < window.innerHeight
}

/** A row's place inside its scroller's content box, so the measurement is the
 *  same before and after an update even if the list scrolled in between. */
function rowOffset(node: HTMLElement, scroller: HTMLElement | null): { top: number; left: number } {
  const rect = node.getBoundingClientRect()
  if (!scroller) return { top: rect.top, left: rect.left }
  const frame = scroller.getBoundingClientRect()
  return {
    top: rect.top - frame.top + scroller.scrollTop,
    left: rect.left - frame.left + scroller.scrollLeft
  }
}
