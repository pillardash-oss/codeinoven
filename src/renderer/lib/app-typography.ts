/**
 * The app's font table, and the one place the persisted appearance settings are
 * turned into CSS on a document root.
 *
 * The app window applies them from its config store (`stores/app-config.svelte.ts`),
 * and the frameless child documents the app opens over a browser page (the
 * browser permission prompt, the toast overlay) load the app's stylesheet but not
 * its stores. They apply the same three values through here rather than copying
 * the font table, so a document drawn in a window of its own wears the same
 * typography as the app it belongs to.
 */

import { DEFAULT_CONTRAST_LEVEL, type ContrastLevel } from '$shared/types'

import { DEFAULT_APP_FONT_FAMILY, FONT_STACKS, normalizeAppFontFamily } from '$shared/app-fonts'
import { syncTerminalFonts } from './terminal/host-registry'
export { DEFAULT_APP_FONT_FAMILY, FONT_STACKS } from '$shared/app-fonts'

/** Fallbacks for documents drawn before config arrives. */
export const DEFAULT_APP_FONT_SIZE = 15
export const DEFAULT_APP_FONT_WEIGHT = 200

/** The appearance values a document needs to draw the app's typography. */
export interface AppTypography {
  fontFamily?: string
  appFontSize?: number
  fontWeight?: number
}

/**
 * Apply the app's typography to a document root: the font stack as a CSS
 * variable, the base font size on the root element (all rem-based text scales
 * from it), and the base weight.
 */
export function applyAppTypography(root: HTMLElement, typography: AppTypography): void {
  const family = normalizeAppFontFamily(typography.fontFamily)
  root.style.setProperty('--font-app', FONT_STACKS[family] ?? FONT_STACKS[DEFAULT_APP_FONT_FAMILY])
  const mono = family === 'system' ? FONT_STACKS[DEFAULT_APP_FONT_FAMILY] : FONT_STACKS[family]
  root.style.setProperty('--font-mono', mono)
  syncTerminalFonts(mono)
  root.style.fontSize = `${typography.appFontSize ?? DEFAULT_APP_FONT_SIZE}px`
  root.style.setProperty(
    '--font-weight-base',
    String(typography.fontWeight ?? DEFAULT_APP_FONT_WEIGHT)
  )
}

/**
 * Apply the reader's chosen contrast level to a document root.
 *
 * The level is carried as a `data-contrast` attribute rather than a class: it is
 * one of three named states, not a toggle, and every level including `normal`
 * gets a value so a stylesheet can select on it. `normal` is the shipped palette,
 * which the attribute spells out explicitly instead of leaving it to the absence
 * of an attribute, so a document that was never told a level still answers
 * `data-contrast="normal"` when asked.
 *
 * The stylesheet keys the stronger palettes off this attribute next to the
 * `.dark` class, so a theme switch and a contrast switch compose without either
 * one knowing about the other.
 */
export function applyContrastLevel(root: HTMLElement, level: ContrastLevel | undefined): void {
  root.dataset.contrast = level ?? DEFAULT_CONTRAST_LEVEL
}

/** Load the selected face before a canvas terminal measures and caches its glyphs. */
export async function loadTerminalFontFamily(): Promise<string> {
  const currentStack = (): string =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
    FONT_STACKS[DEFAULT_APP_FONT_FAMILY]
  const stack = currentStack()
  await document.fonts.load(`13px ${stack.split(',')[0]}`).catch(() => [])
  return currentStack() === stack ? stack : loadTerminalFontFamily()
}
