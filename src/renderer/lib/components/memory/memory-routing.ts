import { ASSISTANT_SPACE_ID } from '$shared/types'
import type { MemoryAudience, MemoryEntry, MemoryProposal, MemoryScope } from '$shared/types'
import {
  locationScopeOf,
  memoryLocationForScopes,
  memoryScopesMatchContext,
  type MemoryScopeLocation
} from '$shared/memory/memory-scopes'

/** The file-based home of a memory entry: the root file, a project file, or a
 *  thread file. Routine memory shares the assistant container's file and is
 *  filtered by `routineId` on the entry itself, so a save never needs a routine
 *  as a storage coordinate. */
export interface MemoryLocation {
  projectId?: string
  threadId?: string
}

/** The memory panel context, which controls scope labels and visibility. */
export type MemoryPanelSurface =
  'settings' | 'sidebar-projects' | 'sidebar-chats' | 'sidebar-assistant' | 'sidebar-browser'

/** One selectable scope, with the pickers it needs on the surface offering it. */
export interface MemoryScopeOption {
  value: MemoryScope
  /** Label on this surface. */
  label: string
  /** A place inside an audience: choosing it replaces the audience toggles. */
  located: boolean
  /** The entry stores a chosen project on itself. */
  needsProject: boolean
  /** The entry stores a chosen thread on itself. */
  needsThread: boolean
}

/** Audience choices are separate from Global, which uses an empty scope set. */
export const MEMORY_SCOPE_OPTIONS: Record<MemoryPanelSurface, readonly MemoryScopeOption[]> = {
  settings: [
    {
      value: 'projects',
      label: 'Projects',
      located: false,
      needsProject: false,
      needsThread: false
    },
    { value: 'chat', label: 'Chats', located: false, needsProject: false, needsThread: false },
    {
      value: 'assistant',
      label: 'Assistant',
      located: false,
      needsProject: false,
      needsThread: false
    },
    {
      value: 'browser',
      label: 'Browser chats',
      located: false,
      needsProject: false,
      needsThread: false
    }
  ],
  'sidebar-projects': [
    {
      value: 'projects',
      label: 'All projects',
      located: false,
      needsProject: false,
      needsThread: false
    },
    {
      value: 'project',
      label: 'Specific project',
      located: true,
      needsProject: true,
      needsThread: false
    },
    { value: 'thread', label: 'Thread', located: true, needsProject: true, needsThread: true }
  ],
  'sidebar-chats': [
    { value: 'chat', label: 'All chats', located: false, needsProject: false, needsThread: false },
    { value: 'thread', label: 'This chat', located: true, needsProject: false, needsThread: false }
  ],
  'sidebar-browser': [
    {
      value: 'browser',
      label: 'All browser chats',
      located: false,
      needsProject: false,
      needsThread: false
    },
    { value: 'thread', label: 'This chat', located: true, needsProject: false, needsThread: false }
  ],
  'sidebar-assistant': [
    {
      value: 'assistant',
      label: 'All routines',
      located: false,
      needsProject: false,
      needsThread: false
    },
    {
      value: 'routine',
      label: 'Specific routine',
      located: true,
      needsProject: false,
      needsThread: false
    },
    { value: 'task', label: 'Task', located: true, needsProject: false, needsThread: false }
  ]
}

/** Everything a surface knows about itself, used to decide what an entry means
 *  here and which ids a staged entry should fall back to. */
export interface MemorySurfaceContext {
  surface: MemoryPanelSurface
  projectId?: string
  threadId?: string
  routineId?: string
}

/** The audience-only set a newly created memory starts in on each surface.
 *  The first option of every surface is its audience-wide choice, so a fresh
 *  entry never lands on a place the user did not pick. */
export function defaultScopesForSurface(surface: MemoryPanelSurface): MemoryScope[] {
  return [MEMORY_SCOPE_OPTIONS[surface][0].value]
}

/** The audience a surface loads memory for. Settings is never used for a
 *  context check (it shows every audience-level entry), so it falls back to
 *  projects. */
