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
    usageJson: v.string(),
    globalMemoriesJson: v.string(),
    updatedAt: v.number()
  },
  /**
   * Persist the profile. Global memories are merged per entry (newest
   * `updatedAt` wins) instead of wholesale-replaced, so two devices can sync
   * the same account without clobbering each other's entries. Returns the
   * merged entry list so the HTTP handler can hand every device the union.
   */
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('accountProfiles')
      .withIndex('by_auth_user_id', (query) => query.eq('authUserId', args.authUserId))
      .unique()
    const mergedMemories = mergeGlobalMemories(
      existing ? readStoredJson(existing.globalMemoriesJson) : [],
      readStoredJson(args.globalMemoriesJson)
    )
    const merged = {
      ...args,
      globalMemoriesJson: JSON.stringify(mergedMemories)
    }
    if (existing) {
      await ctx.db.patch(existing._id, merged)
      return mergedMemories
    }
    await ctx.db.insert('accountProfiles', merged)
    return mergedMemories
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
