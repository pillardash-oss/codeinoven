import { v } from 'convex/values'
import { internalMutation, internalQuery } from './_generated/server'

const profileResult = v.union(
  v.null(),
  v.object({
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    globalMemoryTombstonesJson: v.optional(v.string()),
    updatedAt: v.number()
  })
)

export const userIdForAccountToken = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query('accountTokens')
      .withIndex('by_token_hash', (query) => query.eq('tokenHash', args.tokenHash))
      .unique()
    return token && token.expiresAt > args.now ? token.authUserId : null
  }
})

export const get = internalQuery({
  args: { authUserId: v.string() },
  returns: profileResult,
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    if (!profile) return null
    return {
      authUserId: profile.authUserId,
      email: profile.email,
      displayName: profile.displayName,
      image: profile.image,
      usageJson: profile.usageJson,
      globalMemoriesJson: profile.globalMemoriesJson,
      globalMemoryTombstonesJson: profile.globalMemoryTombstonesJson,
      updatedAt: profile.updatedAt
    }
  }
})

export const ensure = internalMutation({
  args: {
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    updatedAt: v.number()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        displayName: args.displayName,
        image: args.image
      })
      return
    }
    await ctx.db.insert('accountProfiles', args)
  }
})

export const save = internalMutation({
  args: {
    authUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    deviceId: v.string(),
    deviceLabel: v.string(),
    platform: v.string(),
    /** This device's compact usage snapshot (merged into a per-device map). */
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    globalMemoryTombstonesJson: v.string(),
    updatedAt: v.number()
  },
  /**
   * Persist the profile:
   *
   * - Usage is stored per device (keyed by the desktop device id) so every
   *   device's snapshot survives and the usage page can show a per-device
   *   breakdown. `usageJson` holds the full per-device map.
   * - Global memories are merged per entry (newest `updatedAt` wins) instead
   *   of wholesale-replaced, and any entry whose id is tombstoned by a newer
   *   deletion is dropped, so deletions propagate to every device.
   * - Tombstones are merged (id -> newest deletedAt) and pruned after
   *   `MEMORY_TOMBSTONE_RETENTION_MS`.
   *
   * Returns the merged values so the HTTP handler can hand every device the
   * converged state.
   */
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    const usageByDevice = mergeDeviceUsage(
      existing ? readUsageMap(existing.usageJson) : {},
      args.deviceId,
      args.deviceLabel,
      args.platform,
      args.usageJson,
      args.updatedAt
    )
    const tombstones = mergeTombstoneLists(
      [readTombstones(existing?.globalMemoryTombstonesJson), readTombstones(args.globalMemoryTombstonesJson)],
      args.updatedAt
    )
    const memories = mergeGlobalMemories(
      filterTombstoned(readStoredJson(existing?.globalMemoriesJson), tombstones),
      filterTombstoned(readStoredJson(args.globalMemoriesJson), tombstones)
    )
    const merged = {
      authUserId: args.authUserId,
      email: args.email,
      displayName: args.displayName,
      image: args.image,
      usageJson: JSON.stringify(usageByDevice),
      globalMemoriesJson: JSON.stringify(memories),
      globalMemoryTombstonesJson: JSON.stringify(tombstones),
      updatedAt: args.updatedAt
    }
    if (existing) {
      await ctx.db.patch(existing._id, merged)
      return { usageByDevice, globalMemories: memories, globalMemoryTombstones: tombstones }
    }
    await ctx.db.insert('accountProfiles', merged)
    return { usageByDevice, globalMemories: memories, globalMemoryTombstones: tombstones }
  }
})

/** Shared cap for the synced global-memory list; mirrors the desktop limit. */
const MAX_GLOBAL_MEMORY_ENTRIES = 50

/** Parse a stored JSON blob, tolerating corruption by treating it as empty. */
function readStoredJson(raw: string | null | undefined): unknown[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

interface SyncedMemoryEntry {
  id: string
  label: string
  content: string
  enabled: boolean
  updatedAt: number
  category: string
  priority: string
  scope: 'global'
  source: string
  frequency: number
  lastReinforced: number
}

const MEMORY_CATEGORIES = ['behavioral', 'project-rule', 'identity', 'preference'] as const
const MEMORY_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const
const MEMORY_SOURCES = ['manual', 'auto-detected'] as const

/** Normalize an untrusted entry to the canonical global shape, or null. */
function sanitizeGlobalMemory(value: unknown): SyncedMemoryEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const category = entry['category']
  const priority = entry['priority']
  const source = entry['source']
  if (
    typeof entry['id'] !== 'string' ||
    entry['id'].length === 0 ||
    typeof entry['label'] !== 'string' ||
    typeof entry['content'] !== 'string' ||
    typeof entry['enabled'] !== 'boolean' ||
    typeof entry['updatedAt'] !== 'number' ||
    !Number.isFinite(entry['updatedAt']) ||
    typeof category !== 'string' ||
    !MEMORY_CATEGORIES.includes(category as (typeof MEMORY_CATEGORIES)[number]) ||
    typeof priority !== 'string' ||
    !MEMORY_PRIORITIES.includes(priority as (typeof MEMORY_PRIORITIES)[number]) ||
    typeof source !== 'string' ||
    !MEMORY_SOURCES.includes(source as (typeof MEMORY_SOURCES)[number]) ||
    typeof entry['frequency'] !== 'number' ||
    typeof entry['lastReinforced'] !== 'number'
  ) {
    return null
  }
  return {
    id: entry['id'],
    label: entry['label'],
    content: entry['content'],
    enabled: entry['enabled'],
    updatedAt: entry['updatedAt'],
    category,
    priority,
    scope: 'global',
    source,
    frequency: entry['frequency'],
    lastReinforced: entry['lastReinforced']
  }
}

