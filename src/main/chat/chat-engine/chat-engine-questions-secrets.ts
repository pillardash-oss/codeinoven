import { Logger } from '../../system/logger'
import type { PendingQuestionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine questions-secrets: one concern, moved verbatim from the composition root. */
export class ChatEngineQuestionsSecrets {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Close an abandoned secret card and settle the gateway call waiting on it.
   *
   * The entries the user had already filled in are their own input, so they are
   * stored rather than dropped and the rest are reported as unresolved; only a
   * card with nothing filled closes unanswered. Leaving the call open would
   * strand the harness turn on a card nobody will fill in, so either way the
   * request is settled when the deadline passes.
   */
  expireSecretQuestion(pending: PendingQuestionInfo): void {
    if (this.host.pendingQuestions.get(pending.request.requestId) !== pending) return
    pending.timer = undefined
    pending.resumeSecretAfterSettlement = true
    void this.host.units['secrets']
      .settleExpiredSecretDrafts(pending)
      .then((settled) => {
        if (settled) return
        this.expireUnansweredSecretQuestion(pending)
      })
      .catch((error: unknown) => {
        // The card stays pending with a fresh window and retries its own
        // expiry, so a failed vault write never silently loses the draft.
        Logger.error('Expired secret draft settlement failed:', error)
      })
  }

  /** Close a secret card the user never filled in at all. */
  private expireUnansweredSecretQuestion(pending: PendingQuestionInfo): void {
    if (this.host.pendingQuestions.get(pending.request.requestId) !== pending) return
    this.host.units['misc'].reportAutoAnswer({
      id: pending.request.requestId,
      kind: 'secret',
      outcome: 'expired',
      projectId: pending.request.projectId,
      threadId: pending.request.threadId,
      entries: this.host.units['misc'].autoAnswerEntries(pending.request.questions, undefined),
      at: Date.now()
    })
    this.host.units['questions'].finalizePendingQuestion(pending.request.requestId, 'dismissed')
  }
}
