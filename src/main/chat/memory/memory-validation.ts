import type {
  MemoryCategory,
  MemoryConfig,
  MemoryEntry,
  MemoryPriority,
  MemoryScope,
  MemorySource
} from '../../../lib/types'
import { isHarnessScopedModelKey } from '../../../lib/model-keys'
import {
  MEMORY_AUDIENCES,
  MEMORY_LOCATION_SCOPES,
  isMemoryLocationScope,
  orderMemoryScopes,
  readMemoryScopes
} from '../../../lib/memory/memory-scopes'
import { MEMORY_LIMITS } from './memory-constants'

export const VALID_CATEGORIES: MemoryCategory[] = [
  'behavioral',
  'project-rule',
  'identity',
  'preference',
  'models'
]
export const VALID_PRIORITIES: MemoryPriority[] = ['critical', 'high', 'medium', 'low']
export const VALID_SCOPES: MemoryScope[] = [...MEMORY_AUDIENCES, ...MEMORY_LOCATION_SCOPES]
export const VALID_SOURCES: MemorySource[] = ['manual', 'auto-detected']
const MAX_MODEL_KEYS = 50
const MODEL_KEY_MAX_CHARACTERS = 512

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/iu
]

export function validateMemoryConfig(value: unknown): MemoryConfig {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.entries)) {
    throw new TypeError('Memory config must contain enabled and entries')
  }
  if (value.entries.length > MEMORY_LIMITS.maxEntries) {
    throw new TypeError(`Memory supports at most ${MEMORY_LIMITS.maxEntries} entries`)
  }
  const ids = new Set<string>()
  const entries = value.entries.map((entry, index): MemoryEntry => {
    if (!isRecord(entry)) throw new TypeError(`Memory entry ${index} must be an object`)
    const id = text(entry.id, `Memory entry ${index} ID`, 1, 128)
    if (!SAFE_ID.test(id)) throw new TypeError(`Memory entry ${index} has an unsafe ID`)
    if (ids.has(id)) throw new TypeError(`Duplicate memory entry ID: ${id}`)
    ids.add(id)
    const label = text(
      entry.label,
      `Memory entry ${index} label`,
      1,
      MEMORY_LIMITS.maxLabelCharacters
    )
    const content = text(
      entry.content,
      `Memory entry ${index} content`,
      1,
      MEMORY_LIMITS.maxEntryCharacters
    )
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      throw new TypeError(`Memory entry ${index} appears to contain a credential or private key`)
    }
    if (typeof entry.enabled !== 'boolean') {
      throw new TypeError(`Memory entry ${index} enabled must be a boolean`)
    }
    if (
      typeof entry.updatedAt !== 'number' ||
      !Number.isSafeInteger(entry.updatedAt) ||
      entry.updatedAt < 0
    ) {
      throw new TypeError(`Memory entry ${index} updatedAt must be a safe timestamp`)
    }
    const createdAt =
      typeof entry.createdAt === 'number' &&
      Number.isSafeInteger(entry.createdAt) &&
      entry.createdAt >= 0
        ? entry.createdAt
        : entry.updatedAt
    const category = enumValue(
      entry.category,
      VALID_CATEGORIES,
      'preference',
      `Memory entry ${index} category`
    )
    const priority = enumValue(
      entry.priority,
      VALID_PRIORITIES,
      'medium',
      `Memory entry ${index} priority`
    )
    const scope = typeof entry.scope === 'string' ? (entry.scope as MemoryScope) : undefined
    const source = enumValue(entry.source, VALID_SOURCES, 'manual', `Memory entry ${index} source`)
    const modelKeys = validateModelKeys(entry.modelKeys, `Memory entry ${index} model keys`)
    if (category === 'models' && modelKeys.length === 0) {
      throw new TypeError(`Memory entry ${index} requires at least one model`)
    }
    const frequency = optionalSafeInteger(entry.frequency, 1, `Memory entry ${index} frequency`, 1)
    const lastReinforced = optionalSafeInteger(
      entry.lastReinforced,
      entry.updatedAt,
      `Memory entry ${index} lastReinforced`,
      0
    )
    const projectId = optionalEntityId(entry.projectId, `Memory entry ${index} project ID`)
    const threadId = optionalEntityId(entry.threadId, `Memory entry ${index} thread ID`)
    const routineId = optionalEntityId(entry.routineId, `Memory entry ${index} routine ID`)
    const scopes = validateMemoryScopes(
      entry.scopes,
      { scope, projectId },
      `Memory entry ${index} scopes`
    )
    return {
      id,
      label,
      content,
      enabled: entry.enabled,
      createdAt,
      updatedAt: entry.updatedAt,
      category,
      priority,
      scopes,
      source,
      frequency,
      lastReinforced,
      projectId,
      threadId,
      routineId,
      ...(category === 'models' && modelKeys.length > 0 ? { modelKeys } : {})
    }
  })
  const aggregate = entries.reduce((total, entry) => total + entry.content.length, 0)
  if (aggregate > MEMORY_LIMITS.maxAggregateCharacters) {
    throw new TypeError(
      `Memory content exceeds ${MEMORY_LIMITS.maxAggregateCharacters} aggregate characters`
    )
  }
  const chatEnabled = typeof value.chatEnabled === 'boolean' ? value.chatEnabled : true
  return { enabled: value.enabled, chatEnabled, entries }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.trim().length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must contain ${minimum}-${maximum} safe characters`)
  }
  return value.trim()
}

export function optionalSafeInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer`)
  }
  return value
}

