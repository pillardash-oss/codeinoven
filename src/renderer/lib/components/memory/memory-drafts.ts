import type { MemoryEntry } from '$shared/types'
import { memoryEntriesHaveChanges } from './memory-routing'

export interface MemoryDraft {
  revision: string
  entries: MemoryEntry[]
  baseline: MemoryEntry[]
  expandedId: string | null
}

// Keep navigation instantaneous even before the two-second idle write fires.
const drafts = new Map<string, MemoryDraft>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const prefix = 'cio:memory-draft:'
// A panel combines at most three files, each capped at 50 entries.
const maxPanelEntries = 150

export function readMemoryDraft(key: string): MemoryDraft | undefined {
  const cached = drafts.get(key)
  if (cached) return cached
  try {
    const raw = sessionStorage.getItem(prefix + key)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return undefined
    if (!('revision' in parsed) || typeof parsed.revision !== 'string') return undefined
    if (!('entries' in parsed) || !('baseline' in parsed) || !('expandedId' in parsed))
      return undefined
    if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.baseline)) return undefined
    if (parsed.entries.length > maxPanelEntries || parsed.baseline.length > maxPanelEntries)
      return undefined
    if (!parsed.entries.every(isDraftEntry) || !parsed.baseline.every(isDraftEntry))
      return undefined
    const draft: MemoryDraft = {
      revision: parsed.revision,
      entries: parsed.entries,
      baseline: parsed.baseline,
      expandedId: typeof parsed.expandedId === 'string' ? parsed.expandedId : null
    }
    return draft
  } catch {
    return undefined
  }
}

/** Overlay only pending edits/deletions so other conversations' saves stay current. */
export function restoreMemoryDraft(
  key: string,
  freshEntries: MemoryEntry[]
): MemoryDraft | undefined {
  const draft = readMemoryDraft(key)
  if (!draft) return undefined
  const originals = new Map(draft.baseline.map((entry) => [entry.id, entry]))
  const draftIds = new Set(draft.entries.map((entry) => entry.id))
  const deletedIds = new Set(
    draft.baseline.filter((entry) => !draftIds.has(entry.id)).map((entry) => entry.id)
  )
  const edits = new Map(
    draft.entries
      .filter((entry) => {
        const original = originals.get(entry.id)
        return !original || memoryEntriesHaveChanges([entry], [original])
      })
      .map((entry) => [entry.id, entry])
  )
  const freshIds = new Set(freshEntries.map((entry) => entry.id))
  const entries = [
    ...freshEntries
      .filter((entry) => !deletedIds.has(entry.id))
      .map((entry) => edits.get(entry.id) ?? entry),
    ...draft.entries.filter((entry) => edits.has(entry.id) && !freshIds.has(entry.id))
  ]
  if (!memoryEntriesHaveChanges(entries, freshEntries)) clearMemoryDraft(key)
  return { ...draft, entries, baseline: freshEntries }
}

export function cacheMemoryDraft(key: string, content: Omit<MemoryDraft, 'revision'>): void {
  const draft: MemoryDraft = { ...content, revision: crypto.randomUUID() }
  drafts.set(key, draft)
  const previous = timers.get(key)
  if (previous) clearTimeout(previous)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      // Session storage survives a renderer reload. Writes are bounded to the
      // edited panel and only happen after typing stops.
      try {
        sessionStorage.setItem(prefix + key, JSON.stringify(draft))
        drafts.delete(key)
      } catch {
        // Navigation still retains the in-memory draft if storage is unavailable.
      }
    }, 2000)
  )
}

export function clearMemoryDraft(key: string): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
  drafts.delete(key)
  try {
    sessionStorage.removeItem(prefix + key)
  } catch {
    // The in-memory draft has already been cleared.
  }
}

function isDraftEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.content === 'string' &&
    typeof entry.enabled === 'boolean' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.updatedAt === 'number' &&
    typeof entry.frequency === 'number' &&
    typeof entry.lastReinforced === 'number' &&
    ['behavioral', 'project-rule', 'identity', 'preference', 'models'].includes(
      String(entry.category)
    ) &&
    ['critical', 'high', 'medium', 'low'].includes(String(entry.priority)) &&
    ['manual', 'auto-detected'].includes(String(entry.source)) &&
    Array.isArray(entry.scopes) &&
    entry.scopes.every(
      (scope: unknown) =>
        typeof scope === 'string' &&
        [
          'projects',
          'chat',
          'assistant',
          'browser',
          'project',
          'thread',
          'routine',
          'task'
        ].includes(scope)
    ) &&
    ['projectId', 'threadId', 'routineId'].every(
      (key) => entry[key] === undefined || typeof entry[key] === 'string'
    ) &&
    (entry.modelKeys === undefined ||
      (Array.isArray(entry.modelKeys) &&
        entry.modelKeys.every((key: unknown) => typeof key === 'string')))
  )
}
