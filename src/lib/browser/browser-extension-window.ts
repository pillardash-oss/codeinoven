/**
 * The one window this browser lends an extension, and the address that names it.
 *
 * Electron draws no toolbar and no extension window, so an extension that asks for
 * a window with `chrome.windows.create` is answered by the worker shim with a
 * window id of this app's own. That id is a fiction until the app reports it back:
 * a window the extension closes   and a password manager's passkey window does
 * exactly that, to abandon a ceremony it no longer has a prompt for   is only gone
 * for the extension once `chrome.windows.onRemoved` names it.
 *
 * The two ids are therefore a contract between the shim that invents them and the
 * app that reports the window ending, which is why they live here and the shim
 * carries a pointer to this file rather than its own copy of the meaning.
 */
export const BROWSER_EXTENSION_HOSTED_WINDOW_ID = 2147483646

/** The tab id that window's own page is reported under. */
export const BROWSER_EXTENSION_HOSTED_TAB_ID = 2147483645

/**
 * The query parameter an extension uses to name the one window it acts in.
 *
 * Bitwarden opens its passkey prompt as a popout   `?uilocation=popout&
 * singleActionPopout=vault_Fido2Popout_<id>`   and closes that popout by finding
 * the tab whose address carries the same key. Two of its windows are therefore two
 * addresses, not two presentations of one: hosting them as one popup surface is
 * what made a passkey prompt replace the vault popup and never appear at all.
 */
export const BROWSER_EXTENSION_POPOUT_KEY_PARAM = 'singleActionPopout'

/**
 * The key that makes one extension window distinct from another, or null for a
 * page that names none.
 *
 * A page with no key is not a popout a browser would give its own window: the
 * extension's action popup is the address every click on its icon lands on, and it
 * keeps the retained surface this browser already holds for it.
 */
export function extensionWindowKey(url: string): string | null {
  try {
    const key = new URL(url).searchParams.get(BROWSER_EXTENSION_POPOUT_KEY_PARAM)
    return key !== null && key.length > 0 ? key : null
  } catch {
    return null
  }
}