/** Normalized content identity — mirrors the desktop dedupe rule. */
function contentKey(entry: SyncedMemoryEntry): string {
  return entry.content.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Merge two global-memory lists per entry. The primary identity is the entry
 * id (newest `updatedAt` wins); a secondary content-based identity collapses
 * duplicates that carry different ids (e.g. two devices auto-generated the
 * same memory with different fallback ids). The merged list is capped to the
 * newest `MAX_GLOBAL_MEMORY_ENTRIES` so the shared blob stays bounded and never
 * exceeds what a desktop client can apply.
 */
function mergeGlobalMemories(stored: unknown[], incoming: unknown[]): SyncedMemoryEntry[] {
  const byId = new Map<string, SyncedMemoryEntry>()
  const byContent = new Map<string, string>()
  const consider = (value: unknown): void => {
    const entry = sanitizeGlobalMemory(value)
    if (!entry) return
    const byIdWinner = byId.get(entry.id)
    if (byIdWinner) {
      if (entry.updatedAt >= byIdWinner.updatedAt) {
        byId.set(entry.id, entry)
        byContent.set(contentKey(entry), entry.id)
      }
      return
    }
    const key = contentKey(entry)
    const contentWinnerId = byContent.get(key)
    if (contentWinnerId !== undefined) {
      const contentWinner = byId.get(contentWinnerId)
      if (contentWinner && entry.updatedAt >= contentWinner.updatedAt) {
        byId.delete(contentWinnerId)
        byId.set(entry.id, entry)
        byContent.set(key, entry.id)
      }
      return
    }
    byId.set(entry.id, entry)
    byContent.set(key, entry.id)
  }
  for (const value of stored) consider(value)
  for (const value of incoming) consider(value)

  let merged = [...byId.values()]
  if (merged.length > MAX_GLOBAL_MEMORY_ENTRIES) {
    merged = merged
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt || a.index - b.index)
      .slice(0, MAX_GLOBAL_MEMORY_ENTRIES)
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => entry)
  }
  return merged
}

// ── Per-device usage map ────────────────────────────────────────────────

/** Maximum device snapshots retained on one account profile. */
const MAX_DEVICE_USAGE_ENTRIES = 50

interface SyncedDeviceProject {
  id: string
  name: string
  messageCount: number
  costUsd: number
  tokens: number
  durationMs: number
  threadCount: number
}

interface SyncedDeviceUsage {
  deviceId: string
  deviceLabel: string
  platform: string
  messageCount: number
  costUsd: number
  tokens: number
  durationMs: number
  activeDays: number
  projects: SyncedDeviceProject[]
  updatedAt: number
}

