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

/** Font stacks for the family ids offered in Appearance settings. Keep in
 *  sync with FONT_FAMILIES in src/main/ipc/ipc-handlers.ts. */
export const FONT_STACKS: Record<string, string> = {
  'jetbrains-mono':
    "'JetBrains Mono Variable', 'JetBrainsMono Nerd Font Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  satoshi: "'Satoshi', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'sf-mono': "'SF Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  menlo: 'Menlo, ui-monospace, monospace',
  monaco: 'Monaco, ui-monospace, monospace',
  'fira-code': "'Fira Code', 'JetBrains Mono Variable', ui-monospace, monospace"
}

/** Fallbacks for a document that is drawn before any config has reached it. */
export const DEFAULT_APP_FONT_FAMILY = 'jetbrains-mono'
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
  const family = typography.fontFamily ?? DEFAULT_APP_FONT_FAMILY
  root.style.setProperty('--font-app', FONT_STACKS[family] ?? FONT_STACKS[DEFAULT_APP_FONT_FAMILY])
  root.style.fontSize = `${typography.appFontSize ?? DEFAULT_APP_FONT_SIZE}px`
  root.style.setProperty(
    '--font-weight-base',
    String(typography.fontWeight ?? DEFAULT_APP_FONT_WEIGHT)
  )
}