export function surfaceContextAudience(surface: MemoryPanelSurface): MemoryAudience {
  if (surface === 'sidebar-browser') return 'browser'
  if (surface === 'sidebar-chats') return 'chat'
  if (surface === 'sidebar-assistant') return 'assistant'
  return 'projects'
}

/**
 * Whether an entry belongs on a surface.
 *
 * This one predicate is used both to filter what the panel shows and to decide
 * which on-disk entries a save must preserve, so the two can never drift: an
 * entry the user cannot see is exactly an entry the save leaves untouched.
 *
 * Settings shows audience-level entries only (an empty set counts, since it
 * applies everywhere). Every other surface asks the shared scope matcher, which
 * is what drops other routines' memory and other projects' memory.
 */
export function entryVisibleOnSurface(entry: MemoryEntry, context: MemorySurfaceContext): boolean {
  if (context.surface === 'settings') return locationScopeOf(entry.scopes) === null
  return memoryScopesMatchContext(entry, {
    audience: surfaceContextAudience(context.surface),
    projectId: context.projectId,
    threadId: context.threadId,
    routineId: context.routineId
  })
}

/** The proposal twin of `entryVisibleOnSurface`. A proposal has no enabled
 *  flag or frequency, but it carries the same scope set, so the same rule
 *  decides where it may be reviewed. */
export function proposalVisibleOnSurface(
  proposal: MemoryProposal,
  context: MemorySurfaceContext
): boolean {
  if (context.surface === 'settings') return locationScopeOf(proposal.scopes) === null
  return memoryScopesMatchContext(proposal, {
    audience: surfaceContextAudience(context.surface),
    projectId: context.projectId,
    threadId: context.threadId,
    routineId: context.routineId
  })
}

/**
 * The ids an entry should keep when its scope set changes.
 *
 * A place seeds from the entry's own pending choice first and the panel's
 * context second, so switching scope inside a conversation lands on the project
 * (or thread, or routine) the user is already in instead of an empty picker.
 * This never throws: a staged entry may legitimately be missing an id until the
 * user picks one, and the form warns about it before a save.
 */
export function locationForScopeChange(
  scopes: readonly MemoryScope[],
  current: MemoryScopeLocation = {},
  context: MemoryScopeLocation = {}
): MemoryScopeLocation {
  switch (locationScopeOf(scopes)) {
    case 'project':
      return { projectId: current.projectId ?? context.projectId }
    case 'thread':
      return {
        projectId: current.projectId ?? context.projectId,
        threadId: current.threadId ?? context.threadId
      }
    case 'routine':
      return {
        projectId: ASSISTANT_SPACE_ID,
        routineId: current.routineId ?? context.routineId
      }
    case 'task':
      return { projectId: ASSISTANT_SPACE_ID, threadId: current.threadId ?? context.threadId }
    default:
      return memoryLocationForScopes(scopes)
  }
}

/**
 * Resolve the storage file a memory entry belongs to from its scope set.
 *
 * `fallback` supplies the panel's own project/thread/routine (sidebar panels),
 * which is how entries staged in a context with no ids of their own get placed.
 * Missing ids raise an error that names the entry, so the panel can show the
 * user which entry it could not save.
 */
export function memoryDestinationFor(
  entry: MemoryEntry,
  fallback: MemoryScopeLocation = {}
): MemoryLocation {
  const location = locationScopeOf(entry.scopes)
  const context: MemoryScopeLocation = {
    projectId: entry.projectId ?? fallback.projectId,
    threadId: entry.threadId ?? fallback.threadId,
    routineId: entry.routineId ?? fallback.routineId
  }
  if (location === 'project' && !context.projectId) {
    throw new Error(
      `"${entry.label}" needs a project. Use Global or Projects scope, or add this memory inside a project.`
    )
  }
  if (location === 'thread' && (!context.projectId || !context.threadId)) {
    throw new Error(
      `"${entry.label}" needs a thread. Use Global, Projects, or Chats scope, or add this memory inside a thread.`
    )
  }
  if (location === 'routine' && !context.routineId) {
    throw new Error(
      `"${entry.label}" needs a routine. Use Assistant scope, or add this memory inside a routine.`
    )
  }
  if (location === 'task' && !context.threadId) {
    throw new Error(
      `"${entry.label}" needs a task. Use Assistant scope, or add this memory inside an assistant task.`
    )
  }
  const destination = memoryLocationForScopes(entry.scopes, context)
  return { projectId: destination.projectId, threadId: destination.threadId }
}