export function enumValue<T extends string>(
  value: unknown,
  valid: readonly T[],
  fallback: T,
  label: string
): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !valid.includes(value as T)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as T
}

/**
 * Validate a stored scope set.
 *
 * A set is either audience-level (any subset of the three audiences, empty
 * meaning every audience) or exactly one place inside an audience. The legacy
 * single `scope` field is accepted so a file written before the set existed
 * still validates, and it is normalized to its audience meaning.
 */
export function validateMemoryScopes(
  value: unknown,
  legacy: { scope?: string; projectId?: string } = {},
  label = 'Memory scopes'
): MemoryScope[] {
  if (value === undefined)
    return readMemoryScopes({ scope: legacy.scope, projectId: legacy.projectId })
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  const scopes = value.map((candidate, index) => {
    if (typeof candidate !== 'string' || !VALID_SCOPES.includes(candidate as MemoryScope)) {
      throw new TypeError(`${label} item ${index} is invalid`)
    }
    return candidate as MemoryScope
  })
  const unique = orderMemoryScopes([...new Set(scopes)])
  const located = unique.filter(isMemoryLocationScope)
  if (located.length > 1) {
    throw new TypeError(`${label} cannot pin a memory to more than one place`)
  }
  if (located.length === 1 && unique.length > 1) {
    throw new TypeError(`${label} cannot mix an audience with a pinned place`)
  }
  return unique
}

export function optionalEntityId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const id = text(value, label, 1, 128)
  if (!SAFE_ID.test(id)) throw new TypeError(`${label} is unsafe`)
  return id
}

export function parseModelKeysMetadata(value: string | undefined): string[] {
  if (!value) return []
  try {
    return validateModelKeys(JSON.parse(value) as unknown, 'Memory model keys')
  } catch {
    return []
  }
}

export function validateModelKeys(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  if (value.length > MAX_MODEL_KEYS) {
    throw new TypeError(`${label} supports at most ${MAX_MODEL_KEYS} models`)
  }
  const keys = value.map((candidate, index) => {
    if (
      typeof candidate !== 'string' ||
      candidate.includes('\0') ||
      candidate.trim().length === 0 ||
      candidate.length > MODEL_KEY_MAX_CHARACTERS ||
      !isHarnessScopedModelKey(candidate.trim())
    ) {
      throw new TypeError(`${label} item ${index} is invalid`)
    }
    return candidate.trim()
  })
  return [...new Set(keys)]
}
