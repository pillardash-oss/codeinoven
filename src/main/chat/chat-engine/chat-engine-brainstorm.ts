import { join } from 'path'
import { createHash } from 'crypto'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { appendPartDelta } from '../../../lib/agent-part-merge'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  BrainstormContent,
  BrainstormDocument,
  BrainstormEntryChoice,
  EngineeringSpec,
  UserMessagePresentation,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import {
  ensureFeatureSlug,
  featureArtifactDirectory,
  requireLocalProject
} from '../../../lib/project-artifacts'
import type { ActiveBrainstormConversationTurn, SessionInfo } from './chat-engine-types'
import {
  GeneratedBrainstormOutputError,
  rawErrorDetail,
  rawErrorMessage
} from './chat-engine-errors'
import {
  formatBrainstormInterviewDecisions,
  formatConversationTranscript
} from './chat-engine-message-text'
import { SPEC_GENERATION_FAILURE_USER_MESSAGE } from './chat-engine-constants'
import { formatOpenAnnotations } from './chat-engine-prompts'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine brainstorm: one concern, moved verbatim from the composition root. */
export class ChatEngineBrainstorm {
  constructor(private readonly host: ChatEngine) {}

  async implementationBrainstormContract(
    projectId: string,
    threadId: string
  ): Promise<BrainstormDocument | null> {
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    const reference = thread?.implementationBrainstorm
    const document = reference
      ? await this.host.state.brainstormEngine.getVersionViaWorker(
          projectId,
          threadId,
          reference.id,
          reference.version
        )
      : await this.host.state.brainstormEngine.getFinalizedViaWorker(projectId, threadId)
    return document?.status === 'finalized' ? document : null
  }