/** Stamp the ids a scope set implies, so an entry written to a file never keeps
 *  a stale project, thread, or routine id that its scopes do not use. */
export function normalizeMemoryEntryForLocation(
  entry: MemoryEntry,
  location: MemoryScopeLocation
): MemoryEntry {
  const resolved = memoryLocationForScopes(entry.scopes, location)
  return {
    ...entry,
    projectId: resolved.projectId,
    threadId: resolved.threadId,
    routineId: resolved.routineId
  }
}

export function memoryLocationKey(location: MemoryLocation): string {
  return `${location.projectId ?? ''}\0${location.threadId ?? ''}`
}

/** One destination file a save touches, with enough context to reconcile it. */
export interface MemorySaveGroup {
  location: MemoryLocation
  /** The panel's current entries destined for this location (edits + keeps). */
  managedEntries: MemoryEntry[]
  /** IDs the panel already knew about here when it loaded. */
  loadedIds: Set<string>
}

/**
 * Group a panel's current entries by destination file for saving.
 *
 * Includes every location the panel's original load touched, even one that now
 * has zero managed entries, so deleting the last entry in a scope still reaches
 * its file instead of silently no-op'ing. `loadedIds` lets the caller
 * distinguish "the user deleted this" (was loaded, now absent) from "this
 * appeared elsewhere after load" (never loaded, still on disk), which a save
 * must never overwrite.
 */
export function planMemorySaveGroups(
  panelEntries: MemoryEntry[],
  loadedEntries: MemoryEntry[],
  fallback: MemoryLocation = {}
): MemorySaveGroup[] {
  const groups = new Map<string, MemorySaveGroup>()
  const ensure = (location: MemoryLocation): MemorySaveGroup => {
    const key = memoryLocationKey(location)
    const existing = groups.get(key)
    if (existing) return existing
    const created: MemorySaveGroup = { location, managedEntries: [], loadedIds: new Set() }
    groups.set(key, created)
    return created
  }
  for (const entry of loadedEntries) {
    ensure(memoryDestinationFor(entry, fallback)).loadedIds.add(entry.id)
  }
  for (const entry of panelEntries) {
    const location = memoryDestinationFor(entry, fallback)
    // Carry the entry's own routine id into the stamp, since the routine only
    // filters inside the assistant container's file and is not part of the
    // file location itself.
    ensure(location).managedEntries.push(
      normalizeMemoryEntryForLocation(entry, {
        projectId: location.projectId,
        threadId: location.threadId,
        routineId: entry.routineId
      })
    )
  }
  return [...groups.values()]
}

/** Compare editable values, ignoring timestamps and display order. */
export function memoryEntriesHaveChanges(
  entries: readonly MemoryEntry[],
  baseline: readonly MemoryEntry[]
): boolean {
  if (entries.length !== baseline.length) return true
  const originals = new Map(baseline.map((entry) => [entry.id, entry]))
  return entries.some((entry) => {
    const original = originals.get(entry.id)
    if (!original) return true
    return (
      entry.label !== original.label ||
      entry.content !== original.content ||
      entry.enabled !== original.enabled ||
      entry.category !== original.category ||
      entry.priority !== original.priority ||
      entry.projectId !== original.projectId ||
      entry.threadId !== original.threadId ||
      entry.routineId !== original.routineId ||
      entry.scopes.join(',') !== original.scopes.join(',') ||
      (entry.modelKeys ?? []).join('\0') !== (original.modelKeys ?? []).join('\0')
    )
  })
}
