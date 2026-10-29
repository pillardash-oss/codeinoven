import { join, resolve } from 'path'
import type { IsolatedSessionHandle } from '../../drivers/isolated-session'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import type {
  AgentMessage,
  PrdContent,
  PrdDocument,
  PromptAttachment,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { PRODUCT_REQUIREMENTS_DOCUMENT_TOOL_NAME } from '../../../lib/agent-tools'
import { PRD_DOCUMENT_JSON_SCHEMA, parseGeneratedPrdContent } from '../../../lib/prd/prd-validation'
import type { PendingPrdTurn } from './chat-engine-types'
import { GeneratedJsonParseError, rawErrorDetail, rawErrorMessage } from './chat-engine-errors'
import { withoutTransportParts } from './chat-engine-message-merge'
import {
  BRAINSTORM_GENERATION_TIMEOUT_MS,
  assertHarnessRequestCapabilities
} from './chat-engine-constants'
import { BRAINSTORM_RESEARCH_ALLOWED_TOOLS } from './chat-engine-prompts'
import { parseGeneratedJson } from './chat-engine-generated-artifacts'
import { pendingPrdTurnPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine prd: one concern, moved verbatim from the composition root. */
export class ChatEnginePrd {
  constructor(private readonly host: ChatEngine) {}

  /**
   * The one place a PRD draft is created from generated content, shared by the
   * isolated generator and the conversational PRD turn so provenance, the
   * Brainstorm link, and the finalization gate can never drift apart. A
   * submission while a draft is open revises it into the next version, so the
   * review conversation has somewhere to land instead of failing on the engine's
   * "not ready for a new draft" guard.
   */
  async createPrdDraftFromContent(input: {
    projectId: string
    threadId: string
    content: PrdContent
    harnessId?: string
    providerId?: string
    modelId?: string
  }): Promise<PrdDocument> {
    const finalizedBrainstorm = await this.host.state.brainstormEngine.getActive(
      input.projectId,
      input.threadId
    )
    const provenance = {
      source: 'agent' as const,
      actor: 'Sr. Engineer',
      ...(input.harnessId ? { harnessId: input.harnessId } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(finalizedBrainstorm?.status === 'finalized'
        ? {
            brainstormId: finalizedBrainstorm.id,
            brainstormVersion: finalizedBrainstorm.version,
            brainstormInputHash: finalizedBrainstorm.finalizedInputHash
          }
        : {})
    }
    const active = this.host.state.prdEngine.getActive(input.projectId, input.threadId)
    const created = active
      ? await this.host.state.prdEngine.createVersion(
          input.projectId,
          input.threadId,
          active.id,
          input.content,
          provenance
        )
      : await this.host.state.prdEngine.createDraft(
          input.projectId,
          input.threadId,
          input.content,
          provenance
        )
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(
      input.projectId,
      input.threadId
    )
    if (lifecycle?.activeStage === 'prd') {
      this.host.state.engineeringLifecycleEngine.advance(input.projectId, input.threadId, {
        gate: 'prd_finalization'
      })
    }
    return created
  }

  async generatePrd(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    instructions: string,
    attachments: PromptAttachment[],
    userMessageId: string
  ): Promise<PrdDocument> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    settings = validateThreadSettings(settings)
    instructions = validateBoundedString(instructions, 'PRD instructions', 1, 200_000)
    userMessageId = validateEntityId(userMessageId, 'Message ID', 256)
    const workflow = this.host.state.prdEngine.ensureWorkflow(projectId, threadId)
    if (workflow.stage === 'choice_pending') {
      throw new Error('Choose Brainstorm first or Start PRD before generating the PRD')
    }
    if (workflow.stage !== 'drafting') {
      throw new Error('The PRD workflow is not ready for generation')
    }
    const active = this.host.state.prdEngine.getActive(projectId, threadId)
    if (active) return active

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(projectId, driverId, threadId)
    assertHarnessRequestCapabilities(driver, attachments, settings.permissionLevel)
    const userMessage = await this.host.units['messages-write'].persistOutboundMessage(
      projectId,
      threadId,
      userMessageId,
      instructions,
      instructions,
      attachments,
      [],
      [],
      undefined,
      'user'
    )
    const assistantId = `${userMessageId}-prd`
    const startedAt = Date.now()
    const startedMessage: AgentMessage = {
      id: assistantId,
      role: 'assistant',
      origin: 'assistant',
      visibility: 'conversation',
      parts: [
        {
          type: 'text',
          id: `${assistantId}-started`,
          messageID: assistantId,
          text: 'Researching the product requirements and project constraints.',
          phase: 'commentary'
        }
      ],
      createdAt: startedAt
    }
    await this.host.threadManager.upsertMessages(projectId, threadId, [userMessage, startedMessage])
    this.host.broadcast({
      type: 'brainstorm.trace',
      sessionId: `${projectId}:${threadId}:prd`,
      projectId,
      threadId,
      update: { type: 'started', messages: [withoutTransportParts(userMessage), startedMessage] }
    })
    await this.host.threadManager.setStatus(projectId, threadId, 'planning')

    const source = await this.host.units['brainstorm'].brainstormSourceWithConversationContext(
      projectId,
      threadId,
      instructions
    )
    const finalizedBrainstorm = await this.host.state.brainstormEngine.getActive(
      projectId,
      threadId
    )
    const behaviorPrompt = await this.host.units['turns-dispatch'].getBehaviorPrompt(
      projectId,
      threadId,
      projectPath,
      'brainstorm',
      settings,
      'ephemeral'
    )
    const systemPrompt = [
      await this.host.units['turns-dispatch'].cioPrompt('prd-document'),
      `Submit the complete PRD through ${PRODUCT_REQUIREMENTS_DOCUMENT_TOOL_NAME}. Do not generate a specification or implementation.`,
      behaviorPrompt
    ].join('\n\n')
    const structured = driver.capabilities?.structuredOutput === true
    let sessionId = ''
    let isolated: IsolatedSessionHandle | undefined
    try {
      isolated = supportsIsolatedSessions(driver)
        ? await driver.createIsolatedSession(projectPath, `PRD ${new Date().toISOString()}`)
        : undefined
      sessionId =
        isolated?.sessionId ??
        (await driver.createSession(projectPath, `PRD ${new Date().toISOString()}`))
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        'auto_review',
        driverId,
        undefined,
        true
      )
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        BRAINSTORM_GENERATION_TIMEOUT_MS,
        'PRD generation'
      )
      const prompt: SendPromptOptions = {
        sessionId,
        settings: {
          ...settings,
          permissionLevel: 'auto_review',
          assignmentMode: false,
          loopMode: false
        },
        text: [
          source,
          finalizedBrainstorm?.status === 'finalized'
            ? `Use finalized Brainstorm ${finalizedBrainstorm.id} version ${finalizedBrainstorm.version} as product context.`
            : '',
          structured
            ? ''
            : `Return only JSON matching this schema: ${JSON.stringify(PRD_DOCUMENT_JSON_SCHEMA)}`
        ]
          .filter(Boolean)
          .join('\n\n'),
        attachments,
        systemPrompt,
        allowedTools: BRAINSTORM_RESEARCH_ALLOWED_TOOLS,
        readOnly: true,
        agent: leanAgentNameForMode('brainstorm'),
        ...(structured
          ? { structuredOutput: { schema: PRD_DOCUMENT_JSON_SCHEMA, retryCount: 2 } }
          : {})
      }
      if (isolated && supportsIsolatedSessions(driver)) {
        await driver.sendPrompt(projectPath, prompt, isolated)
      } else {
        await driver.sendPrompt(projectPath, prompt)
      }
      const streamed = await completion
      const generatedMessages =
        streamed === undefined
          ? isolated && supportsIsolatedSessions(driver)
            ? await driver.loadMessages(projectPath, sessionId, isolated)
            : await driver.loadMessages(projectPath, sessionId)
          : []
      const response = [...generatedMessages]
        .reverse()
        .find((message) => message.role === 'assistant')
      if (response?.error) throw new Error(response.error)
      const raw =
        streamed ??
        response?.structuredOutput ??
        parseGeneratedJson(
          response?.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n') ?? '',
          'The PRD agent returned invalid JSON'
        )
      const content: PrdContent = parseGeneratedPrdContent(raw)
      const created = await this.createPrdDraftFromContent({
        projectId,
        threadId,
        content,
        harnessId: settings.harnessId,
        providerId: settings.providerId,
        modelId: settings.modelId
      })
      const completedMessage: AgentMessage = {
        ...startedMessage,
        parts: [
          ...startedMessage.parts,
          {
            type: 'text',
            id: `${assistantId}-final`,
            messageID: assistantId,
            text: `The PRD “${created.content.title}” is ready for review and finalization.`,
            phase: 'final_answer'
          }
        ],
        harnessId: settings.harnessId,
        providerId: settings.providerId,
        modelId: settings.modelId,
        completedAt: Date.now()
      }
      await this.host.threadManager.upsertMessages(projectId, threadId, [completedMessage])
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: `${projectId}:${threadId}:prd`,
        projectId,
        threadId,
        update: {
          type: 'completed',
          messages: [withoutTransportParts(userMessage), completedMessage]
        }
      })
      // The PRD stage is done: park the thread on the user for review under the
      // engineering-specific `spec` status, never the generic needs-attention one.
      await this.host.threadManager.setStatus(projectId, threadId, 'spec', { read: false })
      return created
    } catch (error) {
      if (sessionId) {
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.abort(projectPath, sessionId, isolated).catch(() => undefined)
        } else {
          await driver.abort(projectPath, sessionId).catch(() => undefined)
        }
      }
      const message = error instanceof Error ? error.message : 'The PRD agent failed.'
      const failedMessage: AgentMessage = {
        ...startedMessage,
        parts: [
          ...startedMessage.parts,
          {
            type: 'text',
            id: `${assistantId}-failed`,
            messageID: assistantId,
            text: `The PRD could not be generated. ${message}`,
            phase: 'final_answer'
          }
        ],
        completedAt: Date.now(),
        error: message
      }
      await this.host.threadManager.upsertMessages(projectId, threadId, [failedMessage])
      this.host.broadcast({
        type: 'brainstorm.trace',
        sessionId: `${projectId}:${threadId}:prd`,
        projectId,
        threadId,
        update: {
          type: 'completed',
          messages: [withoutTransportParts(userMessage), failedMessage]
        }
      })
      this.host.units['turns'].markEngineeringLifecycleFailure(projectId, threadId, error)
      await this.host.threadManager.setStatus(projectId, threadId, 'failed', {
        read: false,
        error: rawErrorMessage(error),
        errorDetail: rawErrorDetail(error)
      })
      throw error
    } finally {
      if (sessionId) {
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
      }
      if (isolated && supportsIsolatedSessions(driver)) driver.disposeIsolatedSession(isolated)
    }
  }

  readPendingPrdTurn(projectId: string, threadId: string): Promise<PendingPrdTurn | null> {
    return this.host.storage.read<PendingPrdTurn>(pendingPrdTurnPath(projectId, threadId))
  }

  writePendingPrdTurn(pending: PendingPrdTurn): Promise<void> {
    return this.host.storage.write(pendingPrdTurnPath(pending.projectId, pending.threadId), pending)
  }

  clearPendingPrdTurn(projectId: string, threadId: string): Promise<void> {
    return this.host.storage.remove(pendingPrdTurnPath(projectId, threadId))
  }

  runPendingPrdTurn(
    sessionId: string,
    messages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<PrdDocument | null> {
    const existing = this.host.state.prdTurnTasks.get(sessionId)
    if (existing) return existing
    const task = this.persistPendingPrdTurn(sessionId, messages, scope)
    this.host.state.prdTurnTasks.set(sessionId, task)
    void task.then(
      () => {
        if (this.host.state.prdTurnTasks.get(sessionId) === task)
          this.host.state.prdTurnTasks.delete(sessionId)
      },
      () => {
        if (this.host.state.prdTurnTasks.get(sessionId) === task)
          this.host.state.prdTurnTasks.delete(sessionId)
      }
    )
    return task
  }

  /**
   * Capture a PRD the agent submitted inside its own conversational turn. A turn
   * that ends without a submission is the interview outcome, never a failure: the
   * agent asked the user product questions and the conversation continues.
   */
  async persistPendingPrdTurn(
    sessionId: string,
    loadedMessages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<PrdDocument | null> {
    const pending =
      this.host.state.pendingPrdTurns.get(sessionId) ??
      (scope ? await this.readPendingPrdTurn(scope.projectId, scope.threadId) : null)
    if (!pending || pending.sessionId !== sessionId) return null
    this.host.state.pendingPrdTurns.delete(sessionId)
    await this.clearPendingPrdTurn(pending.projectId, pending.threadId)

    // Re-derive the turn intent before touching anything. A record retained across
    // a question-tool turn is consumed by the next finalization for this session,
    // which may belong to a later stage once the PRD was finalized or cancelled,
    // and creating a document there would be wrong.
    const turnLifecycle = this.host.state.engineeringLifecycleEngine.get(
      pending.projectId,
      pending.threadId
    )
    if (turnLifecycle?.activeStage !== 'prd' && turnLifecycle?.humanGate !== 'prd_finalization') {
      return null
    }
    if (
      this.host.state.prdEngine.getWorkflowState(pending.projectId, pending.threadId)?.stage !==
      'drafting'
    ) {
      return null
    }

    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      pending.harnessId,
      this.host.sessionRegistry.get(sessionId)?.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${pending.harnessId}`)
    const projectPath =
      this.host.sessionRegistry.get(sessionId)?.projectPath ??
      (await this.host.resolveThreadPath(pending.projectId, pending.threadId))
    const messages = loadedMessages ?? (await driver.loadMessages(projectPath, sessionId))
    const response = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!response) return null
    if (response.error) throw new Error(response.error)
    const text = response.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    // No decodable JSON object in the answer is the interview outcome: the agent
    // asked its questions or narrated instead of submitting, so nothing is
    // captured and nothing failed. A decodable object that then fails PRD
    // validation is a rejected submission and throws below.
    let submitted: unknown
    if (response.structuredOutput === undefined) {
      try {
        submitted = parseGeneratedJson(text, 'The PRD agent returned invalid JSON')
      } catch (error) {
        if (error instanceof GeneratedJsonParseError) return null
        throw error
      }
    } else {
      submitted = response.structuredOutput
    }
    const content = parseGeneratedPrdContent(submitted)
    const created = await this.createPrdDraftFromContent({
      projectId: pending.projectId,
      threadId: pending.threadId,
      content,
      harnessId: pending.harnessId,
      providerId: pending.providerId,
      modelId: pending.modelId
    })
    this.host.broadcast({
      type: 'prd.ready',
      sessionId,
      projectId: pending.projectId,
      threadId: pending.threadId,
      prdId: created.id,
      version: created.version
    })
    return created
  }
}
