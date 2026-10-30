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
    // The boundary sits at or near the tail of the mirror: a running turn's
    // assistant rows are only written when the turn settles, so the prompt that
    // opened it is within a handful of the newest rows. This read is on the
    // critical path of every trace page and repeats once a second while a run is
    // live, in this instance or another one, and a page carries every message's
    // parts, so the old unconditional 80-row read decoded the whole newest turn
    // (tool output included) to recover one timestamp. Scan a small page first
    // and widen only when the boundary is genuinely further back.
    const near = await this.findTurnStartTs(
      projectId,
      threadId,
      ChatEngineLifecycle.NEAR_BOUNDARY_ROWS
    )
    if (near.found) return near.ts
    if (!near.hasOlder) return undefined
    return (await this.findTurnStartTs(projectId, threadId, ChatEngineLifecycle.WIDE_BOUNDARY_ROWS))
      .ts
  }

  /** Rows one boundary scan reads before widening (see `currentTurnStartTs`). */
  private static readonly NEAR_BOUNDARY_ROWS = 12

  /** Rows the widened scan reads, the previous unconditional page size. */
  private static readonly WIDE_BOUNDARY_ROWS = 80

  /**
   * Find the newest turn-opening prompt inside one bounded page of the mirror.
   *
   * `found` is false when the page held only prompts the boundary skips (an
   * activity notice, an orchestrator continuation, a steer still held); `hasOlder`
   * then says whether history continues behind it, which is the only reason to
   * pay for a wider read.
   */
  private async findTurnStartTs(
    projectId: string,
    threadId: string,
    limit: number
  ): Promise<{ found: boolean; ts: number | undefined; hasOlder: boolean }> {
    const page = await this.host.threadManager.loadMessagePage(
      projectId,
      threadId,
      undefined,
      limit
    )
    const messages = page.messages
    const heldSteerIds = this.host.units['messages'].heldSteerMessageIds(threadId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message || message.role !== 'user') continue
      if (!isTurnBoundaryPrompt(message)) continue
      if (heldSteerIds.has(message.id)) continue
      return { found: true, ts: message.createdAt || undefined, hasOlder: page.hasOlder }
    }
    return { found: false, ts: undefined, hasOlder: page.hasOlder }
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
