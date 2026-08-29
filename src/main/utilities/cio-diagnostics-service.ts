import { readFile } from 'fs/promises'
import { join } from 'path'
import type { Database } from '../database/database'
import { AgentMessageRepo } from '../database/repositories/agent-message-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { AgentMessage, Thread } from '../../lib/types'
import { getConfigRoot } from '../../lib/utils'

/** Bounded, redacted, read-only app diagnostics for an explicit @cio-utility turn. */

const MAX_MESSAGE_TEXT_LENGTH = 4_000
const MAX_LOG_ENTRY_LENGTH = 2_000
const MAX_LOG_ENTRIES = 200
const MAX_MESSAGES = 120
const MAX_THREAD_LIST_RESULTS = 20
const MAX_LOG_BYTES = 1_000_000

/** Log files an agent may inspect during an explicit diagnostics turn. */
const READABLE_LOG_FILES = ['logs/main.jsonl', 'logs/error.log', 'logs/permission-events.jsonl']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirrors the redaction policy of DiagnosticsService. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|private[_-]?key)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"',;\s}]+)/giu,
      '$1$2[REDACTED]'
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)=)[^&#\s]+/giu,
      '$1[REDACTED]'
    )
}

export interface DiagnosticThreadSummary {
  id: string
  projectId: string
  projectName: string
  title: string
  status: Thread['status']
  providerId: string
  harnessIds: string[]
  createdAt: number
  lastActivity: number
}

export interface DiagnosticMessage {
  id: string
  role: AgentMessage['role']
  createdAt: number
  text: string
  error?: string
  modelId?: string
  providerId?: string
}

export interface DiagnosticLogEntry {
  file: string
  timestamp?: string
  level?: string
  message: string
}

export interface ThreadLookupResult {
  matchedThread: DiagnosticThreadSummary | null
  candidates: DiagnosticThreadSummary[]
}

export interface DiagnosticLogResult {
  file: string
  entries: DiagnosticLogEntry[]
  truncated: boolean
}

function summarizeDiagnosticThread(
  thread: Thread,
  projectName: string,
  harnessIds: string[]
): DiagnosticThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    projectName: redactSensitiveText(projectName),
    title: redactSensitiveText(thread.title),
    status: thread.status,
    providerId: thread.providerId,
    harnessIds,
    createdAt: thread.createdAt,
    lastActivity: thread.lastActivity
  }
}

/** Parse a main.jsonl-style JSONL record into a bounded, redacted log entry. */
function summarizeJsonLogRecord(file: string, value: unknown): DiagnosticLogEntry | null {
  if (!isRecord(value) || typeof value['message'] !== 'string') return null
  const entry: DiagnosticLogEntry = {
    file,
    message: redactSensitiveText(value['message']).slice(0, MAX_LOG_ENTRY_LENGTH)
  }
  if (typeof value['timestamp'] === 'string') entry.timestamp = value['timestamp']
  if (typeof value['level'] === 'string') entry.level = value['level']
  return entry
}

/** Read the tail of a plain-text log (debug.log / error.log). */
function summarizePlainTextLog(file: string, raw: string): DiagnosticLogEntry[] {
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  const relevant = lines.filter(
    (line) => !line.includes('durable log write failed') || line.startsWith('[')
  )
  return relevant.slice(-MAX_LOG_ENTRIES).map((line) => ({
    file,
    message: redactSensitiveText(line).slice(0, MAX_LOG_ENTRY_LENGTH)
  }))
}

/**
 * Read-only, bounded, redacted diagnostics across every project: thread lookup
 * (by id or exact title), a bounded message page, and recent log entries.
 * Constructed per turn from the shared Database; never writes.
 */
export class CioDiagnosticsService {
  private readonly threadRepo: ThreadRepo
  private readonly messageRepo: AgentMessageRepo
  private readonly projects: ProjectRepo

  constructor(
    private readonly db: Database,
    private readonly projectNameById: () => Map<string, string>
  ) {
    this.threadRepo = new ThreadRepo(db)
    this.messageRepo = new AgentMessageRepo(db)
    this.projects = new ProjectRepo(db)
  }

  /** Find a thread by id, falling back to an exact (case-insensitive) title match. */
  async lookupThread(query: string): Promise<ThreadLookupResult> {
    const needle = query.trim()
    if (!needle) return { matchedThread: null, candidates: [] }
    const direct = await this.threadRepo.getViaWorker(needle)
    if (direct) {
      return {
        matchedThread: this.summarize(direct),
        candidates: []
      }
    }
    const all = await this.threadRepo.listAllForHydrationViaWorker({ limit: 500 })
    const lowered = needle.toLocaleLowerCase()
    const byTitle = all
      .filter((thread) => thread.title.toLocaleLowerCase() === lowered)
      .slice(0, MAX_THREAD_LIST_RESULTS)
    const candidates = byTitle.map((thread) =>
      this.summarize(thread, this.projectNameById().get(thread.projectId) ?? '')
    )
    return { matchedThread: candidates[0] ?? null, candidates }
  }

