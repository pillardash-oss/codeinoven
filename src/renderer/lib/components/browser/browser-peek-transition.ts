/**
 * The Peek Window's flights.
 *
 * A peek is a native page shown in a modal, and a native page cannot move: the
 * main process places one `WebContentsView` at one rectangle, and the compositor
 * paints it above every DOM surface, so it takes no part in a transform, an
 * opacity ramp or a border radius. Every transition the surface has therefore runs
 * in the DOM beside it, and the whole of that decision is in this module:
 *
 *   - opening flies the panel itself, carrying its loading state, growing out of
 *     the link the user clicked;
 *   - closing and expanding fly a shell that carries a picture of the page, taken
 *     before the view is detached, so the last thing the user sees of the page is
 *     the page. A page that never painted is a blank view, so a flight with nothing
 *     to picture flies the panel itself, with its loading state, instead;
 *   - either way the geometry is one FLIP: the element that flies is laid out at
 *     the rectangle the panel occupies and a transform carries it to where the
 *     flight is, so the animation interpolates a transform and nothing else (no
 *     layout, and no per-frame work on the main thread).
 *
 * The shell is laid out at the panel's rectangle even when the flight lands
 * somewhere small, and that is deliberate: its very first frame has to be a
 * pixel-exact stand-in for the panel, or the swap from the panel to the shell
 * would be visible as a jump. Its content is drawn for the panel's size, and the
 * animation scales the whole of it, exactly as a browser scales a page into a
 * closing tab.
 *
 * The functions here are pure on purpose. They decide what flies, from where, to
 * where, and how long it takes; the component that owns the elements measures
 * them and starts the animation, and the store owns what a landing means.
 */

/** How far a peek has got. */
export type BrowserPeekPhase = 'opening' | 'open' | 'closing' | 'expanding'

/** A rectangle in the window's own pixels, which is the space the native view,
 *  the panel and the pointer all report in. */
export interface PeekRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Flight durations, in milliseconds.
 *
 * Opening is short because the user just clicked and expects the window on the
 * next beat; the exit flights are longer because they carry a picture across the
 * window and the eye has to be able to follow it.
 */
export const PEEK_OPEN_MS = 300
export const PEEK_CLOSE_MS = 260
export const PEEK_EXPAND_MS = 340

/**
 * The accent of each flight.
 *
 * A landing flight decelerates into place, so the surface reads as arriving; an
 * exit accelerates away, which is what makes it read as leaving.
 */
const OPEN_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EXIT_EASING = 'cubic-bezier(0.4, 0, 1, 1)'
const EXPAND_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'

/**
 * The share of an expanding flight spent dissolving the shell into the row it
 * lands on.
 *
 * A close lands on the surface that replaces it (the panel is the peek), so the
 * handover is invisible and must not fade. An expansion lands on a row in the
 * strip, which is a different thing entirely, so the last stretch of the flight
 * fades the shell out and leaves the row the strip has already drawn.
 */
const LANDING_FADE_START = 0.72

/**
 * The box a peek grows out of when nothing named a source, sized in window pixels.
 *
 * A peek can be opened by a page's own script rather than by a click, and the
 * pointer is then nowhere in particular. Growing out of a box at the middle of
 * where the panel is about to be is the honest answer: the surface still unfolds
 * rather than appearing.
 */
const FALLBACK_ORIGIN_WIDTH = 180
const FALLBACK_ORIGIN_HEIGHT = 140

/** What a flight carries. */
export type PeekFlightCarrier =
  /** The loading state: no part of the page is on screen. */
  | 'loading'
  /** A picture of the page, standing in for the view that cannot move with it. */
  | 'picture'

/** One flight of the peek surface. */
export interface PeekFlight {
  /** The rectangle the flight is drawn from. */
  from: PeekRect
  /** The rectangle it lands on. */
  to: PeekRect
  /**
   * Which of the two the shell is laid out at, and therefore which one its content
   * is drawn for.
   *
   * An opening is laid out at its landing rectangle, because the panel underneath
   * it is what it hands over to. An exit is laid out at the rectangle it starts
   * from, which is the panel's own, so that its first frame stands in for the panel
   * exactly.
   */
  anchor: 'from' | 'to'
  carries: PeekFlightCarrier
  durationMs: number
  easing: string
  /** Whether the flight dissolves in its last stretch, for a flight that lands on
   *  chrome of its own rather than on the surface that replaces it. */
  fadesOnLanding: boolean
}

/** Everything a flight is decided from. */
export interface PeekFlightInput {
  phase: BrowserPeekPhase
  /** Whether the page has painted and is on screen, so there is a picture of it
   *  to fly with. */
  pictured: boolean
  /** The rectangle the peek grows out of, or null when nothing named one. */
  origin: PeekRect | null
  /** The peek's own rectangle: where the panel sits while it is still, and the
   *  rectangle the shell is laid out at. */
  panel: PeekRect
  /** The rectangle an expansion lands on, or null when the strip cannot say where
   *  the new tab's row is. */
  target: PeekRect | null
}

/**
 * The flight a phase asks for, or null when it asks for none.
 *
 * `open` is the resting state: the panel is where the user left it and there is
 * nothing to animate. An expansion with no target rectangle is also nothing:
 * rather than fly a page at a guess, the surface lands where it is and the strip
 * takes over.
 */
