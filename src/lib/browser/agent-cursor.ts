import { type ContrastLevel } from '../types/settings'

/**
 * How the agent's cursor is drawn over a page.
 *
 * The mark is the app's, not the page's, so its appearance comes from the app's own
 * tokens rather than from the site it is sitting on   and it has to stay legible on
 * all of them, from a pure white form to a pure black video frame. Contrast is
 * therefore structural: the gold reticle is always drawn over a wider obsidian edge,
 * and the pin that marks the exact point is ivory with an obsidian outline, so the
 * two-tone pair carries the shape on a light page (the dark edge) and on a dark page
 * (the light body) where a single-tone mark would vanish into one of them. The accent
 * is the gold the whole mark is built from, so it still says which app it belongs to
 * (see `src/renderer/app.css` for the palette these values come from).
 */
export interface AgentCursorAppearance {
  /** The pin on the exact point: always the light half of the primary pair. */
  fill: string
  /** Every separating edge: the dark half of that pair, drawn under each accent stroke. */
  stroke: string
  /** The reticle's brackets, its turning index and its press pulse, at the contrast
   *  level the app is showing. */
  accent: string
  /** Multiplier for the whole mark, from the app's own UI scale. */
  scale: number
}

/** Ivory and obsidian: the two ends of `--color-primary`, kept as literals because a
 *  page has no access to the app's stylesheet, and both are needed at once for the
 *  edge-under-every-stroke rule to hold on any page colour. */
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
