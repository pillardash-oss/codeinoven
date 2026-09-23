import type {
  AgentCapabilityCatalog,
  AgentCapabilityEntry,
  UtilityCatalog,
  UtilityDefinition
} from '$shared/types'

/**
 * Where a connection library entry came from. The Utilities page shows both the
 * app registry and the capabilities a harness discovers on disk, so the
 * assistant library has to carry both or it looks half empty next to it.
 */
export type ConnectionLibrarySource = 'library' | 'harness' | 'global' | 'application'

/**
 * One selectable connection, whichever side of the app it came from. Registry
 * utilities and harness-native skills/MCP servers share this shape so the picker
 * and the connection rows never need to know which is which.
 */
export interface ConnectionLibraryEntry {
  /** Stable id stored as a routine connection's `utilityId`. */
  id: string
  name: string
  kind: string
  description: string
  enabled: boolean
  source: ConnectionLibrarySource
  /** The registry utility, when this entry is an app library one. */
  utility: UtilityDefinition | null
  /** The discovered capability, when this entry came from a harness. */
  capability: AgentCapabilityEntry | null
  /** Extra searchable text: skill body keywords, tags. */
  keywords: string
}

/**
 * Harness-discovered capabilities are addressed with a prefix so their ids can
 * never collide with a registry utility id, which is a bare generated id.
 */
const CAPABILITY_PREFIX = 'capability:'

/** The connection id that addresses one discovered capability. */
export function capabilityConnectionId(entry: Pick<AgentCapabilityEntry, 'id'>): string {
  return `${CAPABILITY_PREFIX}${entry.id}`
}

/** Lowercase alphanumeric form used for name matching. */
export function normalizeConnectionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Whether two display names refer to the same thing. One side containing the
 * other is enough, so a routine that says "Slack" links to the "Slack MCP"
 * entry the library carries.
 */
export function connectionNamesOverlap(a: string, b: string): boolean {
  const left = normalizeConnectionName(a)
  const right = normalizeConnectionName(b)
  if (!left || !right) return false
  return left.includes(right) || right.includes(left)
}

function capabilitySource(entry: AgentCapabilityEntry): ConnectionLibrarySource {
  if (entry.origin === 'application') return 'application'
  if (entry.origin === 'global') return 'global'
  return 'harness'
}

function registryEntry(utility: UtilityDefinition): ConnectionLibraryEntry {
  return {
    id: utility.id,
    name: utility.name,
    kind: utility.kind,
    description: utility.description ?? '',
    enabled: utility.enabled,
    source: 'library',
    utility,
    capability: null,
    keywords: utility.kind === 'skill' ? utility.config.instructions : ''
  }
}

function capabilityEntry(entry: AgentCapabilityEntry): ConnectionLibraryEntry {
  return {
    id: capabilityConnectionId(entry),
    name: entry.name,
    kind: entry.kind,
    description: entry.description ?? '',
    enabled: entry.enabled,
    source: capabilitySource(entry),
    utility: null,
    capability: entry,
    keywords: entry.searchKeywords ?? ''
  }
}

/**
 * Every connection the app can offer: the registry utilities the user installed
 * plus the MCP servers and skills the active harness discovers on disk. This is
 * the same union the Utilities page renders, so the assistant picker cannot show
 * a shorter list than the page it points the user at.
 *
 * A capability the registry already carries is skipped: the registry record is
 * the one the user can actually configure, and listing both would offer the same
 * server twice under two different ids.
 */
export function buildConnectionLibrary(
  catalog: UtilityCatalog | null,
  capabilities: AgentCapabilityCatalog | null
): ConnectionLibraryEntry[] {
  const registry = (catalog?.utilities ?? []).map(registryEntry)
  const registryIds = new Set(registry.map((entry) => entry.id))

  const discovered = [
    ...(capabilities?.skill ?? []).map(capabilityEntry),
    ...(capabilities?.mcp ?? []).map(capabilityEntry)
  ]
    // A capability whose source is the registry is the registry utility itself
    // surfaced a second time, so the configurable registry record wins.
    .filter((entry) => {
      const source = entry.capability?.source
      if (source?.kind === 'registry') return !registryIds.has(source.utilityId)
      return true
    })
    // One harness discovers the same skill another already owns, and a picker
    // offering "firecrawl" three times is noise. An app-owned or global copy
    // beats a harness copy, and the first of equals wins.
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source))

  const seen = new Set<string>()
  const native: ConnectionLibraryEntry[] = []
  for (const entry of discovered) {
    const key = `${entry.kind}:${normalizeConnectionName(entry.name)}`
    if (!normalizeConnectionName(entry.name) || seen.has(key)) continue
    seen.add(key)
    native.push(entry)
  }

  return [...registry, ...native].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** Lower rank wins when the same capability is discovered more than once. */
function sourceRank(source: ConnectionLibrarySource): number {
  if (source === 'application') return 0
  if (source === 'global') return 1
  return 2
}

/**
 * The library entry a routine connection points at, by stored id first and by
 * label second. The label fallback keeps a connection that was authored before
 * the utility existed   or that names it in prose   linked to the real entry.
 */
export function findConnectionEntry(
  library: readonly ConnectionLibraryEntry[],
  connection: { utilityId: string; label: string }
): ConnectionLibraryEntry | null {
  const byId = library.find((entry) => entry.id === connection.utilityId)
  if (byId) return byId
  const needle = connection.label.trim()
  if (!needle) return null
  return (
    library.find((entry) => {
      return [entry.name, entry.id, entry.capability?.id ?? ''].some((candidate) =>
        connectionNamesOverlap(candidate, needle)
      )
    }) ?? null
  )
}

/** Human label for where a connection came from. */
export function connectionSourceLabel(source: ConnectionLibrarySource): string {
  switch (source) {
    case 'library':
      return 'Library'
    case 'application':
      return 'App'
    case 'global':
      return 'Global'
    default:
      return 'Harness'
  }
}
