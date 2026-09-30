/**
 * The native overlay's geometry and projections: the toast stack and the browser
 * tab strip that a frameless child window draws over a browser page.
 *
 * The in-app browser's page is a native `WebContentsView` and composites above
 * every DOM node of the app window, so a toast or a floating panel drawn in the
 * DOM is painted under it. No `z-index` fixes that, so while a page covers the
 * place a surface needs, that surface moves into this window instead: same
 * place, same content, same state.
 *
 * Two processes place themselves by these numbers, so they live here rather than
 * in either of them: the app renderer (the toaster in `Toaster.svelte`, the tab
 * strip in `browser-strip-overlay.svelte.ts`), and the overlay window that draws
 * them (`src/main/browser/browser-overlay-window.ts`).
 *
 * Each projection is deliberately narrower than the thing it mirrors. It carries
 * everything the overlay can draw and nothing the boundary cannot carry: the
 * handlers stay in the app renderer, which the overlay asks to run them by
 * reporting an interaction back by id.
 */

import type { BrowserViewBounds } from './ipc/browser'

/** One toast card's width, from svelte-sonner's own `TOAST_WIDTH`. */
export const TOAST_CARD_WIDTH = 356

/** The stack's distance from the window content's right edge, from the toaster's
 *  own `offset` prop. */
export const TOAST_STACK_RIGHT = 24

/** The stack's distance from the top of the window content, from the same prop. */
export const TOAST_STACK_TOP = 56

/**
 * Clearance above the stack, which is deliberately small.
 *
 * It sets the window's top edge, and the window is placed at
 * `TOAST_STACK_TOP - this` below the window content's top, so it opens exactly
 * at the application header's bottom edge: the overlay never covers a pixel of
 * the header, not even for the frame before its click-through is armed. The
 * shadow above a card is the one thing this clips, and svelte-sonner's own
 * shadow is cast downward.
 */
export const TOAST_OVERLAY_TOP_PAD = 8

/** The overlay window's top edge, as an offset from the top of the window content. */
export const TOAST_OVERLAY_TOP = TOAST_STACK_TOP - TOAST_OVERLAY_TOP_PAD

/** The toaster's own top offset inside the overlay document, which lands a
 *  card's top edge at `TOAST_STACK_TOP` in the window's own coordinates. */
export const TOAST_OVERLAY_INNER_TOP = TOAST_STACK_TOP - TOAST_OVERLAY_TOP

/**
 * Where the overlay window sits for a window content of `content`.
 *
 * The window spans the whole content area below the application header. It has
 * to reach both the top right corner the cards occupy and the left band a
 * floating tab strip occupies, and it is transparent and click-through outside
 * whatever it is actually drawing, so its size costs nothing to those surfaces.
 */
export function browserOverlayWindowBounds(content: BrowserViewBounds): BrowserViewBounds {
  const top = Math.min(TOAST_OVERLAY_TOP, Math.max(0, content.height))
  return {
    x: content.x,
    y: content.y + top,
    width: content.width,
    height: Math.max(0, content.height - top)
  }
}

/** The status a projected toast carries, which is sonner's own set minus the two
 *  shapes only a component can render. */
export type ToastOverlayKind = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading'

/**
 * One toast, reduced to what the overlay can draw.
 *
 * `title` is always a string: every toast this app raises passes one, and the one
 * toast that passes a component instead (the memory proposal) is projected from
 * its own props rather than its component.
 */
export interface ToastOverlayToast {
  id: number | string
  kind: ToastOverlayKind
  title: string
  description?: string
  duration?: number
  /** CSS custom properties sonner honours, used by the agent-notification accent. */
  style?: string
  closeButton?: boolean
  dismissible?: boolean
  action?: { label: string }
  cancel?: { label: string }
}

/** The whole stack, and the theme the cards are drawn in. */
export interface ToastOverlayStack {
  toasts: ToastOverlayToast[]
  theme: 'light' | 'dark'
}

/**
 * A stack on its way to the overlay, stamped with the revision it belongs to.
 *
 * The overlay draws cards whose handlers live in the app renderer, so a card it
 * cannot report back about is a card with dead buttons. The revision is what the
 * overlay echoes once the cards are drawn: hearing it is the app renderer's proof
 * that the round trip works, and not hearing it is what takes the stack back
 * before the user ever presses a button that would do nothing.
 */
export interface ToastOverlayRequestStack extends ToastOverlayStack {
  /** Monotonic per app renderer, so an answer to an older stack is never
   *  mistaken for an answer to the current one. */
  revision: number
}

