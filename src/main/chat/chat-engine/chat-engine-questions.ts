import { Logger } from '../../system/logger'
import { isBrainstormDocumentQuestion } from '../../../lib/brainstorm/brainstorm-alignment'
import { InactiveQuestionTurnError, QuestionRequestGoneError } from '../../drivers/driver.interface'
import type { TypesafeDecisionService } from '../../typesafe/typesafe-decision-service'
import type { TypesafeDecisionStatus } from '../../../lib/types/typesafe'
import { isUtilitySuggestionQuestion } from '../../../lib/utility-suggestion'
import type { AgentQuestionRequest, AgentQuestionResolution } from '../../../lib/types'
import type { PendingQuestionInfo, RankingGradeCandidate } from './chat-engine-types'
import {
  inactiveQuestionDecision,
  recommendedQuestionAnswer,
  isSecretQuestion
} from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine questions: one concern, moved verbatim from the composition root. */
export class ChatEngineQuestions {
  constructor(private readonly host: ChatEngine) {}

  /** Resume a persisted session when its provider process exited while waiting for a question. */
  async resumeAfterInactiveQuestion(
    pending: PendingQuestionInfo,
    resolution: Extract<AgentQuestionResolution, 'answered' | 'dismissed' | 'timed_out'>,
    answers?: string[][]
  ): Promise<void> {
    await this.host.units['turns-sessions'].awaitInactiveResumeIdleFinalization(pending)
    await this.resolvePendingQuestion(pending, resolution, answers, async () => undefined)
    // The answer starts a new turn, so the turn that asked the question can
    // never resume and its checkpoint would stay active forever. Settle it
    // here, while the workspace still reflects that turn, so its file changes
    // land on their own card instead of vanishing.
    await this.settleUnresumableQuestionTurn(pending.request.sessionId).catch((error: unknown) =>
      Logger.error('Question turn settlement failed:', error)
    )

    const thread = await this.host.threadManager.getThread(
      pending.request.projectId,
      pending.request.threadId
    )
    if (!thread?.settings) {
      throw new Error(`Thread settings are unavailable: ${pending.request.threadId}`)
    }
    const decision = inactiveQuestionDecision(
      pending.request.questions,
      resolution === 'timed_out' ? 'answered' : resolution,
      answers
    )
    await this.host.sendPrompt(
      pending.request.projectId,
      pending.request.threadId,
      thread.settings,
      decision.prompt,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      // An answered question already persisted its own visible record
      // (`persistQuestionAnswer`), so the resume turn stays hidden rather than
      // duplicating the "Answered agent question" bubble. A dismissal has no
      // such record, so its presentation still has to render.
      resolution === 'answered' ? undefined : decision.presentation
    )
  }

