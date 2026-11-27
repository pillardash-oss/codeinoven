import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ensureDir } from '../../../lib/utils'
import { Logger } from '../../system/logger'
import {
  ensureFeatureSlug,
  featureArtifactDirectory,
  requireLocalProject
} from '../../../lib/project-artifacts'
import { auditProgressStep } from './chat-engine-pure'
import type { AgentEvent } from '../../../lib/types'
import type {
  ActiveAuditProgressRun,
  AuditProgressHeader,
  AuditProgressKind,
  AuditProgressStep,
  AuditProgressSummary
} from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/**
 * Steps one audit run records. A position log that grows without bound is a
 * second transcript; this keeps the newest work and says it was capped.
 */
const MAX_RECORDED_STEPS = 500

/** Where an audit's live progress lives, beneath the feature's artifacts. */
function auditProgressRelativePath(auditorThreadId: string): string {
  return join('audit', 'progress', `${auditorThreadId}.jsonl`)
}

/**
 * The audit's own position inside a turn.
 *
 * A turn's tool calls only reach the mirror when the message is finalized, so a
 * death mid-turn used to leave nothing that said which checks had already run.
 * This unit writes each settled tool call of an audit turn to a durable JSONL log
 * the moment it completes, and reads it back to tell the next attempt where the
 * previous one stopped.
 *
 * It never decides anything: the report validation, the repair manifest and the
 * attempt artifacts stay authoritative. The log only answers "what did the
 * auditor already do".
 */
export class ChatEngineAuditProgress {
  constructor(private readonly host: ChatEngine) {}

  /** Serializes appends per auditor thread so lines land in completion order. */
  private readonly writeQueues = new Map<string, Promise<void>>()

  /**
   * Start recording a run, replacing whatever an earlier run of this auditor
   * left behind. A resumed attempt of the same run keeps appending.
   */
  async beginRun(input: {
    projectId: string
    coordinatorThreadId: string
    threadId: string
    runId: string
    auditKind: AuditProgressKind
  }): Promise<void> {
    const active = this.host.state.auditProgressRuns.get(input.threadId)
    if (active?.runId === input.runId) return
    const header: AuditProgressHeader = {
      kind: 'run',
      runId: input.runId,
      auditKind: input.auditKind,
      threadId: input.threadId,
      startedAt: Date.now()
    }
    const run: ActiveAuditProgressRun = {
      ...input,
      recordedPartIds: new Set<string>(),
      steps: 0
    }
    // Registered before the header is written: a tool call that settles while
    // the write is in flight would otherwise be dropped as "no run recording".
    this.host.state.auditProgressRuns.set(input.threadId, run)
    try {
      await this.writeWhole(input.projectId, input.coordinatorThreadId, input.threadId, [
        `${JSON.stringify(header)}\n`
      ])
    } catch (error) {
      Logger.error('Audit progress header write failed', {
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Stop recording: the run settled, failed, or was stopped. */
  endRun(threadId: string): void {
    this.host.state.auditProgressRuns.delete(threadId)
  }

  /**
   * Record one settled tool call of a recording run.
   *
   * Called from the turn stream funnel for every part event of every thread, so
   * the map lookup is the whole cost of a thread that is not auditing.
   */
  async observe(
    threadId: string,
    event: Extract<AgentEvent, { type: 'message.part.updated' | 'message.part.delta' }>
  ): Promise<void> {
    const run = this.host.state.auditProgressRuns.get(threadId)
    if (!run) return
    if (event.type !== 'message.part.updated') return
    const part = event.part
    if (part.type !== 'tool') return
    if (run.recordedPartIds.has(part.id)) return
    const step = auditProgressStep(part, Date.now())
    // A running call is not a step; the same part id is re-observed when it
    // settles, which is exactly the moment worth recording.
    if (step === null) return
    run.recordedPartIds.add(part.id)
    if (run.steps >= MAX_RECORDED_STEPS) return
    run.steps += 1
    try {
      await this.enqueueAppend(run, `${JSON.stringify(step)}\n`)
    } catch (error) {
      Logger.error('Audit progress step write failed', {
        projectId: run.projectId,
        threadId: run.threadId,
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** The last run's recorded steps, for a resume prompt. Null when none ran. */
  async readRun(
    projectId: string,
    coordinatorThreadId: string,
    auditorThreadId: string
  ): Promise<AuditProgressSummary | null> {
    const relativePath = auditProgressRelativePath(auditorThreadId)
    let raw: string | null
    try {
      const featureSlug = await ensureFeatureSlug(
        this.host.database,
        projectId,
        coordinatorThreadId
      )
      raw = await this.host.storage.readProjectSpecRaw(
        projectId,
        featureSlug,
        relativePath,
        requireLocalProject(this.host.database, projectId)
      )
    } catch (error) {
      Logger.dev('Audit progress read failed:', error)
      return null
    }
    if (!raw) return null
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    let header: AuditProgressHeader | null = null
    const steps: Omit<AuditProgressStep, 'kind'>[] = []
    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A line cut off by a crash is the only torn line there is; skip it.
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const record = parsed as Record<string, unknown>
      if (record.kind === 'run') {
        if (
          typeof record.runId === 'string' &&
          (record.auditKind === 'independent' || record.auditKind === 'assignment')
        ) {
          header = record as unknown as AuditProgressHeader
        }
        continue
      }
      if (
        record.kind === 'step' &&
        typeof record.at === 'number' &&
        typeof record.tool === 'string' &&
        typeof record.action === 'string' &&
        typeof record.subject === 'string' &&
        (record.status === 'completed' || record.status === 'error' || record.status === 'aborted')
      ) {
        steps.push({
          at: record.at,
          tool: record.tool,
          action: record.action,
          subject: record.subject,
          status: record.status
        })
      }
    }
    if (!header) return null
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, coordinatorThreadId)
    return {
      runId: header.runId,
      auditKind: header.auditKind,
      startedAt: header.startedAt,
      steps,
      artifactPath: join(featureArtifactDirectory(featureSlug), relativePath).replace(/\\/gu, '/')
    }
  }

  private enqueueAppend(run: ActiveAuditProgressRun, line: string): Promise<void> {
    const previous = this.writeQueues.get(run.threadId) ?? Promise.resolve()
    const next = previous
      .then(() =>
        this.resolveProject(
          run.projectId,
          run.coordinatorThreadId,
          auditProgressRelativePath(run.threadId)
        )
      )
      .then(async (path) => {
        await ensureDir(dirname(path))
        await appendFile(path, line, 'utf-8')
      })
      .catch((error) => {
        // Surfaced by the caller's catch, which knows the run it belongs to.
        throw error
      })
    const settled = next.catch(() => undefined)
    this.writeQueues.set(run.threadId, settled)
    return next
  }

  private async writeWhole(
    projectId: string,
    coordinatorThreadId: string,
    auditorThreadId: string,
    lines: string[]
  ): Promise<void> {
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, coordinatorThreadId)
    await this.host.storage.writeProjectSpecRaw(
      projectId,
      featureSlug,
      auditProgressRelativePath(auditorThreadId),
      lines.join(''),
      requireLocalProject(this.host.database, projectId)
    )
  }

  private async resolveProject(
    projectId: string,
    coordinatorThreadId: string,
    relativePath: string
  ): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, coordinatorThreadId)
    return this.host.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      relativePath,
      requireLocalProject(this.host.database, projectId)
    )
  }
}
