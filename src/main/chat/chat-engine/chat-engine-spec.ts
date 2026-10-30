import { basename, join } from 'path'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateEntityId, validateThreadSettings } from '../../ipc/ipc-validation'
import type {
  AgentEvent,
  AgentPart,
  AgentSessionStatus,
  EngineeringSpec,
  EngineeringSpecContent,
  ThreadSettings
} from '../../../lib/types'
import {
  ensureFeatureSlug,
  featureArtifactDirectory,
  requireLocalProject
} from '../../../lib/project-artifacts'
import type {
  PendingInitialSpecGeneration,
  RejectedSpecArtifact,
  SessionInfo,
  SpecGenerationFormatMode,
  SpecGenerationMemory
} from './chat-engine-types'
import { GeneratedSpecOutputError, rawErrorMessage } from './chat-engine-errors'
import {
  CURRENT_SPEC_GENERATION_VERSION,
  SPEC_GENERATION_FAILURE_USER_MESSAGE,
  SPEC_GENERATION_MAX_ATTEMPTS,
  SPEC_MEMORY_MAX_LESSONS
} from './chat-engine-constants'
import {
  isRecord,
  parseGeneratedSpecContent,
  validateGeneratedSpecContent
} from './chat-engine-generated-artifacts'
import { normalizedToolName } from './chat-engine-changes'
import { specGenerationLesson, specMemoryPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine spec: one concern, moved verbatim from the composition root. */
export class ChatEngineSpec {
  constructor(private readonly host: ChatEngine) {}

  /** Repair specifications persisted before their ready lifecycle finished. */
  async recoverReadyInitialSpecs(): Promise<void> {
    if (
      this.host.units['runtime-connectivity'].deferAutomaticResumeToLiveInstance(
        'ready specifications'
      )
    )
      return
    try {
      const threads = await this.host.threadManager.listAllThreads()
      await Promise.all(
        threads
          .filter(
            (thread) =>
              this.host.units['turns'].engineeringLifecycleActive(thread.projectId, thread.id) &&
              (thread.status === 'planning' || thread.status === 'failed')
          )
          .map((thread) =>
            this.host.units['spec-lifecycle']
              .runPendingInitialSpec(thread.projectId, thread.id)
              .catch((error) => {
                Logger.error('Ready specification thread recovery failed', {
                  projectId: thread.projectId,
                  threadId: thread.id,
                  error: rawErrorMessage(error)
                })
                return null
              })
          )
      )
    } catch (error) {
      Logger.error('Ready specification recovery failed', {
        error: rawErrorMessage(error)
      })
    }
  }

  /** Ensure the first engineering request has a persisted reviewable spec. */
  async ensureInitialSpec(projectId: string, threadId: string): Promise<EngineeringSpec> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const engineeringThread = await this.host.threadManager.getThread(projectId, threadId)
    if (
      !engineeringThread ||
      !this.host.units['turns'].engineeringLifecycleActive(projectId, threadId)
    ) {
      throw new Error('Specifications are available only in Engineering')
    }
    const active = await this.getActiveSpec(projectId, threadId)
    if (active) return active

    let pending = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
      projectId,
      threadId
    )
    if (!pending) {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) throw new Error(`Thread not found: ${threadId}`)
      const messages = await this.host.threadManager.loadMessages(projectId, threadId)
      const initialRequest = messages.find((message) => message.role === 'user')
      const source = initialRequest
        ? initialRequest.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim()
        : ''
      if (!source) {
        throw new Error('Send an initial engineering request before reviewing its specification.')
      }
      const settings = validateThreadSettings(
        thread.settings ?? {
          harnessId: DEFAULT_HARNESS,
          providerId: thread.providerId,
          modelId: '',
          thinkingLevel: 'medium',
          permissionLevel: 'auto_review'
        }
      )
      const activePrd = this.host.state.prdEngine.getActive(projectId, threadId)
      const finalizedPrd = activePrd?.status === 'finalized' ? activePrd : undefined
      const activeBrainstorm = await this.host.state.brainstormEngine.getActive(projectId, threadId)
      const finalizedBrainstorm =
        activeBrainstorm?.status === 'finalized' ? activeBrainstorm : undefined
      if (finalizedPrd) {
        const prdPath = await this.host.units['media-artifacts'].artifactRef(
          projectId,
          threadId,
          join('versions', `${finalizedPrd.id}-v${finalizedPrd.version}-prd.md`)
        )
        const brainstormPath = finalizedBrainstorm
          ? await this.host.units['media-artifacts'].artifactRef(
              projectId,
              threadId,
              join(
                'versions',
                `${finalizedBrainstorm.id}-v${finalizedBrainstorm.version}-brainstorm.md`
              )
            )
          : undefined
        await this.host.units['spec-lifecycle'].queuePendingInitialSpec({
          projectId,
          threadId,
          sessionId: thread.sessionId ?? '',
          source: [
            'Generate the engineering specification from the finalized PRD and, when present, the finalized Brainstorm. Do not repeat product discovery questions already resolved by these documents.',
            `PRD document: ${prdPath}`,
            brainstormPath ? `Brainstorm document: ${brainstormPath}` : ''
          ]
            .filter(Boolean)
            .join('\n\n'),
          settings,
          prd: finalizedPrd,
          brainstorm: finalizedBrainstorm,
          skipSubmittedRead: true
        })
        pending = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
          projectId,
          threadId
        )
        if (!pending) throw new Error('The PRD-backed specification request could not be queued')
      } else {
        pending = {
          schemaVersion: 1,
          generationVersion: CURRENT_SPEC_GENERATION_VERSION,
          projectId,
          threadId,
          sessionId: thread.sessionId ?? '',
          source,
          settings,
          state: 'pending',
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        await this.host.units['spec-authoring'].writePendingInitialSpec(pending)
      }
    } else if (pending.state === 'failed') {
      const now = Date.now()
      pending = {
        ...pending,
        state: 'pending',
        attempts: 0,
        error: undefined,
        createdAt: now,
        updatedAt: now
      }
      await this.host.units['spec-authoring'].writePendingInitialSpec(pending)
    }

    const generated = await this.host.units['spec-lifecycle'].runPendingInitialSpec(
      projectId,
      threadId
    )
    if (!generated) {
      throw new Error(SPEC_GENERATION_FAILURE_USER_MESSAGE)
    }
    return generated
  }

  async rememberSpecGenerationLesson(
    projectId: string,
    settings: ThreadSettings,
    error: GeneratedSpecOutputError
  ): Promise<void> {
    const now = Date.now()
    const lesson = specGenerationLesson(error)
    const current = await this.host.units['memory'].readSpecGenerationMemory(projectId, settings)
    const prior = current?.lessons.find((candidate) => candidate.code === lesson.code)
    const lessons = [
      ...(current?.lessons.filter((candidate) => candidate.code !== lesson.code) ?? []),
      {
        ...lesson,
        observations: (prior?.observations ?? 0) + 1,
        lastObservedAt: now
      }
    ].slice(-SPEC_MEMORY_MAX_LESSONS)
    await this.host.storage.write(specMemoryPath(projectId, settings), {
      schemaVersion: 1,
      harnessId: settings.harnessId || DEFAULT_HARNESS,
      providerId: settings.providerId,
      modelId: settings.modelId,
      lessons,
      updatedAt: now
    } satisfies SpecGenerationMemory)
  }

  async persistRejectedSpecOutput(input: {
    projectId: string
    threadId: string
    attempt: number
    format: SpecGenerationFormatMode
    settings: ThreadSettings
    error: GeneratedSpecOutputError
  }): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.host.database, input.projectId, input.threadId)
    const relativePath = join(
      'err-spec',
      `attempt-${Math.max(1, input.attempt)}-${input.format}.json`
    )
    const artifactPath = join(featureArtifactDirectory(featureSlug), relativePath).replace(
      /\\/gu,
      '/'
    )
    const artifact: RejectedSpecArtifact = {
      schemaVersion: 1,
      generationVersion: CURRENT_SPEC_GENERATION_VERSION,
      projectId: input.projectId,
      threadId: input.threadId,
      attempt: Math.max(1, input.attempt),
      format: input.format,
      harnessId: input.settings.harnessId || DEFAULT_HARNESS,
      providerId: input.settings.providerId,
      modelId: input.settings.modelId,
      diagnostic: input.error.diagnostic,
      rejectedOutput: input.error.rejectedOutput,
      createdAt: Date.now()
    }
    await this.host.storage.writeProjectSpecRaw(
      input.projectId,
      featureSlug,
      relativePath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      requireLocalProject(this.host.database, input.projectId)
    )
    return artifactPath
  }

  async prepareRejectedSpecRepair(input: {
    projectId: string
    threadId: string
    attempt: number
    format: SpecGenerationFormatMode
    settings: ThreadSettings
    error: GeneratedSpecOutputError
  }): Promise<GeneratedSpecOutputError> {
    let artifactPath: string | undefined
    try {
      artifactPath = await this.persistRejectedSpecOutput(input)
    } catch (artifactError) {
      Logger.error('Rejected specification artifact persistence failed', {
        projectId: input.projectId,
        threadId: input.threadId,
        attempt: input.attempt,
        format: input.format,
        error: rawErrorMessage(artifactError)
      })
    }
    try {
      await this.rememberSpecGenerationLesson(input.projectId, input.settings, input.error)
    } catch (memoryError) {
      Logger.error('Specification generation lesson persistence failed', {
        projectId: input.projectId,
        threadId: input.threadId,
        error: rawErrorMessage(memoryError)
      })
    }
    return new GeneratedSpecOutputError(
      input.error.diagnostic,
      input.error.rejectedOutput,
      artifactPath
    )
  }

  initialSpecKey(projectId: string, threadId: string): string {
    return `${projectId}:${threadId}`
  }

  async getActiveSpec(projectId: string, threadId: string): Promise<EngineeringSpec | null> {
    const workflow = await this.host.state.specEngine.getWorkflowState(projectId, threadId)
    if (!workflow?.activeSpecId || !workflow.activeSpecVersion) return null
    return this.host.state.specEngine.getVersion(
      projectId,
      threadId,
      workflow.activeSpecId,
      workflow.activeSpecVersion
    )
  }

  /** Read a specification submitted through the main planning session's contract. */
  async readSubmittedSpecContent(
    pending: PendingInitialSpecGeneration
  ): Promise<EngineeringSpecContent | GeneratedSpecOutputError | null> {
    if (!pending.sessionId) return null
    let format: SpecGenerationFormatMode = 'json'
    try {
      const { driver, projectPath } = await this.host.resolve(
        pending.projectId,
        pending.settings.harnessId || DEFAULT_HARNESS,
        pending.threadId
      )
      const messages = await driver.loadMessages(projectPath, pending.sessionId)
      const response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (!response) return null
      const assignmentRequired = pending.settings.assignmentMode === true
      if (response.structuredOutput !== undefined) {
        format = 'structured'
        return validateGeneratedSpecContent(response.structuredOutput, assignmentRequired)
      }
      const text = response.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      return text.trim() ? parseGeneratedSpecContent(text, assignmentRequired) : null
    } catch (error) {
      Logger.info('Planning-session specification submission was invalid; using recovery:', error)
      if (error instanceof GeneratedSpecOutputError) {
        return this.prepareRejectedSpecRepair({
          projectId: pending.projectId,
          threadId: pending.threadId,
          attempt: Math.max(1, pending.attempts),
          format,
          settings: pending.settings,
          error
        })
      }
      return null
    }
  }

  async finalizeInitialSpec(
    spec: EngineeringSpec,
    pending: PendingInitialSpecGeneration
  ): Promise<EngineeringSpec> {
    if (pending.settings.assignmentMode === true) {
      if (!spec.content.assignment) {
        Logger.error('Ready specification is missing its generated Assignment graph', {
          projectId: pending.projectId,
          threadId: pending.threadId,
          specId: spec.id,
          specVersion: spec.version
        })
      }
      const existingAssignment = this.host.state.assignmentEngine.getActive(
        pending.projectId,
        pending.threadId
      )
      if (!existingAssignment && spec.content.assignment) {
        try {
          await this.host.state.assignmentEngine.createDraft({
            projectId: pending.projectId,
            coordinatorThreadId: pending.threadId,
            specId: spec.id,
            specVersion: spec.version,
            content: spec.content.assignment,
            provenance: {
              source: 'agent',
              actor: 'Sr. Engineer',
              harnessId: pending.settings.harnessId,
              providerId: pending.settings.providerId,
              modelId: pending.settings.modelId
            }
          })
        } catch (error) {
          Logger.error('Ready specification Assignment creation failed', {
            projectId: pending.projectId,
            threadId: pending.threadId,
            specId: spec.id,
            specVersion: spec.version,
            error: rawErrorMessage(error)
          })
        }
      }
    }
    await this.publishInitialSpecReady(spec, pending.sessionId)
    try {
      await this.host.units['spec-lifecycle'].clearPendingInitialSpec(
        pending.projectId,
        pending.threadId
      )
    } catch (error) {
      Logger.error('Ready specification generation cleanup failed', {
        projectId: pending.projectId,
        threadId: pending.threadId,
        specId: spec.id,
        specVersion: spec.version,
        error: rawErrorMessage(error)
      })
    }
    return spec
  }

  async publishInitialSpecReady(spec: EngineeringSpec, fallbackSessionId?: string): Promise<void> {
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(spec.projectId, spec.threadId)
    if (lifecycle?.activeStage === 'spec') {
      this.host.state.engineeringLifecycleEngine.advance(spec.projectId, spec.threadId, {
        gate: 'spec_approval'
      })
    }
    const thread = await this.host.threadManager.getThread(spec.projectId, spec.threadId)
    try {
      await this.host.threadManager.setStatus(spec.projectId, spec.threadId, 'spec', {
        read: false
      })
    } catch (error) {
      Logger.error('Ready specification thread status update failed', {
        projectId: spec.projectId,
        threadId: spec.threadId,
        specId: spec.id,
        specVersion: spec.version,
        error: rawErrorMessage(error)
      })
    }
    const sessionId = thread?.sessionId ?? fallbackSessionId ?? `spec-${spec.id}`
    this.host.sessionStatuses.set(sessionId, { state: 'idle' })
    this.host.broadcast({
      type: 'spec.ready',
      sessionId,
      projectId: spec.projectId,
      threadId: spec.threadId,
      specId: spec.id,
      version: spec.version
    })
  }

  /** Expose genuine trace parts from the active isolated specification worker. */
  forwardInitialSpecTrace(owner: SessionInfo, event: AgentEvent): void {
    if (!owner.ephemeral || !('sessionId' in event)) return
    const key = this.initialSpecKey(owner.projectId, owner.threadId)
    const active = this.host.state.activeInitialSpecSessions.get(key)
    if (!active || active.sessionId !== event.sessionId) return

    if (event.type === 'session.idle' || event.type === 'session.error') {
      this.host.broadcast({
        type: 'spec.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: { type: 'completed' }
      })
      return
    }
    if (event.type === 'message.completed') {
      // Only a completed message carrying the final structured specification
      // ends the trace. Intermediate messages (tool-call steps, continuing
      // reasoning) are part of the same live run and must never hide the trace
      // the moment they complete; clearing on each one is what made the spec
      // trace flash in and out instead of staying visible through generation.
      if (event.structuredOutput !== undefined) {
        this.host.broadcast({
          type: 'spec.trace',
          sessionId: event.sessionId,
          projectId: owner.projectId,
          threadId: owner.threadId,
          update: { type: 'completed' }
        })
      }
      return
    }

    if (event.type === 'message.part.delta') {
      this.host.broadcast({
        type: 'spec.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: {
          type: 'part.delta',
          partId: `${event.sessionId}:${event.partId}`,
          field: event.field,
          delta: event.delta
        }
      })
      return
    }

    if (event.type !== 'message.part.updated') return
    const sourcePart = event.part
    if (!['reasoning', 'tool', 'subagent', 'step-finish'].includes(sourcePart.type)) return
    const part: AgentPart = {
      ...sourcePart,
      id: `${event.sessionId}:${sourcePart.id}`,
      messageID: `spec-trace:${owner.threadId}`
    }
    this.host.broadcast({
      type: 'spec.trace',
      sessionId: event.sessionId,
      projectId: owner.projectId,
      threadId: owner.threadId,
      update: { type: 'part.updated', part }
    })

    let label: string | null = null
    if (sourcePart.type === 'reasoning') {
      label = 'Reasoning through the engineering specification'
    } else if (sourcePart.type === 'subagent') {
      label = 'Coordinating specification research'
    } else if (sourcePart.type === 'tool') {
      const input = isRecord(sourcePart.state.input) ? sourcePart.state.input : null
      const path =
        input && typeof input.filePath === 'string'
          ? input.filePath
          : input && typeof input.path === 'string'
            ? input.path
            : null
      const tool = normalizedToolName(sourcePart.tool)
      label =
        tool === 'read'
          ? `Inspecting ${path ? basename(path) : 'project files'}`
          : tool === 'grep' || tool === 'glob' || tool === 'list'
            ? 'Searching project context'
            : sourcePart.state.title?.trim() || `Using ${sourcePart.tool}`
    }
    if (!label) return

    const status: AgentSessionStatus = {
      state: 'working',
      startedAt: active.startedAt,
      activity: {
        kind: 'spec_generation',
        label,
        attempt: active.attempt,
        maxAttempts: SPEC_GENERATION_MAX_ATTEMPTS,
        updatedAt: Date.now()
      }
    }
    this.host.sessionStatuses.set(active.threadSessionId, status)
    this.host.broadcast({ type: 'session.status', sessionId: active.threadSessionId, status })
  }
}