  /**
   * Finalize the checkpoint of a turn whose question answer cannot reach it.
   *
   * A turn that ends on a question skips checkpoint finalization on purpose, so
   * the answer can continue the same native turn under the same checkpoint.
   * When the answer cannot reach that turn, the engine sends a new turn instead,
   * which starts a new checkpoint and replaces the thread's `active_turns` row.
   * Nothing then points at the old checkpoint: the renderer skips `active`
   * rows, restart recovery walks the ledger, and the late-claim reopen only
   * accepts terminal checkpoints, so the turn's file changes disappeared with
   * no card, no diff, and no undo.
   */
  async settleUnresumableQuestionTurn(sessionId: string): Promise<void> {
    const session = this.host.sessionRegistry.get(sessionId)
    if (!session?.activeTurnId) return
    this.host.reassertTurnToolEvidence(
      session,
      await this.host.units['speech'].turnTranscriptMessages(session)
    )
    await this.host.units['transcripts'].finishCheckpoint(sessionId, session, 'completed')
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  /**
   * Resolve a pending question that this thread still owns, or `null` when the
   * request has already settled. Operations that must be idempotent (a late
   * draft save, a dismissal of a card that was auto-answered elsewhere) use this
   * tolerant lookup, because the renderer's reply and the request's own
   * resolution travel independently and either order is valid. A request that
   * belongs to another project or thread is a caller bug and stays an error.
   */
  pendingQuestionForThread(
    projectId: string,
    threadId: string,
    requestId: string
  ): PendingQuestionInfo | null {
    const pending = this.host.pendingQuestions.get(requestId)
    if (!pending) return null
    if (pending.request.projectId !== projectId || pending.request.threadId !== threadId) {
      throw new Error(`Question request does not belong to this thread: ${requestId}`)
    }
    return pending
  }

  requirePendingQuestion(
    projectId: string,
    threadId: string,
    requestId: string
  ): PendingQuestionInfo {
    const pending = this.pendingQuestionForThread(projectId, threadId, requestId)
    if (!pending) {
      throw new Error(`Question request is no longer pending: ${requestId}`)
    }
    if (pending.resolving) {
      throw new Error(`Question request is already being resolved: ${requestId}`)
    }
    return pending
  }

  registerPendingQuestion(
    driverId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    request: AgentQuestionRequest,
    timeoutMs: number
  ): PendingQuestionInfo {
    const existing = this.host.pendingQuestions.get(request.requestId)
    if (existing) return existing
    const createdAt = Date.now()
    const session = this.host.sessionRegistry.get(request.sessionId)
    const pending: PendingQuestionInfo = {
      request: {
        ...request,
        projectId,
        threadId,
        createdAt,
        activeQuestionIndex: 0,
        answers: request.questions.map(() => []),
        interactedQuestionIndexes: [],
        expiresAt: createdAt + timeoutMs
      },
      driverId,
      projectPath,
      timeoutMs,
      resolving: false,
      resumeStatus: session?.activeTurnId ? 'executing' : 'planning'
    }
    this.host.pendingQuestions.set(request.requestId, pending)
    this.schedulePendingQuestion(pending)
    this.host.units['turns'].markProjectActive(projectId)
    return pending
  }

  /**
   * The configured human-decision timer, shared by questions and secret
   * requests. Read per request so a Settings change applies to the next card
   * rather than only after a restart.
   */
  async pendingQuestionTimeoutMs(): Promise<number> {
    const config = await this.host.storage.getConfig()
    return config.questionTimeoutMs
  }

  /**
   * Close an abandoned capability-suggestion card and settle the gateway call
   * waiting on it as a decline. Nothing installs without the user, so an expired
   * card is a "no" the agent can react to, never a silent install.
   */
  expireUtilitySuggestionQuestion(pending: PendingQuestionInfo): void {
    if (this.host.pendingQuestions.get(pending.request.requestId) !== pending) return
    pending.timer = undefined
    pending.resumeUtilitySuggestionAfterSettlement = true
    pending.settleUtilitySuggestion?.({ decision: 'declined' })
    this.finalizePendingQuestion(pending.request.requestId, 'timed_out')
  }

  schedulePendingQuestion(pending: PendingQuestionInfo): void {
    if (pending.timer) clearTimeout(pending.timer)
    // Creating a Brainstorm version is a human decision with no safe default at
    // all, so that card never expires. A secret request does run on the timer:
    // nothing can invent a value the user never supplied, but an abandoned card
    // must still close so the waiting tool call is settled.
    if (
      pending.request.questions.some((question) => isBrainstormDocumentQuestion(question.prompt))
    ) {
      pending.timer = undefined
      pending.request.expiresAt = undefined
      return
    }

    // A secret request runs an absolute countdown from the moment its card
    // appeared. It deliberately skips the activity pause that questions use:
    // the user usually steps away from the app to obtain the value, and a card
    // that only counted down while they were elsewhere would expire exactly
    // when they are fetching it. Nothing can invent a secret, so the deadline
    // closes the card rather than answering it.
    if (pending.request.questions.some(isSecretQuestion)) {
      // A card the user has started filling in is paused instead: the value they
      // are pasting is never cut off, and no deadline runs under their hands.
      // The pause lasts while they are interacting with the app; once they are
      // not, the card gets a full window again so an abandoned request still
      // closes and settles the tool call waiting on it.
      if (pending.request.interactedQuestionIndexes.length > 0) {
        pending.request.expiresAt = undefined
        if (this.host.units['turns'].isUserActive()) {
          pending.timer = setTimeout(
            () => this.schedulePendingQuestion(pending),
            ChatEngine.INACTIVITY_CHECK_INTERVAL_MS
          )
          return
        }
      }
      const secretExpiresAt = pending.request.expiresAt ?? Date.now() + pending.timeoutMs
      pending.request.expiresAt = secretExpiresAt
      pending.timer = setTimeout(
        () => this.host.units['questions-secrets'].expireSecretQuestion(pending),
        Math.max(0, secretExpiresAt - Date.now())
      )
      return
    }

    // A capability suggestion runs the same absolute countdown, but an expired
    // card settles as a decline: installing software is never automatic.
    if (pending.request.questions.some(isUtilitySuggestionQuestion)) {
      if (pending.request.interactedQuestionIndexes.length > 0) {
        pending.request.expiresAt = undefined
        if (this.host.units['turns'].isUserActive()) {
          pending.timer = setTimeout(
            () => this.schedulePendingQuestion(pending),
            ChatEngine.INACTIVITY_CHECK_INTERVAL_MS
          )
          return
        }
      }
      const suggestionExpiresAt = pending.request.expiresAt ?? Date.now() + pending.timeoutMs
      pending.request.expiresAt = suggestionExpiresAt
      pending.timer = setTimeout(
        () => this.expireUtilitySuggestionQuestion(pending),
        Math.max(0, suggestionExpiresAt - Date.now())
      )
      return
    }

    // The activity pause is a real hold, exactly as it is on a secret card: while
    // the user is active anywhere in the app the countdown stops outright, so a
    // card can never be answered under someone who is still typing their answer
    // (in this card, or in another thread). Once the user stops working, the card
    // gets a full window of its own rather than an absolute deadline from when it
    // appeared, so an abandoned request still closes and settles the turn it
    // blocks without ever cutting off the person answering it.
    if (this.host.units['turns'].isUserActive()) {
      pending.request.expiresAt = undefined
      pending.timer = setTimeout(
        () => this.schedulePendingQuestion(pending),
        ChatEngine.INACTIVITY_CHECK_INTERVAL_MS
      )
      return
    }

    const expiresAt = pending.request.expiresAt
    if (expiresAt === undefined) {
      pending.request.expiresAt = Date.now() + pending.timeoutMs
      this.schedulePendingQuestion(pending)
      return
    }

    const delay = Math.max(0, expiresAt - Date.now())
    pending.timer = setTimeout(() => {
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        pending.driverId,
        this.host.sessionRegistry.get(pending.request.sessionId)?.accountId
      )
      if (!driver || !this.host.pendingQuestions.has(pending.request.requestId)) {
        return
      }

      // The user started working again while this window ran: hold the card
      // instead of answering a question under their hands.
      if (this.host.units['turns'].isUserActive()) {
        pending.request.expiresAt = undefined
        pending.timer = setTimeout(
          () => this.schedulePendingQuestion(pending),
          ChatEngine.INACTIVITY_CHECK_INTERVAL_MS
        )
        return
      }

      const currentIndex = pending.request.activeQuestionIndex
      const question = pending.request.questions[currentIndex]
      if (!question) return
      pending.timer = undefined
      pending.request.answers[currentIndex] = [recommendedQuestionAnswer(question)]

      const nextIndex = pending.request.answers.findIndex(
        (answer, index) => index !== currentIndex && answer.length === 0
      )
      if (nextIndex >= 0) {
        pending.request.activeQuestionIndex = nextIndex
        pending.request.expiresAt = pending.request.interactedQuestionIndexes.includes(nextIndex)
          ? undefined
          : Date.now() + pending.timeoutMs
        this.schedulePendingQuestion(pending)
        this.host.broadcast({
          type: 'question.updated',
          sessionId: pending.request.sessionId,
          requestId: pending.request.requestId
        })
        return
      }

      const answers = pending.request.answers.map((answer) => [...answer])
      pending.request.expiresAt = undefined
      // The timer is answering for the user, so record exactly what was asked,
      // what was offered and what was chosen before the reply travels.
      this.host.units['misc'].reportAutoAnswer({
        id: pending.request.requestId,
        kind: 'question',
        outcome: 'auto-answered',
        projectId: pending.request.projectId,
        threadId: pending.request.threadId,
        entries: this.host.units['misc'].autoAnswerEntries(pending.request.questions, answers),
        at: Date.now()
      })
      void this.resolvePendingQuestion(pending, 'timed_out', answers, () =>
        driver.replyToQuestion(
          pending.projectPath,
          pending.request.sessionId,
          pending.request.requestId,
          answers
        )
      ).catch((error) => {
        if (
          error instanceof InactiveQuestionTurnError ||
          error instanceof QuestionRequestGoneError
        ) {
          if (pending.timer) clearTimeout(pending.timer)
          pending.timer = undefined
        }
        void this.host.units['questions-ask']
          .reconcileUnanswerableQuestion(pending, 'timed_out', answers, error, driver)
          .then((handled) => {
            if (!handled) Logger.error('Automatic question resolution failed:', error)
          })
          .catch((recoveryError: unknown) => {
            Logger.error('Automatic question recovery failed:', recoveryError)
          })
      })
    }, delay)
  }

