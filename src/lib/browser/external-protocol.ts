/**
 * External-protocol handoff for the embedded browser.
 *
 * A page can point a link at a scheme the browser cannot render: `macappstore:`
 * asks for the Mac App Store, `mailto:` for the default mail client, `zoommtg:`
 * for Zoom. The browser's navigation policy answers only `http(s)` and an
 * extension's own pages, so without this module those clicks are dropped in
 * silence and the page simply looks broken.
 *
 * This module is the one place that decides which of those addresses may be
 * handed to the operating system and what to call them. It is deliberately free
 * of Electron and SvelteKit imports, so the main process that performs the
 * handoff and the renderer that draws its confirmation card read the very same
 * answer, and the tests exercise it without an Electron runtime.
 */

/**
 * The permission id an external address travels as on the prompt card.
 *
 * The confirmation reuses the browser's permission prompt: it is the surface the
 * app already shows over a page, and an external address is the same shape of
 * decision. This id tells the card to render the "wants to open" copy instead of
 * a permission's.
 */
export const EXTERNAL_PROTOCOL_PERMISSION = 'external-protocol'

/**
 * Schemes that must never reach the operating system.
 *
 * They are the app's own documents, running code, or a route to the filesystem:
 * handing one to `shell.openExternal` would give it to a handler that must never
 * see it. `http` and `https` are absent because they are not external at all and
 * never reach the handoff.
 */
const DENIED_SCHEMES = new Set([
  'about',
  'blob',
  'chrome',
  'chrome-extension',
  'chrome-native',
  'chrome-search',
  'chrome-untrusted',
  'data',
  'devtools',
  'edge',
  'file',
  'filesystem',
  'javascript',
  'moz-extension',
  'resource',
  'safari-extension',
  'vbscript',
  'view-source',
  'ws',
  'wss'
])

/** The longest address the handoff will consider, matching the browser's own
 *  URL bound so a page cannot push an oversized value through this path. */
const MAX_EXTERNAL_URL_LENGTH = 8192

/** A scheme is `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, per RFC 3986. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/

/**
 * True when an address carries a control character.
 *
 * A newline or a NUL has no place in a scheme-qualified address and is a known
 * way to smuggle a second instruction past an OS URL handler, so any address
 * carrying one is refused outright. A plain space is not refused: the URL
 * parser percent-encodes it (`mailto:?subject=Hello World` becomes
 * `%20`) before the address is handed out, which is the normal form of an
 * everyday mail link.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * What an external address is called on the confirmation card.
 *
 * Kebab-case schemes still reach a real label for the handful the app knows by
 * name; every other scheme (including one added after this build) still opens,
 * and is named generically rather than with a raw machine string.
 */
const SCHEME_LABELS: Readonly<Record<string, string>> = {
  macappstore: 'the Mac App Store',
  'itms-apps': 'the App Store',
  itms: 'the App Store',
  mailto: 'your email app',
  tel: 'your phone app',
  sms: 'your messaging app',
  facetime: 'FaceTime',
  webcal: 'your calendar',
  zoommtg: 'Zoom',
  slack: 'Slack',
  msteams: 'Microsoft Teams',
  discord: 'Discord',
  spotify: 'Spotify',
  obsidian: 'Obsidian',
  vscode: 'Visual Studio Code',
  'x-apple.systempreferences': 'System Settings'
}

/** One address the operating system may be asked to open. */
export interface ExternalProtocolTarget {
  /** The normalized address, exactly what would be handed to the OS. */
  url: string
  /** The lowercased scheme without its trailing colon. */
  scheme: string
  /** How the confirmation card names the app on the other end. */
  label: string
}

/** The app a scheme opens, in the card's own words, for any scheme. */
export function externalProtocolAppLabel(scheme: string): string {
  return SCHEME_LABELS[scheme] ?? 'an external app'
}

/**
 * The external address a URL asks to open, or null when it is not one the
 * handoff may perform.
 *
 * Null covers every case that must stay inside the browser: a web address, an
 * address the browser renders itself, a denied scheme, and anything malformed.
 */
export function externalProtocolTarget(rawUrl: string): ExternalProtocolTarget | null {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null
  }
  if (hasControlCharacter(rawUrl)) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!SCHEME_PATTERN.test(scheme)) return null
  if (scheme === 'http' || scheme === 'https') return null
  if (DENIED_SCHEMES.has(scheme)) return null
  return { url: parsed.href, scheme, label: externalProtocolAppLabel(scheme) }
}