/**
 * How long the app renderer waits for the overlay to confirm a stack before it
 * stops using the overlay for the rest of the session.
 *
 * The wait is not there to save the card on screen: a stack the overlay never
 * confirmed was never drawn either, so there is nothing left to rescue. It is
 * there to stop handing the cards after it to a window that cannot answer, which
 * is why it is generous. The first toast of a browsing session pays for creating
 * a second renderer and loading its document, and a dev-mode module graph is
 * slower than a built one; a warm overlay confirms in a frame, long before this.
 */
export const OVERLAY_ACK_TIMEOUT_MS = 10_000

/** What the overlay reports once the content it was given is drawn. */
export interface BrowserOverlayAck {
  /** The revision of the stack it drew, once it drew one. */
  revision?: number
  /** The ids of the cards now on its screen. */
  drawn?: Array<number | string>
  /** The revision of the tab strip it drew, once it drew one. */
  stripRevision?: number
}

/** What the user did to a card in the overlay. The overlay never runs a handler
 *  itself: it reports the interaction and the app renderer runs the original. */
export type ToastOverlayInteraction = 'action' | 'cancel' | 'dismiss' | 'autoclose'

/**
 * Where the pointer is inside the overlay document, in that document's own
 * client coordinates, or null when there is no window to measure it in.
 *
 * The document asks for this whenever it has to settle the click-through state
 * from scratch, instead of believing what its own pointer events say. Events are
 * not a reliable witness here: this window ignores the mouse until a card is
 * under the pointer, and the call that lifts that is what makes the window
 * server re-evaluate the window the pointer is over, which sends back a mouseout
 * that is indistinguishable from the pointer having left. Believing it put the
 * window back into click-through while the pointer sat on a card, so the next
 * press fell through to the page and the card's button did nothing.
 */
export interface ToastOverlayCursor {
  x: number
  y: number
}

export interface ToastOverlayInteractionReport {
  id: number | string
  interaction: ToastOverlayInteraction
}

/**
 * The stack the overlay should draw, or null to take it down.
 *
 * `toasts` empty means the page still covers the stack's corner but nothing is
 * showing: the window is hidden and kept, so the next toast is instant.
 */
export type ToastOverlayRequest = ToastOverlayRequestStack | null

/**
 * One tab, reduced to what the strip the overlay draws can show.
 *
 * `icon` is a data URL   a favicon or the tab's own custom icon   or null for
 * the globe fallback; the overlay document cannot ask the main process for an
 * icon, so whatever it draws has to arrive ready to render.
 */
export interface BrowserStripOverlayTab {
  id: string
  label: string
  /** The page's address, for the row's tooltip; empty on a blank tab. */
  url: string
  icon: string | null
  /** The tab's own accent colour, or null. */
  accent: string | null
  active: boolean
  loading: boolean
  pinned: boolean
  hibernated: boolean
  audible: boolean
  muted: boolean
}

/**
 * The floating tab strip, reduced to a value.
 *
 * `width` is the panel's own width and `top` its viewport top edge, because the
 * panel's geometry is the app's layout's, not the overlay document's: the
 * document starts at the application header's bottom edge, and the header's
 * height follows the user's font size, so the strip's top inside the document is
 * `top` minus that edge.
 */
export interface BrowserStripOverlayStrip {
  width: number
  top: number
  theme: 'light' | 'dark'
  tabs: BrowserStripOverlayTab[]
}

/**
 * A strip on its way to the overlay, stamped with the revision it belongs to.
 *
 * A row here has no handler of its own: selecting or closing a tab works only
 * while the overlay can reach the app renderer that owns the strip. The overlay
 * echoes the revision once the strip is drawn, and not hearing that is what
 * makes the app renderer fall back to the DOM panel before the user clicks a row
 * that would do nothing.
 */
export interface BrowserStripOverlayRequest extends BrowserStripOverlayStrip {
  /** Monotonic per app renderer, so an answer to an older strip is never
   *  mistaken for an answer to the current one. */
  revision: number
}

/** What the user did to the strip the overlay drew. */
export type BrowserStripOverlayInteraction =
  | { kind: 'select'; tabId: string }
  | { kind: 'close'; tabId: string }
  /** The pointer entered or left the strip's own rectangle, which is what opens
   *  and closes the floating panel while the overlay is the one drawing it. */
  | { kind: 'pointer'; over: boolean }

/**
 * Everything the overlay is drawing at one moment, for the document's pull.
 *
 * One snapshot rather than one per region because the document becomes ready
 * once: it asks this question the moment its listener is bound, and asking it
 * twice would race the two answers against each other.
 */
export interface BrowserOverlaySnapshot {
  stack: ToastOverlayRequestStack | null
  strip: BrowserStripOverlayRequest | null
}
