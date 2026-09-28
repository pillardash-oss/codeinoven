/**
 * The colour a page view is drawn over.
 *
 * A document that declares no background of its own is painted over the base
 * background colour of the view holding it, which is where the white a site's
 * authors never wrote down comes from: the browser window behind their content is
 * white, so a hero, a card, or a whole page that simply relies on that default
 * reads the way it was designed. Every view here used to be transparent, so those
 * same areas showed whatever the app paints behind the page, which is the dark
 * `bg-app` surface of the browser panel. On an ordinary light site that turns
 * sections black-on-black, or makes them look like holes punched through the page.
 *
 * So a view holding a document is given white, and nothing more than that: a page
 * that paints its own background covers it, a page that declares
 * `color-scheme: dark` keeps the dark canvas Chromium gives it, and a document
 * Chromium made for itself (`about:blank`) keeps whatever Chromium draws for it.
 * The one thing white must not do is repaint a surface of the app, so a view with
 * no document at all, which is a fresh blank tab, stays transparent and the
 * panel's `bg-app` is what shows through it.
 */

import type { WebContents, WebContentsView } from 'electron'

/** What a loaded page is drawn over where the page itself paints nothing. */
const LOADED_PAGE_BACKGROUND = '#ffffff'

/** No colour of our own, so the app's own surface shows through the view. */
const UNLOADED_PAGE_BACKGROUND = '#00000000'

/**
 * Whether a view holds a document at all.
 *
 * A `WebContentsView` that has never navigated reports an empty URL and has no
 * document behind it, which is exactly a fresh, blank tab: the one case where the
 * app's own surface is what should show through the view. Every other address,
 * `about:blank` included, is a document a page owns.
 */
function hasPageDocument(url: string): boolean {
  return url !== ''
}

/**
 * Give a page view the background its current document is drawn over.
 *
 * Called when a view is created, where it has no document yet, and again on every
 * committed navigation, because which background applies is a property of the
 * document on screen and a navigation replaces that document.
 */
export function applyBrowserPageBackground(view: WebContentsView): void {
  const contents: WebContents | undefined = view.webContents
  if (!contents || contents.isDestroyed()) return
  view.setBackgroundColor(
    hasPageDocument(contents.getURL()) ? LOADED_PAGE_BACKGROUND : UNLOADED_PAGE_BACKGROUND
  )
}
