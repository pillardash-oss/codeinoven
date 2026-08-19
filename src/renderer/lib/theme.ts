/**
 * Theme resolution shared by the desktop shell and the phone client.
 *
 * The stylesheet's dark tokens live under a `.dark` class on `<html>`, so a
 * surface that never toggles that class renders in light mode no matter what
 * the user configured. Keeping the resolution here means the phone cannot drift
 * from the desktop's appearance.
 */

export type ResolvedTheme = 'light' | 'dark'

/** `--color-app` for each theme, mirrored into the mobile status-bar colour. */
const APP_BACKGROUND: Record<ResolvedTheme, string> = {
  light: '#f7f6f2',
  dark: '#0b0b0d'
}

/**
 * Apply the resolved theme to the document.
 *
 * Also updates `meta[name="theme-color"]`, which drives the browser chrome and
 * status bar on a phone — a fixed value there leaves the notch area clashing
 * with the page whenever the theme changes.
 */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', APP_BACKGROUND[theme])
}

/**
 * Observe the OS colour-scheme preference, reporting the current value
 * immediately. Returns an unsubscribe function.
 */
export function watchSystemDark(onChange: (dark: boolean) => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  onChange(query.matches)
  const handler = (event: MediaQueryListEvent): void => onChange(event.matches)
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}

/** Resolve a stored preference against the current OS colour scheme. */
export function resolveTheme(
  preference: 'system' | 'light' | 'dark',
  systemDark: boolean
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}
