import type { ChatEngine } from '../chat-engine'

/** ChatEngine messages: one concern, moved verbatim from the composition root. */
export class ChatEngineMessages {
  constructor(private readonly host: ChatEngine) {}

  /** Record a user interaction so the activity grace period is extended. */
  touchUserActivity(): void {
    this.host.state.lastUserActivityAt = Date.now()
    for (const pending of this.host.pendingQuestions.values()) {
      this.host.units['questions'].schedulePendingQuestion(pending)
    }
  }

  /** Only held steers are excluded from display boundaries. Once delivered,
   *  subsequent work renders below their message even though the native run
   *  keeps its original execution and checkpoint anchor. */
  heldSteerMessageIds(threadId: string): Set<string> {
    const ids = new Set<string>()
    for (const steer of this.host.state.heldSteers.values()) {
      if (steer.conversationId === threadId) ids.add(steer.userMessageId)
    }
    return ids
  }
}
