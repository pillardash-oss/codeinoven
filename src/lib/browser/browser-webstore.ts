/**
 * Chrome Web Store addresses, parsed in one place.
 *
 * Two surfaces ask almost the same question with different strictness. The
 * install service accepts whatever a user pasted: a bare id, a store URL, or a
 * URL that carries the id in an `id` query parameter. The browser chrome asks
 * whether the page on screen is an extension's own store page, so it checks the
 * host before believing any path segment. That second question only exists
 * because the store's own button cannot work here: "Add to Chrome" is Chrome's
 * inline-install API, which Electron does not implement, so the app has to
 * offer its own install affordance on those pages rather than wait for the
 * store to offer one.
 */

/** Where browsing the store begins. */
export const WEBSTORE_HOME_URL = 'https://chromewebstore.google.com/'

/** Chromium's extension ids: 32 characters from `a` to `p`, one per nibble. */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u

/** Hosts that serve extension pages: the current store, and the legacy
 *  `chrome.google.com/webstore` address, which redirects to it. */
const WEBSTORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

/** True for a well-formed Chromium extension id. */
export function isWebstoreExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value)
}

/**
 * The id inside whatever was pasted: a bare id, a store URL, or a URL with an
 * `id` query parameter. Null when there is no id in it, so a caller can refuse
 * the input instead of fetching a made-up address.
 */
export function webstoreExtensionIdFromInput(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (isWebstoreExtensionId(value)) return value
  const fromQuery = /[?&]id=([a-p]{32})(?:[&#]|$)/u.exec(value)
  if (fromQuery?.[1]) return fromQuery[1]
  const fromPath = /\/([a-p]{32})(?:[/?#]|$)/u.exec(value)
  if (fromPath?.[1]) return fromPath[1]
  return null
}

/**
 * The extension id a store page's own address carries, or null when the page is
 * not an extension's store page. The host is checked first, so a page that
 * happens to hold a 32-character string is never taken for one.
 */
export function webstoreExtensionIdFromUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !WEBSTORE_HOSTS.has(url.hostname)) return null
  return webstoreExtensionIdFromInput(`${url.pathname}${url.search}`)
}

/**
 * The extension a store page's title names, so an install button can say what it
 * will install instead of only what it will do. Store titles end in
 * " - Chrome Web Store", and only that suffix makes a title a store title: the
 * provisional title a tab wears before its page reports one is the address, and
 * reading a name out of it would put "chromewebstore.google.com" on the button.
 */
export function webstoreExtensionNameFromTitle(rawTitle: string): string | null {
  const suffix = /\s+[-|]\s*Chrome Web Store\s*$/u.exec(rawTitle)
  if (!suffix) return null
  const name = rawTitle.slice(0, suffix.index).trim()
  return name === '' ? null : name
}