/** Parse the stored per-device usage map, tolerating legacy single-blob rows. */
function readUsageMap(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function sanitizeDeviceProject(value: unknown): SyncedDeviceProject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const messageCount = finiteNonnegative(row['messageCount'])
  const costUsd = finiteNonnegative(row['costUsd'])
  const tokens = finiteNonnegative(row['tokens'])
  const durationMs = finiteNonnegative(row['durationMs'])
  const threadCount = finiteNonnegative(row['threadCount'])
  if (
    typeof row['id'] !== 'string' ||
    typeof row['name'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    threadCount === null
  ) {
    return null
  }
  return {
    id: row['id'],
    name: row['name'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    threadCount
  }
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sanitizeDeviceUsage(value: unknown): SyncedDeviceUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const messageCount = finiteNonnegative(record['messageCount'])
  const costUsd = finiteNonnegative(record['costUsd'])
  const tokens = finiteNonnegative(record['tokens'])
  const durationMs = finiteNonnegative(record['durationMs'])
  const activeDays = finiteNonnegative(record['activeDays'])
  const updatedAt = finiteNonnegative(record['updatedAt'])
  if (
    typeof record['deviceId'] !== 'string' ||
    typeof record['deviceLabel'] !== 'string' ||
    typeof record['platform'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    activeDays === null ||
    updatedAt === null ||
    !Array.isArray(record['projects'])
  ) {
    return null
  }
  const projects: SyncedDeviceProject[] = []
  for (const item of record['projects'].slice(0, 10)) {
    const project = sanitizeDeviceProject(item)
    if (!project) return null
    projects.push(project)
  }
  return {
    deviceId: record['deviceId'],
    deviceLabel: record['deviceLabel'],
    platform: record['platform'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    activeDays,
    projects,
    updatedAt
  }
}

/**
 * Merge the incoming device snapshot into the per-device map. The map is
 * bounded to the newest `MAX_DEVICE_USAGE_ENTRIES` by `updatedAt`.
 */
function mergeDeviceUsage(
  stored: Record<string, unknown>,
  deviceId: string,
  deviceLabel: string,
  platform: string,
  usageJson: string,
  now: number
): Record<string, SyncedDeviceUsage> {
  const byDevice = new Map<string, SyncedDeviceUsage>()
  for (const [id, raw] of Object.entries(stored)) {
    const usage = sanitizeDeviceUsage(raw)
    if (usage && usage.deviceId === id) byDevice.set(id, usage)
  }
  // The client sends its single compact snapshot as JSON; parse it directly.
  let parsedIncoming: SyncedDeviceUsage | null = null
  try {
    parsedIncoming = sanitizeDeviceUsage(JSON.parse(usageJson))
  } catch {
    parsedIncoming = null
  }
  if (parsedIncoming && parsedIncoming.deviceId === deviceId) {
    byDevice.set(deviceId, { ...parsedIncoming, deviceId, deviceLabel, platform, updatedAt: now })
  }
  if (byDevice.size > MAX_DEVICE_USAGE_ENTRIES) {
    const sorted = [...byDevice.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.deviceId.localeCompare(b.deviceId)
    )
    byDevice.clear()
    for (const usage of sorted.slice(0, MAX_DEVICE_USAGE_ENTRIES)) byDevice.set(usage.deviceId, usage)
  }
  const result: Record<string, SyncedDeviceUsage> = {}
  for (const [id, usage] of byDevice) result[id] = usage
  return result
}

// ── Memory deletion tombstones ──────────────────────────────────────────

/** How long a deletion tombstone is honored before it is pruned. */
const MEMORY_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000

interface MemoryTombstone {
  id: string
  deletedAt: number
}

function readTombstones(raw: string | null | undefined): MemoryTombstone[] {
  const values = readStoredJson(raw)
  const tombstones: MemoryTombstone[] = []
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (typeof record['id'] !== 'string' || typeof record['deletedAt'] !== 'number') continue
    tombstones.push({ id: record['id'], deletedAt: record['deletedAt'] })
  }
  return tombstones
}

/** Merge tombstone lists (id -> newest deletedAt) and prune expired ones. */
function mergeTombstoneLists(lists: MemoryTombstone[][], now: number): MemoryTombstone[] {
  const byId = new Map<string, number>()
  for (const list of lists) {
    for (const tombstone of list) {
      const existing = byId.get(tombstone.id)
      if (existing === undefined || tombstone.deletedAt > existing) {
        byId.set(tombstone.id, tombstone.deletedAt)
      }
    }
  }
  const retention = now - MEMORY_TOMBSTONE_RETENTION_MS
  const pruned: MemoryTombstone[] = []
  for (const [id, deletedAt] of byId) {
    if (deletedAt > retention) pruned.push({ id, deletedAt })
  }
  return pruned.sort((a, b) => a.deletedAt - b.deletedAt)
}

/** Drop entries whose id is tombstoned by a deletion at or after their update. */
function filterTombstoned(values: unknown[], tombstones: MemoryTombstone[]): unknown[] {
  if (tombstones.length === 0) return values
  const byId = new Map(tombstones.map((tombstone) => [tombstone.id, tombstone.deletedAt]))
  return values.filter((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
    const entry = value as Record<string, unknown>
    if (typeof entry['id'] !== 'string') return true
    const deletedAt = byId.get(entry['id'])
    if (deletedAt === undefined) return true
    const updatedAt = typeof entry['updatedAt'] === 'number' ? entry['updatedAt'] : 0
    return updatedAt > deletedAt
  })
}

// ── Response sanitizers (used by the HTTP layer on GET) ──────────────────

/**
 * Sanitize a parsed per-device usage map so legacy single-blob rows (or
 * corrupt data) degrade to an empty map instead of breaking strict client
 * validation.
 */
export function sanitizeUsageMapForResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const usage = sanitizeDeviceUsage(raw)
    if (usage && usage.deviceId === id) result[id] = usage
  }
  return result
}

/** Sanitize a parsed global-memory list to the canonical shape. */
export function sanitizeMemoriesForResponse(value: unknown): SyncedMemoryEntry[] {
  if (!Array.isArray(value)) return []
  const memories: SyncedMemoryEntry[] = []
  for (const item of value) {
    const entry = sanitizeGlobalMemory(item)
    if (entry) memories.push(entry)
  }
  return memories
}

/** Sanitize a parsed tombstone list to the canonical shape. */
export function sanitizeTombstonesForResponse(value: unknown): MemoryTombstone[] {
  if (!Array.isArray(value)) return []
  const tombstones: MemoryTombstone[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record['id'] !== 'string' || typeof record['deletedAt'] !== 'number') continue
    tombstones.push({ id: record['id'], deletedAt: record['deletedAt'] })
  }
  return tombstones
}