  async resolvePendingQuestion(
    pending: PendingQuestionInfo,
    resolution: AgentQuestionResolution,
    answers: string[][] | undefined,
    providerAction: () => Promise<void>
  ): Promise<void> {
    if (
      pending.resolving ||
      this.host.pendingQuestions.get(pending.request.requestId) !== pending
    ) {
      throw new Error(`Question request is no longer pending: ${pending.request.requestId}`)
    }
    pending.resolving = true
    pending.resolution = resolution
    pending.answers = answers
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }
    try {
      await providerAction()
      this.finalizePendingQuestion(pending.request.requestId, resolution, answers)
    } catch (error) {
      pending.resolving = false
      pending.resolution = undefined
      pending.answers = undefined
      pending.request.expiresAt = Math.max(pending.request.expiresAt ?? 0, Date.now() + 10_000)
      this.schedulePendingQuestion(pending)
      throw error
    }
  }

  finalizePendingQuestion(
    requestId: string,
    resolution: AgentQuestionResolution,
    answers?: string[][]
  ): boolean {
    const pending = this.host.pendingQuestions.get(requestId)
    if (!pending) return false
    const finalResolution = pending.resolution ?? resolution
    const finalAnswers = pending.answers ?? answers
    this.clearPendingQuestion(requestId)
    void this.host.threadManager
      .setStatus(pending.request.projectId, pending.request.threadId, pending.resumeStatus)
      .catch((error) => Logger.error('Question resolution status update failed:', error))
    this.host.broadcast({
      type: 'question.resolved',
      sessionId: pending.request.sessionId,
      requestId,
      resolution: finalResolution,
      answers: finalAnswers
    })
    return true
  }

  clearPendingQuestion(requestId: string): void {
    const pending = this.host.pendingQuestions.get(requestId)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.host.pendingQuestions.delete(requestId)
    // A gateway `cio_ask_secret` call is still awaiting this card. Nothing else
    // can answer it once the request is gone, so settle it as dismissed and let
    // the harness turn continue instead of hanging on an unreachable question.
    pending.settleSecret?.({ status: 'dismissed', secrets: [] })
    // A gateway `cio_util_suggest` call is waiting on this card too. An accepted
    // decision already settled it; anything else (dismissal, teardown) is a
    // decline, so a capability is never installed by a card that went away.
    pending.settleUtilitySuggestion?.({ decision: 'declined' })
  }

  clearPendingQuestionsForSession(sessionId: string): void {
    for (const [requestId, pending] of this.host.pendingQuestions) {
      if (pending.request.sessionId === sessionId) {
        this.clearPendingQuestion(requestId)
      }
    }
  }

  /**
   * Attach the app's TypeSafe (Jev) decision capability.
   *
   * Attached after construction because the capability is built later in boot
   * than this engine is, the same way the heartbeat and retry schedulers are. One
   * instance serves every seam, so the key, the breaker and the audit trail are
   * shared rather than duplicated per caller.
   */
  attachTypesafeDecisionService(service: TypesafeDecisionService): void {
    this.host.state.typesafeDecision = service
  }

  /**
   * Report a TypeSafe fall-through once per distinct outcome.
   *
   * The first occurrence carries the information; every later one only proves
   * the first was not a blip, and a durable log that repeats a standing
   * `not-configured` on each graded turn is noise an operator learns to skip.
   * It is logged at `info` because the fall-through is a supported behaviour
   * (the harness lanes below take over), not a failure.
   */
  reportTypesafeFallthrough(
    status: Exclude<TypesafeDecisionStatus, 'answered'>,
    detail: string | undefined,
    candidate: RankingGradeCandidate
  ): void {
    const key = `${status}:${detail ?? ''}`
    if (this.host.state.reportedTypesafeFallthroughs.has(key)) return
    this.host.state.reportedTypesafeFallthroughs.add(key)
    Logger.info('Ranking grading falls through from TypeSafe', {
      harnessId: candidate.harnessId,
      modelId: candidate.modelId,
      status,
      detail
    })
  }
}
