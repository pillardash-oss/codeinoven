import { type ContrastLevel } from '../types/settings'

/**
 * How the agent's cursor is drawn over a page.
 *
 * The pointer is the app's, not the page's, so its appearance comes from the app's
 * own tokens rather than from the site it is sitting on   and it has to stay legible
 * on all of them, from a pure white form to a pure black video frame. That is why the
 * pointer is drawn in the two halves of the primary pair rather than in one colour: a
 * light body with a dark outline reads as one shape on a light page (the outline) and
 * on a dark page (the body), where a single-tone pointer disappears into one of them.
 * The press ring carries the accent, so the moving mark still says which app it
 * belongs to (see `src/renderer/app.css` for the palette these values come from).
 */
export interface AgentCursorAppearance {
  /** Pointer body: always the light half of the primary pair. */
  fill: string
  /** Pointer outline and the ring's separating edge: the dark half of that pair. */
  stroke: string
  /** Press ring, themed at the contrast level the app is showing. */
  accent: string
  /** Multiplier for the pointer and its ring, from the app's own UI scale. */
  scale: number
}

/** Ivory and obsidian: the two ends of `--color-primary`, kept as literals because a
 *  page has no access to the app's stylesheet. */
const POINTER_LIGHT = '#f5f4f0'
const POINTER_DARK = '#081825'

/**
 * The Auric accent the app ships, by theme and contrast level.
 *
 * `src/renderer/app.css` darkens the gold at the two stronger levels for a light
 * palette and leaves it alone in the dark one, so this table mirrors that instead of
 * inventing a second colour.
 */
const ACCENT_BY_CONTRAST: Record<'light' | 'dark', Record<ContrastLevel, string>> = {
  light: { normal: '#d4af37', more: '#8e731e', intense: '#725d19' },
  dark: { normal: '#d4af37', more: '#d4af37', intense: '#d4af37' }
}

/** The base font size the app ships with, which is the scale's own neutral value. */
const BASE_APP_FONT_SIZE = 15

/** Bounds on the scale: below this the pointer stops being findable, above it it
 *  covers the control it is pointing at. */
const MIN_SCALE = 0.8
const MAX_SCALE = 1.8

/**
 * The appearance for the app's current theme, contrast level and UI scale.
 *
 * Pure, so it is the same answer in main (which draws the cursor) and in any preview
 * of it, and cheap enough to recompute whenever one of the three inputs changes.
 */
export function agentCursorAppearance(input: {
  dark: boolean
  contrast: ContrastLevel
  appFontSize: number
}): AgentCursorAppearance {
  const scale = Math.min(
    MAX_SCALE,
    Math.max(
      MIN_SCALE,
      (Number.isFinite(input.appFontSize) ? input.appFontSize : BASE_APP_FONT_SIZE) /
        BASE_APP_FONT_SIZE
    )
  )
  return {
    fill: POINTER_LIGHT,
    stroke: POINTER_DARK,
    accent: ACCENT_BY_CONTRAST[input.dark ? 'dark' : 'light'][input.contrast],
    // Rounded so the generated page script carries a short, stable number: the
    // recorded appearance is compared to decide whether the drawn pointer is stale.
    scale: Math.round(scale * 100) / 100
  }
}
