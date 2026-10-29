import type { AgentEvent, AgentMessage, ThreadSettings } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type {
  IdleNativeSessionHandOffProbe,
  IdleNativeSessionReleaseResult
} from '../driver.interface'
import { CODEX_COMPACTION_TIMEOUT_MS, type CodexAppServerHost } from '../codex/codex-protocol'
import { namespacedMessage } from '../codex/codex-stream-fold'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver sessions: one concern, moved verbatim from the composition root. */
export class CodexDriverSessions {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /** Codex runs as a shared app-server daemon, so the base implementation's
   *  process-liveness check cannot tell one session's turn from another's:
   *  the host process is alive for every session while the daemon runs.
   *  Report per-turn registration instead so a silent session whose turn has
   *  already finished is probed as idle (letting the watchdog reconcile or
   *  abort it) while a genuinely active silent turn stays preserved. */
  async isSessionBusy(_projectPath: string, sessionId: string): Promise<boolean> {
    return this.host.hasActiveTurn(sessionId)
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const active = this.host.activeTurns.get(sessionId)
    if (active) await this.host.units['runtime'].finishAppServerTurn(active)
    await this.host.base.superDeleteSession(projectPath, sessionId)
    await this.host.base.storage.remove(`drivers/${this.host.base.id}/inputs/${sessionId}`)
    await this.host.base.storage.remove(`drivers/${this.host.base.id}/transfers/${sessionId}.json`)
    this.host.units['runtime'].stopResidentHostForPathIfIdle(projectPath)
  }

  /** Check the resident writer without starting a host or loading history. */
  hasSessionWriter(projectPath: string, sessionId: string): boolean {
    if (!this.host.hostsByProjectPath.has(projectPath)) return false
    for (const binding of this.host.threadSessionsByNativeId.values()) {
      if (binding.sessionId === sessionId && binding.projectPath === projectPath) return true
    }
    return false
  }

