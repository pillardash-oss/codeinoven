import { lstat, realpath, readFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import type {
  ChangeTrackingMode,
  PermissionLevel,
  Project,
  Thread,
  ThreadStatus
} from '../../lib/types'
import { atomicWrite, getConfigRoot } from '../../lib/utils'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { AuxiliaryFeature, AuxiliaryUsageTotals } from '../chat/memory-service'

const DEFAULT_LOG_LIMIT = 100
const DEFAULT_PERMISSION_EVENT_LIMIT = 100
const MAX_ENTRY_LIMIT = 500
const MAX_LOG_MESSAGE_LENGTH = 4_000

export type AuxiliaryUsageReport = Record<AuxiliaryFeature, AuxiliaryUsageTotals>

function emptyAuxiliaryUsage(): AuxiliaryUsageReport {
  return {
    memory: { calls: 0, inputChars: 0, inputTokens: 0, estimatedCost: 0 },
    title: { calls: 0, inputChars: 0, inputTokens: 0, estimatedCost: 0 }
  }
}

export interface DiagnosticsMetadata {
  appName: string
  appVersion: string
  appBuild?: string
  platform: string
  platformRelease: string
  architecture: string
  electronVersion?: string
}

export interface DiagnosticsOptions {
  logLimit?: number
  permissionEventLimit?: number
  now?: () => Date
}

export interface DiagnosticsLogEntry {
  timestamp?: string
  level: 'dev' | 'info' | 'error' | 'unknown'
  message: string
}

export interface DiagnosticsPermissionEvent {
  timestamp?: number
  projectId?: string
  threadId?: string
  driverId?: string
  permission?: string
  risk?: string
  reply?: string
  decidedBy?: string
  expiresAt?: number
}

export interface DiagnosticsThreadSummary {
  id: string
  providerId: string
  status: ThreadStatus
  pinned: boolean
  archived: boolean
  read: boolean
  permissionLevel?: PermissionLevel
  engineeringMode?: boolean
  loopMode?: boolean
  fileSystemMode?: boolean
  loopIteration?: number
  hasSession: boolean
  createdAt: number
  updatedAt: number
  lastActivity: number
}

export interface DiagnosticsProjectSummary {
  id: string
  name: string
  source: 'local' | 'ssh'
  providerId: string
  workflowId: string
  threadLimit: number
  hidden: boolean
  changeTrackingMode?: ChangeTrackingMode
  createdAt: number
  updatedAt: number
  threads: DiagnosticsThreadSummary[]
}

export interface DiagnosticsReport {
  schemaVersion: 1
  generatedAt: string
  metadata: DiagnosticsMetadata
  logs: DiagnosticsLogEntry[]
  permissionEvents: DiagnosticsPermissionEvent[]
  projects: DiagnosticsProjectSummary[]
  /** Auxiliary (memory/title) token input and cost totals by feature. */
  auxiliaryUsage: AuxiliaryUsageReport
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactText(value: string): string {
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

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? redactText(value) : undefined
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(MAX_ENTRY_LIMIT, Math.trunc(value)))
}

function parseJsonLines(raw: string | null): unknown[] {
  if (!raw) return []

  const parsed: unknown[] = []
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      parsed.push(JSON.parse(line) as unknown)
    } catch {
      // A partial final append must not prevent exporting the remaining diagnostics.
    }
  }
  return parsed
}

function takeRecent<T>(entries: T[], limit: number): T[] {
  return limit === 0 ? [] : entries.slice(-limit)
}

function summarizeLog(value: unknown): DiagnosticsLogEntry | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null
  const knownLevels = new Set(['dev', 'info', 'error'])
  const level =
    typeof value.level === 'string' && knownLevels.has(value.level)
      ? (value.level as DiagnosticsLogEntry['level'])
      : 'unknown'

  const timestamp = safeString(value.timestamp)
  return {
    ...(timestamp ? { timestamp } : {}),
    level,
    message: redactText(value.message).slice(0, MAX_LOG_MESSAGE_LENGTH)
  }
}

function summarizePermissionEvent(value: unknown): DiagnosticsPermissionEvent | null {
  if (!isRecord(value)) return null
  const timestamp = safeNumber(value.timestamp)
  const projectId = safeString(value.projectId)
  const threadId = safeString(value.threadId)
  const driverId = safeString(value.driverId)
  const permission = safeString(value.permission)
  const risk = safeString(value.risk)
  const reply = safeString(value.reply)
  const decidedBy = safeString(value.decidedBy)
  const expiresAt = safeNumber(value.expiresAt)
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(driverId ? { driverId } : {}),
    ...(permission ? { permission } : {}),
    ...(risk ? { risk } : {}),
    ...(reply ? { reply } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
  }
}

