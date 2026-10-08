/**
 * Per-site extension rules: pure host matching and manifest filtering.
 *
 * A rule names a host (`example.com`) and covers itself plus subdomains. Blocked
 * wins over allowed. An empty allowlist means everywhere not blocked.
 */

export function normalizeSiteHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > 260) return null
  if (
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes(':') ||
    trimmed.includes(' ')
  ) {
    return null
  }
  const cleaned = trimmed.replace(/^\*\./u, '')
  if (cleaned.length === 0) return null
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/u.test(cleaned)) return null
  return cleaned
}

/** Whether a page host is covered by one site rule. */
export function siteHostMatches(rule: string, host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized.length === 0) return false
  if (normalized === rule) return true
  return normalized.endsWith(`.${rule}`)
}

/** Whether an extension runs on a host. Blocked wins. */
export function runsOnHost(
  blockedHosts: readonly string[],
  allowedHosts: readonly string[],
  host: string | null
): boolean {
  if (!host) return true
  const normalized = host.trim().toLowerCase()
  if (normalized.length === 0) return true
  for (const blocked of blockedHosts) {
    if (siteHostMatches(blocked, normalized)) return false
  }
  if (allowedHosts.length === 0) return true
  return allowedHosts.some((allowed) => siteHostMatches(allowed, normalized))
}

/** Host of an http(s) URL, or null for anything else. Extension pages have none. */
export function hostOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Whether a manifest match pattern covers a host. Supports the shapes
 * extensions actually declare: `<all_urls>`, `*://...`, `http(s)://...` with
 * `*` host or `*.` prefix. Unknown shapes answer false rather than granting.
 */
export function matchPatternCoversHost(pattern: string, host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized.length === 0) return false
  if (pattern === '<all_urls>') return true
  const separator = pattern.indexOf('://')
  if (separator === -1) return false
  const afterScheme = pattern.slice(separator + 3)
  const slash = afterScheme.indexOf('/')
  const patternHost = slash === -1 ? afterScheme : afterScheme.slice(0, slash)
  if (patternHost === '*') return true
  if (patternHost.startsWith('*.')) {
    const parent = patternHost.slice(2).toLowerCase()
    return normalized === parent || normalized.endsWith(`.${parent}`)
  }
  return patternHost.toLowerCase() === normalized
}

/** Exclude patterns that block a host and its subdomains over http and https. */
export function excludePatternsForHost(host: string): string[] {
  return [`*://${host}/*`, `*://*.${host}/*`]
}

/** Allow patterns that enable a host and its subdomains. */
export function allowPatternsForHost(host: string): string[] {
  return [`*://${host}/*`, `*://*.${host}/*`]
}

/**
 * Filter an original manifest for per-site rules. Answers null when nothing
 * changed. Blocked hosts append to each content script's `exclude_matches`. A
 * non-empty allowlist intersects each content script's `matches` with the hosts
 * the original patterns already cover, so an allowlist never broadens an
 * extension past what it declared.
 */
export interface ExtensionManifestLike {
  [key: string]: unknown
  content_scripts?: Array<Record<string, unknown> | null> | unknown
}

export function filterManifestForSiteRules(
  original: ExtensionManifestLike,
  blockedHosts: readonly string[],
  allowedHosts: readonly string[]
): ExtensionManifestLike | null {
  if (blockedHosts.length === 0 && allowedHosts.length === 0) return null
  const scripts = original.content_scripts
  if (!Array.isArray(scripts)) return null
  let changed = false
  const nextScripts = scripts.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    const matchesRaw = record.matches
    const excludeRaw = record.exclude_matches
    const matches = Array.isArray(matchesRaw)
      ? matchesRaw.filter((item): item is string => typeof item === 'string')
      : []
    const exclude = Array.isArray(excludeRaw)
      ? excludeRaw.filter((item): item is string => typeof item === 'string')
      : []
    let nextMatches = matches
    if (allowedHosts.length > 0) {
      const picked: string[] = []
      for (const host of allowedHosts) {
        if (!matches.some((pattern) => matchPatternCoversHost(pattern, host))) continue
        for (const pattern of allowPatternsForHost(host)) {
          if (!picked.includes(pattern)) picked.push(pattern)
        }
      }
      nextMatches = picked
    }
    const nextExclude = [...exclude]
    for (const host of blockedHosts) {
      for (const pattern of excludePatternsForHost(host)) {
        if (!nextExclude.includes(pattern)) nextExclude.push(pattern)
      }
    }
    const matchesSame =
      nextMatches.length === matches.length &&
      nextMatches.every((item, index) => item === matches[index])
    const excludeSame =
      nextExclude.length === exclude.length &&
      nextExclude.every((item, index) => item === exclude[index])
    if (matchesSame && excludeSame) return entry
    changed = true
    return { ...record, matches: nextMatches, exclude_matches: nextExclude }
  })
  if (!changed) return null
  return { ...original, content_scripts: nextScripts }
}
