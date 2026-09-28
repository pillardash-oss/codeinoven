/**
 * Push the app's scrollbar colours to the embedded browser.
 *
 * The page inside a browser tab is a native `WebContents`, not part of this
 * document, so its default scrollbar cannot be reached by the application
 * stylesheet. The two tokens the app's own `::-webkit-scrollbar` rules use are
 * read here and handed to main, which installs them into every browser tab as a
 * user-origin stylesheet: reading the tokens instead of duplicating the palette
 * is what keeps a page's scrollbar the same colour as the app's in both light
 * and dark mode, and a user-origin sheet is what lets a site that styles its own
 * scrollbar keep it.
 */

import type { BrowserScrollbarTheme } from '$shared/ipc-contract'
import { invoke } from '$lib/ipc.svelte'

/** The app tokens the browser page's default scrollbar mirrors, per part. */
const SCROLLBAR_TOKENS = {
  thumb: '--color-border-strong',
  thumbHover: '--color-dimmed'
} as const satisfies Record<keyof BrowserScrollbarTheme, string>

/** The last signature pushed, so a re-apply with no theme change is a no-op. */
let lastSignature = ''

export function publishBrowserScrollbarTheme(): void {
  const styles = getComputedStyle(document.documentElement)
  const theme = {} as BrowserScrollbarTheme
  for (const key of Object.keys(SCROLLBAR_TOKENS) as (keyof BrowserScrollbarTheme)[]) {
    const value = styles.getPropertyValue(SCROLLBAR_TOKENS[key]).trim()
    // A token the stylesheet has not applied yet (the very first paint) is not a
    // reason to ship an unthemed page: the next theme apply pushes it.
    if (!value) return
    theme[key] = value
  }
  const signature = `${theme.thumb}|${theme.thumbHover}`
  if (signature === lastSignature) return
  lastSignature = signature
  void invoke('browser:setScrollbarTheme', theme).catch(() => {})
}