function summarizeThread(thread: Thread): DiagnosticsThreadSummary {
  const permissionLevel = thread.settings?.permissionLevel
  const engineeringMode = thread.settings?.engineeringMode
  const loopMode = thread.settings?.loopMode
  const fileSystemMode = thread.settings?.fileSystemMode
  return {
    id: redactText(thread.id),
    providerId: redactText(thread.providerId),
    status: thread.status,
    pinned: thread.pinned,
    archived: thread.archived,
    read: thread.read,
    ...(permissionLevel ? { permissionLevel } : {}),
    ...(engineeringMode !== undefined ? { engineeringMode } : {}),
    ...(loopMode !== undefined ? { loopMode } : {}),
    ...(fileSystemMode !== undefined ? { fileSystemMode } : {}),
    ...(thread.loopIteration !== undefined ? { loopIteration: thread.loopIteration } : {}),
    hasSession: Boolean(thread.sessionId),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivity: thread.lastActivity
  }
}

function summarizeProject(project: Project, threads: Thread[]): DiagnosticsProjectSummary {
  return {
    id: redactText(project.id),
    name: redactText(project.name),
    source: project.source,
    providerId: redactText(project.providerId),
    workflowId: redactText(project.workflowId),
    threadLimit: project.threadLimit,
    hidden: Boolean(project.hidden),
    ...(project.changeTrackingMode ? { changeTrackingMode: project.changeTrackingMode } : {}),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    threads: threads.map(summarizeThread)
  }
}

function sanitizeMetadata(metadata: DiagnosticsMetadata): DiagnosticsMetadata {
  return {
    appName: redactText(metadata.appName),
    appVersion: redactText(metadata.appVersion),
    ...(metadata.appBuild ? { appBuild: redactText(metadata.appBuild) } : {}),
    platform: redactText(metadata.platform),
    platformRelease: redactText(metadata.platformRelease),
    architecture: redactText(metadata.architecture),
    ...(metadata.electronVersion ? { electronVersion: redactText(metadata.electronVersion) } : {})
  }
}

async function assertSafeDestination(destinationPath: string): Promise<string> {
  if (!isAbsolute(destinationPath)) {
    throw new Error('Diagnostics destination must be an absolute path on this platform')
  }
  if (destinationPath.split(/[\\/]+/u).includes('..')) {
    throw new Error('Diagnostics destination cannot contain parent traversal')
  }

  const normalizedPath = resolve(destinationPath)
  const parentPath = dirname(normalizedPath)
  const parentInfo = await lstat(parentPath)
  if (!parentInfo.isDirectory()) {
    throw new Error('Diagnostics destination parent must be a directory')
  }
  await realpath(parentPath)

  try {
    const destinationInfo = await lstat(normalizedPath)
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile()) {
      throw new Error('Diagnostics destination must be a regular file')
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  return normalizedPath
}

export class DiagnosticsService {
  private readonly projectRepo: ProjectRepo
  private readonly threadRepo: ThreadRepo

  constructor(
    private readonly db: Database,
    private readonly auxiliaryUsage?: () => AuxiliaryUsageReport
  ) {
    this.projectRepo = new ProjectRepo(db)
    this.threadRepo = new ThreadRepo(db)
  }

  async createReport(
    metadata: DiagnosticsMetadata,
    options: DiagnosticsOptions = {}
  ): Promise<DiagnosticsReport> {
    const warnings: string[] = []
    const logLimit = boundedLimit(options.logLimit, DEFAULT_LOG_LIMIT)
    const permissionLimit = boundedLimit(
      options.permissionEventLimit,
      DEFAULT_PERMISSION_EVENT_LIMIT
    )

    const [rawLogs, rawPermissionEvents] = await Promise.all([
      this.readRawSafely('logs/main.jsonl', warnings, 'main logs'),
      this.readRawSafely('logs/permission-events.jsonl', warnings, 'permission events')
    ])

    const logs = takeRecent(
      parseJsonLines(rawLogs)
        .map(summarizeLog)
        .filter((entry): entry is DiagnosticsLogEntry => entry !== null),
      logLimit
    )
    const permissionEvents = takeRecent(
      parseJsonLines(rawPermissionEvents)
        .map(summarizePermissionEvent)
        .filter((entry): entry is DiagnosticsPermissionEvent => entry !== null),
      permissionLimit
    )

    const projects: DiagnosticsProjectSummary[] = []
    const allProjects = this.projectRepo.list()
    for (const project of allProjects) {
      const threads = this.threadRepo.listByProject(project.id)
      projects.push(summarizeProject(project, threads))
    }

    return {
      schemaVersion: 1,
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      metadata: sanitizeMetadata(metadata),
      logs,
      permissionEvents,
      projects,
      auxiliaryUsage: this.auxiliaryUsage?.() ?? emptyAuxiliaryUsage(),
      warnings
    }
  }

  async writeReport(
    destinationPath: string,
    metadata: DiagnosticsMetadata,
    options: DiagnosticsOptions = {}
  ): Promise<string> {
    const safeDestination = await assertSafeDestination(destinationPath)
    const report = await this.createReport(metadata, options)
    await atomicWrite(safeDestination, `${JSON.stringify(report, null, 2)}\n`)
    return safeDestination
  }

  private async readRawSafely(
    relativePath: string,
    warnings: string[],
    label: string
  ): Promise<string | null> {
    try {
      return await readFile(join(getConfigRoot(), relativePath), 'utf-8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        warnings.push(`Unable to read ${label}`)
        return null
      }
      throw error
    }
  }
}
