/**
 * One coherent Chrome identity for a browser jar.
 *
 * Chromium in this app describes itself twice, and the two descriptions disagree. The
 * user agent is rewritten into a plain Chrome string (`brandUserAgent`), while the
 * client hints Chromium sends on its own   `Sec-CH-UA`, `Sec-CH-UA-Full-Version-List`
 *   and the `navigator.userAgentData` a page can read still name Chromium. A site that
 * reads both is therefore told two different browsers rendered the page.
 *
 * Google's account pages are the case that made this matter: they answer that mismatch
 * with "This browser or app may not be secure" and refuse the sign-in. Varying only the
 * user agent, which is what earlier attempts did, could never clear it, because the
 * other half kept naming Chromium.
 *
 * So this makes one identity out of the two halves: the hints the request carries are
 * rewritten to the brand and version the user agent claims, the hints a real Chrome
 * always sends are supplied when the request has none, and the page's own
 * `navigator.userAgentData` answers the same way. Nothing is invented that a real
 * browser does not send   high-entropy hints stay the ones Chromium itself reports,
 * because only the brands were inconsistent in the first place.
 *
 * Supplying the missing hints is not optional bookkeeping. Measured on a running app
 * (`https://httpbin.org/headers`, `https://tls.peet.ws/api/all`), a browser jar sends
 * a branded Chrome user agent and no `Sec-CH-UA*` header at all: overriding the user
 * agent leaves Chromium with no client-hint metadata to publish. Real Chrome attaches
 * the three low-entropy hints to every request, so a Chrome user agent without them
 * is precisely how a site recognises an embedded or faked browser. The rewrite below
 * therefore adds the hints a real browser would have sent instead of waiting for
 * Chromium to send hints it never sends.
 */

/** The greased brand every Chromium build advertises, and its version. */
const GREASE_BRAND = 'Not_A Brand'
const GREASE_VERSION = '24'

/** One brand entry, in both the hint header's and `userAgentData`'s shape. */
export interface ChromeBrand {
  brand: string
  version: string
}

/** The major segment of a Chromium version, which is what a brand list carries. */
export function chromeMajorVersion(chromeVersion: string): string {
  const [major] = chromeVersion.split('.')
  return major && major.length > 0 ? major : chromeVersion
}

/** The brands a Chrome of this version advertises: Chrome, Chromium, and the grease. */
export function chromeBrands(chromeVersion: string): ChromeBrand[] {
  const major = chromeMajorVersion(chromeVersion)
  return [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: GREASE_BRAND, version: GREASE_VERSION }
  ]
}

/** The same brands carrying their full version, for the full-version-list hint. */
export function chromeFullVersionList(chromeVersion: string): ChromeBrand[] {
  return [
    { brand: 'Google Chrome', version: chromeVersion },
    { brand: 'Chromium', version: chromeVersion },
    { brand: GREASE_BRAND, version: GREASE_VERSION }
  ]
}

/** A brand list as one header value, in the exact shape Chromium writes it. */
export function serializeBrandList(brands: ChromeBrand[]): string {
  return brands.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(', ')
}

/** Request headers as the web-request API hands them over. */
export type ClientHintHeaders = Record<string, string | string[]>

/**
 * The same headers with every value flattened to a single string.
 *
 * Chromium may hand over a repeated header as an array, while the response the
 * web-request API expects carries strings only. Values this module rewrites are always
 * single strings, so only the ones it passed through can ever need joining.
 */
export function toStringHeaders(headers: ClientHintHeaders): Record<string, string> {
  const flattened: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = typeof value === 'string' ? value : value.join(', ')
  }
  return flattened
}

/** The low-entropy hint names every Chrome request carries, and how it spells them. */
const LOW_ENTROPY_HINT_NAMES: Record<string, string> = {
  'sec-ch-ua': 'Sec-CH-UA',
  'sec-ch-ua-mobile': 'Sec-CH-UA-Mobile',
  'sec-ch-ua-platform': 'Sec-CH-UA-Platform'
}

