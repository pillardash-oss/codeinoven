import type {
  MemoryEntry,
  MemoryExportFile,
  MemoryExportKind,
  MemoryImportPreview
} from '../../../lib/types'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import { normalizeText } from './memory-extraction'
import { isRecord, optionalEntityId, validateMemoryConfig } from './memory-validation'

export const MEMORY_EXPORT_FORMAT = 'codeinoven-memory'
export const MEMORY_EXPORT_VERSION = 1

export function serializeMemoryExport(input: {
  kind: MemoryExportKind
  projectId?: string
  entries: MemoryEntry[]
}): string {
  const file: MemoryExportFile = {
    format: MEMORY_EXPORT_FORMAT,
    version: MEMORY_EXPORT_VERSION,
    exportedAt: Date.now(),
    kind: input.kind,
    projectId: input.kind === 'project' ? input.projectId : undefined,
    entries: input.entries
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Validate an exported memory JSON string and return a preview of what it
 * contains without touching any storage file.
 */
export function parseMemoryExport(value: unknown): MemoryImportPreview {
  if (!isRecord(value)) throw new TypeError('The file does not contain a memory export')
  if (value.format !== MEMORY_EXPORT_FORMAT) {
    throw new TypeError('The file is not a CodeInOven memory export')
  }
  if (value.version !== MEMORY_EXPORT_VERSION) {
    throw new TypeError('The memory export version is not supported by this app')
  }
  if (!Array.isArray(value.entries)) {
    throw new TypeError('The memory export contains no entries array')
  }
  const kind = value.kind
  if (kind !== 'projects' && kind !== 'chats' && kind !== 'both' && kind !== 'project') {
    throw new TypeError('The memory export kind is invalid')
  }
  const projectId = value.projectId
  if (typeof projectId !== 'undefined' && typeof projectId !== 'string') {
    throw new TypeError('The memory export project ID is invalid')
  }
  // Entries are validated individually: the per-file limits that
  // `validateMemoryConfig` enforces across an array do not apply to a whole
  // export, which may contain entries from many storage files.
  const entries = value.entries.map((entry, index) => {
    try {
      return validateMemoryConfig({ enabled: true, entries: [entry] }).entries[0]
    } catch (cause) {
      throw new TypeError(
        `Memory entry ${index} is invalid: ${cause instanceof Error ? cause.message : 'invalid entry'}`,
        { cause }
      )
    }
  })
  return {
    format: MEMORY_EXPORT_FORMAT,
    version: MEMORY_EXPORT_VERSION,
    kind,
    projectId,
    entryCount: entries.length,
    entries
  }
}

/** Validate that an export kind and optional project ID form a legal request. */
export function validateMemoryExportKind(
  kind: unknown,
  projectId?: unknown
): {
  kind: MemoryExportKind
  projectId?: string
} {
  if (kind !== 'projects' && kind !== 'chats' && kind !== 'both' && kind !== 'project') {
    throw new TypeError('Memory export scope is invalid')
  }
  if (kind === 'project') {
    const safeProjectId = optionalEntityId(projectId, 'Project ID')
    if (!safeProjectId) {
      throw new TypeError('A project export requires a project ID')
    }
    return { kind, projectId: safeProjectId }
  }
  return { kind }
}

/** Whether an entry belongs to a given export scope. Global applies to both. */
export function entryBelongsToExportKind(entry: MemoryEntry, kind: MemoryExportKind): boolean {
  switch (kind) {
    case 'both':
      return true
    case 'projects':
      return (
        entry.scope === 'global' ||
        entry.scope === 'projects' ||
        entry.scope === 'project' ||
        (entry.scope === 'thread' && entry.projectId !== INBOX_PROJECT_ID)
      )
    case 'chats':
      return (
        entry.scope === 'global' ||
        entry.scope === 'chat' ||
        (entry.scope === 'thread' && entry.projectId === INBOX_PROJECT_ID)
      )
    case 'project':
      return (
        entry.scope === 'global' ||
        entry.scope === 'projects' ||
        entry.scope === 'project' ||
        entry.scope === 'thread'
      )
  }
}

/** Resolve the storage file an imported entry should be written to. */
export function importDestinationFor(
  entry: MemoryEntry,
  options: { kind: MemoryExportKind; projectId?: string }
): { projectId?: string; threadId?: string } | null {
  switch (entry.scope) {
    case 'global':
    case 'projects':
      return {}
    case 'chat':
      return { projectId: INBOX_PROJECT_ID }
    case 'project': {
      const projectId = options.kind === 'project' ? options.projectId : entry.projectId
      if (!projectId) return null
      return { projectId }
    }
    case 'thread': {
      const projectId = options.kind === 'project' ? options.projectId : entry.projectId
      if (!projectId || !entry.threadId) return null
      return { projectId, threadId: entry.threadId }
    }
  }
}

/** Dedupe identity: scope + normalized content (the user-chosen merge rule). */
export function dedupeKey(entry: MemoryEntry): string {
  return `${entry.scope}\0${normalizeText(entry.content)}`
}

export function dedupeEntriesById(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const result: MemoryEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}