  /** Search thread titles across every project for a case-insensitive substring. */
  async searchThreads(query: string): Promise<DiagnosticThreadSummary[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const all = await this.threadRepo.listAllForHydrationViaWorker({ limit: 500 })
    const names = this.projectNameById()
    return all
      .filter((thread) => thread.title.toLocaleLowerCase().includes(needle))
      .slice(0, MAX_THREAD_LIST_RESULTS)
      .map((thread) => this.summarize(thread, names.get(thread.projectId) ?? ''))
  }

  /**
   * Load a bounded newest page of mirrored conversation messages for a thread.
   * `loadPageByThread` already returns the page oldest-to-newest.
   */
  async loadThreadMessages(threadId: string, limit: number): Promise<DiagnosticMessage[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_MESSAGES, Math.trunc(limit) || 40))
    const thread = await this.threadRepo.getViaWorker(threadId)
    if (!thread) return []
    const page = this.messageRepo.loadPageByThread(threadId, undefined, boundedLimit)
    return page.messages
      .map((message) => this.toDiagnosticMessage(message))
      .filter((message): message is DiagnosticMessage => message !== null)
  }

  /** Read recent entries from one allow-listed log file. */
  async readLog(
    file: string,
    options: { level?: string; limit?: number } = {}
  ): Promise<DiagnosticLogResult> {
    const normalized = `logs/${file.replace(/^logs\//u, '').replace(/^\/+/u, '')}`
    if (!READABLE_LOG_FILES.includes(normalized)) {
      throw new Error(
        `Log file not readable: ${file}. Allowed: ${READABLE_LOG_FILES.join(', ')}`
      )
    }
    const boundedLimit = Math.max(1, Math.min(MAX_LOG_ENTRIES, Math.trunc(options.limit ?? 100)))
    let raw: string
    try {
      raw = await readFile(join(getConfigRoot(), normalized), 'utf-8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { file: normalized, entries: [], truncated: false }
      }
      throw error
    }
    // Only the tail is ever needed for debugging; cap the parse window.
    const tail = raw.length > MAX_LOG_BYTES ? raw.slice(-MAX_LOG_BYTES) : raw
    if (normalized.endsWith('.jsonl')) {
      let entries: DiagnosticLogEntry[] = []
      for (const line of tail.split(/\r?\n/u)) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          const entry = summarizeJsonLogRecord(normalized, parsed)
          if (entry) entries.push(entry)
        } catch {
          // A partial final append must not break the remaining entries.
        }
      }
      if (options.level) {
        const level = options.level.toLocaleLowerCase()
        entries = entries.filter((entry) => entry.level === level)
      }
      return {
        file: normalized,
        entries: entries.slice(-boundedLimit),
        truncated: raw.length > MAX_LOG_BYTES
      }
    }
    let lines = summarizePlainTextLog(normalized, tail)
    if (options.level) {
      const level = options.level.toLocaleLowerCase()
      lines = lines.filter((line) => (line.message.match(/\[(\w+)\]/u)?.[1] ?? '') === level)
    }
    return {
      file: normalized,
      entries: lines.slice(-boundedLimit),
      truncated: raw.length > MAX_LOG_BYTES
    }
  }

  private summarize(thread: Thread, projectNameOverride?: string): DiagnosticThreadSummary {
    const names = this.projectNameById()
    return summarizeDiagnosticThread(
      thread,
      projectNameOverride ?? names.get(thread.projectId) ?? '',
      thread.usedHarnessIds ?? []
    )
  }

  private toDiagnosticMessage(message: AgentMessage): DiagnosticMessage | null {
    const text = message.parts
      .filter((part): part is Extract<AgentMessage['parts'][number], { type: 'text' }> =>
        part.type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
      .slice(0, MAX_MESSAGE_TEXT_LENGTH)
    if (!text.trim() && !message.error) return null
    const result: DiagnosticMessage = {
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      text: redactSensitiveText(text)
    }
    if (message.error) result.error = redactSensitiveText(message.error).slice(0, 500)
    if (message.modelId) result.modelId = message.modelId
    if (message.providerId) result.providerId = message.providerId
    return result
  }
}
