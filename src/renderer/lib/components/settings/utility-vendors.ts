import type {
  AgentCapabilityEntry,
  InstalledSkillLocation,
  McpUtilityConfig,
  SkillMarketEntry,
  UtilityDefinition
} from '$shared/types'

/**
 * Vendor attribution for the Utilities catalog.
 *
 * A row belongs to the vendor that actually published it, which is a different
 * kind of answer per source: the app owns its built-in utilities, a marketplace
 * install names the owner it came from, a native capability belongs to the
 * harness whose folder holds it, and everything the app cannot attribute is
 * simply local. The same file that builds the grouping also resolves the label
 * and the mark, so a vendor can never render two different ways in one list.
 */

export type UtilityVendorKind = 'app' | 'marketplace' | 'harness' | 'local'

/** The vendor one catalog row belongs to. */
export interface UtilityVendor {
  /** Stable group key: `<kind>:<identity>`, or `local` for rows with no vendor. */
  id: string
  /** What the group header and its tooltip show. */
  label: string
  kind: UtilityVendorKind
  /** Bundled vendor-mark candidate, when the label alone would not resolve one. */
  iconName?: string
  /** Harness whose skill folder owns the row (harness groups only). */
  harnessId?: string
  /** Marketplace source the row came from, kept for the group tooltip. */
  source?: string
}

/** One rendered group: a vendor and the rows attributed to it. */
export interface UtilityVendorGroup<T> {
  vendor: UtilityVendor
  rows: T[]
}

const APP_VENDOR: UtilityVendor = { id: 'app:codeinoven', label: 'CodeInOven', kind: 'app' }
const LOCAL_VENDOR: UtilityVendor = { id: 'local', label: 'Local', kind: 'local' }

/** Order vendors appear in: the app, then published sources, then local files. */
const VENDOR_ORDER: Record<UtilityVendorKind, number> = {
  app: 0,
  marketplace: 1,
  harness: 2,
  local: 3
}

/** Package and repository names that need a friendlier label than title case. */
const VENDOR_LABELS: Readonly<Record<string, string>> = {
  sveltejs: 'Svelte',
  apptweak: 'AppTweak',
  modelcontextprotocol: 'Model Context Protocol',
  'vercel-labs': 'Vercel',
  anthropics: 'Anthropic',
  'ni-c': 'Google'
}

/** Vendor words that keep their own capitalization when a name is spelled out. */
const VENDOR_ACRONYMS: Readonly<Record<string, string>> = {
  ai: 'AI',
  api: 'API',
  aso: 'ASO',
  aws: 'AWS',
  cdk: 'CDK',
  cli: 'CLI',
  css: 'CSS',
  gcp: 'GCP',
  gsc: 'GSC',
  html: 'HTML',
  mcp: 'MCP',
  sdk: 'SDK',
  seo: 'SEO',
  sql: 'SQL',
  ui: 'UI',
  ux: 'UX'
}

/** Host labels that are infrastructure, never the vendor itself. */
const HOST_SUBDOMAINS = new Set([
  'mcp',
  'api',
  'www',
  'app',
  'server',
  'connect',
  'developer',
  'docs',
  'portal',
  'cloud',
  'gateway'
])

/** Package-name parts that name no vendor on their own. */
const GENERIC_PACKAGE_NAMES = new Set([
  'mcp',
  'server',
  'cli',
  'sdk',
  'api',
  'app',
  'tool',
  'tools'
])

/** Commands that launch a package rather than being one. */
const RUNNER_COMMANDS = new Set([
  'npx',
  'bunx',
  'node',
  'bun',
  'deno',
  'pnpm',
  'yarn',
  'uvx',
  'uv',
  'python',
  'python3',
  'sh',
  'bash',
  'zsh'
])

/** Built-in web tool providers, which are vendors in their own right. */
const WEB_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  brave: 'Brave'
}

/** Spell a raw identifier out as a readable vendor name. */
function vendorLabel(raw: string): string {
  const key = raw.trim().toLowerCase()
  const override = VENDOR_LABELS[key]
  if (override) return override
  return key
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((part) => VENDOR_ACRONYMS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Strip the affixes a package name wears around its vendor. */
function stripPackageAffixes(value: string): string {
  let current = value
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/^(mcp|server|sdk|cli|plugin)[-_]/iu, '')
      .replace(/[-_](mcp|server|sdk|cli|plugin)s?$/iu, '')
      .replace(/[-_](beta|alpha|latest|next)$/iu, '')
    if (next === current) break
    current = next
  }
  return current.trim()
}

/**
 * The vendor a package names: `@sveltejs/mcp` is Svelte, `slack-mcp-server` is
 * Slack. A scoped package falls back to its scope when its own name is generic,
 * so `@sveltejs/mcp` does not resolve to "MCP".
 */
function packageVendorName(token: string): string | null {
  if (!token || token.startsWith('-')) return null
  const clean = token.trim()
  if (!/[a-z]/iu.test(clean)) return null
  const scoped = clean.match(/^@([^/]+)\/(.+)$/u)
  const scope = scoped?.[1] ?? ''
  const base = (scoped?.[2] ?? clean).replace(/@[\w.-]+$/u, '')
  if (!base || /[\\/]/u.test(base) || /\.(?:js|ts|mjs|cjs|py|sh)$/iu.test(base)) return null
  if (!scoped && RUNNER_COMMANDS.has(base.toLowerCase())) return null
  const usable = (candidate: string): boolean =>
    candidate.length >= 3 && !GENERIC_PACKAGE_NAMES.has(candidate.toLowerCase())
  const stripped = stripPackageAffixes(base)
  if (usable(stripped)) return stripped
  const strippedScope = stripPackageAffixes(scope)
  return usable(strippedScope) ? strippedScope : null
}

