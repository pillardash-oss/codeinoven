import { ChatEngine, isTurnBoundaryPrompt } from '../chat-engine'

/** ChatEngine lifecycle: one concern, moved verbatim from the composition root. */
export class ChatEngineLifecycle {
  constructor(private readonly host: ChatEngine) {}

  /** Timestamp of the prompt that opened the current logical turn.
   *
   *  The boundary is the newest real prompt, and nothing more. A steer the
   *  harness has taken is a real prompt: its work is a turn of its own with its
   *  own working trace, so the boundary moves to it the moment it is delivered
   *  and the fold stops at the work that came before it.
   *
   *  Two kinds of prompt are skipped instead of becoming the boundary:
   *
   *  - An activity-only notice (compaction, sub-agent envelope) or an app-issued
   *    continuation prompt (origin `orchestrator`) only re-prompts work already
   *    streaming, and its timestamp would empty a live trace.
   *  - A steer still held for its undo window has not reached the harness, so it
   *    has not opened a turn yet and the fold must keep feeding the turn it is
   *    steering. It becomes the boundary the instant delivery clears the hold.
   *
   *  The walk deliberately does not extend back over a contiguous run of user
   *  messages: a steer follows the interrupted prompt in the mirror (the
   *  assistant rows between them are only persisted when the turn settles), and
   *  folding the run back to its oldest prompt is exactly what kept one trace
   *  growing past a steer. Returns undefined when no such prompt exists (fresh
   *  thread, orchestrator-only transcript), in which case the fold keeps the
   *  whole log as before. */
  async currentTurnStartTs(projectId: string, threadId: string): Promise<number | undefined> {
    const page = await this.host.threadManager.loadMessagePage(projectId, threadId, undefined, 80)
    const messages = page.messages
    const heldSteerIds = this.host.units['messages'].heldSteerMessageIds(threadId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message || message.role !== 'user') continue
      if (!isTurnBoundaryPrompt(message)) continue
      if (heldSteerIds.has(message.id)) continue
      return message.createdAt || undefined
    }
    return undefined
  }

  // ─── Session watchdog   catches silent agent failures ───────────────────

  /**
   * Start (or restart) the inactivity watchdog for a session.
   * The timer is reset on every SSE event   if it fires, no events arrived
   * within the window and provider history is checked for a terminal failure.
   */
  startSessionWatchdog(
    sessionId: string,
    timeoutMs = ChatEngine.SESSION_ACTIVITY_TIMEOUT_MS
  ): void {
    this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
    const timer = setTimeout(
      () => void this.host.units['turns-sessions'].fireSessionWatchdog(sessionId),
      timeoutMs
    )
    this.host.state.sessionWatchdogs.set(sessionId, timer)
  }
}
