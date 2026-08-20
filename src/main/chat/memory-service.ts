import { createHash } from 'crypto'
import { join } from 'path'
import type {
  AppConfig,
  MemoryCategory,
  MemoryConfig,
  MemoryEntry,
  MemoryExportFile,
  MemoryExportKind,
  MemoryImportPreview,
  MemoryPriority,
  MemoryProposal,
  MemoryScope,
  MemorySource,
  SpecContextReference
} from '../../lib/types'
import { INBOX_PROJECT_ID } from '../../lib/types'
import { isHarnessScopedModelKey } from '../../lib/model-keys'
import { StorageEngine } from '../storage/storage-engine'

const MEMORY_FILENAME = 'memory.md'
const PROPOSALS_FILENAME = 'memory-proposals.json'
const ENTRY_MARKER = '<!-- codeinoven-memory-entry -->'
const MEMORY_DIR = 'memory'
const MEMORY_PROJECTS_DIR = join(MEMORY_DIR, 'projects')
const MEMORY_CHATS_DIR = join(MEMORY_DIR, 'chats')
const THREADS_DIR = 'threads'

export const MEMORY_LIMITS = {
  maxEntries: 50,
  maxLabelCharacters: 80,
  maxEntryCharacters: 4_096,
  maxAggregateCharacters: 24_576,
  maxProposals: 20,
  proposalExpiryMs: 7 * 24 * 60 * 60 * 1000
} as const

/**
 * Bounds for auxiliary (deterministic + cheap-model) memory extraction so a
 * turn can never resend the full user/assistant transcript to a second model
 * session. These satisfy the A-06 acceptance: local caps, deduplication,
 * debounce, and a separately configurable cheap-model token budget.
 */
export const MEMORY_EXTRACTION_LIMITS = {
  maxUserCandidateCharacters: 2_000,
  maxAssistantCandidateCharacters: 8_000,
  maxCandidates: 3,
  debounceMs: 60_000,
  maxExtractionsPerWindow: 3,
  extractionWindowMs: 10 * 60 * 1000,
  cheapModelTokenBudget: 4_096
} as const

