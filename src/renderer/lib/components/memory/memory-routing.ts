import { INBOX_PROJECT_ID } from '$shared/types'
import type { MemoryEntry, MemoryScope } from '$shared/types'

/** A treated memory storage location: root, per-project, or per-thread file. */
export interface MemoryLocation {
  projectId?: string
  threadId?: string
}

/**
 * Which memory surface a panel is, which decides both the scopes it offers and
 * the files it owns.
 *
 * - `settings` is the global memory page: it owns `global` (both), `projects`
 *   (all projects), and `chat` (all chats), which live in the root file and the
 *   inbox project file.
 * - `sidebar-projects` is a project conversation's memory sidebar: it owns the
 *   projects-wide `projects` scope (shown to the user as "Global"), the
 *   `project` scope, and the `thread` scope. Truly cross-audience `global`
 *   memory is settings-only and is preserved untouched by a sidebar save.
 * - `sidebar-chats` is a chat conversation's memory sidebar: it owns the
 *   `chat` scope (shown as "Global") and the `thread` scope.
 * - `sidebar-assistant` is an assistant task's memory sidebar. Assistant tasks
 *   are conversations inside the hidden assistant space, so the engine loads
 *   them exactly like a project thread (root `projects` scope, the assistant
 *   space's own file, and the task's file). It therefore owns the same three
 *   scopes but pins the project to the assistant space, because an assistant
 *   task never belongs to any project the user can pick.
 */
export type MemoryPanelSurface =
  'settings' | 'sidebar-projects' | 'sidebar-chats' | 'sidebar-assistant'

/** One selectable scope, with the pickers it needs on the surface offering it. */
export interface MemoryScopeOption {
  value: MemoryScope
  label: string
  /** The entry stores a chosen project on itself. */
  needsProject: boolean
  /** The entry stores a chosen thread on itself. */
  needsThread: boolean
}

/**
 * The scope choices per surface. Labels are surface-specific on purpose: a
 * project sidebar calls the projects-wide scope "Global" because that is what
 * it means to a single conversation, while the settings page names the three
 * audiences plainly so a user knows where a memory applies.
 */
export const MEMORY_SCOPE_OPTIONS = {
  settings: [
    { value: 'projects', label: 'Projects', needsProject: false, needsThread: false },
    { value: 'chat', label: 'Chats', needsProject: false, needsThread: false },
    { value: 'global', label: 'Both', needsProject: false, needsThread: false }
  ],
  'sidebar-projects': [
    { value: 'projects', label: 'Global', needsProject: false, needsThread: false },
    { value: 'project', label: 'Specific project', needsProject: true, needsThread: false },
    { value: 'thread', label: 'Thread', needsProject: true, needsThread: true }
  ],
  'sidebar-chats': [
    { value: 'chat', label: 'Global', needsProject: false, needsThread: false },
    { value: 'thread', label: 'Thread', needsProject: false, needsThread: true }
  ],
  'sidebar-assistant': [
    { value: 'projects', label: 'Global', needsProject: false, needsThread: false },
    { value: 'project', label: 'Assistant', needsProject: false, needsThread: false },
    { value: 'thread', label: 'This task', needsProject: false, needsThread: false }
  ]
} as const satisfies Record<MemoryPanelSurface, readonly MemoryScopeOption[]>

/**
 * Scopes a memory panel manages for one load/save run. Scopes a run does not
 * manage are preserved as-is when a save rewrites a shared destination file
 * (e.g. a project sidebar save must never drop the root `global` entries it
 * never loaded).
 */
export const MEMORY_MANAGED_SCOPES = {
  settings: ['global', 'projects', 'chat'],
  'sidebar-projects': ['projects', 'project', 'thread'],
  'sidebar-chats': ['chat', 'thread'],
  'sidebar-assistant': ['projects', 'project', 'thread']
} as const satisfies Record<MemoryPanelSurface, readonly MemoryScope[]>

export function managedScopesFor(surface: MemoryPanelSurface): readonly MemoryScope[] {
  return MEMORY_MANAGED_SCOPES[surface]
}

/** The scope a newly created memory starts in on each surface. */
export function defaultScopeForSurface(surface: MemoryPanelSurface): MemoryScope {
  return MEMORY_SCOPE_OPTIONS[surface][0]?.value ?? 'projects'
}

/**
 * The ids an entry keeps when its scope changes, and the ones it must drop.
 *
 * A `project`/`thread` scope seeds from the entry's own pending choice first and
 * the panel's context second, so switching scope inside a conversation lands on
 * the project (or thread) the user is already in instead of an empty picker.
 */
export function scopeIdsForChange(
  scope: MemoryScope,
  current: MemoryLocation = {},
  context: MemoryLocation = {}
): MemoryLocation {
  switch (scope) {
    case 'global':
    case 'projects':
    case 'chat':
      return { projectId: undefined, threadId: undefined }
    case 'project':
      return { projectId: current.projectId ?? context.projectId, threadId: undefined }
    case 'thread':
      return {
        projectId: current.projectId ?? context.projectId,
        threadId: current.threadId ?? context.threadId
      }
  }
}

export function memoryLocationKey(location: MemoryLocation): string {
  return `${location.projectId ?? ''}\0${location.threadId ?? ''}`
}

/**
 * Resolve the storage file a memory entry belongs to from its scope.
 *
 * `fallback` supplies the panel's own project/thread (sidebar panels), which
 * is how entries staged in a context with no IDs of their own get placed.
 */
export function memoryDestinationFor(
  entry: MemoryEntry,
  fallback: MemoryLocation = {}
): MemoryLocation {
  switch (entry.scope) {
    case 'global':
    case 'projects':
      return {}
    case 'chat':
      return { projectId: INBOX_PROJECT_ID }
    case 'project': {
      const projectId = entry.projectId ?? fallback.projectId
      if (!projectId) {
        throw new Error(
          `"${entry.label}" needs a project. Use Global or Projects scope, or add this memory inside a project.`
        )
      }
      return { projectId }
    }
    case 'thread': {
      const projectId = entry.projectId ?? fallback.projectId
      const threadId = entry.threadId ?? fallback.threadId
      if (!projectId || !threadId) {
        throw new Error(
          `"${entry.label}" needs a thread. Use Global, Projects, or Chats scope, or add this memory inside a thread.`
        )
      }
      return { projectId, threadId }
    }
  }
}

/** Strip or set entry IDs so they match the file the entry is written to. */
export function normalizeMemoryEntryForLocation(
  entry: MemoryEntry,
  location: MemoryLocation
): MemoryEntry {
  if (entry.scope === 'global' || entry.scope === 'projects') {
    return { ...entry, projectId: undefined, threadId: undefined }
  }
  if (entry.scope === 'chat') {
    return { ...entry, projectId: INBOX_PROJECT_ID, threadId: undefined }
  }
  if (entry.scope === 'project') {
    return { ...entry, projectId: location.projectId, threadId: undefined }
  }
  return { ...entry, projectId: location.projectId, threadId: location.threadId }
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
 * Includes every location the panel's original load touched   even one that
 * now has zero managed entries   so deleting the last entry in a scope still
 * reaches its file instead of silently no-op'ing. `loadedIds` lets the
 * caller distinguish "the user deleted this" (was loaded, now absent) from
 * "this appeared elsewhere after load" (never loaded, still on disk), which
 * a save must never overwrite.
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
    ensure(location).managedEntries.push(normalizeMemoryEntryForLocation(entry, location))
  }
  return [...groups.values()]
}