/** The first package token a stdio command line names. */
function commandPackageName(config: McpUtilityConfig): string | null {
  const tokens = [config.command ?? '', ...(config.args ?? [])]
  for (const token of tokens) {
    const name = packageVendorName(token)
    if (name) return name
  }
  return null
}

/** Lower-case host of a URL, or null when it is not a parseable URL. */
function urlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The vendor a remote MCP endpoint names, from its host. */
function urlVendorName(url: string): string | null {
  const hostname = urlHostname(url)
  if (!hostname) return null
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) return null
  const domain = labels.slice(0, -1)
  while (domain.length > 1 && HOST_SUBDOMAINS.has(domain[0] ?? '')) domain.shift()
  const candidate = domain[0] ?? ''
  return candidate.length >= 3 ? candidate : null
}

/** A vendor for a marketplace source: its GitHub owner, or a well-known domain. */
export function marketplaceVendor(source: string): UtilityVendor {
  const value = source.trim()
  const slash = value.indexOf('/')
  const owner = (slash > 0 ? value.slice(0, slash) : value) || value
  return {
    id: `marketplace:${owner.toLowerCase()}`,
    label: owner,
    kind: 'marketplace',
    iconName:
      stripPackageAffixes(owner.toLowerCase().replace(/[^a-z0-9]+/gu, '')) || owner.toLowerCase(),
    source: value
  }
}

/** The remote or package vendor an MCP configuration names, with a local fallback. */
export function mcpVendor(config: McpUtilityConfig): UtilityVendor {
  const raw =
    config.transport === 'stdio'
      ? (commandPackageName(config) ?? (config.url ? urlVendorName(config.url) : null))
      : config.url
        ? urlVendorName(config.url)
        : null
  if (!raw) return LOCAL_VENDOR
  return {
    id: `marketplace:${raw.toLowerCase()}`,
    label: vendorLabel(raw),
    kind: 'marketplace',
    iconName: raw.toLowerCase()
  }
}

/** The skill id a registry skill writes into its harness bindings. */
function registrySkillId(utility: UtilityDefinition): string {
  return (
    utility.harnessBindings.find((binding) => binding.strategy === 'skill' && binding.transportName)
      ?.transportName ?? ''
  )
}

/**
 * The vendor a registry entry belongs to. A built-in utility is the app's own;
 * an installed skill names the marketplace source its install record kept; an
 * MCP server names its package or host; a web utility names its provider.
 */
export function registryUtilityVendor(
  utility: UtilityDefinition,
  locations: readonly InstalledSkillLocation[]
): UtilityVendor {
  if (utility.appOwned) return APP_VENDOR
  if (utility.kind === 'skill') {
    const skillId = registrySkillId(utility)
    const source = locations.find(
      (location) => location.skillId === skillId && location.source
    )?.source
    return source ? marketplaceVendor(source) : LOCAL_VENDOR
  }
  if (utility.kind === 'mcp') return mcpVendor(utility.config)
  if (utility.kind === 'web_search' || utility.kind === 'web_fetch') {
    const provider = utility.config.provider ?? ''
    const label = WEB_PROVIDER_LABELS[provider]
    if (label)
      return { id: `marketplace:${provider}`, label, kind: 'marketplace', iconName: provider }
  }
  return LOCAL_VENDOR
}

/**
 * The vendor a harness-discovered capability belongs to: the harness whose
 * folder owns it, or local when it sits in the shared skills layer no harness
 * claims.
 */
export function nativeCapabilityVendor(
  entry: AgentCapabilityEntry,
  harnessLabel: (harnessId: string) => string
): UtilityVendor {
  if (entry.origin === 'harness' && entry.harnessId) {
    return {
      id: `harness:${entry.harnessId}`,
      label: harnessLabel(entry.harnessId),
      kind: 'harness',
      harnessId: entry.harnessId
    }
  }
  return LOCAL_VENDOR
}

/** The vendor a bookmarked marketplace skill names, from its source. */
export function bookmarkVendor(entry: SkillMarketEntry): UtilityVendor {
  return marketplaceVendor(entry.source)
}

/** Rows grouped under their vendor, app first and local files last. */
export function groupRowsByVendor<T extends { vendor: UtilityVendor }>(
  rows: readonly T[]
): UtilityVendorGroup<T>[] {
  const groups = new Map<string, UtilityVendorGroup<T>>()
  for (const row of rows) {
    const existing = groups.get(row.vendor.id)
    if (existing) {
      existing.rows.push(row)
      continue
    }
    groups.set(row.vendor.id, { vendor: row.vendor, rows: [row] })
  }
  return [...groups.values()].sort((left, right) => {
    const order = VENDOR_ORDER[left.vendor.kind] - VENDOR_ORDER[right.vendor.kind]
    if (order !== 0) return order
    return left.vendor.label.localeCompare(right.vendor.label, undefined, { sensitivity: 'base' })
  })
}