  /**
   * Transfer a settled app session. An idle host exits to release the exact
   * native writer. A busy host stays alive for unrelated turns; the receiving
   * instance forks the settled history under a new native ID on its own host.
   */
  async releaseIdleSessionForTransfer(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionReleaseResult> {
    // A session record this process cannot read names no native thread, so there
    // is no writer here for a hand-off to release. Answering with a thrown error
    // would instead fail the peer's ordinary prompt with a transfer message it
    // cannot act on: this method's contract is a result, never an exception.
    let nativeThreadId: string | null
    try {
      nativeThreadId =
        (await this.host.base.requireSession(projectPath, sessionId)).nativeSessionId ?? null
    } catch (error) {
      Logger.dev('Codex idle writer release could not read the session:', error)
      return { owner: false, released: false }
    }
    const host = this.host.units['runtime'].writerHostFor(projectPath, sessionId, nativeThreadId)
    if (!host || !nativeThreadId) return { owner: false, released: false }

    const sessionBlocker = this.sessionTransferBlocker(sessionId, nativeThreadId)
    if (sessionBlocker) return { owner: true, released: false, reason: sessionBlocker }
    const blocker = this.handOffBlockerFor(host, sessionId)
    if (blocker) {
      // Keep unrelated turns on their shared server. The adopter forks this
      // settled native history on its own host and retains the app session ID.
      await this.host.base.storage.write(
        `drivers/${this.host.base.id}/transfers/${sessionId}.json`,
        {
          nativeThreadId,
          projectPath
        }
      )
      this.host.threadSessionsByNativeId.delete(nativeThreadId)
      this.host.base.sessionCache.delete(sessionId)
      void this.host.units['runtime']
        .appServerRequest(host, 'thread/unsubscribe', { threadId: nativeThreadId })
        .catch((error: unknown) =>
          Logger.dev('Codex transferred thread unsubscribe unavailable:', error)
        )
      return { owner: true, released: true }
    }

    if (this.host.hostsByProjectPath.get(projectPath) === host) {
      this.host.hostsByProjectPath.delete(projectPath)
    }
    const stopped = await this.host.units['runtime'].stopAppServerHostAndWait(
      host,
      'Codex app-server handed an idle thread to another instance'
    )
    if (!stopped) {
      return {
        owner: true,
        released: false,
        reason: 'The Codex app-server did not exit, so its thread writer is still held.'
      }
    }
    for (const [threadId, sessionOwner] of this.host.threadSessionsByNativeId) {
      if (sessionOwner.projectPath === projectPath)
        this.host.threadSessionsByNativeId.delete(threadId)
    }
    return { owner: true, released: true }
  }

  /**
   * Whether this thread's writer could be released once its own turn stops,
   * judged without stopping anything.
   *
   * Unrelated host activity can use the history-fork path. Only operations on
   * this session block the transfer, and its own turn will be stopped by the
   * caller after this probe.
   */
  async canHandOffIdleSession(
    projectPath: string,
    sessionId: string
  ): Promise<IdleNativeSessionHandOffProbe> {
    let nativeThreadId: string | null
    try {
      nativeThreadId =
        (await this.host.base.requireSession(projectPath, sessionId)).nativeSessionId ?? null
    } catch (error) {
      // A session this process cannot even read is one it cannot hand over.
      Logger.dev('Codex hand-off probe could not read the session:', error)
      return { blocked: true, reason: 'This Codex session is no longer available to hand over.' }
    }
    const host = this.host.units['runtime'].writerHostFor(projectPath, sessionId, nativeThreadId)
    // No writer here means this process is not the one holding the thread, so a
    // hand-off has nothing to wait on.
    if (!host) return { blocked: false }
    const blocker = this.sessionTransferBlocker(sessionId, nativeThreadId, true)
    return blocker ? { blocked: true, reason: blocker } : { blocked: false }
  }

  sessionTransferBlocker(
    sessionId: string,
    nativeThreadId: string | null,
    ignoreOwnTurn = false
  ): string | null {
    if (!ignoreOwnTurn && this.host.activeTurns.has(sessionId)) {
      return `Codex session ${sessionId} still has an active turn.`
    }
    if (nativeThreadId && this.host.compactionsByThreadId.has(nativeThreadId)) {
      return `Codex session ${sessionId} is still compacting its history.`
    }
    if (nativeThreadId && this.host.contextUsageByThreadId.has(nativeThreadId)) {
      return `Codex session ${sessionId} is still refreshing context usage.`
    }
    return null
  }

  /**
   * Why the host cannot be stopped for a hand-off right now, or null when it can.
   *
   * `ignoreOwnTurn` covers a transfer's pre-flight: the thread being handed over
   * is still running its turn at that moment, and the transfer stops it before
   * it releases the writer.
   */
  handOffBlockerFor(
    host: CodexAppServerHost,
    sessionId: string,
    options: { ignoreOwnTurn?: boolean } = {}
  ): string | null {
    if (!options.ignoreOwnTurn && this.host.activeTurns.has(sessionId)) {
      return `Codex session ${sessionId} still has an active turn on the app-server.`
    }
    const blockers = new Set<string>()
    for (const [turnSessionId, active] of this.host.activeTurns) {
      if (active.host !== host || turnSessionId === sessionId) continue
      blockers.add(`active turn for session ${turnSessionId}`)
    }
    for (const [threadId, compaction] of this.host.compactionsByThreadId) {
      if (compaction.host === host) blockers.add(`compaction for native thread ${threadId}`)
    }
    for (const [threadId, waiter] of this.host.contextUsageByThreadId) {
      if (waiter.host === host) blockers.add(`context-usage request for native thread ${threadId}`)
    }
    for (const request of this.host.serverRequests.values()) {
      if (request.host === host && request.sessionId !== sessionId) {
        blockers.add(`${request.method} server request for session ${request.sessionId}`)
      }
    }
    for (const pending of host.pending.values()) blockers.add(`pending ${pending.method} request`)
    if (blockers.size === 0) return null
    return `This Codex thread cannot move yet; its app-server is still handling ${[...blockers].join('; ')}.`
  }

  normalizeSessionMessages(messages: AgentMessage[], sessionId: string): AgentMessage[] {
    const byId = new Map<string, AgentMessage>()
    for (const message of messages) {
      const renamed = namespacedMessage(message, sessionId)
      byId.set(renamed.id, renamed)
    }
    return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const nativeThreadId = await this.host.base.nativeSessionId(projectPath, sessionId)
    const session = await this.host.base.requireSession(projectPath, sessionId)
    const messageId = `${sessionId}:compaction:${Date.now()}`
    const partId = `${messageId}:compaction`
    const basePart = {
      type: 'compaction' as const,
      id: partId,
      messageID: messageId,
      auto: false
    }
    session.messages.push({
      id: messageId,
      role: 'assistant',
      parts: [basePart],
      createdAt: Date.now(),
      harnessId: this.host.base.id
    })

    this.host.base.emit({ type: 'session.status', sessionId, status: { state: 'working' } })
    this.host.base.applyEventToSession(session, {
      type: 'message.part.updated',
      sessionId,
      part: basePart
    })
    this.host.base.emit({ type: 'message.part.updated', sessionId, part: basePart })

    const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
    // `thread/compact/start` only accepts threads the app-server has loaded.
    // Loading (resuming) first is a no-op when the thread is already loaded, and
    // it turns the "thread not found" rejection into a real compaction run.
    await this.host.units['runtime'].appServerRequest(host, 'thread/resume', {
      threadId: nativeThreadId,
      excludeTurns: true,
      developerInstructions: null
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.host.compactionsByThreadId.delete(nativeThreadId)
        reject(new Error('Codex compaction timed out'))
      }, CODEX_COMPACTION_TIMEOUT_MS)
      this.host.compactionsByThreadId.set(nativeThreadId, {
        host,
        session,
        messageId,
        basePart,
        resolve,
        reject,
        timer
      })
      void this.host.units['runtime']
        .appServerRequest(host, 'thread/compact/start', { threadId: nativeThreadId })
        .catch((error: unknown) => {
          clearTimeout(timer)
          this.host.compactionsByThreadId.delete(nativeThreadId)
          reject(error instanceof Error ? error : new Error('Codex compaction failed'))
        })
    }).catch((error) => {
      const failed: AgentEvent = {
        type: 'message.completed',
        sessionId,
        messageId,
        error: error instanceof Error ? error.message : 'Codex compaction failed',
        compaction: true
      }
      this.host.base.applyEventToSession(session, failed)
      this.host.base.emit(failed)
      this.host.base.emit({ type: 'session.idle', sessionId })
      throw error
    })
  }
}
