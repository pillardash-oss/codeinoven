import type { Component } from 'svelte'
import type { ToastOverlayIcon } from '$shared/browser-overlay'
import ClipboardToastIcon from './ClipboardToastIcon.svelte'
import MemoryToastIcon from './MemoryToastIcon.svelte'

/**
 * The icons a toast card can lead with, and the one place a token becomes one.
 *
 * A card's icon travels as a token (`ToastOverlayIcon`), because the component
 * itself cannot cross to the window that draws the cards: the app renderer holds
 * the component, the native toast document draws it, and only plain data survives
 * the hop. Both sides of the projection read this registry, so adding an icon is
 * one entry here plus the icon option at the call site, and neither the bridge
 * nor the drawing surface learns a new special case.
 *
 * The icon a call site passes has to be one of these components: a plain lucide
 * icon would draw correctly in the app window and carry no token, which is a card
 * that loses its mark the moment it is drawn by the native surface. The icons are
 * therefore wrappers, one file each, which is also what keeps their size in the
 * drawing code rather than at every call site (sonner renders them propless).
 */
export const TOAST_ICONS: Readonly<Record<ToastOverlayIcon, Component>> = {
  memory: MemoryToastIcon,
  clipboard: ClipboardToastIcon
}

/**
 * The token a live toast's icon stands for, or `undefined` when it carries none.
 *
 * The lookup runs the registry backwards, so the two directions cannot drift: an
 * icon added above is projected the moment a call site uses it, and a component
 * that is not in the registry is reported as no icon rather than guessed at.
 */
export function toastIconToken(icon: unknown): ToastOverlayIcon | undefined {
  if (!icon) return undefined
  for (const [token, component] of Object.entries(TOAST_ICONS)) {
    if (icon === component) return token as ToastOverlayIcon
  }
  return undefined
}
