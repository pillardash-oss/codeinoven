import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { Logger } from '../../system/logger'
import {
  BRAINSTORM_CREATE_DOCUMENT_ANSWER,
  brainstormDocumentQuestion,
  isBrainstormDocumentQuestion
} from '../../../lib/brainstorm/brainstorm-alignment'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import { InactiveQuestionTurnError, QuestionRequestGoneError } from '../../drivers/driver.interface'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { utilitySuggestionResolution } from '../../../lib/utility-suggestion'
import type {
  AgentEvent,
  AgentMessage,
  AgentQuestionResolution,
  PendingAgentQuestionRequest,
  Thread
} from '../../../lib/types'
import type { PendingQuestionInfo } from './chat-engine-types'
import { QUESTION_ANSWER_MESSAGE_PREFIX } from './chat-engine-message-text'
import { DEFAULT_QUESTION_TIMEOUT_MS } from './chat-engine-constants'
import {
  assertQuestionIndex,
  recommendedQuestionAnswer,
  isSecretQuestion,
  validateQuestionAnswers
} from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine questions-ask: one concern, moved verbatim from the composition root. */
export class ChatEngineQuestionsAsk {
  constructor(private readonly host: ChatEngine) {}

  /** Answer a pending question from the agent. */
  async answerQuestion(
    projectId: string,
    threadId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const ovenThread = await this.host.threadManager.getThread(projectId, threadId)
    if (ovenThread && this.host.state.ovenChat.remote(ovenThread)) {
      await this.host.state.ovenChat.answer(ovenThread, requestId, answers)
      return
    }

    requestId = validateEntityId(requestId, 'Question request ID', 256)
    const pending = this.host.units['questions'].requirePendingQuestion(
      projectId,
      threadId,
      requestId
    )
    const safeAnswers = validateQuestionAnswers(answers, pending.request.questions)
    // An agent-proposed capability is an app-owned request with no harness behind
    // it: the user's choice settles the waiting gateway call here, and only the
    // gateway installs, and only on acceptance.
    if (pending.settleUtilitySuggestion) {
      pending.resumeUtilitySuggestionAfterSettlement = true
      await this.persistQuestionAnswer(pending, safeAnswers)
      // The user's own words are carried through, not flattened into a "no": a
      // reply that names a different server is an instruction, not a decline.
      const resolution = utilitySuggestionResolution(safeAnswers[0] ?? [])
      await this.host.units['questions'].resolvePendingQuestion(
        pending,
        'answered',
        safeAnswers,
        async () => {
          pending.settleUtilitySuggestion?.(resolution)
        }
      )
      return
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      pending.driverId,
      this.host.sessionRegistry.get(pending.request.sessionId)?.accountId
    )
    if (!driver) {
      throw new Error(`Harness driver is unavailable: ${pending.driverId}`)
    }
    await this.persistQuestionAnswer(pending, safeAnswers)
    const approvalIndex = pending.request.questions.findIndex((question) =>
      isBrainstormDocumentQuestion(question.prompt)
    )
    if (approvalIndex >= 0) {
      const workflow = this.host.state.brainstormEngine.getWorkflowState(projectId, threadId)
      if (workflow?.entryChoice === 'brainstorm' && workflow.stage === 'drafting') {
        const round = await this.host.units['brainstorm-review'].brainstormAlignmentRound(
          projectId,
          threadId
        )
        const question = pending.request.questions[approvalIndex]
        const answer = safeAnswers[approvalIndex]?.[0]?.trim()
        if (
          pending.request.questions.length === 1 &&
          question?.prompt === brainstormDocumentQuestion(round.version) &&
          safeAnswers[approvalIndex]?.length === 1 &&
          (answer === BRAINSTORM_CREATE_DOCUMENT_ANSWER ||
            /^(?:yes|create document|yes, create (?:the )?document)[.!]?$/iu.test(answer ?? ''))
        ) {
          await this.host.state.brainstormAlignmentNotes.approve(round, requestId)
        } else {
          await this.host.state.brainstormAlignmentNotes.clearApproval(round)
        }
      }
    }
    try {
      await this.host.units['questions'].resolvePendingQuestion(
        pending,
        'answered',
        safeAnswers,
        () =>
          driver.replyToQuestion(
            pending.projectPath,
            pending.request.sessionId,
            requestId,
            safeAnswers
          )
      )
    } catch (error) {
      if (
        await this.reconcileUnanswerableQuestion(pending, 'answered', safeAnswers, error, driver)
      ) {
        return
      }
      throw error
    }
  }

