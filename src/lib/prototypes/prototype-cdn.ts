/**
 * Approved external CDN origins for prototype previews.
 *
 * A prototype is served from its own loopback origin under a Content-Security-
 * Policy that denies cross-origin reach, so a design that links a web font or a
 * chart library cannot load it. This module is the single place that decides
 * which external hosts a prototype may reach: the origins the app ships, the
 * ones a user added in General settings, and the merged result that both the
 * preview server's header and the prototype turn instruction are built from, so
 * the model is told exactly the hosts that will actually load.
 */

/**
 * CDN origins the app approves out of the box. These are the hosts the design
 * templates behind the prototype phase actually reference: the two Google Fonts
 * origins (the stylesheet and the font files it points at), the three package
 * CDNs, and Tailwind's browser build.
 */
export const APP_PROTOTYPE_CDN_ORIGINS: readonly string[] = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.tailwindcss.com'
]

/** Ceiling on one merged allowlist, so a hand-edited config cannot build an
 *  unbounded CSP header on every preview response. */
export const MAX_PROTOTYPE_CDN_ORIGINS = 50

/** Longest accepted entry. An origin is a host and an optional port. */
export const MAX_PROTOTYPE_CDN_ORIGIN_LENGTH = 253

/** Whether a project that has never been configured allows external CDNs. */
export const DEFAULT_PROTOTYPE_CDN_ENABLED = true

/** Which external hosts a prototype preview may load from. */
export interface PrototypeCdnPolicy {
  /** Whether prototype pages may reach external hosts at all. */
  allowExternalCdn: boolean
  /** Origins the user added, merged after the app's own list. */
  userOrigins: readonly string[]
}

/** The conservative policy: nothing external loads. Used until the app hands a
 *  configured policy over, so a service that never receives one stays closed. */
export const STRICT_PROTOTYPE_CDN_POLICY: PrototypeCdnPolicy = {
  allowExternalCdn: false,
  userOrigins: []
}

/**
 * A host, optionally wildcarded on the left, with at least two labels (`a.b`),
 * so a bare label can never become an approved origin. A wildcard is only
 * accepted as the whole leftmost label, which is the form CSP itself supports.
 */
const CDN_HOSTNAME_PATTERN =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u

/**
 * Normalize one allowlist entry to the CSP origin form, or null when it is not
 * an origin at all.
 *
 * Accepts what a user is likely to paste (`cdn.example.com`,
 * `https://cdn.example.com/`, `https://cdn.example.com:8443`,
 * `*.example.com`) and rejects everything else: plain HTTP, credentials, paths,
 * queries, and fragments. A path is refused on purpose, because a CSP source
 * with a path is matched by prefix and would silently widen the approval to
 * every path on that host.
 */
export function normalizePrototypeCdnOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PROTOTYPE_CDN_ORIGIN_LENGTH) return null
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null
  const hostname = parsed.hostname.toLowerCase()
  if (!CDN_HOSTNAME_PATTERN.test(hostname)) return null
  return `https://${hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
}

/**
 * Every origin the policy approves, app list first, deduplicated and bounded.
 * An entry that no longer normalizes is dropped here rather than rejected, so a
 * config written by an older version cannot break preview serving.
 */
export function prototypeCdnOrigins(policy: PrototypeCdnPolicy): string[] {
  if (!policy.allowExternalCdn) return []
  const origins: string[] = []
  for (const candidate of [...APP_PROTOTYPE_CDN_ORIGINS, ...policy.userOrigins]) {
    const origin = normalizePrototypeCdnOrigin(candidate)
    if (!origin || origins.includes(origin)) continue
    origins.push(origin)
    if (origins.length >= MAX_PROTOTYPE_CDN_ORIGINS) break
  }
  return origins
}

/** The config fields this policy is read from. */
export interface PrototypeCdnConfig {
  allowPrototypeExternalCdn?: boolean
  prototypeCdnAllowlist?: readonly string[]
}

/** Read the policy out of the app config, defaulting to CDNs allowed. */
export function prototypeCdnPolicyFromConfig(config: PrototypeCdnConfig): PrototypeCdnPolicy {
  return {
    allowExternalCdn: config.allowPrototypeExternalCdn ?? DEFAULT_PROTOTYPE_CDN_ENABLED,
    userOrigins: config.prototypeCdnAllowlist ?? []
  }
}

/**
 * The prototype preview Content-Security-Policy for one policy.
 *
 * Every directive the prototype posture already relied on is unchanged: the
 * page runs its own inline scripts, posts demo forms to itself, and reads
 * same-origin data. The approved origins are added to the directives that fetch
 * assets. Two directives deliberately never see them: `frame-src` stays `'self'`
 * because the allowlist approves assets to fetch, not documents to embed, and
 * `default-src` stays `'self'` so an unlisted directive cannot inherit reach.
 */
export function prototypePreviewCsp(policy: PrototypeCdnPolicy): string {
  const approved = prototypeCdnOrigins(policy)
  const allow = (directive: string): string =>
    approved.length === 0 ? directive : `${directive} ${approved.join(' ')}`
  return [
    "default-src 'self'",
    allow("script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
    allow("style-src 'self' 'unsafe-inline'"),
    allow("img-src 'self' data: blob:"),
    allow("font-src 'self' data:"),
    allow("media-src 'self' data: blob:"),
    allow("connect-src 'self'"),
    allow("worker-src 'self' blob:"),
    "frame-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ')
}

/**
 * The prototype turn's line about external assets: the approved origins when
 * the switch is on, the closed posture when it is off. The model has no other
 * way to know which hosts will load, so this is the same list the preview
 * server is serving.
 */
export function prototypeCdnInstruction(policy: PrototypeCdnPolicy): string {
  const approved = prototypeCdnOrigins(policy)
  if (approved.length === 0) {
    return "Prototype work was explicitly requested. Generate dependency-free HTML/CSS/JavaScript without installing packages and without any external host: this project's preview blocks every CDN, so inline every style, script, font, and image. Reuse the existing project stack only when it is already available without setup."
  }
  return `Prototype work was explicitly requested. Generate HTML/CSS/JavaScript without installing packages. These CDN origins are approved for this project's preview, and no other host will load: ${approved.join(', ')}. Use an approved CDN only when the design needs what it provides, keep every other asset inline, and reuse the existing project stack only when it is already available without setup.`
}
