import { cubicOut } from 'svelte/easing'
import { fly } from 'svelte/transition'
import type { TransitionConfig } from 'svelte/transition'
import { CUBIC_OUT_CSS, motionDuration, prefersReducedMotion, promptArrive } from '$lib/motion'
import type { Attachment } from 'svelte/attachments'

/**
 * Continuity for a prompt the reader just sent: the words leave the composer and
 * travel into the place they take in the transcript, instead of leaving the box
 * and blinking on above it.
 *
 * Only the words' own text is handed over   the composer is emptied the instant
 * the turn is dispatched, so a hand-off is the only way the reader sees where the
 * message went. The transcript row cannot carry the flight itself: it lives inside
 * the conversation's scroll container, which clips anything below its bottom edge,
 * and the composer sits exactly there. So the flight is drawn by a fixed layer
 * (`PromptFlightLayer`) and the row stays invisible until the words land on it.
 */

/** How long a departure waits for the row it belongs to. A send that is queued,
 *  parked behind a card, or otherwise delivered late drops the hand-off and plays
 *  the ordinary arrival instead of flying words that no longer mean "just now". */
const HANDOFF_TTL_MS = 600

/** The flight between the composer and the transcript. */
const FLIGHT_MS = 230
/** Where in the flight the words stop being fully painted and hand over to the row.
 *  The row starts fading in under them a little before this, so no frame shows
 *  neither the words nor the message. */
const FLIGHT_HOLD = 0.72
const LAND_DELAY_MS = 150
const LAND_MS = 120

/** A point in viewport coordinates. */
type Point = { x: number; y: number }

/** Where the words land: the ledger row's own box, in viewport coordinates. */
type LandingBox = { left: number; top: number; width: number }

type PromptDeparture = Point & { text: string; at: number }

/** The words in the air: what to draw, where they started, where they land. */
export type PromptFlight = { id: number; text: string; from: Point; to: LandingBox }

/** What an arriving prompt row needs to know about the view it lands in. */
export type PromptLanding = { createdAt: number; viewAttachedAt: number }

/**
 * The painted box of what is written in the editor.
 *
 * A range rather than the element's own rect: the editor carries padding for its
 * prompt marker, and starting the flight from the box's edge would snap the words
 * sideways on the first frame. jsdom reports no box for a range, so the element's
 * rect is the fallback there.
 */
function draftBox(editor: HTMLElement): { left: number; top: number; width: number } {
  const range = document.createRange()
  range.selectNodeContents(editor)
  const box = range.getBoundingClientRect()
  if (box.width > 0) return { left: box.left, top: box.top, width: box.width }
  const fallback = editor.getBoundingClientRect()
  return { left: fallback.left, top: fallback.top, width: fallback.width }
}

class ChatComposerPromptFlight {
  /** The flight the layer is drawing, or null when nothing is in the air. */
  flight = $state<PromptFlight | null>(null)

  private departure: PromptDeparture | null = null

  private sequence = 0

  /**
   * Remember the words leaving the composer, measured while the draft is still on
   * screen. Called the instant the message is dispatched and before the draft is
   * cleared, because the editor's words are what the flight starts from.
   */
  depart(editorId: string, text: string): void {
    const editor = document.getElementById(editorId)
    if (!editor || text.trim().length === 0) {
      this.departure = null
      return
    }
    const box = draftBox(editor)
    if (box.width === 0) {
      this.departure = null
      return
    }
    this.departure = { text, x: box.left, y: box.top, at: Date.now() }
  }

  /**
   * Try to give the arriving row the words that just left the composer.
   *
   * Returns false when there is nothing to hand over   no departure, a stale one, a
   * row that landed off screen, or reduced motion   and the caller then plays the
   * ordinary arrival.
   */
  launch(node: HTMLElement): boolean {
    const departure = this.departure
    this.departure = null
    if (!departure || prefersReducedMotion()) return false
    if (Date.now() - departure.at > HANDOFF_TTL_MS) return false
    // The words land on the ledger row itself, not on the block that wraps it with
    // the action row: the ghost is drawn with that row's own padding, so the two
    // line up when one hands over to the other.
    const landing = node.querySelector<HTMLElement>('[data-conversation-searchable]') ?? node
    const rect = landing.getBoundingClientRect()
    if (rect.width === 0 || rect.top < 0 || rect.top > window.innerHeight) return false
    this.flight = {
      id: (this.sequence += 1),
      text: departure.text,
      from: { x: departure.x, y: departure.y },
      to: { left: rect.left, top: rect.top, width: rect.width }
    }
    return true
  }

  /** The words have landed: drop them from the layer. */
  finish(id: number): void {
    if (this.flight?.id === id) this.flight = null
  }
}

export const promptFlight = new ChatComposerPromptFlight()

/**
 * Arrival for a prompt row in the transcript: the hand-off when the words just
 * left this composer, and the quiet rise (`promptArrive`) for everything else   a
 * message the queue released, one another window pushed, or history the view
 * mounted.
 *
 * The row stays invisible while the words fly and fades in as they land, so the
 * transcript never shows the message twice.
 */
export function promptLanding(
  node: HTMLElement,
  { createdAt, viewAttachedAt }: PromptLanding
): TransitionConfig {
  if (createdAt <= viewAttachedAt) return { duration: 0 }
  if (!promptFlight.launch(node)) return fly(node, promptArrive(createdAt, viewAttachedAt))
  return {
    delay: motionDuration(LAND_DELAY_MS),
    duration: motionDuration(LAND_MS),
    easing: cubicOut,
    css: (t: number) => `opacity:${t}`
  }
}

/** The offset the words travel, in viewport pixels, from the composer to the row. */
export function promptFlightTravel(flight: PromptFlight): { x: number; y: number } {
  return { x: flight.from.x - flight.to.left, y: flight.from.y - flight.to.top }
}

/**
 * The flight itself, as an attachment on the ghost the layer draws.
 *
 * The ghost is keyed by the flight's id, so a new send brings a new element and
 * this runs again for it; a run that finishes tells the store to drop the ghost
 * rather than leaving it parked over the composer.
 */
export function promptFlightAnimation(flight: PromptFlight): Attachment<HTMLElement> {
  return (node) => {
    const travel = promptFlightTravel(flight)
    const animation = node.animate(
      [
        { transform: `translate(${travel.x}px, ${travel.y}px)`, opacity: 1 },
        { transform: 'translate(0px, 0px)', opacity: 1, offset: FLIGHT_HOLD },
        { transform: 'translate(0px, 0px)', opacity: 0 }
      ],
      { duration: FLIGHT_MS, easing: CUBIC_OUT_CSS }
    )
    animation.onfinish = () => promptFlight.finish(flight.id)
    return () => animation.cancel()
  }
}
