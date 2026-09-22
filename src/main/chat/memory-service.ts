import { createHash } from 'crypto'
import { join } from 'path'
import type {
  AppConfig,
  DeferredMemoryExtraction,
  MemoryCategory,
  MemoryConfig,
  MemoryEntry,
  MemoryExportKind,
  MemoryPriority,
  MemoryProposal,
  MemoryScope,
  MemorySource,
  SpecContextReference
} from '../../lib/types'
import { INBOX_PROJECT_ID } from '../../lib/types'
import { StorageEngine } from '../storage/storage-engine'
import {
  DEFERRED_EXTRACTIONS_FILENAME,
  MEMORY_CHATS_DIR,
  MEMORY_DEFERRED_EXTRACTION_LIMITS,
  MEMORY_DIR,
  MEMORY_EXTRACTION_LIMITS,
  MEMORY_FILENAME,
  MEMORY_LIMITS,
  MEMORY_PROJECTS_DIR,
  PROPOSALS_FILENAME,
  THREADS_DIR
} from './memory/memory-constants'
import {
  capText,
  detectMemoryCandidates,
  estimateTokens,
  isTrivialUserTurn,
  normalizeText,
  readMemoryExtractionLimits,
  type MemoryExtractionDecision,
  type MemorySkipReason
} from './memory/memory-extraction'
import type {
  AuxiliaryFeature,
  AuxiliaryUsageEntry,
  AuxiliaryUsageMeasurement,
  AuxiliaryUsageTotals
} from './memory/memory-auxiliary-usage'
import { parseMemoryMd, serializeMemoryMd } from './memory/memory-markdown'
import {
  assertEntryLocation,
  entryAppliesToContext,
  groupByCategory,
  locationForScope
} from './memory/memory-location'
import {
  dedupeEntriesById,
  dedupeKey,
  entryBelongsToExportKind,
  importDestinationFor
} from './memory/memory-export'
import {
  SECRET_PATTERNS,
  VALID_CATEGORIES,
  VALID_PRIORITIES,
  VALID_SCOPES,
  VALID_SOURCES,
  enumValue,
  isRecord,
  optionalEntityId,
  text,
  validateMemoryConfig,
  validateModelKeys
} from './memory/memory-validation'

