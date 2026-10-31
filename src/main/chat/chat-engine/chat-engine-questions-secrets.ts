import type { PendingQuestionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine questions-secrets: one concern, moved verbatim from the composition root. */
export class ChatEngineQuestionsSecrets {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Close an abandoned secret card and settle the gateway call waiting on it.
   * Nothing can answer a secret on the user's behalf, so the only correct
   * outcome for an expired card is a dismissal the agent can react to: leaving
   * the call open would strand the harness turn on a card nobody will fill in.
   */
  expireSecretQuestion(pending: PendingQuestionInfo): void {
    if (this.host.pendingQuestions.get(pending.request.requestId) !== pending) return
    pending.timer = undefined
    pending.resumeSecretAfterSettlement = true
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
