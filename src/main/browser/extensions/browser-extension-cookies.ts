/**
 * A jar's cookies, in the shape `chrome.cookies` hands an extension.
 *
 * Electron compiles `chrome.cookies` out of this runtime and refuses the manifest
 * permission that asks for it, so an extension that forwards a site's session
 * cookie with a download   a download manager capturing a file behind a login is
 * the case this exists for   has nothing to read. The cookies themselves are there:
 * every page in the jar sends them, so the jar's session holds them already.
 *
 * The two shapes are close but not the same. Electron answers `cookies.get` with
 * the values it was given, leaves `path` and `domain` optional, and names the
 * same-site policy exactly as Chrome does; Chrome also carries `hostOnly`,
 * `session` and `storeId`, and a cookie an extension forwards is read for those as
 * much as for its value.
 *
 * What this module does not decide is whose cookies may be read. A jar is one
 * identity, and only the session of the jar the extension is loaded in may answer
 * for it; that rule belongs to the service that owns the session, so the mapping
 * here stays pure.
 */

import type { Cookie, CookiesGetFilter } from 'electron'

/**
 * The filter `chrome.cookies.get` and `getAll` accept, as the wire carries it.
 *
 * Chrome also allows a `storeId`, which the app has exactly one of: the jar's own
 * session. It is deliberately absent from the filter so a worker cannot name a
 * store it does not run in.
 */
export interface BrowserExtensionCookieFilter {
  url?: string
  name?: string
  domain?: string
  path?: string
  secure?: boolean
  session?: boolean
}

/** Chrome's `SameSiteStatus` for a cookie. */
export type BrowserExtensionCookieSameSite = 'no_restriction' | 'lax' | 'strict' | 'unspecified'

/** One cookie as `chrome.cookies` reports it. */
export interface BrowserExtensionCookie {
  name: string
  value: string
  domain: string
  /** True when the domain was set by the cookie's own host rather than by a
   *  `Domain` attribute, which is what tells an extension whether the value is
   *  also sent to subdomains. */
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  /** True for a cookie with no expiry, which is why `expirationDate` is absent. */
  session: boolean
  expirationDate?: number
  /** Chrome names a cookie store; this app has the jar's own session only. */
  storeId: string
  sameSite: BrowserExtensionCookieSameSite
}

/**
 * The Electron query that asks the same question the extension's filter asked.
 *
 * The field names agree today, so the mapping is written out rather than spread so
 * that a runtime that renames one is a compile error here instead of a filter that
 * silently widens to the whole jar.
 */
export function toCookieQuery(filter: BrowserExtensionCookieFilter): CookiesGetFilter {
  const query: CookiesGetFilter = {}
  if (filter.url !== undefined) query.url = filter.url
  if (filter.name !== undefined) query.name = filter.name
  if (filter.domain !== undefined) query.domain = filter.domain
  if (filter.path !== undefined) query.path = filter.path
  if (filter.secure !== undefined) query.secure = filter.secure
  if (filter.session !== undefined) query.session = filter.session
  return query
}

/** Electron's same-site values are Chrome's, but an unknown one is not allowed to
 *  reach the wire as itself: Chrome would reject the whole cookie for a value it
 *  does not know, which would cost the extension the value it asked for. */
function toSameSite(value: string | undefined): BrowserExtensionCookieSameSite {
  switch (value) {
    case 'no_restriction':
    case 'lax':
    case 'strict':
    case 'unspecified':
      return value
    default:
      return 'unspecified'
  }
}

/** One Electron cookie, in the shape `chrome.cookies` documents. */
export function toExtensionCookie(cookie: Cookie): BrowserExtensionCookie {
  const domain = cookie.domain ?? ''
  const mapped: BrowserExtensionCookie = {
    name: cookie.name,
    value: cookie.value,
    domain,
    // Chrome's rule, read from the domain itself: a leading dot is the only thing
    // that separates a cookie a site set for its subdomains from one set for its
    // own host. Electron reports `hostOnly` too, but deriving it here keeps the
    // domain and the flag from ever disagreeing.
    hostOnly: !domain.startsWith('.'),
    path: cookie.path ?? '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    session: typeof cookie.expirationDate !== 'number',
    storeId: '0',
    sameSite: toSameSite(cookie.sameSite)
  }
  if (typeof cookie.expirationDate === 'number') mapped.expirationDate = cookie.expirationDate
  return mapped
}
