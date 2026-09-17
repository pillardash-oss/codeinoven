import type { MemoryEntry, MemoryPriority, MemoryScope } from '../../../lib/types'
import { optionalEntityId } from './memory-validation'

interface MemoryLocation {
  projectId?: string
  threadId?: string
  entryProjectId?: string
  entryThreadId?: string
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

export function locationForScope(
  scope: MemoryScope,
  projectId?: string,
  threadId?: string
): MemoryLocation {
  if (scope === 'global' || scope === 'projects') return {}
  if (scope === 'chat') return { projectId: 'inbox' }

  const safeProjectId = optionalEntityId(projectId, 'Project ID')
  if (!safeProjectId) {
    throw new TypeError(`${scope === 'thread' ? 'Thread' : 'Project'} memory requires a project ID`)
  }
  if (scope === 'project') {
    if (safeProjectId === 'inbox')
      throw new TypeError('Project memory does not accept the chat scope')
    if (threadId !== undefined) throw new TypeError('Project memory does not accept a thread ID')
    return { projectId: safeProjectId, entryProjectId: safeProjectId }
  }

  const safeThreadId = optionalEntityId(threadId, 'Thread ID')
  if (!safeThreadId) throw new TypeError('Thread memory requires a thread ID')
  return {
    projectId: safeProjectId,
    threadId: safeThreadId,
    entryProjectId: safeProjectId,
    entryThreadId: safeThreadId
  }
}

export function assertEntryLocation(
  entry: MemoryEntry,
  projectId?: string,
  threadId?: string
): void {
  const expected = locationForScope(entry.scope, entry.projectId, entry.threadId)
  const actualProjectId =
    projectId === 'inbox' ? 'inbox' : optionalEntityId(projectId, 'Project ID')
  const actualThreadId = optionalEntityId(threadId, 'Thread ID')
  if (expected.projectId !== actualProjectId || expected.threadId !== actualThreadId) {
    throw new TypeError(`Memory entry "${entry.label}" does not belong in this storage scope`)
  }
}

export function entryAppliesToContext(
  entry: MemoryEntry,
  projectId?: string,
  threadId?: string,
  modelKey?: string
): boolean {
  const scopeMatches = (() => {
    switch (entry.scope) {
      case 'global':
        return true
      case 'projects':
        return Boolean(projectId && projectId !== 'inbox')
      case 'project':
        return Boolean(entry.projectId && entry.projectId === projectId)
      case 'thread':
        return Boolean(
          entry.projectId &&
          entry.threadId &&
          entry.projectId === projectId &&
          entry.threadId === threadId
        )
      case 'chat':
        return projectId === 'inbox'
    }
  })()
  if (!scopeMatches) return false
  return entry.category !== 'models' || Boolean(modelKey && entry.modelKeys?.includes(modelKey))
}
