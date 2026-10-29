/**
 * The vocabulary of the thread browser's extension-bar menu.
 *
 * The thread browser draws the same extension chrome the global browser does,
 * without its rail: one button in the toolbar opens the OS menu of the extensions
 * that run in the tab's jar, and the extension a user picks renders its own popup
 * in a dropdown under that button.
 *
 * A native menu rather than a document one, for the reason every other menu in
 * this browser is native: the page on screen is a `WebContentsView` composited
 * above the renderer, and an OS popup floats above it while a DOM dropdown would
 * be drawn behind it. The profile's extension list lives in the renderer, so the
 * entries travel with the call and main turns them into menu rows; both sides read
 * this shape, so neither can disagree about what a row is.
 */

/**
 * One extension the menu offers.
 *
 * Only what a menu row has to decide: which extension the click means, what to
 * call it, and whether a click opens a popup (an extension with none opens its
 * setup page instead, which is what a browser does).
 */
export interface BrowserExtensionBarMenuEntry {
  id: string
  name: string
  hasPopup: boolean
  hasOptions: boolean
}

/**
 * The install offer the page on screen makes, when that page is an extension's
 * Web Store page and the profile does not have it yet.
 *
 * It heads the menu in both directions, because installing what the user is
 * looking at is the row they opened the menu for, and the button wears a dot for
 * as long as the offer exists.
 */
export interface BrowserExtensionBarMenuOffer {
  /** What the store page calls it, or null when its title names nothing. */
  name: string | null
  /**
   * What this offer's install is doing, in two words, or null when nothing is in
   * flight for it. A row that says so is not clickable: the install is already
   * queued.
   */
  installVerb: string | null
}

/** Everything one call to open the menu carries. */
export interface BrowserExtensionBarMenuInput {
  /** The extensions that run in the tab's jar, in install order. */
  extensions: BrowserExtensionBarMenuEntry[]
  /** The store page's offer, or null when the page offers nothing to install. */
  offer: BrowserExtensionBarMenuOffer | null
  /**
   * Whether to add the two ways in: the Web Store, which opens in this browser so
   * the page's own offer can install it, and an unpacked folder on this computer.
   * A right-click asks for them; a left-click asks only for the extensions.
   */
  installDoors: boolean
}

/** What the menu was answered with, or null when it was dismissed. */
export type BrowserExtensionBarMenuChoice =
  | { kind: 'extension'; extensionId: string }
  | { kind: 'install-offer' }
  | { kind: 'install-webstore' }
  | { kind: 'install-folder' }

/** The extensions one menu may carry. The profile's own list is shorter; this only
 *  bounds a call main cannot take on trust. */
export const MAX_BROWSER_EXTENSION_BAR_ENTRIES = 60
