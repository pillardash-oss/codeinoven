/**
 * The toast stack's geometry, and the projection that carries a toast into the
 * native window that draws it over a browser page.
 *
 * The in-app browser's page is a native `WebContentsView` and composites above
 * every DOM node of the app window, so a toast drawn in the DOM is painted under
 * it. No `z-index` fixes that, so while a page covers the stack's corner the
 * toaster renders in a frameless, transparent child window instead, at the same
 * place, with the same cards, from the same state.
 *
 * Two processes place themselves by these numbers, so they live here rather than
 * in either of them: the app renderer's toaster (`Toaster.svelte`), and the
 * overlay window that mirrors it (`src/main/browser/toast-overlay-window.ts`).
 *
 * The projection is deliberately narrower than sonner's own toast type. It
 * carries everything the overlay can draw (text, status, duration, the accent
 * style, the two button labels) and nothing the boundary cannot carry: the
 * click, dismiss and auto-close handlers stay in the app renderer, which the
 * overlay asks to run them by reporting the interaction back.
 */

import type { BrowserViewBounds } from './ipc/browser'

/** One toast card's width, from svelte-sonner's own `TOAST_WIDTH`. */
export const TOAST_CARD_WIDTH = 356

/** The stack's distance from the window content's right edge, from the toaster's
 *  own `offset` prop. */
export const TOAST_STACK_RIGHT = 24

/** The stack's distance from the top of the window content, from the same prop. */
export const TOAST_STACK_TOP = 56

/** Clearance the overlay window keeps beside and below the stack, which is the
 *  room the card's shadow needs. There is nothing to draw there. */
export const TOAST_OVERLAY_SIDE_PAD = 24

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

/** Tall enough for a full stack of three cards, their gaps, and the expansion
 *  that hovering one causes. The rest of the window is transparent. */
export const TOAST_OVERLAY_HEIGHT = 420

export const TOAST_OVERLAY_WIDTH = TOAST_CARD_WIDTH + TOAST_STACK_RIGHT + TOAST_OVERLAY_SIDE_PAD * 2

/** The overlay window's top edge, as an offset from the top of the window content. */
export const TOAST_OVERLAY_TOP = TOAST_STACK_TOP - TOAST_OVERLAY_TOP_PAD

/** The toaster's own top offset inside the overlay document, which lands a
 *  card's top edge at `TOAST_STACK_TOP` in the window's own coordinates. */
export const TOAST_OVERLAY_INNER_TOP = TOAST_STACK_TOP - TOAST_OVERLAY_TOP

/**
 * Where the overlay window sits for a window content of `content`.
 *
 * Its right edge is flush with the content's right edge, because the toaster's
 * own right offset inside the document then lands the cards at the same
 * `TOAST_STACK_RIGHT` they have in the app window.
 */
export function toastOverlayWindowBounds(content: BrowserViewBounds): BrowserViewBounds {
  return {
    x: content.x + content.width - TOAST_OVERLAY_WIDTH,
    y: content.y + TOAST_OVERLAY_TOP,
    width: TOAST_OVERLAY_WIDTH,
    height: TOAST_OVERLAY_HEIGHT
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

/** What the user did to a card in the overlay. The overlay never runs a handler
 *  itself: it reports the interaction and the app renderer runs the original. */
export type ToastOverlayInteraction = 'action' | 'cancel' | 'dismiss' | 'autoclose'

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
export type ToastOverlayRequest = ToastOverlayStack | null