export {
  MEMORY_DEFERRED_EXTRACTION_LIMITS,
  MEMORY_EXTRACTION_LIMITS,
  MEMORY_LIMITS,
  detectMemoryCandidates,
  estimateTokens,
  readMemoryExtractionLimits,
  validateMemoryConfig
}
export {
  MEMORY_EXPORT_FORMAT,
  MEMORY_EXPORT_VERSION,
  parseMemoryExport,
  serializeMemoryExport,
  validateMemoryExportKind
} from './memory/memory-export'
export type {
  AuxiliaryFeature,
  AuxiliaryUsageEntry,
  AuxiliaryUsageMeasurement,
  AuxiliaryUsageTotals
} from './memory/memory-auxiliary-usage'
export type {
  MemoryCandidate,
  MemoryExtractionDecision,
  MemoryExtractionLimits,
  MemorySkipReason
} from './memory/memory-extraction'

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
      createdAt: now,
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

  // ─── Deferred extraction retry queue ──────────────────────────────────

  private getDeferredPath(projectId?: string): string {
    return join(this.proposalsDirectory(projectId), DEFERRED_EXTRACTIONS_FILENAME)
  }

  private async readDeferred(projectId?: string): Promise<DeferredMemoryExtraction[]> {
    try {
      const parsed = await this.storage.read<unknown>(this.getDeferredPath(projectId))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (d): d is DeferredMemoryExtraction =>
          isRecord(d) &&
          typeof d.id === 'string' &&
          typeof d.userMessage === 'string' &&
          typeof d.assistantResponse === 'string' &&
          typeof d.createdAt === 'number' &&
          typeof d.attempts === 'number'
      )
    } catch {
      return []
    }
  }

  private async writeDeferred(
    items: DeferredMemoryExtraction[],
    projectId?: string
  ): Promise<void> {
    if (items.length === 0) {
      await this.storage.remove(this.getDeferredPath(projectId))
      return
    }
    await this.storage.write(this.getDeferredPath(projectId), items)
  }

  /**
   * Persist a gated memory candidate whose model extraction failed so it can
   * be retried on a later completed turn instead of being lost. Deduplicates
   * by normalized user material and enforces the count/expiry limits.
   */
  async deferMemoryExtraction(input: {
    userMessage: string
    assistantResponse: string
    previousUserMessage?: string
    reason: string
    projectId?: string
    threadId?: string
  }): Promise<void> {
    const items = await this.readDeferred(input.projectId)
    const now = Date.now()
    const normalized = normalizeText(input.userMessage)
    if (items.some((item) => normalizeText(item.userMessage) === normalized)) return
    const previousUserMessage = input.previousUserMessage
      ? capText(input.previousUserMessage, MEMORY_EXTRACTION_LIMITS.maxPreviousUserCharacters)
      : undefined
    const entry: DeferredMemoryExtraction = {
      id: `deferred-${now}-${createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      userMessage: input.userMessage,
      assistantResponse: input.assistantResponse,
      ...(previousUserMessage ? { previousUserMessage } : {}),
      reason: capText(input.reason, 200),
      createdAt: now,
      attempts: 0
    }
    items.push(entry)
    const live = items
      .filter((item) => now - item.createdAt < MEMORY_DEFERRED_EXTRACTION_LIMITS.expiryMs)
      .slice(-MEMORY_DEFERRED_EXTRACTION_LIMITS.maxEntries)
    await this.writeDeferred(live, input.projectId)
  }

  /** Live deferred extractions for a scope, with expired and over-attempt entries pruned. */
  async readDeferredExtractions(projectId?: string): Promise<DeferredMemoryExtraction[]> {
    const items = await this.readDeferred(projectId)
    const now = Date.now()
    const live = items.filter(
      (item) =>
        now - item.createdAt < MEMORY_DEFERRED_EXTRACTION_LIMITS.expiryMs &&
        item.attempts < MEMORY_DEFERRED_EXTRACTION_LIMITS.maxAttempts
    )
    if (live.length !== items.length) await this.writeDeferred(live, projectId)
    return live
  }

  /** Remove a deferred extraction after its retry succeeded or was decided. */
  async removeDeferredExtraction(id: string, projectId?: string): Promise<void> {
    const items = await this.readDeferred(projectId)
    const remaining = items.filter((item) => item.id !== id)
    if (remaining.length !== items.length) await this.writeDeferred(remaining, projectId)
  }

  /** Record a failed retry attempt; drops the entry once attempts are exhausted. */
  async recordDeferredExtractionFailure(
    id: string,
    error: string,
    projectId?: string
  ): Promise<void> {
    const items = await this.readDeferred(projectId)
    const entry = items.find((item) => item.id === id)
    if (!entry) return
    if (entry.attempts + 1 >= MEMORY_DEFERRED_EXTRACTION_LIMITS.maxAttempts) {
      await this.removeDeferredExtraction(id, projectId)
      return
    }
    const updated = items.map((item) =>
      item.id === id
        ? {
            ...item,
            attempts: item.attempts + 1,
            lastError: capText(error, 200),
            lastAttemptAt: Date.now()
          }
        : item
    )
    await this.writeDeferred(updated, projectId)
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
    /**
     * Whether the standing-preference patterns decide that this turn is worth a
     * model call at all.
     *
     * True is the historical behaviour and the default, and it is what keeps the
     * cheap-model chain off ordinary turns. A caller that holds a model able to
     * judge durability itself sets it to false, so the pattern list stops being
     * the thing that decides whether a rule exists; the trivial-turn check, the
     * debounce, the window and the token budget below all still apply either way.
     */
    requireDurableCandidate?: boolean
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
    if (input.requireDurableCandidate ?? true) {
      if (candidates.length === 0) return skip('no-candidate', 0)
    } else if (isTrivialUserTurn(input.candidateUserMessage ?? input.userMessage)) {
      // Even with the pattern list out of the way, a bare acknowledgement or a
      // one-word question is not worth sending anywhere.
      return skip('no-candidate', 0)
    }

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
      },
      speech_lesson: {
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
