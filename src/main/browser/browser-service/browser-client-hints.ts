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
 * So this makes one identity out of the two halves: the hints Chromium already sends are
 * rewritten to the brand and version the user agent claims, and the page's own
 * `navigator.userAgentData` answers the same way. Nothing is invented that a real
 * browser does not send   high-entropy hints stay the ones Chromium itself reports,
 * because only the brands were inconsistent in the first place.
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

/**
 * The same request headers with the brand hints naming the browser the user agent
 * names, or null when there was nothing to rewrite.
 *
 * Only the two brand hints are touched: `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform`
 * already describe this machine correctly, and rewriting a hint Chromium never sent
 * would make the request look less like a browser's rather than more.
 */
export function coherentClientHintHeaders(
  headers: ClientHintHeaders,
  chromeVersion: string
): ClientHintHeaders | null {
  const brandList = serializeBrandList(chromeBrands(chromeVersion))
  const fullVersionList = serializeBrandList(chromeFullVersionList(chromeVersion))
  let changed = false
  const rewritten: ClientHintHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (normalized === 'sec-ch-ua') {
      rewritten[name] = brandList
      changed = true
      continue
    }
    if (normalized === 'sec-ch-ua-full-version-list') {
      rewritten[name] = fullVersionList
      changed = true
      continue
    }
    rewritten[name] = value
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