  /**
   * Keep the user's exact question answers in the app-owned transcript instead
   * of relying on each harness to serialize its native question tool result.
   * The stable id makes retries idempotent.
   */
  async persistQuestionAnswer(pending: PendingQuestionInfo, answers: string[][]): Promise<void> {
    const decisions = pending.request.questions.map((question, index) => ({
      question: question.prompt,
      answers: answers[index] ?? []
    }))
    const digest = createHash('sha256')
      .update(
        [
          pending.request.projectId,
          pending.request.threadId,
          pending.request.sessionId,
          pending.request.requestId
        ].join('\n')
      )
      .digest('hex')
      .slice(0, 24)
    const messageId = `${QUESTION_ANSWER_MESSAGE_PREFIX}${digest}`
    const body = decisions
      .map(
        (decision, index) =>
          `${index + 1}. ${decision.question}\n${decision.answers.map((answer) => `   - ${answer}`).join('\n')}`
      )
      .join('\n')
    const transportText = [
      '[Authoritative agent question answer]',
      'The user explicitly submitted these answers. Preserve custom text exactly and treat each answered question as resolved unless a later user message changes it.',
      JSON.stringify(decisions)
    ].join('\n')
    const createdAt = Date.now()
    const message: AgentMessage = {
      id: messageId,
      role: 'user',
      origin: 'user',
      visibility: 'conversation',
      parts: [
        {
          type: 'user-presentation',
          id: `${messageId}-presentation`,
          messageID: messageId,
          presentation: { action: 'Answered agent question', body }
        }
      ],
      transportParts: [
        {
          type: 'text',
          id: `${messageId}-transport-text`,
          messageID: messageId,
          text: transportText
        }
      ],
      transportOrigin: 'user',
      createdAt,
      completedAt: createdAt
    }
    await this.host.threadManager.upsertMessages(
      pending.request.projectId,
      pending.request.threadId,
      [message],
      pending.request.sessionId
    )
  }

  /** Reject a pending question and let the provider continue the active turn. */
  async dismissQuestion(projectId: string, threadId: string, requestId: string): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const ovenThread = await this.host.threadManager.getThread(projectId, threadId)
    if (ovenThread && this.host.state.ovenChat.remote(ovenThread)) {
      await this.host.state.ovenChat.answer(ovenThread, requestId, null)
      return
    }

