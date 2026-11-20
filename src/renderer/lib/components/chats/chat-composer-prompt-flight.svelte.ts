import { cubicOut } from 'svelte/easing'
import { fly } from 'svelte/transition'
import type { TransitionConfig } from 'svelte/transition'
import { motionDuration, prefersReducedMotion, promptArrive } from '$lib/motion'

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

/** The flight between the composer and the transcript. The row comes up under it
 *  slightly before the words arrive, so there is never a frame with neither. */
const FLIGHT_MS = 230
/** How long the words stay fully painted before they are handed to the row. */
const FLIGHT_HOLD = 0.72
const LAND_DELAY_MS = 150
const LAND_MS = 120

/** How long the layer keeps the words in the air. */
export const PROMPT_FLIGHT_MS = FLIGHT_MS

type Box = { left: number; top: number; width: number }

type PromptDeparture = Box & { text: string; at: number }

/** The words in the air: what to draw, where they started, where they land. */
export type PromptFlight = {
  id: number
  text: string
  from: Box
  to: Box
}

/** What an arriving prompt row needs to know about the view it lands in. */
export type PromptLanding = { createdAt: number; viewAttachedAt: number }

class ChatComposerPromptFlight {
  /** The flight the layer is drawing, or null when nothing is in the air. */
  flight = $state<PromptFlight | null>(null)

  private departure: PromptDeparture | null = null

  private sequence = 0

  /**
   * Remember the words leaving the composer, measured while the draft is still on
   * screen. Called the instant the message is dispatched and before the draft is
   * cleared, because the editor's box is what the flight starts from.
   */
  depart(editorId: string, text: string): void {
    const editor = document.getElementById(editorId)
    const rect = editor?.getBoundingClientRect()
    if (!rect || rect.width === 0 || text.trim().length === 0) {
      this.departure = null
      return
    }
    this.departure = {
      text,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      at: Date.now()
    }
  }

  /**
   * Try to give the arriving row the words that just left the composer.
   *
   * Returns false when there is nothing to hand over   no departure, a stale one,
   * or reduced motion   and the caller then plays the ordinary arrival.
   */
  launch(node: HTMLElement): boolean {
    const departure = this.departure
    this.departure = null
    if (!departure || prefersReducedMotion()) return false
    if (Date.now() - departure.at > HANDOFF_TTL_MS) return false
    const rect = node.getBoundingClientRect()
    if (rect.width === 0) return false
    this.flight = {
      id: (this.sequence += 1),
      text: departure.text,
      from: { left: departure.left, top: departure.top, width: departure.width },
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
  return { x: flight.from.left - flight.to.left, y: flight.from.top - flight.to.top }
}

/** Where the words stop being fully painted and hand over to the row. */
export const PROMPT_FLIGHT_HOLD = FLIGHT_HOLD