export function peekFlightFor(input: PeekFlightInput): PeekFlight | null {
  const origin =
    input.origin ?? centeredBox(input.panel, FALLBACK_ORIGIN_WIDTH, FALLBACK_ORIGIN_HEIGHT)
  if (input.phase === 'opening') {
    return {
      from: origin,
      to: input.panel,
      anchor: 'to',
      carries: 'loading',
      durationMs: PEEK_OPEN_MS,
      easing: OPEN_EASING,
      fadesOnLanding: false
    }
  }
  if (input.phase === 'open') return null
  // Every exit starts from the panel's own rectangle, which is where the element
  // that flies it is laid out. A flight that replaces one in the air therefore
  // restarts from there rather than inheriting where that flight had got to: the
  // surface is one surface, drawn at the rectangle it is laid out at.
  const from = input.panel
  if (input.phase === 'closing') {
    return {
      from,
      to: origin,
      anchor: 'from',
      carries: input.pictured ? 'picture' : 'loading',
      durationMs: PEEK_CLOSE_MS,
      easing: EXIT_EASING,
      fadesOnLanding: false
    }
  }
  if (!input.target) return null
  return {
    from,
    to: input.target,
    anchor: 'from',
    carries: input.pictured ? 'picture' : 'loading',
    durationMs: PEEK_EXPAND_MS,
    easing: EXPAND_EASING,
    fadesOnLanding: true
  }
}

/**
 * The transform that draws an element laid out at `box` over `rect`.
 *
 * Scaling is around the top left corner, so the two translate terms are what puts
 * the box's corner on the rectangle's, and the two scale terms are what stretches
 * it to that rectangle's size.
 */
export function peekRectTransform(box: PeekRect, rect: PeekRect): string {
  const x = rect.x - box.x
  const y = rect.y - box.y
  const scaleX = scaleOf(rect.width, box.width)
  const scaleY = scaleOf(rect.height, box.height)
  return `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`
}

/**
 * The transform a flight opens on.
 *
 * The shell is created for its flight, and one frame passes between creating it and
 * starting its animation, so it writes this into its own style as it appears: its
 * first paint is already the rectangle the flight leaves, rather than the one it
 * is laid out at.
 */
export function peekFlightStartTransform(
  flight: Pick<PeekFlight, 'from' | 'to' | 'anchor'>
): string {
  return peekRectTransform(flight.anchor === 'to' ? flight.to : flight.from, flight.from)
}

/**
 * The transform keyframes a flight interpolates.
 *
 * One of the two frames is the identity, and which one it is comes from the
 * anchor: a flight laid out at its landing rectangle starts away from it and
 * arrives at nothing, and a flight laid out at its source starts at nothing and
 * ends up at the target. There is no third case, because the shell is always laid
 * out at one end of its own flight.
 */
export function peekFlightKeyframes(
  flight: Pick<PeekFlight, 'from' | 'to' | 'anchor' | 'fadesOnLanding'>
): Keyframe[] {
  const box = flight.anchor === 'to' ? flight.to : flight.from
  const start: Keyframe = { transform: peekFlightStartTransform(flight), opacity: 1 }
  const landed: Keyframe = { transform: peekRectTransform(box, flight.to), opacity: 1 }
  if (!flight.fadesOnLanding) return [start, landed]
  // The dissolve window is spelled out rather than left implicit, because the two
  // offsets are the whole shape of the landing: solid until the last stretch, then
  // gone exactly as it arrives.
  return [start, { ...landed, offset: LANDING_FADE_START }, { ...landed, offset: 1, opacity: 0 }]
}

/** What a landing means, or null while the peek is still where it belongs. */
export type PeekLanding = 'open' | 'close' | 'expand'

export function peekLandingFor(phase: BrowserPeekPhase): PeekLanding | null {
  if (phase === 'opening') return 'open'
  if (phase === 'closing') return 'close'
  if (phase === 'expanding') return 'expand'
  return null
}

/**
 * Whether the peek's page can be uncovered.
 *
 * Two things have to be true, and each of them is there for a reason:
 *
 *   - the flight has landed, because the page cannot take part in it and would
 *     otherwise sit at its final rectangle while the surface it belongs to is
 *     still on its way;
 *   - the page has reported a document and has stopped loading, because main
 *     starts the load before the surface even exists. A gate that only read
 *     "not loading" would uncover the view on the first frame, before the page
 *     had asked for anything, and show the user an empty rectangle where the
 *     loading state should have been.
 */
/**
 * Whether a peek's page is on screen.
 *
 * Three things have to be true, and each of them is there for a reason:
 *
 *   - the opening flight has landed, because the page cannot take part in it and
 *     would otherwise sit at its final rectangle while the surface that owns it is
 *     still on its way there;
 *   - the page has reported a document and has stopped loading, because main starts
 *     the load before the surface even exists. A gate that only read "not loading"
 *     would uncover an empty view on the first frame, which is exactly the flash
 *     the loading state is there to prevent;
 *   - and nothing else is holding it, which is the surface's own decision to make;
 *     this is the rule it answers with, not the whole answer.
 *
 * It is also the only state in which the page can be pictured, which the exit
 * flights depend on: a page the surface has never uncovered is a blank view, and a
 * picture of it is a blank rectangle flying across the window.
 */
export function peekPageOnScreen(input: {
  /** Whether the peek's opening flight has landed. */
  landed: boolean
  documentSeen: boolean
  loading: boolean
}): boolean {
  return input.landed && input.documentSeen && !input.loading
}

function centeredBox(panel: PeekRect, width: number, height: number): PeekRect {
  const boxWidth = Math.min(width, Math.max(1, panel.width))
  const boxHeight = Math.min(height, Math.max(1, panel.height))
  return {
    x: panel.x + (panel.width - boxWidth) / 2,
    y: panel.y + (panel.height - boxHeight) / 2,
    width: boxWidth,
    height: boxHeight
  }
}

function scaleOf(value: number, box: number): number {
  return value / Math.max(1, box)
}
