import type { MemoryEntry, MemoryPriority, MemoryScope } from '../../../lib/types'
import {
  memoryAppliesToContext as scopesApplyToContext,
  memoryAudienceForContainer,
  memoryLocationForScopes,
  memoryScopesMatchContext,
  type MemoryContext
} from '../../../lib/memory/memory-scopes'
import { optionalEntityId } from './memory-validation'

interface MemoryLocation {
  projectId?: string
  threadId?: string
  entryProjectId?: string
  entryThreadId?: string
  entryRoutineId?: string
}

export function groupByCategory(entries: MemoryEntry[]): Record<MemoryPriority, MemoryEntry[]> {
  const grouped: Record<MemoryPriority, MemoryEntry[]> = {
    critical: [],
    high: [],
    medium: [],
    low: []
  }
  for (const entry of entries) {
    grouped[entry.priority].push(entry)
  }
  return grouped
}

/**
 * The file a scope set addresses, plus the ids the entry must carry to live
 * there. Audience-level sets land in their audience's own file (or the root
 * file when the set covers several audiences or every audience), located sets
 * land in the file of the place they name, and routine memory shares the
 * assistant container's file and is filtered by its routine id.
 */
export function locationForScopes(
  scopes: readonly MemoryScope[],
  projectId?: string,
  threadId?: string,
  routineId?: string
): MemoryLocation {
  const safeProjectId =
    projectId === undefined ? undefined : optionalEntityId(projectId, 'Project ID')
  const safeThreadId = threadId === undefined ? undefined : optionalEntityId(threadId, 'Thread ID')
  const safeRoutineId =
    routineId === undefined ? undefined : optionalEntityId(routineId, 'Routine ID')
  const expected = memoryLocationForScopes(scopes, {
    projectId: safeProjectId,
    threadId: safeThreadId,
    routineId: safeRoutineId
  })
  return {
    projectId: expected.projectId,
    threadId: expected.threadId,
    entryProjectId: expected.projectId,
    entryThreadId: expected.threadId,
    entryRoutineId: expected.routineId
  }
}

/**
 * Reject an entry that would be written into a file its scopes do not address,
 * and stamp the ids its scopes imply, so a re-scoped entry never keeps a stale
 * project, thread, or routine id.
 */
export function normalizeEntriesForLocation(
  entries: readonly MemoryEntry[],
  projectId?: string,
  threadId?: string
): MemoryEntry[] {
  const actualProjectId =
    projectId === undefined ? undefined : optionalEntityId(projectId, 'Project ID')
  const actualThreadId =
    threadId === undefined ? undefined : optionalEntityId(threadId, 'Thread ID')
  return entries.map((entry) => {
    const expected = locationForScopes(
      entry.scopes,
      entry.projectId,
      entry.threadId,
      entry.routineId
    )
    if (expected.projectId !== actualProjectId || expected.threadId !== actualThreadId) {
      throw new TypeError(`Memory entry "${entry.label}" does not belong in this storage scope`)
    }
    return {
      ...entry,
      projectId: expected.entryProjectId,
      threadId: expected.entryThreadId,
      routineId: expected.entryRoutineId
    }
  })
}

/** Whether an entry's scope set reaches one thread's context. */
export function entryMatchesContext(
  entry: MemoryEntry,
  projectId?: string,
  threadId?: string,
  routineId?: string
): boolean {
  return memoryScopesMatchContext(entry, contextFor(projectId, threadId, routineId))
}

/** Whether an entry is sent to the agent for one thread's context. */
export function entryAppliesToContext(
  entry: MemoryEntry,
  projectId?: string,
  threadId?: string,
  modelKey?: string,
  routineId?: string
): boolean {
  return scopesApplyToContext(entry, contextFor(projectId, threadId, routineId, modelKey))
}

function contextFor(
  projectId?: string,
  threadId?: string,
  routineId?: string,
  modelKey?: string
): MemoryContext {
  return {
    audience: memoryAudienceForContainer(projectId),
    projectId,
    threadId,
    routineId,
    modelKey
  }
}