    requestId = validateEntityId(requestId, 'Question request ID', 256)
    const pending = this.host.pendingQuestions.get(requestId)
    if (
      !pending ||
      pending.request.projectId !== projectId ||
      pending.request.threadId !== threadId ||
      pending.resolving
    ) {
      // Discarding must always work: the request was auto-answered, answered in
      // another view, or its session was retired, so the question (or secret)
      // card only has to close. Never answer a dead card with an error.
      Logger.dev(`Ignoring dismissal of settled question request: ${requestId}`)
      return
    }
    if (pending.request.questions.some(isSecretQuestion)) {
      // An app-owned secret card has no harness side to reject: settle the
      // waiting tool call so the agent continues without the value.
      pending.resumeSecretAfterSettlement = true
      await this.host.units['questions'].resolvePendingQuestion(
        pending,
        'dismissed',
        undefined,
        async () => {
          pending.settleSecret?.({ status: 'dismissed', secrets: [] })
        }
      )
      return
    }
    if (pending.settleUtilitySuggestion) {
      // A capability suggestion is app-owned too: the request id is the app's,
      // never one the harness issued, so rejecting it through the driver only
      // produces a "request is gone" error (and, on some harnesses, a failed
      // discard in the UI). Settle the waiting tool call as a decline instead.
      pending.resumeUtilitySuggestionAfterSettlement = true
      await this.host.units['questions'].resolvePendingQuestion(
        pending,
        'dismissed',
        undefined,
        async () => {
          pending.settleUtilitySuggestion?.({ decision: 'declined' })
        }
      )
      return
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      pending.driverId,
      this.host.sessionRegistry.get(pending.request.sessionId)?.accountId
    )
    if (!driver) {
      throw new Error(`Harness driver is unavailable: ${pending.driverId}`)
    }
    if (
      pending.request.questions.some((question) => isBrainstormDocumentQuestion(question.prompt))
    ) {
      await this.host.state.brainstormAlignmentNotes.clearApproval(
        await this.host.units['brainstorm-review'].brainstormAlignmentRound(projectId, threadId)
      )
    }
    try {
      await this.host.units['questions'].resolvePendingQuestion(
        pending,
        'dismissed',
        undefined,
        () => driver.rejectQuestion(pending.projectPath, pending.request.sessionId, requestId)
      )
    } catch (error) {
      if (
        await this.reconcileUnanswerableQuestion(pending, 'dismissed', undefined, error, driver)
      ) {
        return
      }
      throw error
    }
  }

  /**
   * Settle a question the harness can no longer accept. Both outcomes mean the
   * card on screen is stale, so neither may reach the renderer as a failure:
   * `QuestionRequestGoneError` (the harness already dropped the request, for
   * example because the process holding it exited) closes it in place, and
   * `InactiveQuestionTurnError` (the owning turn process exited) resumes the
   * session with the user's decision instead of losing it. A dropped request is
   * only closed in place while its driver can still prove a live turn holds the
   * reply: when it cannot, the answer has nowhere to go, so the persisted
   * session is resumed with the decision rather than left idle on a card that
   * can never reach the agent.
   *
   * Returns false for an unrelated error, which the caller keeps propagating.
   */
  async reconcileUnanswerableQuestion(
    pending: PendingQuestionInfo,
    resolution: Extract<AgentQuestionResolution, 'answered' | 'dismissed' | 'timed_out'>,
    answers: string[][] | undefined,
    error: unknown,
    driver: HarnessDriver
  ): Promise<boolean> {
    if (error instanceof InactiveQuestionTurnError) {
      await this.host.units['questions'].resumeAfterInactiveQuestion(pending, resolution, answers)
      return true
    }
    if (error instanceof QuestionRequestGoneError) {
      if (!this.questionAnswerCanReachLiveTurn(pending, driver)) {
        await this.host.units['questions'].resumeAfterInactiveQuestion(pending, resolution, answers)
        return true
      }
      this.host.units['questions'].finalizePendingQuestion(
        pending.request.requestId,
        resolution,
        answers
      )
      return true
    }
    return false
  }

  /**
   * Whether an answer to a pending question can still reach a live turn. A
   * driver that can prove it has no registered turn (codex, pi) means the reply
   * would be written into a closed conversation; drivers without the probe are
   * assumed to still hold one, preserving the existing finalize behavior.
   */
  questionAnswerCanReachLiveTurn(pending: PendingQuestionInfo, driver: HarnessDriver): boolean {
    return driver.hasActiveTurn ? driver.hasActiveTurn(pending.request.sessionId) : true
  }

  /** Merge provider-held questions into the authoritative pending-question queue. */
  async listQuestions(projectId: string, threadId: string): Promise<PendingAgentQuestionRequest[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const ovenThread = await this.host.threadManager.getThread(projectId, threadId)
    if (ovenThread && this.host.state.ovenChat.remote(ovenThread))
      return this.host.state.ovenChat.questions(ovenThread)

    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.sessionId) return []
    // Pending provider questions belong to the thread's bound session, which
    // after a mid-run harness switch is owned by the original harness even
    // when settings point at a new one.
    const driverId =
      thread.sessionHarnessId ??
      this.host.sessionRegistry.get(thread.sessionId)?.driverId ??
      thread.settings?.harnessId ??
      DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      thread.sessionAccountId ?? this.host.sessionRegistry.get(thread.sessionId)?.accountId
    )
    const providerRequests = await driver.listPendingQuestions(projectPath)
    const timeoutMs = (await this.host.storage.getConfig()).questionTimeoutMs
    for (const request of providerRequests) {
      if (request.sessionId !== thread.sessionId) continue
      const pending = this.host.registerPendingQuestion(
        driverId,
        projectId,
        threadId,
        projectPath,
        request,
        timeoutMs
      )
      if (
        (await this.host.units['runtime-workflows'].achievementOwnsDecisions(thread)) &&
        !pending.resolving
      ) {
        const answers = request.questions.map((question) => [recommendedQuestionAnswer(question)])
        try {
          await this.host.units['questions'].resolvePendingQuestion(
            pending,
            'answered',
            answers,
            () => driver.replyToQuestion(projectPath, request.sessionId, request.requestId, answers)
          )
        } catch (error) {
          // One question the harness can no longer accept must never fail the
          // whole pending-question list: settle it when it is simply gone, and
          // otherwise keep the card and let the next poll retry.
          if (
            !(await this.reconcileUnanswerableQuestion(pending, 'answered', answers, error, driver))
          ) {
            Logger.error('Provider question auto-answer failed:', error)
          }
        }
      }
    }
    return [...this.host.pendingQuestions.values()]
      .map((pending) => pending.request)
      .filter((request) => request.projectId === projectId && request.threadId === threadId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Persist the draft progress of one pending question card.
   *
   * A draft save is best-effort, so it must never surface as a failure: clicking
   * an option, navigating between questions, the custom-answer debounce, and the
   * card's own unmount flush all race with the request being answered, dismissed,
   * auto-answered, or retired with its session. When the request is already gone
   * this answers `null`, which tells the renderer to close the stale card instead
   * of reporting an error for a card nobody can answer any more.
   */
  async updateQuestion(
    projectId: string,
    threadId: string,
    requestId: string,
    questionIndex: number,
    answers: string[],
    nextQuestionIndex?: number
  ): Promise<PendingAgentQuestionRequest | null> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    requestId = validateEntityId(requestId, 'Question request ID', 256)
    const pending = this.host.units['questions'].pendingQuestionForThread(
      projectId,
      threadId,
      requestId
    )
    if (!pending) {
      Logger.dev(`Ignoring progress update for settled question request: ${requestId}`)
      return null
    }
    assertQuestionIndex(questionIndex, pending.request.questions.length)
    if (!Array.isArray(answers)) {
      throw new TypeError('Question answers must be an array')
    }
    if (nextQuestionIndex !== undefined) {
      assertQuestionIndex(nextQuestionIndex, pending.request.questions.length)
    }

    const question = pending.request.questions[questionIndex]
    const safeAnswers = answers.map((answer) =>
      validateBoundedString(answer, `Question answer ${questionIndex + 1}`, 1, 10_000)
    )
    if (!question?.multiple && safeAnswers.length > 1) {
      throw new TypeError(`Question answer ${questionIndex + 1} allows exactly one selection`)
    }

    // A resolution is already in flight (the user's own answer, a dismissal, or
    // the inactivity timer), so the decision is captured and this late save only
    // has to report the state the main process still holds. It must not rewrite
    // the request: a resolution that fails is restored and its card stays up, and
    // the card's own selection must survive that.
    if (pending.resolving) return structuredClone(pending.request)

    pending.request.answers = pending.request.answers.map((answer, index) =>
      index === questionIndex ? safeAnswers : answer
    )
    if (!pending.request.interactedQuestionIndexes.includes(questionIndex)) {
      pending.request.interactedQuestionIndexes = [
        ...pending.request.interactedQuestionIndexes,
        questionIndex
      ]
    }
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }
    pending.request.expiresAt = undefined

    if (nextQuestionIndex !== undefined) {
      pending.request.activeQuestionIndex = nextQuestionIndex
      if (!pending.request.interactedQuestionIndexes.includes(nextQuestionIndex)) {
        pending.request.expiresAt = Date.now() + pending.timeoutMs
        this.host.units['questions'].schedulePendingQuestion(pending)
      }
    } else if (pending.request.questions.some(isSecretQuestion)) {
      // A secret card the user is filling in stays paused, and re-scheduling is
      // what holds that pause (and what gives the card a full window back once
      // the user stops interacting). Without it a cleared deadline would sit
      // there until the next unrelated activity turned it into a fresh
      // countdown, under a card that still says it is paused.
      this.host.units['questions'].schedulePendingQuestion(pending)
    }
    return structuredClone(pending.request)
  }

  async handleQuestionAsked(
    driverId: string,
    event: Extract<AgentEvent, { type: 'question.asked' }>
  ): Promise<void> {
    const session = this.host.sessionRegistry.get(event.sessionId)
    if (!session || event.questions.length === 0 || !event.requestId) return
    const pending = this.host.registerPendingQuestion(
      driverId,
      session.projectId,
      session.threadId,
      session.projectPath,
      {
        requestId: event.requestId,
        sessionId: event.sessionId,
        questions: event.questions,
        tool: event.tool
      },
      DEFAULT_QUESTION_TIMEOUT_MS
    )
    const thread = await this.host.threadManager.getThread(session.projectId, session.threadId)
    if (
      !event.questions.some(
        (question) => isBrainstormDocumentQuestion(question.prompt) || isSecretQuestion(question)
      ) &&
      (await this.host.units['runtime-workflows'].achievementOwnsDecisions(thread ?? null))
    ) {
      const driver = this.host.units['turns-dispatch'].driverForRuntime(driverId, session.accountId)
      if (!driver) return
      const answers = event.questions.map((question) => [recommendedQuestionAnswer(question)])
      try {
        await this.host.units['questions'].resolvePendingQuestion(
          pending,
          'answered',
          answers,
          () =>
            driver.replyToQuestion(session.projectPath, event.sessionId, event.requestId, answers)
        )
      } catch (error) {
        if (
          !(await this.reconcileUnanswerableQuestion(pending, 'answered', answers, error, driver))
        ) {
          throw error
        }
      }
      return
    }
    const timeoutMs = (await this.host.storage.getConfig()).questionTimeoutMs
    if (this.host.pendingQuestions.get(event.requestId) !== pending) return
    pending.timeoutMs = timeoutMs
    pending.request.expiresAt = pending.request.createdAt + timeoutMs
    this.host.units['questions'].schedulePendingQuestion(pending)
    // A temporary side chat (including a global browser's agent sidebar) owns no
    // status of its own: its parent thread must not be marked as awaiting input
    // for a question the side chat asked.
    if (!session.ephemeral) {
      await this.host.threadManager.setStatus(
        session.projectId,
        session.threadId,
        'awaiting_approval',
        {
          read: false
        }
      )
    }
    this.host.broadcast(event)
  }

  /**
   * Whether the capability can actually answer a question right now.
   *
   * Only the memory gate needs this. That gate decides whether the deterministic
   * pattern list is what judges durability, and widening it while the capability
   * cannot answer would send turns the patterns rejected to the cheap-model chain
   * instead, spending more than the code did before TypeSafe existed. A missing
   * key and an open breaker therefore both read as "cannot answer".
   */
  async typesafeCanAnswer(): Promise<boolean> {
    const capabilities = this.host.state.typesafeDecision
    if (!capabilities) return false
    const now = Date.now()
    const cached = this.host.state.typesafeAnswerable
    if (cached && now - cached.checkedAt < ChatEngine.TYPESAFE_ANSWERABLE_TTL_MS) {
      return cached.value
    }
    let value = false
    try {
      const status = await capabilities.getStatus()
      // `unverified` is the ordinary state before the first call has succeeded,
      // so it counts: a key is present and nothing has failed yet.
      value =
        status.hasKey && (status.availability === 'ready' || status.availability === 'unverified')
    } catch (error) {
      Logger.dev('TypeSafe availability could not be read:', error)
    }
    this.host.state.typesafeAnswerable = { value, checkedAt: now }
    return value
  }
}
