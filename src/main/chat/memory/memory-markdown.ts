import { createHash } from 'crypto'
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryPriority,
  MemoryScope,
  MemorySource
} from '../../../lib/types'
import { ENTRY_MARKER } from './memory-constants'
import {
  SAFE_ID,
  VALID_CATEGORIES,
  VALID_PRIORITIES,
  VALID_SCOPES,
  VALID_SOURCES,
  parseModelKeysMetadata
} from './memory-validation'

function safeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/u.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

/** Parse memory entries from the current marked Markdown format. */
export function parseMemoryMd(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  const blocks = content.split(ENTRY_MARKER).slice(1)
  for (const [index, block] of blocks.entries()) {
    const match = block.match(/^\s*##\s+(.+?)\s*$/mu)
    if (!match) continue
    const label = match[1].trim()
    const body = block.replace(/^\s*##\s+(.+?)\s*$/mu, '').trim()
    if (!label || !body) continue

    const sections = body.split(/\r?\n\s*\r?\n/u)
    const metadata = new Map<string, string>()
    for (const line of sections[0].split(/\r?\n/u)) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      metadata.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
    }
    const hasMetadata = ['category', 'priority', 'scope', 'source', 'id'].some((key) =>
      metadata.has(key)
    )
    const cleanBody = hasMetadata ? sections.slice(1).join('\n\n').trim() : body
    if (!cleanBody) continue
    const now = Date.now()
    const fallbackId = `memory-${createHash('sha256')
      .update(`${label}\0${cleanBody}\0${index}`)
      .digest('hex')
      .slice(0, 12)}`
    const category = metadata.get('category')
    const priority = metadata.get('priority')
    const scope = metadata.get('scope')
    const source = metadata.get('source')
    const modelKeys = parseModelKeysMetadata(metadata.get('modelkeys'))

    const updatedAt = safeInteger(metadata.get('updatedat'), now)
    entries.push({
      id: SAFE_ID.test(metadata.get('id') ?? '') ? metadata.get('id')! : fallbackId,
      label,
      content: cleanBody,
      enabled: metadata.get('enabled') !== 'false',
      // Entries written before createdAt existed fall back to their updatedAt.
      createdAt: safeInteger(metadata.get('createdat'), updatedAt),
      updatedAt,
      category: VALID_CATEGORIES.includes(category as MemoryCategory)
        ? (category as MemoryCategory)
        : 'preference',
      priority: VALID_PRIORITIES.includes(priority as MemoryPriority)
        ? (priority as MemoryPriority)
        : 'medium',
      scope: VALID_SCOPES.includes(scope as MemoryScope) ? (scope as MemoryScope) : 'global',
      source: VALID_SOURCES.includes(source as MemorySource) ? (source as MemorySource) : 'manual',
      frequency: safeInteger(metadata.get('frequency'), 1),
      lastReinforced: safeInteger(metadata.get('lastreinforced'), now),
      projectId: metadata.get('projectid') || undefined,
      threadId: metadata.get('threadid') || undefined,
      ...(modelKeys.length > 0 ? { modelKeys } : {})
    })
  }
  return entries
}

/** Serialize memory entries to Markdown format with metadata. */
export function serializeMemoryMd(entries: MemoryEntry[]): string {
  return entries
    .map((entry) => {
      const meta = [
        `id: ${entry.id}`,
        `enabled: ${entry.enabled}`,
        `createdAt: ${entry.createdAt}`,
        `updatedAt: ${entry.updatedAt}`,
        `category: ${entry.category}`,
        `priority: ${entry.priority}`,
        `scope: ${entry.scope}`,
        `source: ${entry.source}`,
        `frequency: ${entry.frequency}`,
        `lastReinforced: ${entry.lastReinforced}`
      ]
      if (entry.projectId) meta.push(`projectId: ${entry.projectId}`)
      if (entry.threadId) meta.push(`threadId: ${entry.threadId}`)
      if (entry.modelKeys?.length) meta.push(`modelKeys: ${JSON.stringify(entry.modelKeys)}`)
      return `${ENTRY_MARKER}\n## ${entry.label}\n\n${meta.join('\n')}\n\n${entry.content}`
    })
    .join('\n\n')
}
