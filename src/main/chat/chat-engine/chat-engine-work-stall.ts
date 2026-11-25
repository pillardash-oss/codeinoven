import { isRealProjectId } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { SessionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** Sub-agent lifecycle states that mean the worker is over, whatever its outcome. */
const SETTLED_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'aborted'])

/**
 * How long to wait before re-checking a turn whose one check landed while real
 * work was in flight (an open shell tool, a running sub-agent).
 *
 * A turn waiting on a sub-agent is not stalling: the child is doing the work, so
 * steering the parent would be a false positive and would talk over the child's
 * report. The check is simply repeated shortly after, still against the same
 * turn and the same start-of-turn window.
 */
const IN_FLIGHT_RECHECK_MS = 60_000

/** How many minutes the steer names, in the agent's own language. */
function minutesLabel(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * The invisible steer an agent receives when a turn reaches its check with no
 * file changed.
 *
 * It is deliberately blunt: the failure it corrects is an agent that keeps
 * reading, searching and re-reading while the turn burns time and tokens without
 * producing anything. It also forbids discussing the steer itself, because the
 * message is the app's and never the user's.
 */
export function stalledWorkSteerPrompt(minutes: number): string {
  return [
    `STOP STALLING. Not one file has changed in the last ${minutesLabel(minutes)} of this turn.`,
    'Reading and searching is not the work. Get on to work now: make the changes this task actually needs with your own tools, then verify them.',
    'Do not reply with a plan, a summary of what you read, or an explanation of this message, and do not mention that you were nudged. Stay focused and produce the work.'
  ].join(' ')
}

/**
 * Steer a turn that reaches the configured window without changing a file.
 *
 * The complaint this answers is concrete: an agent can open file after file for
 * ten minutes, emitting tool calls and reasoning the whole time, and finish the
 * turn with nothing changed. Harness events therefore cannot be the measure,
 * since a reading agent emits plenty of them.
 *
 * The rule is one check per turn, taken from the turn's start:
 *
 * - `noteTurnStarted` arms that one check when a turn becomes active; streaming
 *   events and steers never move it, so it is not a rolling clock.
 * - If the agent changes a file at any point before the check lands, the check
 *   simply ends and no steer is sent for the rest of that turn.
 * - `endTurn` drops the check when the turn settles; the next turn arms its own.
 *
 * The steer is dispatched as an `internal` prompt: it reaches the harness as a
 * mid-turn steer, is persisted hidden, and never appears in the user's
 * conversation.
 *
 * Only project threads are watched. Chats, assistant tasks and browser assistant
 * conversations are conversations, where file changes are not the work.
 */
export class ChatEngineWorkStall {
  constructor(private readonly host: ChatEngine) {}

  /** A turn became active: arm its one check unless that turn already has one. */
  noteTurnStarted(sessionId: string): void {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info || info.ephemeral) return
    const turnKey = this.turnKey(info)
    const settled = this.host.state.workStallSettledTurns.get(sessionId)
    if (settled !== undefined) {
      // The previous turn's outcome says nothing about this one.
      if (settled === turnKey) return
      this.host.state.workStallSettledTurns.delete(sessionId)
    }
    const existing = this.host.state.workStallChecks.get(sessionId)
    if (existing) {
      // A check belongs to the turn it was armed for. A turn that started
      // without the previous one settling gets its own full window.
      if (existing.turnKey === turnKey) return
      this.clearCheck(sessionId)
    }
    void this.arm(sessionId, turnKey)
  }

  /** The turn settled (idle, error, retirement): drop its check and outcome. */
  endTurn(sessionId: string): void {
    this.clearCheck(sessionId)
    this.host.state.workStallSettledTurns.delete(sessionId)
  }

  private turnKey(info: SessionInfo): string {
    return info.activeTurnId ?? info.activeTurnUserMessageId ?? 'unbound'
  }

  private clearCheck(sessionId: string): void {
    const existing = this.host.state.workStallChecks.get(sessionId)
    if (!existing) return
    clearTimeout(existing.timer)
    this.host.state.workStallChecks.delete(sessionId)
  }

  private async arm(sessionId: string, turnKey: string): Promise<void> {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info || info.ephemeral) return
    // Project threads only: a chat, an assistant task or a browser assistant
    // conversation is a conversation, where file changes are not the work.
    if (!isRealProjectId(info.projectId)) return
    // Child sessions and temporary chats are steered through the conversation
    // that owns them, never directly: an internal prompt sent to a child would
    // be answered on a session the user is not reading.
    if (this.host.state.childSessionOwners.has(sessionId)) return
    if (this.host.units['temporary-chats'].temporaryChatForSession(sessionId)) return
    const minutes = (await this.host.storage.getConfig()).steerToStartWorkMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    // The lookups above await: a turn that settled meanwhile must not leave a
    // timer behind for a session that is gone or already idle.
    if (!this.host.sessionRegistry.has(sessionId)) return
    const status = this.host.sessionStatuses.get(sessionId)?.state
    if (status !== 'working' && status !== 'waiting') return
    this.setCheck(sessionId, turnKey, minutes * 60_000)
  }

  private setCheck(sessionId: string, turnKey: string, delayMs: number): void {
    this.clearCheck(sessionId)
    this.host.state.workStallChecks.set(sessionId, {
      turnKey,
      timer: setTimeout(() => void this.fire(sessionId), delayMs)
    })
  }

  /** Run the one check a turn gets. */
  private async fire(sessionId: string): Promise<void> {
    const check = this.host.state.workStallChecks.get(sessionId)
    const info = this.host.sessionRegistry.get(sessionId)
    if (!check || !info) {
      this.host.state.workStallChecks.delete(sessionId)
      this.host.state.workStallSettledTurns.delete(sessionId)
      return
    }
    const turnKey = this.turnKey(info)
    if (turnKey !== check.turnKey) {
      // The turn this check belonged to is gone. A new one runs on its own
      // start-of-turn window, never on the remains of the previous one.
      this.clearCheck(sessionId)
      this.host.state.workStallSettledTurns.delete(sessionId)
      void this.arm(sessionId, turnKey)
      return
    }
    this.host.state.workStallChecks.delete(sessionId)
    const state = this.host.sessionStatuses.get(sessionId)?.state
    if (state !== 'working' && state !== 'waiting') {
      // The turn ended before its check landed: nothing to steer.
      this.host.state.workStallSettledTurns.delete(sessionId)
      return
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(info.driverId, info.accountId)
    // A session can still claim `working` after its driver released the turn
    // (the idle event may be in flight). An internal prompt sent then would open
    // a brand-new turn instead of steering the one that stalled, so hold off.
    if (driver?.hasActiveTurn && !driver.hasActiveTurn(sessionId)) {
      this.host.state.workStallSettledTurns.delete(sessionId)
      return
    }
    // The agent already did the work this check exists to ask for. One file
    // action anywhere in the turn ends the check for the rest of the turn.
    if (this.madeFileChanges(info)) {
      this.host.state.workStallSettledTurns.set(sessionId, turnKey)
      return
    }
    // A turn waiting on real work is not stalling, however quiet its own tools
    // look: an open shell command or a running sub-agent is the work. The child
    // sessions come from the harness-neutral `subagent` part the app folds every
    // driver's child activity into, so this holds for every harness that reports
    // children at all.
    if (this.hasInFlightWork(sessionId, info)) {
      this.setCheck(sessionId, turnKey, IN_FLIGHT_RECHECK_MS)
      return
    }
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    if (!thread?.settings) return
    const minutes = (await this.host.storage.getConfig()).steerToStartWorkMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    // Settle the turn before sending: the dispatch re-announces the working
    // state, and this turn has spent its one check.
    this.host.state.workStallSettledTurns.set(sessionId, turnKey)
    Logger.info('Steering a stalled agent to start work', {
      sessionId,
      projectId: info.projectId,
      threadId: info.threadId,
      driverId: info.driverId,
      minutes
    })
    try {
      await this.host.sendPrompt(
        info.projectId,
        info.threadId,
        thread.settings,
        stalledWorkSteerPrompt(minutes),
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal'
      )
    } catch (error) {
      Logger.dev('Work-stall steer could not be delivered:', error)
    }
  }

  /** Whether this turn produced any file change, by its own tools or a child. */
  private madeFileChanges(info: SessionInfo): boolean {
    return (info.changedPaths?.size ?? 0) > 0 || (info.preciseChangedPaths?.size ?? 0) > 0
  }

  /**
   * Whether this turn is waiting on work it started rather than stalling.
   *
   * Both signals are app-owned and harness-neutral: the session's own open
   * shell-like tools, and the child sessions the engine registers from the
   * normalized `subagent` activity every driver reports. A child counts as
   * running until its reported lifecycle status settles, so a parent parked on a
   * long sub-agent is never steered.
   */
  private hasInFlightWork(sessionId: string, info: SessionInfo): boolean {
    if (this.host.units['misc'].hasInFlightWork(sessionId, info)) return true
    for (const [childSessionId, owner] of this.host.state.childSessionOwners) {
      if (owner.parentSessionId !== sessionId) continue
      if (this.host.sessionStatuses.get(childSessionId)?.state === 'working') return true
      const status = this.host.state.childSessionActivityStatuses.get(childSessionId)
      if (status !== undefined && !SETTLED_SUBAGENT_STATUSES.has(status)) return true
    }
    return false
  }
}
