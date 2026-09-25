import type { ResolvedTheme } from '$lib/theme'

/**
 * The colour scheme the interface is painted in.
 *
 * This cannot be asked of a media query. A user picks light or dark in
 * Appearance independently of the OS, the choice is painted as a `dark` class
 * on `<html>`, and nothing tells Electron about it, so
 * `prefers-color-scheme` inside the renderer keeps answering for the OS.
 *
 * Provider markdown is where that difference becomes visible. A GitHub comment
 * selects between two assets with `<source media="(prefers-color-scheme: dark)">`,
 * and a renderer that asked the browser would draw a white logo on a white panel
 * for anyone whose OS disagrees with their setting.
 *
 * Whoever paints the class records it here, and the markdown renderer reads it,
 * so a theme switch re-renders the blocks that carry such a picture.
 */
class SchemeState {
  /** Seeded from the class `theme-init.js` already painted, so the first render
   *  agrees with what is on screen instead of flipping once the config loads. */
  #scheme = $state<ResolvedTheme>(paintedScheme())

  /** The scheme currently on screen. Reading it subscribes to changes. */
  get current(): ResolvedTheme {
    return this.#scheme
  }

  get isDark(): boolean {
    return this.#scheme === 'dark'
  }

  /** Record the scheme a surface just painted. */
  sync(theme: ResolvedTheme): void {
    this.#scheme = theme
  }
}

function paintedScheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export const schemeState = new SchemeState()
