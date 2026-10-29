import { Logger } from '../../system/logger'
import type { GradeTurnOptions } from '../driver.interface'
import { type CodexAppServerTurn } from '../codex/codex-protocol'
import { normalizeAppServerItem } from '../codex/codex-tools'
import { notificationThreadId, recordValue, stringValue } from '../codex/codex-values'
import { parseItem } from '../codex/codex-stream-fold'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver turns: one concern, moved verbatim from the composition root. */
export class CodexDriverTurns {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.host.base.gradeTurnWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.host.units['title'].cheapestCandidate(projectPath))
    )
  }

  /** Whether the driver still has a registered live turn for this session.
   *  The engine's watchdog uses this to distinguish a session whose turn
   *  settled without finalization (stale working state) from one that is
   *  legitimately streaming a long turn. */
  hasActiveTurn(sessionId: string): boolean {
    const active = this.host.activeTurns.get(sessionId)
    return Boolean(active && !active.finished && !active.completionReceived)
  }

  async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.host.base.requireSession(projectPath, sessionId)
    const active = this.host.activeTurns.get(sessionId)
    if (!active?.nativeThreadId || !active.turnId) return
    try {
      await this.host.units['runtime'].appServerRequest(active.host, 'turn/interrupt', {
        threadId: active.nativeThreadId,
        turnId: active.turnId
      })
      // A successful interrupt does not guarantee Codex's `turn/completed`
      // notification will arrive: the wedged connection that forced the abort
      // may stay silent indefinitely, leaving this registration as a zombie
      // that rejects every later dispatch with "A turn is already active".
      // Finish the turn locally; the notification path is idempotent.
      await this.host.units['runtime'].finishAppServerTurn(active)
    } catch (error) {
      await this.host.units['runtime'].finishAppServerTurn(
        active,
        error instanceof Error ? error.message : 'Codex turn could not be interrupted'
      )
      throw error
    }
  }

  /**
   * Between-turn auto-compaction reporting.
   *
   * Codex emits `contextCompaction` item notifications outside any registered
   * turn (for example an automatic compaction running between turns or right
   * at resume/turn-start, before `turn/start` registers the turn). The
   * active-turn gate would drop those notifications, so this reconciliation
   * routes them to the session that last bound the native thread, producing
   * the same compaction message the in-turn parser produces.
   */
  reportBetweenTurnCompaction(method: string, params: Record<string, unknown>): void {
    if (method !== 'item/started' && method !== 'item/completed') return
    const threadId = notificationThreadId(params)
    if (!threadId) return
    const mapping = this.host.threadSessionsByNativeId.get(threadId)
    if (!mapping) return
    const item = normalizeAppServerItem(recordValue(params['item']))
    if (!item || stringValue(item['type']) !== 'contextCompaction') return
    void this.host.base
      .requireSession(mapping.projectPath, mapping.sessionId)
      .then((session) => {
        const parsed = parseItem(item, method === 'item/completed', session.id)
        if (!parsed) return
        if (parsed.messages) this.host.base.mergeMessages(session, parsed.messages)
        for (const event of parsed.events ?? []) {
          this.host.base.applyEventToSession(session, event)
          this.host.base.emit(event)
        }
        session.updatedAt = Date.now()
        return this.host.base.persistSession(session)
      })
      .catch((error) => Logger.dev('Codex between-turn compaction report failed:', error))
  }

  activeTurnForNotification(params: Record<string, unknown>): CodexAppServerTurn | undefined {
    const turn = recordValue(params['turn'])
    const threadId =
      stringValue(params['threadId']) ??
      stringValue(params['thread_id']) ??
      stringValue(turn?.['threadId']) ??
      stringValue(turn?.['thread_id'])
    const turnId =
      stringValue(params['turnId']) ?? stringValue(params['turn_id']) ?? stringValue(turn?.['id'])
    if (turnId) {
      const byTurn = [...this.host.activeTurns.values()].find((active) => active.turnId === turnId)
      if (byTurn) return byTurn
    }
    if (threadId) {
      const byThread = [...this.host.activeTurns.values()].find(
        (active) => active.nativeThreadId === threadId
      )
      if (byThread) return byThread
      // A transferred thread can still emit late events on the source host.
      return undefined
    }
    if (this.host.activeTurns.size === 1) return this.host.activeTurns.values().next().value
    return undefined
  }
}
