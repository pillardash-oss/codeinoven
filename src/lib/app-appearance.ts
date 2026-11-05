/**
 * The appearance choices both clients offer, and the one place they are written
 * onto a document.
 *
 * The desktop and the phone draw the same product, so they offer the same table:
 * the same font families, the same weights, the same zoom steps. A change here
 * lands on both, and neither client keeps a second copy that can drift.
 *
 * What each client does with the values stays its own: the desktop hands zoom to
 * the main process (`setZoomFactor`) and syncs its canvas terminals with the mono
 * stack this returns; the phone has no main process, so it scales its own root
 * and lets every rem in the stylesheet follow.
 */

import {
  APP_FONT_OPTIONS,
  DEFAULT_APP_FONT_FAMILY,
  FONT_STACKS,
  normalizeAppFontFamily
} from './app-fonts'

export { DEFAULT_APP_FONT_FAMILY, FONT_STACKS, normalizeAppFontFamily } from './app-fonts'

export type AppearanceTheme = 'light' | 'dark' | 'system'

export interface ThemeOption {
  id: AppearanceTheme
  label: string
}

/** Follow the system is first, because it is the shipped choice. */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

/** The font families the picker offers: the app's own two, then the system's. */
export const FONT_FAMILY_OPTIONS = APP_FONT_OPTIONS

/** Font weights offered under the family, as the numbers CSS wants. */
export const FONT_WEIGHT_OPTIONS: readonly { id: number; label: string }[] = [
  { id: 200, label: 'Extra light (default)' },
  { id: 300, label: 'Light' },
  { id: 400, label: 'Regular' },
  { id: 500, label: 'Medium' }
]

/** Zoom levels offered as percentages of the interface's own size. */
export const ZOOM_LEVEL_OPTIONS: readonly { id: number; label: string }[] = [
  { id: 0.5, label: '50%' },
  { id: 0.67, label: '67%' },
  { id: 0.75, label: '75%' },
  { id: 0.8, label: '80%' },
  { id: 0.9, label: '90%' },
  { id: 1, label: '100%' },
  { id: 1.1, label: '110%' },
  { id: 1.25, label: '125%' },
  { id: 1.5, label: '150%' },
  { id: 1.75, label: '175%' },
  { id: 2, label: '200%' }
]

/** The base root size, in css pixels, that every rem in either stylesheet follows. */
export const DEFAULT_APP_FONT_SIZE = 15
export const MIN_APP_FONT_SIZE = 12
export const MAX_APP_FONT_SIZE = 18
export const DEFAULT_APP_FONT_WEIGHT = 200
export const DEFAULT_ZOOM_LEVEL = 1

export interface AppearanceTypography {
  fontFamily?: string
  appFontSize?: number
  fontWeight?: number
  /**
   * A client with no native page zoom scales its own root by this instead, and
   * every rem the layout is built from follows. A client that hands zoom to
   * something outside the stylesheet leaves it out.
   */
  zoomLevel?: number
}

function inRange(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null
}

export function normalizeAppFontSize(value: unknown): number {
  const size = inRange(value, MIN_APP_FONT_SIZE, MAX_APP_FONT_SIZE)
  return size === null ? DEFAULT_APP_FONT_SIZE : Math.round(size)
}

export function normalizeAppFontWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_APP_FONT_WEIGHT
  return FONT_WEIGHT_OPTIONS.some((option) => option.id === value) ? value : DEFAULT_APP_FONT_WEIGHT
}

export function normalizeZoomLevel(value: unknown): number {
  const zoom = inRange(value, 0.5, 2)
  return zoom === null ? DEFAULT_ZOOM_LEVEL : zoom
}

/**
 * Write the typography onto a document root: the chosen stack as the app's font,
 * the same family as its mono (a reader who picks a face wants it in both places,
 * and the system stack is the one exception because it has no mono of its own),
 * the base size every rem is measured against, and the base weight.
 *
 * Returns the mono stack, so a client that draws glyphs outside the DOM (a canvas
 * terminal) can measure the face it should load instead of resolving it again.
 */
export function applyAppearanceTypography(
  root: HTMLElement,
  typography: AppearanceTypography
): string {
  const family = normalizeAppFontFamily(typography.fontFamily)
  // The table is keyed by the ids the settings store validates, but a stylesheet
  // still needs a stack even if the record were ever missing its default entry.
  const shipped = FONT_STACKS[DEFAULT_APP_FONT_FAMILY] ?? 'ui-monospace, monospace'
  const stack = FONT_STACKS[family] ?? shipped
  const mono = family === 'system' ? shipped : stack
  root.style.setProperty('--font-app', stack)
  root.style.setProperty('--font-mono', mono)
  root.style.fontSize = `${scaledRootSize(typography.appFontSize, typography.zoomLevel)}px`
  root.style.setProperty(
    '--font-weight-base',
    String(normalizeAppFontWeight(typography.fontWeight))
  )
  return mono
}

/**
 * The size the root should actually be written at, once the reader's zoom is taken
 * into account. A client with a native page zoom ignores this; a client that has
 * only its stylesheet multiplies the base size by it, which scales every rem the
 * layout is built from without touching the viewport the shell has to fill.
 */
export function scaledRootSize(
  appFontSize: number | undefined,
  zoomLevel: number | undefined
): number {
  const size = normalizeAppFontSize(appFontSize)
  const zoom = normalizeZoomLevel(zoomLevel)
  return Math.round(size * zoom * 100) / 100
}