/** Standing-preference vocabulary that makes a user turn a durable candidate. */
const STANDING_PREFERENCE_PATTERN =
  /\b(?:always|never|from now on|in future|going forward|from here on|from today|please remember|remember that|i prefer|i like|i don'?t (?:like|want)|i want you to|prefer(?: \w+){0,4} over|make sure (?:to|you))\b/iu

const TRIVIAL_CONTINUATION_PATTERN =
  /^(?:ok|okay|yes|no|yep|nope|sure|fine|got it|understood|thanks|thank you|thank you!|thx|cool|nice|great|perfect|lgtm|please continue|continue|go ahead|go on|proceed)\b/iu

export interface MemoryCandidate {
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
}

export type MemorySkipReason = 'none' | 'no-candidate' | 'debounced' | 'over-budget'

export interface MemoryExtractionDecision {
  /** Whether a model-assisted extraction should run for this turn. */
  run: boolean
  /** Deterministic candidates extracted without a model call. */
  candidates: MemoryCandidate[]
  /** Skip reason when `run` is false. */
  reason: MemorySkipReason
  /** User text capped to local limits, safe to send to the cheap model. */
  userInput: string
  /** Assistant text capped to local limits and the token budget. */
  assistantInput: string
  /** Estimated cheap-model input tokens for this extraction. */
  inputTokens: number
}

/** Estimated token count (~4 characters per token) for auxiliary accounting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function capText(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return ''
  return text.length > maxCharacters ? text.slice(0, maxCharacters) : text
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

function isTrivialUserTurn(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length === 0 || trimmed.length < 15) return true
  if (trimmed.endsWith('?')) return true
  return TRIVIAL_CONTINUATION_PATTERN.test(trimmed)
}

function categoryForCandidate(message: string, matched: string): MemoryCategory {
  if (/i am\b|my name\b|i work as\b|i'?m a\b/i.test(matched)) return 'identity'
  if (/\bnever\b|\bdon'?t\b|\bdo not\b|make sure\b/i.test(matched)) return 'behavioral'
  if (/\bprefer\b|i like\b|i don'?t (?:like|want)\b/i.test(matched)) return 'preference'
  if (/\bproject|repository|codebase|stack|tooling\b/i.test(message)) return 'project-rule'
  return 'preference'
}

function priorityForCandidate(matched: string): MemoryPriority {
  return /\b(?:always|never|from now on|in future|going forward)\b/iu.test(matched)
    ? 'high'
    : 'medium'
}

/** Extract the sentences of the user message that carry a standing marker. */
function extractDurableContent(message: string): string {
  const sentences = message.split(/(?<=[.!?])\s+/u)
  const durable = sentences.filter((sentence) => STANDING_PREFERENCE_PATTERN.test(sentence))
  if (durable.length === 0 && STANDING_PREFERENCE_PATTERN.test(message)) return message
  return durable.join(' ')
}

/**
 * Deterministic, model-free memory candidate detection. Returns at most
 * `maxCandidates` candidates; a turn that is a question, acknowledgement,
 * continuation, one-off task instruction, or contains no standing-preference
 * vocabulary yields no candidate (and therefore no auxiliary model call).
 */
export function detectMemoryCandidates(input: {
  userMessage: string
  assistantResponse: string
  existingEntries: MemoryEntry[]
  projectId?: string
  threadId?: string
}): MemoryCandidate[] {
  const user = input.userMessage.trim()
  if (isTrivialUserTurn(user)) return []
  if (!STANDING_PREFERENCE_PATTERN.test(user)) return []

  const content = extractDurableContent(user)
  if (!content) return []
  const cappedContent = capText(content, MEMORY_EXTRACTION_LIMITS.maxUserCandidateCharacters)
  const match = STANDING_PREFERENCE_PATTERN.exec(cappedContent)
  const matched = match ? match[0] : ''
  const existing = new Set(
    input.existingEntries
      .filter((entry) => entry.enabled)
      .map((entry) => normalizeText(entry.content))
  )
  const scope: MemoryScope = input.projectId === 'inbox' ? 'thread' : 'project'
  const candidate: MemoryCandidate = {
    label: capText(cappedContent, MEMORY_LIMITS.maxLabelCharacters),
    content: cappedContent,
    category: categoryForCandidate(cappedContent, matched),
    priority: priorityForCandidate(cappedContent),
    scope
  }
  const normalized = normalizeText(candidate.content)
  if (existing.has(normalized)) return []

  const candidates: MemoryCandidate[] = [candidate]
  // Deduplicate within this turn (identical normalized content).
  return candidates.filter(
    (item, index) =>
      candidates.findIndex(
        (other) => normalizeText(other.content) === normalizeText(item.content)
      ) === index
  )
}

export interface MemoryExtractionLimits {
  maxUserCandidateCharacters: number
  maxAssistantCandidateCharacters: number
  maxCandidates: number
  debounceMs: number
  maxExtractionsPerWindow: number
  extractionWindowMs: number
  cheapModelTokenBudget: number
}

/** Read the cheap-model extraction budget, overridable per deployment. */
export function readMemoryExtractionLimits(): MemoryExtractionLimits {
  const tokenBudget = readPositiveIntEnv('CODEINOVEN_MEMORY_TOKEN_BUDGET')
  const debounceMs = readPositiveIntEnv('CODEINOVEN_MEMORY_DEBOUNCE_MS')
  const maxPerWindow = readPositiveIntEnv('CODEINOVEN_MEMORY_MAX_PER_WINDOW')
  return {
    ...MEMORY_EXTRACTION_LIMITS,
    cheapModelTokenBudget: tokenBudget ?? MEMORY_EXTRACTION_LIMITS.cheapModelTokenBudget,
    debounceMs: debounceMs ?? MEMORY_EXTRACTION_LIMITS.debounceMs,
    maxExtractionsPerWindow: maxPerWindow ?? MEMORY_EXTRACTION_LIMITS.maxExtractionsPerWindow
  }
}

function readPositiveIntEnv(name: string): number | null {
  const value = process.env[name]
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export type AuxiliaryFeature = 'memory' | 'title' | 'search_nudge'

export interface AuxiliaryUsageEntry {
  feature: AuxiliaryFeature
  inputChars: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  unavailableCost: boolean
  timestamp: number
}

export interface AuxiliaryUsageTotals {
  calls: number
  inputChars: number
  inputTokens: number
  outputTokens?: number
  estimatedCost: number
  unavailableCalls?: number
}

export interface AuxiliaryUsageMeasurement {
  outputTokens: number
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
}

const VALID_CATEGORIES: MemoryCategory[] = [
  'behavioral',
  'project-rule',
  'identity',
  'preference',
  'models'
]
const VALID_PRIORITIES: MemoryPriority[] = ['critical', 'high', 'medium', 'low']
const VALID_SCOPES: MemoryScope[] = ['global', 'projects', 'project', 'thread', 'chat']
const VALID_SOURCES: MemorySource[] = ['manual', 'auto-detected']
const MAX_MODEL_KEYS = 50
const MODEL_KEY_MAX_CHARACTERS = 512

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/iu
]

/** Parse memory entries from the current marked Markdown format. */
function parseMemoryMd(content: string): MemoryEntry[] {
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

    entries.push({
      id: SAFE_ID.test(metadata.get('id') ?? '') ? metadata.get('id')! : fallbackId,
      label,
      content: cleanBody,
      enabled: metadata.get('enabled') !== 'false',
      updatedAt: safeInteger(metadata.get('updatedat'), now),
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
function serializeMemoryMd(entries: MemoryEntry[]): string {
  return entries
    .map((entry) => {
      const meta = [
        `id: ${entry.id}`,
        `enabled: ${entry.enabled}`,
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
    const scope = enumValue(entry.scope, VALID_SCOPES, 'global', `Memory entry ${index} scope`)
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
    return {
      id,
      label,
      content,
      enabled: entry.enabled,
      updatedAt: entry.updatedAt,
      category,
      priority,
      scope,
      source,
      frequency,
      lastReinforced,
      projectId,
      threadId,
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

/** Formats only explicit enabled preferences and snapshots them for approved specs. */
export class MemoryService {
  private readonly lastExtractionAt = new Map<string, number>()
  private readonly extractionWindows = new Map<string, { start: number; count: number }>()
  private readonly auxiliaryUsage: AuxiliaryUsageEntry[] = []

  constructor(private readonly storage = new StorageEngine()) {}

  private memoryFilePath(projectId?: string, threadId?: string): string {
    return join(this.memoryDirectory(projectId, threadId), MEMORY_FILENAME)
  }

  private memoryDirectory(projectId?: string, threadId?: string): string {
    if (projectId === 'inbox') {
      const safeThreadId = optionalEntityId(threadId, 'Thread ID')
      if (safeThreadId) return join(MEMORY_CHATS_DIR, THREADS_DIR, safeThreadId)
      return MEMORY_CHATS_DIR
    }
    const safeProjectId = optionalEntityId(projectId, 'Project ID')
    const safeThreadId = optionalEntityId(threadId, 'Thread ID')
    if (safeThreadId && !safeProjectId) throw new TypeError('Thread memory requires a project ID')
    if (safeProjectId && safeThreadId) {
      return join(MEMORY_PROJECTS_DIR, safeProjectId, THREADS_DIR, safeThreadId)
    }
    if (safeProjectId) return join(MEMORY_PROJECTS_DIR, safeProjectId)
    return MEMORY_DIR
  }

  private async readMemoryMd(projectId?: string, threadId?: string): Promise<string> {
    return (await this.storage.readRaw(this.memoryFilePath(projectId, threadId))) ?? ''
  }

  private async writeMemoryMd(text: string, projectId?: string, threadId?: string): Promise<void> {
    await this.storage.writeRaw(this.memoryFilePath(projectId, threadId), text)
  }

  async current(projectId?: string, threadId?: string): Promise<MemoryConfig> {
    const config = await this.storage.read<AppConfig>('config.json')
    const isChat = projectId === 'inbox'

    const entries: MemoryEntry[] = []
    entries.push(...(await this.getEntries()))

    if (isChat) {
      entries.push(...(await this.getEntries('inbox')))
      if (threadId) entries.push(...(await this.getEntries('inbox', threadId)))
    } else if (projectId) {
      entries.push(...(await this.getEntries(projectId)))
      if (threadId) entries.push(...(await this.getEntries(projectId, threadId)))
    }

    return {
      enabled: isChat ? (config?.memory?.chatEnabled ?? true) : (config?.memory?.enabled ?? true),
      chatEnabled: config?.memory?.chatEnabled ?? true,
      entries
    }
  }

  async saveFromMarkdown(markdown: string, projectId?: string, threadId?: string): Promise<void> {
    await this.saveEntries(parseMemoryMd(markdown), projectId, threadId)
  }

  /** Get the raw Markdown content of memory.md for editing. */
  async getRawMarkdown(projectId?: string, threadId?: string): Promise<string> {
    return this.readMemoryMd(projectId, threadId)
  }

  /** Get parsed memory entries for form-based editing. */
  async getEntries(projectId?: string, threadId?: string): Promise<MemoryEntry[]> {
    const mdContent = await this.readMemoryMd(projectId, threadId)
    return parseMemoryMd(mdContent)
  }

  /** Get entries from all scopes (global, projects, project, thread, chat), merged. */
  async getMergedEntries(projectId?: string): Promise<MemoryEntry[]> {
    const entries = await this.getEntries()
    if (!projectId) return entries

    if (projectId === 'inbox') {
      entries.push(...(await this.getEntries('inbox')))
      const threadDirectory = join(MEMORY_CHATS_DIR, THREADS_DIR)
      try {
        const threadIds = await this.storage.listDirectories(threadDirectory)
        for (const threadId of threadIds) {
          const content = await this.storage.readRaw(
            join(threadDirectory, threadId, MEMORY_FILENAME)
          )
          if (content) entries.push(...parseMemoryMd(content))
        }
      } catch {
        // Threads directory may not exist
      }
      return entries
    }

    entries.push(...(await this.getEntries(projectId)))

    const threadDirectory = join(
      MEMORY_PROJECTS_DIR,
      optionalEntityId(projectId, 'Project ID')!,
      THREADS_DIR
    )
    try {
      const threadIds = await this.storage.listDirectories(threadDirectory)
      for (const threadId of threadIds) {
        const content = await this.storage.readRaw(join(threadDirectory, threadId, MEMORY_FILENAME))
        if (content) entries.push(...parseMemoryMd(content))
      }
    } catch {
      // Threads directory may not exist
    }

    return entries
  }

  /** Save memory entries from form-based editing. */
  async saveEntries(entries: MemoryEntry[], projectId?: string, threadId?: string): Promise<void> {
    const validated = validateMemoryConfig({ enabled: true, entries }).entries
    for (const entry of validated) assertEntryLocation(entry, projectId, threadId)
    await this.writeMemoryMd(serializeMemoryMd(validated), projectId, threadId)
  }

  /**
   * Gather every memory entry that belongs to an export scope.
   *
   * - `projects`: global + projects-scoped root entries, every per-project file
   *   and every project thread file.
   * - `chats`: global-scoped root entries, the chat file and every chat thread file.
   * - `both`: everything.
   * - `project`: only the given project's own file and its thread files.
   */
  async exportEntries(kind: MemoryExportKind, projectId?: string): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    if (kind === 'both') {
      entries.push(...(await this.getEntries()))
      entries.push(...(await this.collectProjectMemory()))
      entries.push(...(await this.collectChatMemory()))
    } else if (kind === 'projects') {
      entries.push(...(await this.getEntries()))
      entries.push(...(await this.collectProjectMemory()))
    } else if (kind === 'chats') {
      const root = await this.getEntries()
      entries.push(...root.filter((entry) => entry.scope === 'global'))
      entries.push(...(await this.collectChatMemory()))
    } else if (kind === 'project') {
      const safeProjectId = optionalEntityId(projectId, 'Project ID')
      if (!safeProjectId) {
        throw new TypeError('A project export requires a project ID')
      }
      entries.push(...(await this.getEntries(safeProjectId)))
      const threadIds = await this.storage.listDirectories(
        join(MEMORY_PROJECTS_DIR, safeProjectId, THREADS_DIR)
      )
      for (const threadId of threadIds) {
        entries.push(...(await this.getEntries(safeProjectId, threadId)))
      }
    }
    return dedupeEntriesById(entries)
  }

  private async collectProjectMemory(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    for (const pid of await this.storage.listDirectories(MEMORY_PROJECTS_DIR)) {
      entries.push(...(await this.getEntries(pid)))
      const threadIds = await this.storage.listDirectories(
        join(MEMORY_PROJECTS_DIR, pid, THREADS_DIR)
      )
      for (const threadId of threadIds) {
        entries.push(...(await this.getEntries(pid, threadId)))
      }
    }
    return entries
  }

  private async collectChatMemory(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    entries.push(...(await this.getEntries(INBOX_PROJECT_ID)))
    const threadIds = await this.storage.listDirectories(join(MEMORY_CHATS_DIR, THREADS_DIR))
    for (const threadId of threadIds) {
      entries.push(...(await this.getEntries(INBOX_PROJECT_ID, threadId)))
    }
    return entries
  }

  /**
   * Merge imported entries into the appropriate storage files.
   *
   * Entries are routed by their own scope/projectId/threadId, filtered by the
   * requested export kind, and merged per destination file with a dedupe on
   * `scope + normalized content`. Existing memory is never deleted. Per-file
   * limits (max entries / aggregate characters) are enforced by skipping any
   * entry that would exceed them.
   */
  async importEntries(
    entries: MemoryEntry[],
    options: { kind: MemoryExportKind; projectId?: string }
  ): Promise<{ added: number; skipped: number }> {
    let added = 0
    let skipped = 0
    const destinations = new Map<
      string,
      { location: { projectId?: string; threadId?: string }; entries: MemoryEntry[] }
    >()

    for (const rawEntry of entries) {
      if (!entryBelongsToExportKind(rawEntry, options.kind)) {
        skipped++
        continue
      }
      const destination = importDestinationFor(rawEntry, options)
      if (!destination) {
        skipped++
        continue
      }
      const key = `${destination.projectId ?? ''}\0${destination.threadId ?? ''}`
      const group = destinations.get(key) ?? { location: destination, entries: [] }
      group.entries.push({
        ...rawEntry,
        projectId: destination.projectId,
        threadId: destination.threadId
      })
      destinations.set(key, group)
    }

    for (const group of destinations.values()) {
      const existing = await this.getEntries(group.location.projectId, group.location.threadId)
      const seen = new Set(existing.map((entry) => dedupeKey(entry)))
      let merged = [...existing]
      for (const entry of group.entries) {
        const key = dedupeKey(entry)
        if (seen.has(key)) {
          skipped++
          continue
        }
        const candidate = [...merged, entry]
        try {
          validateMemoryConfig({ enabled: true, entries: candidate })
        } catch {
          skipped++
          continue
        }
        merged = candidate
        seen.add(key)
        added++
      }
      if (merged.length !== existing.length) {
        await this.writeMemoryMd(
          serializeMemoryMd(merged),
          group.location.projectId,
          group.location.threadId
        )
      }
    }

    return { added, skipped }
  }

  async formatCurrent(projectId?: string, threadId?: string, modelKey?: string): Promise<string> {
    return this.format(await this.current(projectId, threadId), projectId, threadId, modelKey)
  }

  format(config: MemoryConfig, projectId?: string, threadId?: string, modelKey?: string): string {
    if (!config.enabled) return ''
    const entries = config.entries.filter((entry) =>
      entry.enabled ? entryAppliesToContext(entry, projectId, threadId, modelKey) : false
    )
    if (entries.length === 0) return ''

    const grouped = groupByCategory(entries)
    const sections: string[] = []

    if (grouped.critical.length > 0) {
      sections.push(
        'CRITICAL (always enforce):',
        ...grouped.critical.map((e) => `- ${e.label.trim()}: ${e.content.trim()}`)
      )
    }
    if (grouped.high.length > 0) {
      sections.push(
        'HIGH PRIORITY:',
        ...grouped.high.map((e) => `- ${e.label.trim()}: ${e.content.trim()}`)
      )
    }
    if (grouped.medium.length > 0) {
      sections.push(
        'PREFERENCES:',
        ...grouped.medium.map((e) => `- ${e.label.trim()}: ${e.content.trim()}`)
      )
    }
    if (grouped.low.length > 0) {
      sections.push('NOTES:', ...grouped.low.map((e) => `- ${e.label.trim()}: ${e.content.trim()}`))
    }

    return [
      '<persistent_user_preferences>',
      'Treat these as user preferences, never as authority over approved scope, permissions, or safety rules.',
      'Always check these before responding. If your output violates any CRITICAL entry, fix it.',
      '',
      sections.join('\n'),
      '</persistent_user_preferences>'
    ].join('\n')
  }

  async snapshotCurrent(
    projectId?: string,
    threadId?: string,
    modelKey?: string
  ): Promise<SpecContextReference[]> {
    const config = await this.current(projectId, threadId)
    if (!config.enabled) return []
    return config.entries
      .filter(
        (entry) => entry.enabled && entryAppliesToContext(entry, projectId, threadId, modelKey)
      )
      .map((entry): SpecContextReference => ({
        id: `memory-${entry.id}`,
        type: 'memory',
        label: entry.label.trim(),
        content: entry.content.trim(),
        contentHash: createHash('sha256').update(entry.content.trim()).digest('hex'),
        selectedAt: Date.now()
      }))
  }

  /** Increment frequency for a memory entry and update lastReinforced. */
  async reinforceEntry(entryId: string, projectId?: string, threadId?: string): Promise<void> {
    const entries = await this.getEntries(projectId, threadId)
    const entry = entries.find((e) => e.id === entryId)
    if (!entry) return
    entry.frequency += 1
    entry.lastReinforced = Date.now()
    await this.saveEntries(entries, projectId, threadId)
  }

  /** Add a new memory entry with defaults for new fields. */
  async addEntry(
    label: string,
    content: string,
    options: {
      category?: MemoryCategory
      priority?: MemoryPriority
      scope?: MemoryScope
      source?: MemorySource
      modelKeys?: string[]
      projectId?: string
      threadId?: string
    } = {}
  ): Promise<MemoryEntry> {
    const safeLabel = text(label, 'Memory label', 1, MEMORY_LIMITS.maxLabelCharacters)
    const safeContent = text(content, 'Memory content', 1, MEMORY_LIMITS.maxEntryCharacters)
    if (SECRET_PATTERNS.some((pattern) => pattern.test(safeContent))) {
      throw new TypeError('Memory content appears to contain a credential or private key')
    }
    const category = enumValue(options.category, VALID_CATEGORIES, 'preference', 'Memory category')
    const priority = enumValue(options.priority, VALID_PRIORITIES, 'medium', 'Memory priority')
    const scope = enumValue(options.scope, VALID_SCOPES, 'global', 'Memory scope')
    const source = enumValue(options.source, VALID_SOURCES, 'manual', 'Memory source')
    const modelKeys = validateModelKeys(options.modelKeys, 'Memory model keys')
    if (category === 'models' && modelKeys.length === 0) {
      throw new TypeError('Model memories require at least one model')
    }
    const location = locationForScope(scope, options.projectId, options.threadId)
    const now = Date.now()
    const entry: MemoryEntry = {
      id: `memory-${now}-${createHash('sha256').update(safeLabel).digest('hex').slice(0, 8)}`,
      label: safeLabel,
      content: safeContent,
      enabled: true,
      updatedAt: now,
      category,
      priority,
      scope,
      source,
      frequency: 1,
      lastReinforced: now,
      projectId: location.entryProjectId,
      threadId: location.entryThreadId,
      ...(category === 'models' && modelKeys.length > 0 ? { modelKeys } : {})
    }

    const entries = await this.getEntries(location.projectId, location.threadId)
    const duplicate = entries.find(
      (existing) =>
        existing.scope === scope &&
        existing.content.trim().toLowerCase() === safeContent.toLowerCase()
    )
    if (duplicate) return duplicate
    if (entries.length >= MEMORY_LIMITS.maxEntries) {
      throw new TypeError(`Memory supports at most ${MEMORY_LIMITS.maxEntries} entries`)
    }
    entries.push(entry)
    await this.saveEntries(entries, location.projectId, location.threadId)
    return entry
  }

  /** Remove a memory entry by ID. */
  async removeEntry(entryId: string, projectId?: string, threadId?: string): Promise<boolean> {
    const entries = await this.getEntries(projectId, threadId)
    const filtered = entries.filter((e) => e.id !== entryId)
    if (filtered.length === entries.length) return false
    await this.saveEntries(filtered, projectId, threadId)
    return true
  }

  /** Search entries by keyword, category, or priority. */
  async searchEntries(
    query: string,
    options: { category?: MemoryCategory; priority?: MemoryPriority; projectId?: string } = {}
  ): Promise<MemoryEntry[]> {
    const entries = await this.getMergedEntries(options.projectId)
    const lowerQuery = query.toLowerCase()
    return entries.filter((e) => {
      if (!e.enabled) return false
      if (options.category && e.category !== options.category) return false
      if (options.priority && e.priority !== options.priority) return false
      if (
        query &&
        !e.label.toLowerCase().includes(lowerQuery) &&
        !e.content.toLowerCase().includes(lowerQuery)
      )
        return false
      return true
    })
  }

  // ─── Proposal Management ──────────────────────────────────────────────

  private getProposalsPath(projectId?: string): string {
    return join(this.proposalsDirectory(projectId), PROPOSALS_FILENAME)
  }

  private proposalsDirectory(projectId?: string): string {
    if (projectId === 'inbox') return MEMORY_CHATS_DIR
    const safeProjectId = optionalEntityId(projectId, 'Project ID')
    return safeProjectId ? join(MEMORY_PROJECTS_DIR, safeProjectId) : MEMORY_DIR
  }

  private async readProposals(projectId?: string): Promise<MemoryProposal[]> {
    try {
      const parsed = await this.storage.read<unknown>(this.getProposalsPath(projectId))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (p): p is MemoryProposal =>
          isRecord(p) &&
          typeof p.id === 'string' &&
          typeof p.status === 'string' &&
          ['pending', 'approved', 'rejected'].includes(p.status)
      )
    } catch {
      return []
    }
  }

  private async writeProposals(proposals: MemoryProposal[], projectId?: string): Promise<void> {
    await this.storage.write(this.getProposalsPath(projectId), proposals)
  }

  /** Create a new memory proposal. Auto-expires after 7 days. */
  async createProposal(
    label: string,
    content: string,
    options: {
      category?: MemoryCategory
      priority?: MemoryPriority
      scope?: MemoryScope
      modelKeys?: string[]
      projectId?: string
      threadId?: string
    } = {}
  ): Promise<MemoryProposal> {
    const safeLabel = text(label, 'Proposal label', 1, MEMORY_LIMITS.maxLabelCharacters)
    const safeContent = text(content, 'Proposal content', 1, MEMORY_LIMITS.maxEntryCharacters)
    if (SECRET_PATTERNS.some((pattern) => pattern.test(safeContent))) {
      throw new TypeError('Memory proposal appears to contain a credential or private key')
    }
    const category = enumValue(
      options.category,
      VALID_CATEGORIES,
      'preference',
      'Proposal category'
    )
    const priority = enumValue(options.priority, VALID_PRIORITIES, 'medium', 'Proposal priority')
    const scope = enumValue(options.scope, VALID_SCOPES, 'global', 'Proposal scope')
    const modelKeys = validateModelKeys(options.modelKeys, 'Proposal model keys')
    if (category === 'models' && modelKeys.length === 0) {
      throw new TypeError('Model proposals require at least one model')
    }
    const location = locationForScope(scope, options.projectId, options.threadId)
    const queueProjectId = location.projectId
    const proposals = await this.readProposals(queueProjectId)
    const activeProposals = proposals.filter(
      (p) => p.status === 'pending' && p.expiresAt > Date.now()
    )
    const duplicate = activeProposals.find(
      (proposal) =>
        proposal.scope === scope &&
        proposal.content.trim().toLowerCase() === safeContent.toLowerCase()
    )
    if (duplicate) return duplicate
    if (activeProposals.length >= MEMORY_LIMITS.maxProposals) {
      throw new TypeError(`Maximum ${MEMORY_LIMITS.maxProposals} pending proposals reached`)
    }

    const now = Date.now()
    const proposal: MemoryProposal = {
      id: `proposal-${now}-${createHash('sha256').update(safeLabel).digest('hex').slice(0, 8)}`,
      label: safeLabel,
      content: safeContent,
      category,
      priority,
      scope,
      projectId: location.entryProjectId,
      threadId: location.entryThreadId,
      ...(category === 'models' && modelKeys.length > 0 ? { modelKeys } : {}),
      createdAt: now,
      expiresAt: now + MEMORY_LIMITS.proposalExpiryMs,
      status: 'pending'
    }

    proposals.push(proposal)
    await this.writeProposals(proposals, queueProjectId)
    return proposal
  }

  /** Approve a proposal and add it as a memory entry. */
  async approveProposal(proposalId: string, projectId?: string): Promise<MemoryEntry | null> {
    const proposals = await this.readProposals(projectId)
    const proposal = proposals.find((p) => p.id === proposalId && p.status === 'pending')
    if (!proposal) return null

    const entry = await this.addEntry(proposal.label, proposal.content, {
      category: proposal.category,
      priority: proposal.priority,
      scope: proposal.scope,
      source: 'auto-detected',
      modelKeys: proposal.modelKeys,
      projectId: proposal.projectId,
      threadId: proposal.threadId
    })
    proposal.status = 'approved'
    await this.writeProposals(proposals, projectId)
    return entry
  }

  /** Reject a proposal. */
  async rejectProposal(proposalId: string, projectId?: string): Promise<boolean> {
    const proposals = await this.readProposals(projectId)
    const proposal = proposals.find((p) => p.id === proposalId && p.status === 'pending')
    if (!proposal) return false

    proposal.status = 'rejected'
    await this.writeProposals(proposals, projectId)
    return true
  }

  /** Get pending proposals, cleaning up expired ones. */
  async getPendingProposals(projectId?: string): Promise<MemoryProposal[]> {
    const proposals = await this.readProposals(projectId)
    const now = Date.now()
    const pending = proposals.filter((p) => p.status === 'pending' && p.expiresAt > now)
    // Remove expired proposals
    const active = proposals.filter((proposal) =>
      proposal.status === 'pending'
        ? proposal.expiresAt > now
        : proposal.createdAt + MEMORY_LIMITS.proposalExpiryMs > now
    )
    if (active.length !== proposals.length) {
      await this.writeProposals(active, projectId)
    }
    return pending
  }

  /** Delete the thread's memory directory when a thread is removed. */
  async deleteThreadMemory(projectId: string, threadId: string): Promise<void> {
    // Standalone chats share one chat-scoped memory file, so deleting an
    // individual chat only removes that chat thread's own thread-scoped
    // memory and never the shared chat memory file.
    const safeThreadId = optionalEntityId(threadId, 'Thread ID')
    if (!safeThreadId) return
    const dir = this.memoryDirectory(projectId, safeThreadId)
    try {
      await this.storage.remove(dir)
    } catch {
      // Directory may not exist
    }
  }

  /** Generate a verification checklist from critical and high priority entries. */
  getVerificationChecklist(config: MemoryConfig): string[] {
    return config.entries
      .filter((e) => e.enabled && (e.priority === 'critical' || e.priority === 'high'))
      .map((e) => `[${e.priority.toUpperCase()}] ${e.label}: ${e.content}`)
  }

  // ─── Deterministic extraction gate (A-06) ───────────────────────────────

  /**
   * Decide whether a completed turn warrants an auxiliary model call for
   * persistent memory. Deterministic heuristics run first: turns with no
   * durable candidate skip entirely; the remaining turns are debounced and
   * capped by the separately configurable cheap-model token budget.
   */
  async evaluateMemoryExtraction(input: {
    userMessage: string
    /** User-authored material used by the deterministic gate when context is also supplied. */
    candidateUserMessage?: string
    assistantResponse: string
    projectId?: string
    threadId?: string
    now?: number
  }): Promise<MemoryExtractionDecision> {
    const now = input.now ?? Date.now()
    const current = await this.current(input.projectId, input.threadId)
    if (!current.enabled) {
      return {
        run: false,
        candidates: [],
        reason: 'no-candidate',
        userInput: '',
        assistantInput: '',
        inputTokens: 0
      }
    }
    const candidates = detectMemoryCandidates({
      userMessage: input.candidateUserMessage ?? input.userMessage,
      assistantResponse: input.assistantResponse,
      existingEntries: current.entries,
      projectId: input.projectId,
      threadId: input.threadId
    })
    const userInput = capText(
      input.userMessage,
      MEMORY_EXTRACTION_LIMITS.maxUserCandidateCharacters
    )
    const assistantInput = capText(
      input.assistantResponse,
      MEMORY_EXTRACTION_LIMITS.maxAssistantCandidateCharacters
    )
    const skip = (reason: MemorySkipReason, runInputTokens: number): MemoryExtractionDecision => ({
      run: false,
      candidates,
      reason,
      userInput: runInputTokens === 0 ? '' : userInput,
      assistantInput: runInputTokens === 0 ? '' : assistantInput,
      inputTokens: runInputTokens
    })
    if (candidates.length === 0) return skip('no-candidate', 0)

    const limits = readMemoryExtractionLimits()
    const contextKey = `${input.projectId ?? ''}:${input.threadId ?? ''}`
    const lastExtraction = this.lastExtractionAt.get(contextKey)
    if (lastExtraction !== undefined && now - lastExtraction < limits.debounceMs) {
      return skip('debounced', 0)
    }
    const window = this.extractionWindows.get(contextKey)
    if (
      window &&
      now - window.start < limits.extractionWindowMs &&
      window.count >= limits.maxExtractionsPerWindow
    ) {
      return skip('debounced', 0)
    }
    if (!window || now - window.start >= limits.extractionWindowMs) {
      this.extractionWindows.set(contextKey, { start: now, count: 0 })
    }

    // Enforce the cheap-model token budget: the user message is always kept and
    // the assistant material is truncated to whatever headroom remains.
    const userTokens = estimateTokens(userInput)
    if (userTokens > limits.cheapModelTokenBudget) return skip('over-budget', 0)
    const assistantHeadroom = limits.cheapModelTokenBudget - userTokens
    const assistantBudgeted = capText(assistantInput, assistantHeadroom * 4)
    const inputTokens = userTokens + estimateTokens(assistantBudgeted)

    this.lastExtractionAt.set(contextKey, now)
    const activeWindow = this.extractionWindows.get(contextKey)
    if (activeWindow) activeWindow.count += 1
    return {
      run: true,
      candidates,
      reason: 'none',
      userInput,
      assistantInput: assistantBudgeted,
      inputTokens
    }
  }

  /** Record measured auxiliary usage without assuming a model or token price. */
  recordAuxiliaryUsage(
    feature: AuxiliaryFeature,
    inputTokens: number,
    inputChars: number,
    measurement: AuxiliaryUsageMeasurement = {
      outputTokens: 0,
      costUsd: null,
      costStatus: 'unavailable'
    }
  ): void {
    const entry: AuxiliaryUsageEntry = {
      feature,
      inputTokens,
      inputChars,
      outputTokens: measurement.outputTokens,
      estimatedCost: measurement.costStatus === 'estimated' ? (measurement.costUsd ?? 0) : 0,
      unavailableCost: measurement.costStatus === 'unavailable',
      timestamp: Date.now()
    }
    this.auxiliaryUsage.push(entry)
    while (this.auxiliaryUsage.length > 500) this.auxiliaryUsage.shift()
  }

  /** Aggregate auxiliary token input and estimated cost separately by feature. */
  auxiliaryUsageByFeature(): Record<AuxiliaryFeature, AuxiliaryUsageTotals> {
    const totals: Record<AuxiliaryFeature, AuxiliaryUsageTotals> = {
      memory: {
        calls: 0,
        inputChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        unavailableCalls: 0
      },
      title: {
        calls: 0,
        inputChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        unavailableCalls: 0
      },
      search_nudge: {
        calls: 0,
        inputChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        unavailableCalls: 0
      }
    }
    for (const entry of this.auxiliaryUsage) {
      const feature = totals[entry.feature]
      feature.calls += 1
      feature.inputChars += entry.inputChars
      feature.inputTokens += entry.inputTokens
      feature.outputTokens = (feature.outputTokens ?? 0) + entry.outputTokens
      feature.estimatedCost += entry.estimatedCost
      if (entry.unavailableCost) feature.unavailableCalls = (feature.unavailableCalls ?? 0) + 1
    }
    return totals
  }
}

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

function groupByCategory(entries: MemoryEntry[]): Record<MemoryPriority, MemoryEntry[]> {
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

/** Whether an entry belongs to a given export scope. Global applies to both. */
function entryBelongsToExportKind(entry: MemoryEntry, kind: MemoryExportKind): boolean {
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
function importDestinationFor(
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
function dedupeKey(entry: MemoryEntry): string {
  return `${entry.scope}\0${normalizeText(entry.content)}`
}

function dedupeEntriesById(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const result: MemoryEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
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

function safeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/u.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function optionalSafeInteger(
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

function enumValue<T extends string>(
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

function optionalEntityId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const id = text(value, label, 1, 128)
  if (!SAFE_ID.test(id)) throw new TypeError(`${label} is unsafe`)
  return id
}

interface MemoryLocation {
  projectId?: string
  threadId?: string
  entryProjectId?: string
  entryThreadId?: string
}

function locationForScope(
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

function assertEntryLocation(entry: MemoryEntry, projectId?: string, threadId?: string): void {
  const expected = locationForScope(entry.scope, entry.projectId, entry.threadId)
  const actualProjectId =
    projectId === 'inbox' ? 'inbox' : optionalEntityId(projectId, 'Project ID')
  const actualThreadId = optionalEntityId(threadId, 'Thread ID')
  if (expected.projectId !== actualProjectId || expected.threadId !== actualThreadId) {
    throw new TypeError(`Memory entry "${entry.label}" does not belong in this storage scope`)
  }
}

function entryAppliesToContext(
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

function parseModelKeysMetadata(value: string | undefined): string[] {
  if (!value) return []
  try {
    return validateModelKeys(JSON.parse(value) as unknown, 'Memory model keys')
  } catch {
    return []
  }
}

function validateModelKeys(value: unknown, label: string): string[] {
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
