import { normalizeBrowserUrl } from './local-development-url'

/**
 * Browser search engines and address resolution.
 *
 * A browser address field accepts two kinds of input: an address to open, or a
 * phrase to search for. This module owns both halves of that decision   the
 * engines the app ships, the engines a user added, and the single rule that
 * turns a typed string into the URL the browser loads   so the sidebar address
 * bar, the full-screen workspace, the Cmd/Ctrl+L spotlight, and the settings
 * page can never disagree about what a string means.
 */

/** One search engine: a stable id, a display name, and its query template. */
export interface BrowserSearchEngine {
  /** Stable id. Referenced by `AppConfig.browserSearchEngine`. */
  id: string
  /** Name shown wherever an engine is chosen or listed. */
  name: string
  /**
   * An http/https URL with `%s` where the percent-encoded query is substituted.
   * A template without `%s` is accepted too: the query is appended as `?q=`.
   */
  searchUrlTemplate: string
}

/**
 * Engines the app approves out of the box, in the order they are offered.
 *
 * These ids are reserved: a user cannot add an engine that shadows one of them,
 * so the two built-ins can never be redefined underneath the default setting.
 */
export const BUILT_IN_BROWSER_SEARCH_ENGINES: readonly BrowserSearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', searchUrlTemplate: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', searchUrlTemplate: 'https://www.google.com/search?q=%s' }
]

/** The engine used until the user changes it. */
export const DEFAULT_BROWSER_SEARCH_ENGINE_ID = 'duckduckgo'

/** Ceiling on user-added engines, so the settings list stays bounded. */
export const MAX_BROWSER_CUSTOM_SEARCH_ENGINES = 20

/** Longest accepted engine name. */
export const MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH = 48

/** Longest accepted query template. */
export const MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH = 2048

/** Whether an id belongs to an engine the app ships. */
export function isBuiltInBrowserSearchEngineId(id: string): boolean {
  return BUILT_IN_BROWSER_SEARCH_ENGINES.some((engine) => engine.id === id)
}

/** App engines followed by the user's own, in the order they are presented. */
export function browserSearchEngines(
  custom: readonly BrowserSearchEngine[] = []
): BrowserSearchEngine[] {
  return [...BUILT_IN_BROWSER_SEARCH_ENGINES, ...custom]
}

/**
 * The engine an id names, falling back to the shipped default when the id is
 * unknown   a config can outlive the custom engine it points at, and a removed
 * engine must still leave a working address bar rather than a dead default.
 */
export function findBrowserSearchEngine(
  id: string,
  custom: readonly BrowserSearchEngine[] = []
): BrowserSearchEngine {
  return (
    browserSearchEngines(custom).find((engine) => engine.id === id) ??
    BUILT_IN_BROWSER_SEARCH_ENGINES[0]
  )
}

/**
 * Build the search URL for a query, or null when the template cannot produce a
 * navigable one. Only http/https survive, and credentials are refused, which is
 * the same contract the browser's own navigation validation enforces.
 */
export function buildBrowserSearchUrl(engine: BrowserSearchEngine, query: string): string | null {
  const template = engine.searchUrlTemplate.trim()
  if (!template) return null
  const encoded = encodeURIComponent(query)
  const candidate = template.includes('%s')
    ? template.split('%s').join(encoded)
    : appendQueryParameter(template, 'q', encoded)
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}

/** Append `?key=value` (or `&key=value`) to a URL that has no `%s` placeholder. */
function appendQueryParameter(url: string, key: string, value: string): string {
  const separator = /[?&]$/u.test(url) ? '' : url.includes('?') ? '&' : '?'
  return `${url}${separator}${key}=${value}`
}

/**
 * Normalize a user-entered query template, or null when it cannot become one.
 *
 * The trimmed string is returned unchanged: the placeholder is part of the
 * user's own URL and rewriting it would edit a value they can still see.
 */
export function normalizeBrowserSearchUrlTemplate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH) return null
  const probe = buildBrowserSearchUrl({ id: '', name: '', searchUrlTemplate: trimmed }, 'query')
  return probe === null ? null : trimmed
}

/**
 * Read a persisted custom-engine list tolerantly: a hand-edited entry that is
 * not a usable engine is dropped rather than failing the whole config read.
 */
export function sanitizeCustomSearchEngines(value: unknown): BrowserSearchEngine[] {
  if (!Array.isArray(value)) return []
  const engines: BrowserSearchEngine[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const template = typeof record.searchUrlTemplate === 'string' ? record.searchUrlTemplate : ''
    if (!id || !name || isBuiltInBrowserSearchEngineId(id)) continue
    if (engines.some((engine) => engine.id === id)) continue
    const normalized = normalizeBrowserSearchUrlTemplate(template)
    if (!normalized) continue
    if (engines.length >= MAX_BROWSER_CUSTOM_SEARCH_ENGINES) break
    engines.push({
      id,
      name: name.slice(0, MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH),
      searchUrlTemplate: normalized
    })
  }
  return engines
}

/** A resolved address field entry: an address to load, or a search to run. */
export type BrowserAddressResolution =
  { kind: 'url'; url: string } | { kind: 'search'; url: string; query: string }

/**
 * Resolve typed address-field text into what the browser should load, or null
 * for empty input.
 *
 * An http/https URL, a host with a dot, an IP literal, or localhost (with an
 * optional port, path, query or fragment) is opened as an address. Everything
 * else   a sentence, a lone word, a phrase with spaces   is handed to the
 * engine as a query, so "Lucide icon" searches without a special gesture.
 */
export function resolveBrowserAddress(
  value: string,
  engine: BrowserSearchEngine
): BrowserAddressResolution | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (looksLikeBrowserAddress(trimmed)) {
    const url = normalizeBrowserUrl(trimmed)
    if (url) return { kind: 'url', url }
  }
  const url =
    buildBrowserSearchUrl(engine, trimmed) ??
    buildBrowserSearchUrl(findBrowserSearchEngine(DEFAULT_BROWSER_SEARCH_ENGINE_ID), trimmed)
  return url ? { kind: 'search', url, query: trimmed } : null
}

/** A scheme followed by `//`, which is how every navigable web URL is written. */
const SCHEME_WITH_AUTHORITY = /^[a-z][a-z\d+.-]*:\/\//iu

/** Hostname labels separated by dots, ending in a label. */
const DOTTED_HOSTNAME = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+\.?$/iu

/**
 * Whether text reads as an address rather than a phrase.
 *
 * A bare single label ("foo") is deliberately not an address: browsers search
 * for it, and treating it as a host would send every one-word query to a
 * nonexistent site. `localhost` is the exception, because it names this machine
 * and never a website.
 */
export function looksLikeBrowserAddress(value: string): boolean {
  if (SCHEME_WITH_AUTHORITY.test(value)) return true
  if (/\s/u.test(value)) return false
  const authority = value.split(/[/?#]/u)[0] ?? ''
  if (!authority) return false
  const hostname = authority.replace(/:\d+$/u, '').toLowerCase()
  if (hostname === '' || hostname.includes('@')) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (isIpv4Host(hostname)) return true
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  return DOTTED_HOSTNAME.test(hostname)
}

/** Whether a hostname is a dotted-quad IPv4 literal. */
function isIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}
