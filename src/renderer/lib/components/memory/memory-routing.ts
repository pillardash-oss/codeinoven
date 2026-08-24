import { INBOX_PROJECT_ID } from '$shared/types'
import type { MemoryEntry, MemoryScope } from '$shared/types'

/** A treated memory storage location: root, per-project, or per-thread file. */
export interface MemoryLocation {
  projectId?: string
  threadId?: string
}

/**
 * Scopes a memory panel manages for one load/save run.
 *
 * A 'projects' run loads the root file plus every per-project and per-thread
 * file, so it manages `global`/`projects` (root), `project`, and `thread`
 * scopes. A 'chats' run loads the root global entries plus the chat file and
 * chat-thread files, so it manages `global` (root), `chat`, and `thread`.
 * Scopes a run does not manage are preserved as-is when a save rewrites a
 * shared destination file (e.g. a chats save must never drop `projects`-
 * scoped root entries it never loaded).
 */
export const MEMORY_MANAGED_SCOPES = {
  projects: ['global', 'projects', 'project', 'thread'],
  chats: ['global', 'chat', 'thread']
} as const satisfies Record<'projects' | 'chats', readonly MemoryScope[]>

export function managedScopesFor(kind: 'projects' | 'chats'): readonly MemoryScope[] {
  return MEMORY_MANAGED_SCOPES[kind]
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