  async chooseBrainstormEntry(
    projectId: string,
    threadId: string,
    choice: BrainstormEntryChoice
  ): Promise<BrainstormDocument | EngineeringSpec | null> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    if (choice !== 'brainstorm' && choice !== 'spec') {
      throw new TypeError('Brainstorm entry choice is invalid')
    }
    const operationKey = `${projectId}:${threadId}`
    const running = this.host.state.activeBrainstormEntryOperations.get(operationKey)
    if (running) {
      if (running.choice !== choice) {
        throw new Error(`The planning path is already ${running.choice}`)
      }
      return running.promise
    }
    if (this.host.state.activeBrainstormOperations.has(operationKey)) {
      throw new Error('The Sr. Engineer is already updating this Brainstorm')
    }
    const operation = this.runBrainstormEntryChoice(projectId, threadId, choice, operationKey)
    this.host.state.activeBrainstormEntryOperations.set(operationKey, {
      choice,
      promise: operation
    })
    try {
      return await operation
    } finally {
      if (
        this.host.state.activeBrainstormEntryOperations.get(operationKey)?.promise === operation
      ) {
        this.host.state.activeBrainstormEntryOperations.delete(operationKey)
      }
    }
  }

  async runBrainstormEntryChoice(
    projectId: string,
    threadId: string,
    choice: BrainstormEntryChoice,
    operationKey: string
  ): Promise<BrainstormDocument | EngineeringSpec | null> {
    this.host.state.activeBrainstormOperations.add(operationKey)
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.settings) throw new Error('Sr. Engineer settings are missing')
      this.host.state.brainstormEngine.chooseEntry(projectId, threadId, choice)
      await this.host.threadManager.setStatus(projectId, threadId, 'planning')

      if (choice === 'spec') {
        await this.host.units['spec-lifecycle'].queuePendingInitialSpec({
          projectId,
          threadId,
          sessionId: thread.sessionId ?? '',
          source: 'Generate the engineering specification from the user request and conversation.',
          settings: thread.settings,
          skipSubmittedRead: true
        })
        return this.host.units['spec-lifecycle'].runPendingInitialSpec(projectId, threadId)
      }

      const existing = await this.host.state.brainstormEngine.getActive(projectId, threadId)
      if (existing) return existing
      await this.host.sendPrompt(
        projectId,
        threadId,
        thread.settings,
        'Begin the Brainstorm session now. Do one bounded read-only research pass, share at most one concise paragraph of decision-relevant findings, then immediately use the question tool for the first focused alignment questions. Do not save alignment notes or call another tool before that first question.',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal'
      )
      return null
    } catch (error) {
      if (this.host.state.userAbortedBrainstormOperations.delete(operationKey)) {
        await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
        return null
      }
      this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, error)
      await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
        read: false,
        error: rawErrorMessage(error),
        errorDetail: rawErrorDetail(error)
      })
      throw error
    } finally {
      this.host.state.activeBrainstormOperations.delete(operationKey)
    }
  }

  async createBrainstormSessionReport(
    projectId: string,
    threadId: string,
    note: string
  ): Promise<BrainstormDocument> {
    const existing = await this.host.state.brainstormEngine.getActive(projectId, threadId)
    if (existing) return existing
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.settings) throw new Error('Sr. Engineer settings are missing')
    // First-document creation must surface the same live indicators as the
    // revision refresh: without the trace broadcast the renderer never marks
    // the thread busy, so the open conversation shows nothing and the sidebar
    // hover shows no working stage until the final `spec` status lands.
    const createSessionId = `brainstorm-create-${threadId}-${Date.now()}`
    const createHarnessId = thread.settings.harnessId || DEFAULT_HARNESS
    this.host.broadcast({
      type: 'brainstorm.trace',
      sessionId: createSessionId,
      projectId,
      threadId,
      update: { type: 'refresh.started', startedAt: Date.now(), phase: 'create', version: 1 }
    })
    try {
      await this.host.threadManager.setStatus(projectId, threadId, 'planning')
      const content = await this.host.units['brainstorm-generate'].generateBrainstormContent(
        projectId,
        threadId,
        thread.settings,
        [
          'Create the first concise Brainstorm session report from the conversation and verified research.',
          'Preserve unresolved material choices in Still to Decide rather than inventing answers.',
          note.trim() ? `Latest user input: ${note.trim()}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        { announceProgress: false }
      )
      const created = await this.host.state.brainstormEngine.createDraft({
        projectId,
        threadId,
        content,
        provenance: {
          source: 'agent',
          actor: 'Sr. Engineer',
          harnessId: thread.settings.harnessId,
          providerId: thread.settings.providerId,
          modelId: thread.settings.modelId
        }
      })
      await this.publishBrainstormReady(created, thread.sessionId)
      return created
    } catch (error) {
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: createSessionId,
        projectId,
        threadId,
        update: {
          type: 'refresh.failed',
          error: rawErrorMessage(error),
          harnessId: createHarnessId
        }
      })
      throw error
    } finally {
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: createSessionId,
        projectId,
        threadId,
        update: { type: 'refresh.completed' }
      })
    }
  }

  async finalizeBrainstorm(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note = ''
  ): Promise<EngineeringSpec | BrainstormDocument> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    brainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
    note = validateBoundedString(note, 'Brainstorm finalize note', 0, 20_000)
    const operationKey = `${projectId}:${threadId}`
    const runningFinalize = this.host.state.activeBrainstormFinalizes.get(operationKey)
    if (runningFinalize) {
      // A finalize is already in flight for this thread (finalizing the Brainstorm
      // and/or generating its spec takes a while). Reuse it instead of failing with
      // a misleading "already updating this Brainstorm" on a legitimate retry.
      return runningFinalize
    }
    if (this.host.state.activeBrainstormOperations.has(operationKey)) {
      throw new Error('The Sr. Engineer is already updating this Brainstorm')
    }
    const operation = this.runFinalizeBrainstorm(
      projectId,
      threadId,
      brainstormId,
      version,
      note,
      operationKey
    )
    this.host.state.activeBrainstormFinalizes.set(operationKey, operation)
    try {
      return await operation
    } finally {
      if (this.host.state.activeBrainstormFinalizes.get(operationKey) === operation) {
        this.host.state.activeBrainstormFinalizes.delete(operationKey)
      }
    }
  }

  async runFinalizeBrainstorm(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note: string,
    operationKey: string
  ): Promise<EngineeringSpec | BrainstormDocument> {
    this.host.state.activeBrainstormOperations.add(operationKey)
    try {
      const finalized = await this.host.state.brainstormEngine.finalize(
        projectId,
        threadId,
        brainstormId,
        version,
        note
      )
      const prdWorkflow = this.host.state.prdEngine.getWorkflowState(projectId, threadId)
      if (prdWorkflow?.stage === 'brainstorming') {
        const lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
        if (lifecycle?.humanGate === 'brainstorm_finalization' && lifecycle.resumeToken) {
          this.host.state.engineeringLifecycleEngine.resume(
            projectId,
            threadId,
            lifecycle.resumeToken,
            'continue',
            'prd'
          )
        }
        this.host.state.prdEngine.beginDrafting(projectId, threadId)
        await this.host.threadManager.setStatus(projectId, threadId, 'planning', { read: false })
        return finalized
      }
      let lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, threadId)
      if (
        lifecycle?.resumeToken &&
        (lifecycle.humanGate === 'prototype_selection' ||
          lifecycle.humanGate === 'brainstorm_finalization')
      ) {
        lifecycle = this.host.state.engineeringLifecycleEngine.resume(
          projectId,
          threadId,
          lifecycle.resumeToken,
          lifecycle.humanGate === 'prototype_selection' ? 'continue_without_hifi' : 'continue',
          'brainstorm'
        ).state
      }
      if (lifecycle?.activeStage === 'brainstorm') {
        this.host.state.engineeringLifecycleEngine.completeStage(projectId, threadId, 'brainstorm')
        if (lifecycle.autopilot) this.host.state.prdEngine.ensureWorkflow(projectId, threadId)
        // The Brainstorm stage is done: park the thread on the user for review
        // under the engineering-specific `spec` status, never the generic
        // needs-attention one.
        await this.host.threadManager.setStatus(projectId, threadId, 'spec', {
          read: false
        })
        return finalized
      }
      const existing = await this.host.units['spec'].getActiveSpec(projectId, threadId)
      if (
        existing?.provenance.brainstormId === finalized.id &&
        existing.provenance.brainstormVersion === finalized.version &&
        existing.provenance.brainstormInputHash === finalized.finalizedInputHash
      ) {
        return existing
      }
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.settings) throw new Error('Sr. Engineer settings are missing')
      const brainstormPath = await this.host.units['media-artifacts'].artifactRef(
        projectId,
        threadId,
        join('versions', `${finalized.id}-v${finalized.version}-brainstorm.md`)
      )
      const finalizeNotes = finalized.decisionComments
        .map((comment) => `- ${comment.action}: ${comment.body}`)
        .join('\n')
      await this.host.units['spec-lifecycle'].queuePendingInitialSpec({
        projectId,
        threadId,
        sessionId: thread.sessionId ?? '',
        source: [
          'Generate the engineering specification from this finalized Brainstorm. Read the Brainstorm document at the referenced path and incorporate every open annotation and finalize note.',
          `Brainstorm document: ${brainstormPath}`,
          `Open annotations:\n${formatOpenAnnotations(finalized.annotations)}`,
          finalizeNotes ? `Finalize notes:\n${finalizeNotes}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        settings: thread.settings,
        brainstorm: finalized,
        skipSubmittedRead: true
      })
      const generated = await this.host.units['spec-lifecycle'].runPendingInitialSpec(
        projectId,
        threadId
      )
      if (!generated) throw new Error(SPEC_GENERATION_FAILURE_USER_MESSAGE)
      return generated
    } catch (error) {
      this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, error)
      await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
        read: false,
        error: rawErrorMessage(error),
        errorDetail: rawErrorDetail(error)
      })
      throw error
    } finally {
      this.host.state.activeBrainstormOperations.delete(operationKey)
    }
  }

  async publishBrainstormReady(brainstorm: BrainstormDocument, sessionId?: string): Promise<void> {
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(
      brainstorm.projectId,
      brainstorm.threadId
    )
    const prdWorkflow = this.host.state.prdEngine.getWorkflowState(
      brainstorm.projectId,
      brainstorm.threadId
    )
    if (
      lifecycle?.activeStage === 'brainstorm' ||
      (lifecycle?.activeStage === 'prd' && prdWorkflow?.stage === 'brainstorming')
    ) {
      const prototypes = brainstorm.content.prototypes ?? []
      const needsPrototypeSelection =
        prototypes.some((prototype) => prototype.fidelity === 'lofi') &&
        !prototypes.some((prototype) => prototype.fidelity === 'hifi')
      this.host.state.engineeringLifecycleEngine.advance(
        brainstorm.projectId,
        brainstorm.threadId,
        {
          gate:
            lifecycle.activeStage === 'prd'
              ? 'brainstorm_finalization'
              : needsPrototypeSelection
                ? 'prototype_selection'
                : 'brainstorm_finalization'
        }
      )
    }
    await this.host.threadManager.setStatus(brainstorm.projectId, brainstorm.threadId, 'spec', {
      read: false
    })
    this.host.broadcast({
      type: 'brainstorm.ready',
      sessionId: sessionId ?? `brainstorm-${brainstorm.id}`,
      projectId: brainstorm.projectId,
      threadId: brainstorm.threadId,
      brainstormId: brainstorm.id,
      version: brainstorm.version
    })
  }

  async beginBrainstormConversationTurn(
    projectId: string,
    threadId: string,
    source: string,
    presentation?: UserMessagePresentation
  ): Promise<ActiveBrainstormConversationTurn> {
    const operationKey = `${projectId}:${threadId}`
    const digest = createHash('sha256')
      .update(`${operationKey}\n${source}`)
      .digest('hex')
      .slice(0, 24)
    const turnId = `brainstorm-research-${digest}`
    const startedAt = Date.now()
    const action = source.startsWith('Revise the complete Brainstorm')
      ? 'Review Brainstorm'
      : 'Start brainstorm'
    const userMessage: AgentMessage = {
      id: `${turnId}-user`,
      role: 'user',
      origin: 'user',
      visibility: 'conversation',
      parts: [
        {
          type: 'user-presentation',
          id: `${turnId}-user-presentation`,
          messageID: `${turnId}-user`,
          presentation: presentation ?? { action }
        }
      ],
      createdAt: startedAt
    }
    const initialPart: AgentPart = {
      type: 'text',
      id: `${turnId}-started`,
      messageID: `${turnId}-assistant`,
      text: 'Inspecting the project and researching evidence, constraints, options, and tradeoffs.',
      phase: 'commentary'
    }
    const assistantMessage: AgentMessage = {
      id: `${turnId}-assistant`,
      role: 'assistant',
      origin: 'assistant',
      visibility: 'conversation',
      parts: [initialPart],
      createdAt: startedAt + 1
    }
    const turn = { id: turnId, userMessage, parts: [initialPart], startedAt }
    this.host.state.activeBrainstormConversationTurns.set(operationKey, turn)
    await this.host.threadManager.upsertMessages(projectId, threadId, [
      userMessage,
      assistantMessage
    ])
    this.host.broadcast({
      type: 'brainstorm.trace',
      sessionId: operationKey,
      projectId,
      threadId,
      update: { type: 'started', messages: [userMessage, assistantMessage] }
    })
    return turn
  }

  async completeBrainstormConversationTurn(
    projectId: string,
    threadId: string,
    content: BrainstormContent,
    settings: ThreadSettings
  ): Promise<void> {
    const operationKey = `${projectId}:${threadId}`
    const turn = this.host.state.activeBrainstormConversationTurns.get(operationKey)
    if (!turn) return
    const proposedDirection = content.sections.find(
      (section) => section.id === 'proposed_direction'
    )?.markdown
    const finalText = [
      'The Brainstorm session report is ready.',
      content.summary.trim(),
      proposedDirection?.trim(),
      'The concise session direction, aligned decisions, boundaries, and remaining choices are ready for review.'
    ]
      .filter(Boolean)
      .join('\n\n')
    const assistantMessage: AgentMessage = {
      id: `${turn.id}-assistant`,
      role: 'assistant',
      origin: 'assistant',
      visibility: 'conversation',
      parts: [
        ...turn.parts,
        {
          type: 'text',
          id: `${turn.id}-final`,
          messageID: `${turn.id}-assistant`,
          text: finalText,
          phase: 'final_answer'
        }
      ],
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      createdAt: turn.startedAt + 1,
      completedAt: Date.now()
    }
    await this.host.threadManager.upsertMessages(projectId, threadId, [
      turn.userMessage,
      assistantMessage
    ])
    this.host.broadcast({
      type: 'brainstorm.trace',
      sessionId: operationKey,
      projectId,
      threadId,
      update: { type: 'completed', messages: [turn.userMessage, assistantMessage] }
    })
    this.host.state.activeBrainstormConversationTurns.delete(operationKey)
  }

  async failBrainstormConversationTurn(
    projectId: string,
    threadId: string,
    error: Error,
    settings: ThreadSettings
  ): Promise<void> {
    const operationKey = `${projectId}:${threadId}`
    const turn = this.host.state.activeBrainstormConversationTurns.get(operationKey)
    if (!turn) return
    const assistantMessage: AgentMessage = {
      id: `${turn.id}-assistant`,
      role: 'assistant',
      origin: 'assistant',
      visibility: 'conversation',
      parts: [
        ...turn.parts,
        {
          type: 'text',
          id: `${turn.id}-final`,
          messageID: `${turn.id}-assistant`,
          text: `The Brainstorm research could not be completed. ${error.message}`,
          phase: 'final_answer'
        }
      ],
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      createdAt: turn.startedAt + 1,
      completedAt: Date.now(),
      error: error.message
    }
    await this.host.threadManager.upsertMessages(projectId, threadId, [
      turn.userMessage,
      assistantMessage
    ])
    this.host.broadcast({
      type: 'brainstorm.trace',
      sessionId: operationKey,
      projectId,
      threadId,
      update: { type: 'completed', messages: [turn.userMessage, assistantMessage] }
    })
    this.host.state.activeBrainstormConversationTurns.delete(operationKey)
  }

  async brainstormSourceWithConversationContext(
    projectId: string,
    threadId: string,
    instructions: string
  ): Promise<string> {
    const messages = await this.host.threadManager.loadMessageRecords(projectId, threadId)
    const interviewDecisions = formatBrainstormInterviewDecisions(messages)
    const transcript = formatConversationTranscript(
      messages.filter((message) => !message.id.startsWith('brainstorm-research-')),
      { maxCharacters: 80_000 }
    )
    return [
      instructions,
      await this.host.units['brainstorm-review'].brainstormAlignmentContext(
        projectId,
        threadId,
        false
      ),
      interviewDecisions ? `Authoritative interview decisions:\n${interviewDecisions}` : '',
      transcript ? `Conversation context:\n${transcript}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /** Ephemeral Brainstorm generation cannot survive a main-process restart. */
  async recoverInterruptedBrainstormEntries(): Promise<void> {
    if (
      this.host.units['runtime-connectivity'].deferAutomaticResumeToLiveInstance(
        'interrupted Brainstorm entries'
      )
    )
      return
    try {
      const threads = await this.host.threadManager.listAllThreads()
      for (const thread of threads) {
        if (thread.status !== 'planning') continue
        const workflow = this.host.state.brainstormEngine.getWorkflowState(
          thread.projectId,
          thread.id
        )
        if (
          workflow?.entryChoice !== 'brainstorm' ||
          workflow.stage !== 'drafting' ||
          workflow.activeBrainstormId
        ) {
          continue
        }
        await this.host.threadManager.setStatus(thread.projectId, thread.id, 'failed', {
          read: false
        })
      }
    } catch (error) {
      Logger.error('Interrupted Brainstorm recovery failed:', error)
    }
  }

  async prepareRejectedBrainstormRepair(input: {
    projectId: string
    threadId: string
    attempt: number
    format: 'structured' | 'json'
    settings: ThreadSettings
    error: GeneratedBrainstormOutputError
  }): Promise<GeneratedBrainstormOutputError> {
    let artifactPath: string | undefined
    try {
      artifactPath = await this.persistRejectedBrainstormOutput(input)
    } catch (artifactError) {
      Logger.error('Rejected Brainstorm artifact persistence failed', {
        projectId: input.projectId,
        threadId: input.threadId,
        attempt: input.attempt,
        format: input.format,
        error: rawErrorMessage(artifactError)
      })
    }
    return new GeneratedBrainstormOutputError(
      input.error.diagnostic,
      input.error.rejectedOutput,
      artifactPath
    )
  }

  async persistRejectedBrainstormOutput(input: {
    projectId: string
    threadId: string
    attempt: number
    format: 'structured' | 'json'
    settings: ThreadSettings
    error: GeneratedBrainstormOutputError
  }): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.host.database, input.projectId, input.threadId)
    const relativePath = join(
      'err-brainstorm',
      `attempt-${Math.max(1, input.attempt)}-${input.format}.json`
    )
    const artifactPath = join(featureArtifactDirectory(featureSlug), relativePath).replace(
      /\\/gu,
      '/'
    )
    const artifact = {
      schemaVersion: 1,
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

  /** Expose isolated Brainstorm research activity without leaking its final JSON response. */
  forwardBrainstormTrace(owner: SessionInfo, event: AgentEvent): void {
    if (!owner.ephemeral || !('sessionId' in event) || event.type === 'brainstorm.trace') return
    const active = this.host.state.activeBrainstormSessions.get(
      `${owner.projectId}:${owner.threadId}`
    )
    if (active?.sessionId !== event.sessionId) return
    const turn = this.host.state.activeBrainstormConversationTurns.get(
      `${owner.projectId}:${owner.threadId}`
    )
    if (!turn) return

    if (event.type === 'message.part.updated') {
      const sourcePart = event.part
      if (sourcePart.type === 'text' && sourcePart.phase !== 'commentary') return
      if (!['reasoning', 'tool', 'subagent', 'step-finish', 'text'].includes(sourcePart.type))
        return
      const part: AgentPart = {
        ...sourcePart,
        id: `${event.sessionId}:${sourcePart.id}`,
        messageID: `${turn.id}-assistant`
      }
      const partIndex = turn.parts.findIndex((candidate) => candidate.id === part.id)
      turn.parts =
        partIndex === -1
          ? [...turn.parts, part]
          : turn.parts.map((candidate, index) => (index === partIndex ? part : candidate))
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: { type: 'part.updated', messageId: `${turn.id}-assistant`, part }
      })
      return
    }
    if (event.type === 'message.part.delta') {
      const partId = `${event.sessionId}:${event.partId}`
      turn.parts = turn.parts.map((part) =>
        part.id === partId ? appendPartDelta(part, event.field, event.delta) : part
      )
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: {
          type: 'part.delta',
          messageId: `${turn.id}-assistant`,
          partId,
          field: event.field,
          delta: event.delta
        }
      })
    }
  }
}