/**
 * The three low-entropy hints a real Chrome attaches to every request.
 *
 * They stay low-entropy on purpose: a mobile flag that is honest for this runtime and
 * the platform name Chromium itself reports, which is the same answer a Chrome on this
 * machine would give. High-entropy hints are never supplied here, because Chrome only
 * sends those to an origin that asked with `Accept-CH`.
 */
export function lowEntropyHintValues(
  chromeVersion: string,
  platform: NodeJS.Platform
): Record<string, string> {
  return {
    'sec-ch-ua': serializeBrandList(chromeBrands(chromeVersion)),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${clientHintPlatform(platform)}"`
  }
}

/**
 * The same request headers with the brand hints naming the browser the user agent
 * names, or null when the request already says what a real Chrome would say.
 *
 * The two brand hints are rewritten to this build's version. `Sec-CH-UA-Mobile` and
 * `Sec-CH-UA-Platform` are left exactly as Chromium sent them, since they describe the
 * machine correctly; when Chromium sent none of the three, as it does with our branded
 * user agent, all three are supplied with the values a Chrome on this machine sends.
 * A full-version-list hint is only ever rewritten, never added: Chrome sends that one
 * to an origin that asked for it, and only to that origin.
 */
export function coherentClientHintHeaders(
  headers: ClientHintHeaders,
  chromeVersion: string,
  platform: NodeJS.Platform
): ClientHintHeaders | null {
  const brandList = serializeBrandList(chromeBrands(chromeVersion))
  const fullVersionList = serializeBrandList(chromeFullVersionList(chromeVersion))
  const present = new Set<string>()
  let changed = false
  const rewritten: ClientHintHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (normalized === 'sec-ch-ua') {
      rewritten[name] = brandList
      present.add(normalized)
      if (value !== brandList) changed = true
      continue
    }
    if (normalized === 'sec-ch-ua-full-version-list') {
      rewritten[name] = fullVersionList
      present.add(normalized)
      if (value !== fullVersionList) changed = true
      continue
    }
    if (normalized in LOW_ENTROPY_HINT_NAMES) present.add(normalized)
    rewritten[name] = value
  }
  const supplied = lowEntropyHintValues(chromeVersion, platform)
  for (const [normalized, name] of Object.entries(LOW_ENTROPY_HINT_NAMES)) {
    if (present.has(normalized)) continue
    rewritten[name] = supplied[normalized]
    changed = true
  }
  return changed ? rewritten : null
}

/** The platform name `navigator.userAgentData` reports for this runtime. */
export function clientHintPlatform(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Linux'
}

/**
 * The preload a browser page is created with, so the page's own view of its browser
 * agrees with the headers.
 *
 * A preload runs before any document script, and `webFrame.executeJavaScript` from it
 * lands in the page's main world, which is the only world a site can read. Only the
 * brands are replaced: every other high-entropy answer Chromium gives about this
 * machine is left as it is, because it was never the part that disagreed.
 */
export function browserIdentityPreload(options: {
  chromeVersion: string
  platform: NodeJS.Platform
}): string {
  const brands = JSON.stringify(chromeBrands(options.chromeVersion))
  const fullVersionList = JSON.stringify(chromeFullVersionList(options.chromeVersion))
  const platform = JSON.stringify(clientHintPlatform(options.platform))
  return `// Generated by browser-client-hints.ts. Rewritten on every launch.
const { webFrame } = require('electron')
const source = \`(() => {
  const brands = ${brands}
  const fullVersionList = ${fullVersionList}
  const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData')
  if (!descriptor || typeof descriptor.get !== 'function') return
  const original = descriptor.get.call(navigator)
  if (!original || typeof original.getHighEntropyValues !== 'function') return
  const identity = {
    brands,
    mobile: original.mobile === true,
    platform: typeof original.platform === 'string' ? original.platform : ${platform},
    getHighEntropyValues(hints) {
      return original.getHighEntropyValues(hints).then((values) => ({
        ...values,
        brands,
        fullVersionList
      }))
    },
    toJSON() {
      return { brands, mobile: identity.mobile, platform: identity.platform }
    }
  }
  Object.defineProperty(Navigator.prototype, 'userAgentData', {
    configurable: true,
    get: () => identity
  })
})()\`
webFrame.executeJavaScript(source).catch(() => undefined)
`
}
