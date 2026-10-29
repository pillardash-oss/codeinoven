import { join, resolve } from 'path'
import { Logger } from '../../system/logger'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import type {
  AgentSessionStatus,
  EngineeringSpec,
  EngineeringSpecContent,
  SpecGenerationRequest,
  Thread
} from '../../../lib/types'
import { modelKey } from '../../../lib/model-keys'
import { ensureFeatureSlug, featureArtifactDirectory } from '../../../lib/project-artifacts'
import { validateEngineeringSpec } from '../../../lib/spec/spec-validation'
import type { PendingInitialSpecGeneration, PendingSpecRevision } from './chat-engine-types'
import { GeneratedSpecOutputError } from './chat-engine-errors'
import { formatConversationTranscript } from './chat-engine-message-text'
import {
  MAX_SPEC_INSTRUCTIONS_LENGTH,
  SPEC_GENERATION_FAILURE_USER_MESSAGE,
  SPEC_GENERATION_MAX_ATTEMPTS,
  SPEC_GENERATION_TIMEOUT_MS
} from './chat-engine-constants'
import {
  ASSIGNMENT_GENERATION_INSTRUCTION,
  PROMPT_READ_ONLY_TOOLS,
  SPEC_JSON_FALLBACK_SYSTEM_PROMPT,
  engineeringArtifactBoundaryInstruction
} from './chat-engine-prompts'
import {
  parseGeneratedSpecContent,
  specGenerationSchema,
  stringifyRejectedSpecOutput,
  validateGeneratedSpecContent
} from './chat-engine-generated-artifacts'
import {
  broadcastToast,
  initialSpecPath,
  initialSpecWorkingStatus,
  pendingSpecRevisionPath,
  specRepairInstruction
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine spec-authoring: one concern, moved verbatim from the composition root. */
export class ChatEngineSpecAuthoring {
  constructor(private readonly host: ChatEngine) {}

  /** Generate structured spec content in an isolated read-only harness session. */
  async generateSpec(
    projectId: string,
    threadId: string,
    request: SpecGenerationRequest
  ): Promise<EngineeringSpecContent> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const settings = validateThreadSettings(request.settings)
    const assignmentRequired = settings.assignmentMode === true
    const workflowKey = this.host.units['spec'].initialSpecKey(projectId, threadId)
    const pendingWorkflow = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
      projectId,
      threadId
    )
    const workflowThread = pendingWorkflow
      ? await this.host.threadManager.getThread(projectId, threadId)
      : null
    const artifactDirectory = featureArtifactDirectory(
      await ensureFeatureSlug(this.host.database, projectId, threadId)
    )
    const artifactBoundary = engineeringArtifactBoundaryInstruction(artifactDirectory)
    const memoryPrompt = await this.host.state.memoryService.formatCurrent(
      projectId,
      threadId,
      modelKey(settings.harnessId, settings.providerId, settings.modelId)
    )
    const specMemoryPrompt = await this.host.units['memory'].formatSpecGenerationMemory(
      projectId,
      settings
    )
    const generationSystemPrompt = [
      await this.host.units['turns-dispatch'].cioPrompt('engineering-spec'),
      artifactBoundary,
      memoryPrompt,
      specMemoryPrompt,
      assignmentRequired ? ASSIGNMENT_GENERATION_INSTRUCTION : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const fallbackSystemPrompt = [
      await this.host.units['turns-dispatch'].cioPrompt('engineering-spec'),
      SPEC_JSON_FALLBACK_SYSTEM_PROMPT,
      artifactBoundary,
      memoryPrompt,
      specMemoryPrompt,
      assignmentRequired ? ASSIGNMENT_GENERATION_INSTRUCTION : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const generationSchema = specGenerationSchema(assignmentRequired)
    const instructions = validateBoundedString(
      request.instructions,
      'Specification instructions',
      1,
      MAX_SPEC_INSTRUCTIONS_LENGTH
    )
    if (request.mode !== 'problem' && request.mode !== 'conversation') {
      throw new TypeError('Invalid specification generation mode')
    }

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, threadId)
    let source = instructions
    if (request.mode === 'conversation') {
      const messages = await this.host.threadManager.loadMessageRecords(projectId, threadId)
      const transcript = formatConversationTranscript(messages, { maxCharacters: 80_000 })
      source = `${instructions}\n\nConversation context:\n${transcript}`
    }
    if (await this.host.state.brainstormEngine.getActive(projectId, threadId)) {
      source += `\n\n${await this.host.units['brainstorm-review'].brainstormAlignmentContext(projectId, threadId, false)}`
    }

    const structuredOutputKey = `${driverId}:${settings.providerId}:${settings.modelId}`
    const isZenFreeModel =
      driverId === 'opencode' &&
      settings.providerId === 'opencode' &&
      settings.modelId.endsWith('-free')
    const useStructuredOutput =
      driver.capabilities?.structuredOutput === true &&
      !isZenFreeModel &&
      !this.host.state.unsupportedStructuredOutputModels.has(structuredOutputKey)
    const formatModes = useStructuredOutput ? [true, false] : [false]
    let lastError: Error | null = null
    let repairError: GeneratedSpecOutputError | null = null

    for (const useStructuredOutput of formatModes) {
      const isolated = supportsIsolatedSessions(driver)
        ? await driver.createIsolatedSession(projectPath, `Spec draft ${new Date().toISOString()}`)
        : undefined
      const sessionId =
        isolated?.sessionId ??
        (await driver.createSession(projectPath, `Spec draft ${new Date().toISOString()}`))
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        settings.permissionLevel,
        driverId,
        undefined,
        true
      )
      if (pendingWorkflow && workflowThread?.sessionId) {
        this.host.state.activeInitialSpecSessions.set(workflowKey, {
          sessionId,
          threadSessionId: workflowThread.sessionId,
          driver,
          projectPath,
          isolated,
          startedAt: pendingWorkflow.createdAt,
          attempt: Math.max(1, pendingWorkflow.attempts)
        })
        this.host.broadcast({
          type: 'spec.trace',
          sessionId,
          projectId,
          threadId,
          update: { type: 'started', startedAt: pendingWorkflow.createdAt }
        })
        const status = initialSpecWorkingStatus(
          pendingWorkflow,
          `${repairError || pendingWorkflow.repairArtifactPath ? 'Correcting invalid specification output' : 'Formulating specification'} · attempt ${Math.max(1, pendingWorkflow.attempts)}/${SPEC_GENERATION_MAX_ATTEMPTS}`
        )
        this.host.sessionStatuses.set(workflowThread.sessionId, status)
        this.host.broadcast({ type: 'session.status', sessionId: workflowThread.sessionId, status })
      }
      // A stop that landed while the spec session was still being created must
      // win: tear the just-created session down instead of running the prompt.
      if (this.host.state.userAbortedInitialSpecOperations.has(workflowKey)) {
        this.host.state.activeInitialSpecSessions.delete(workflowKey)
        this.host.sessionRegistry.delete(sessionId)
        if (isolated && supportsIsolatedSessions(driver)) {
          driver.disposeIsolatedSession(isolated)
        } else {
          await driver.deleteSession?.(projectPath, sessionId).catch(() => undefined)
        }
        throw new Error('Specification generation was stopped by the user.')
      }
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        SPEC_GENERATION_TIMEOUT_MS,
        'Specification generation',
        () => new Error('Specification generation stopped producing activity for 10 minutes')
      )

      try {
        const prompt: SendPromptOptions = {
          sessionId,
          settings,
          text: [source, repairError ? specRepairInstruction(repairError) : '']
            .filter(Boolean)
            .join('\n\n'),
          attachments: [],
          systemPrompt: useStructuredOutput ? generationSystemPrompt : fallbackSystemPrompt,
          allowedTools: PROMPT_READ_ONLY_TOOLS,
          ...(useStructuredOutput
            ? {
                structuredOutput: {
                  schema: generationSchema,
                  retryCount: 2
                }
              }
            : {})
        }
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.sendPrompt(projectPath, prompt, isolated)
        } else {
          await driver.sendPrompt(projectPath, prompt)
        }
        const streamedStructuredOutput = await completion
        if (streamedStructuredOutput !== undefined) {
          return validateGeneratedSpecContent(streamedStructuredOutput, assignmentRequired)
        }
        const messages =
          isolated && supportsIsolatedSessions(driver)
            ? await driver.loadMessages(projectPath, sessionId, isolated)
            : await driver.loadMessages(projectPath, sessionId)
        const response = [...messages].reverse().find((message) => message.role === 'assistant')
        if (!response) throw new Error('The spec agent returned no response')
        if (response.error) throw new Error(response.error)
        if (response.structuredOutput !== undefined) {
          return validateGeneratedSpecContent(response.structuredOutput, assignmentRequired)
        }
        const text = response.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        return parseGeneratedSpecContent(text, assignmentRequired)
      } catch (error) {
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.abort(projectPath, sessionId, isolated).catch(() => undefined)
        } else {
          await driver.abort(projectPath, sessionId).catch(() => undefined)
        }
        const rejectedError =
          error instanceof GeneratedSpecOutputError
            ? await this.host.units['spec'].prepareRejectedSpecRepair({
                projectId,
                threadId,
                attempt: Math.max(1, pendingWorkflow?.attempts ?? 1),
                format: useStructuredOutput ? 'structured' : 'json',
                settings,
                error
              })
            : null
        lastError =
          rejectedError ??
          (error instanceof Error ? error : new Error('The specification agent failed.'))
        if (rejectedError) repairError = rejectedError
        if (this.host.state.userAbortedInitialSpecOperations.has(workflowKey)) throw lastError
        Logger.error('Specification generation session rejected', {
          projectId,
          threadId,
          sessionId,
          structuredOutput: useStructuredOutput,
          error: lastError.message
        })
        if (useStructuredOutput && !rejectedError) {
          this.host.state.unsupportedStructuredOutputModels.add(structuredOutputKey)
          Logger.info(
            'Structured specification generation failed; using JSON-only output for this model:',
            {
              driverId,
              providerId: settings.providerId,
              modelId: settings.modelId,
              error: lastError.message
            }
          )
        }
      } finally {
        await this.host.units['messages-write'].recordEphemeralSessionUsage({
          projectId,
          threadId,
          sessionId,
          projectPath,
          driver,
          isolated
        })
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        this.host.sessionRegistry.delete(sessionId)
        this.host.state.reasoningTimes.delete(sessionId)
        this.host.state.toolTimes.delete(sessionId)
        if (isolated && supportsIsolatedSessions(driver)) {
          driver.disposeIsolatedSession(isolated)
        }
        if (this.host.state.activeInitialSpecSessions.get(workflowKey)?.sessionId === sessionId) {
          this.host.state.activeInitialSpecSessions.delete(workflowKey)
        }
      }
    }

    throw repairError ?? lastError ?? new Error('The specification agent failed.')
  }

  writePendingInitialSpec(pending: PendingInitialSpecGeneration): Promise<void> {
    return this.host.storage.write(initialSpecPath(pending.projectId, pending.threadId), pending)
  }

  writePendingSpecRevision(pending: PendingSpecRevision): Promise<void> {
    return this.host.storage.write(
      pendingSpecRevisionPath(pending.projectId, pending.threadId),
      pending
    )
  }

  async generatePendingInitialSpec(
    projectId: string,
    threadId: string
  ): Promise<EngineeringSpec | null> {
    const operationKey = this.host.units['spec'].initialSpecKey(projectId, threadId)
    const active = await this.host.units['spec'].getActiveSpec(projectId, threadId)
    if (active) {
      const pending = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
        projectId,
        threadId
      )
      if (pending) return this.host.units['spec'].finalizeInitialSpec(active, pending)
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (
        thread &&
        active.status !== 'approved' &&
        !(thread.dismissedSpecId === active.id && thread.dismissedSpecVersion === active.version) &&
        (thread.status === 'planning' || thread.status === 'failed')
      ) {
        await this.host.units['spec'].publishInitialSpecReady(active, thread.sessionId)
      }
      return active
    }

    let pending = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
      projectId,
      threadId
    )
    if (!pending) return null
    if (pending.state === 'failed' && pending.attempts >= SPEC_GENERATION_MAX_ATTEMPTS) {
      return null
    }
    if (pending.state === 'generating') {
      pending = {
        ...pending,
        state: 'pending',
        attempts: Math.max(0, pending.attempts - 1),
        updatedAt: Date.now()
      }
      await this.writePendingInitialSpec(pending)
    }

    await this.host.threadManager.setStatus(projectId, threadId, 'planning')
    let lastError = ''
    let encounteredInvalidSpec = Boolean(pending.repairArtifactPath)
    while (pending.attempts < SPEC_GENERATION_MAX_ATTEMPTS) {
      // A stop that landed between attempts (or before the first one) must
      // cancel the remaining attempts instead of letting the loop continue.
      if (this.host.state.userAbortedInitialSpecOperations.delete(operationKey)) {
        await this.host.units['spec-lifecycle'].clearPendingInitialSpec(projectId, threadId)
        await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
        Logger.info('Specification generation interrupted by user', {
          projectId,
          threadId,
          attempt: pending.attempts
        })
        return null
      }
      pending = {
        ...pending,
        state: 'generating',
        attempts: pending.attempts + 1,
        error: undefined,
        updatedAt: Date.now()
      }
      await this.writePendingInitialSpec(pending)
      Logger.info('Specification generation attempt started', {
        projectId,
        threadId,
        attempt: pending.attempts,
        maxAttempts: SPEC_GENERATION_MAX_ATTEMPTS,
        startedAt: pending.createdAt
      })
      try {
        const submittedResult: EngineeringSpecContent | GeneratedSpecOutputError | null =
          pending.skipSubmittedRead
            ? null
            : await this.host.units['spec'].readSubmittedSpecContent(pending)
        const submittedRepair: GeneratedSpecOutputError | null =
          submittedResult instanceof GeneratedSpecOutputError ? submittedResult : null
        const submittedContent: EngineeringSpecContent | null =
          submittedResult && !(submittedResult instanceof GeneratedSpecOutputError)
            ? submittedResult
            : null
        encounteredInvalidSpec ||= submittedRepair !== null
        if (submittedRepair?.repairArtifactPath) {
          pending = {
            ...pending,
            error: submittedRepair.message,
            repairArtifactPath: submittedRepair.repairArtifactPath,
            updatedAt: Date.now()
          }
          await this.writePendingInitialSpec(pending)
        }
        const content =
          submittedContent ??
          (await this.host.generateSpec(projectId, threadId, {
            mode: 'conversation',
            instructions: [
              pending.source,
              submittedRepair ? specRepairInstruction(submittedRepair) : '',
              lastError
                ? [
                    'The previous specification output failed deterministic validation.',
                    `Exact validator diagnostic: ${lastError}`,
                    pending.repairArtifactPath
                      ? `Read the rejected output and diagnostic at ${pending.repairArtifactPath}. Correct it before submitting a complete replacement object.`
                      : '',
                    'Return only one complete valid JSON object matching the required schema.'
                  ]
                    .filter(Boolean)
                    .join('\n')
                : ''
            ]
              .filter(Boolean)
              .join('\n\n'),
            settings: pending.settings
          }))
        const validationTimestamp = Date.now()
        const validation = validateEngineeringSpec({
          schemaVersion: 1,
          id: 'pending-generated-spec',
          projectId,
          threadId,
          version: 1,
          status: 'draft',
          content,
          annotations: [],
          dismissedValidationIssues: [],
          decisionComments: [],
          context: [],
          provenance: {
            source: 'agent',
            actor: 'spec-validator',
            createdAt: validationTimestamp
          },
          createdAt: validationTimestamp,
          updatedAt: validationTimestamp
        })
        if (!validation.valid) {
          const validationError = new GeneratedSpecOutputError(
            `Specification domain validation failed: ${validation.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join('; ')}`,
            stringifyRejectedSpecOutput(content)
          )
          throw await this.host.units['spec'].prepareRejectedSpecRepair({
            projectId,
            threadId,
            attempt: pending.attempts,
            format: 'domain',
            settings: pending.settings,
            error: validationError
          })
        }
        const context = await this.host.state.memoryService.snapshotCurrent(
          projectId,
          threadId,
          modelKey(
            pending.settings.harnessId,
            pending.settings.providerId,
            pending.settings.modelId
          )
        )
        const spec = await this.host.state.specEngine.createDraft({
          projectId,
          threadId,
          content,
          provenance: pending.prdId
            ? {
                source: 'prd',
                actor: 'Sr. Engineer',
                prdId: pending.prdId,
                prdVersion: pending.prdVersion,
                prdInputHash: pending.prdInputHash,
                brainstormId: pending.brainstormId,
                brainstormVersion: pending.brainstormVersion,
                brainstormInputHash: pending.brainstormInputHash
              }
            : pending.brainstormId
              ? {
                  source: 'brainstorm',
                  actor: 'Sr. Engineer',
                  brainstormId: pending.brainstormId,
                  brainstormVersion: pending.brainstormVersion,
                  brainstormInputHash: pending.brainstormInputHash
                }
              : { source: 'agent', actor: 'spec-agent' },
          context
        })
        return this.host.units['spec'].finalizeInitialSpec(spec, pending)
      } catch (error) {
        const created = await this.host.units['spec'].getActiveSpec(projectId, threadId)
        if (created) return this.host.units['spec'].finalizeInitialSpec(created, pending)
        const invalidSpecError = error instanceof GeneratedSpecOutputError ? error : null
        encounteredInvalidSpec ||= invalidSpecError !== null
        lastError = error instanceof Error ? error.message : 'The specification agent failed.'
        if (this.host.state.userAbortedInitialSpecOperations.delete(operationKey)) {
          await this.host.units['spec-lifecycle'].clearPendingInitialSpec(projectId, threadId)
          await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', {
            read: true
          })
          Logger.info('Specification generation interrupted by user', {
            projectId,
            threadId,
            attempt: pending.attempts
          })
          return null
        }
        const willRetry = pending.attempts < SPEC_GENERATION_MAX_ATTEMPTS
        Logger.error('Specification generation attempt rejected', {
          projectId,
          threadId,
          attempt: pending.attempts,
          maxAttempts: SPEC_GENERATION_MAX_ATTEMPTS,
          willRetry,
          error: lastError
        })
        pending = {
          ...pending,
          state: pending.attempts >= SPEC_GENERATION_MAX_ATTEMPTS ? 'failed' : 'pending',
          error: lastError,
          repairArtifactPath: invalidSpecError?.repairArtifactPath ?? pending.repairArtifactPath,
          updatedAt: Date.now()
        }
        await this.writePendingInitialSpec(pending)
      }
    }

    await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
      read: false,
      error: lastError || 'The specification could not be generated.'
    })
    pending = {
      ...pending,
      state: 'failed',
      error: lastError || 'The specification could not be generated.',
      updatedAt: Date.now()
    }
    await this.writePendingInitialSpec(pending)
    // The run is terminally done   release the live working trace so the
    // dedicated Retry-specification card replaces it instead of a stale trace.
    this.host.broadcast({
      type: 'spec.trace',
      sessionId: pending.sessionId || '',
      projectId,
      threadId,
      update: { type: 'completed' }
    })
    this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, pending.error)
    Logger.error('Specification generation failed', {
      projectId,
      threadId,
      attempts: pending.attempts,
      elapsedMs: Date.now() - pending.createdAt,
      error: pending.error
    })
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (thread?.sessionId) {
      const status: AgentSessionStatus = { state: 'idle' }
      this.host.sessionStatuses.set(thread.sessionId, status)
      // Idle prompts the renderer to reconcile persisted planning state, which
      // opens the dedicated Retry specification card without a red error card.
      this.host.broadcast({ type: 'session.status', sessionId: thread.sessionId, status })
    }
    broadcastToast(
      encounteredInvalidSpec
        ? SPEC_GENERATION_FAILURE_USER_MESSAGE
        : `Specification generation failed: ${lastError}`
    )
    return null
  }
}
