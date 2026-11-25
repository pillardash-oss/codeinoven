import { Logger } from '../../system/logger'
import type { SessionInfo } from './chat-engine-types'
import type { ChatEngine } from '../chat-engine'

/** Sub-agent lifecycle states that mean the worker is over, whatever its outcome. */
const SETTLED_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'aborted'])

/** How many minutes the nudge names, in the agent's own language. */
function minutesLabel(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * How long to wait before re-checking a turn whose clock fired while real work
 * was in flight (an open shell tool, a running sub-agent).
 *
 * A turn waiting on a sub-agent is not stalling: the child is doing the work, so
 * steering the parent would be a false positive and would talk over the child's
 * report. The clock is only inspected again shortly after the work settles, at
 * which point a parent that still changed nothing gets its one steer.
 */
const IN_FLIGHT_RECHECK_MS = 60_000

/**
 * The invisible steer an agent receives after a window with no file changed.
 *
 * It is deliberately blunt: the failure it corrects is an agent that keeps
 * reading, searching and re-reading while the turn burns time and tokens without
 * producing anything. It also forbids discussing the nudge itself, because the
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
 * Steer a turn that has stopped producing anything.
 *
 * The complaint this answers is concrete: an agent can open file after file for
 * ten minutes, emitting tool calls and reasoning the whole time, and finish the
 * turn with nothing changed. Harness events therefore cannot be the clock, since
 * a reading agent emits plenty of them. The clock is file changes, the one
 * signal that means work actually happened, and this unit owns it:
 *
 * - `noteTurnStarted` arms it when a turn becomes active (a fresh thread or a
 *   resume), and only once per turn, so ordinary streaming never pushes it out.
 * - `noteFileProgress` restarts it whenever a real edit, write or writing shell
 *   command lands.
 * - `endTurn` clears it when the turn settles.
 *
 * When the timer fires and the turn is still live, the steer is dispatched as an
 * `internal` prompt: it reaches the harness as a mid-turn steer, is persisted
 * with hidden visibility, and never appears in the user's conversation. One
 * steer is sent per turn, so an agent that ignores it is not nudged forever.
 */
export class ChatEngineWorkStall {
  constructor(private readonly host: ChatEngine) {}

  /** A turn just became active: arm its clock unless one is already running. */
  noteTurnStarted(sessionId: string): void {
    // A steer or any other in-turn send re-announces the working state; the
    // running timer is that turn's clock and must not be pushed out by it.
    if (this.host.state.workStallTimers.has(sessionId)) return
    if (this.host.state.workStallNudgedTurns.has(sessionId)) return
    void this.arm(sessionId)
  }

  /** A real file change landed: this turn is working, so restart its clock. */
  noteFileProgress(sessionId: string): void {
    // One steer per turn: once this turn was nudged, nothing restarts the clock.
    if (this.host.state.workStallNudgedTurns.has(sessionId)) return
    if (!this.host.state.workStallTimers.has(sessionId)) return
    void this.arm(sessionId)
  }

  /** The turn settled (idle, error, retirement): drop its clock and budget. */
  endTurn(sessionId: string): void {
    this.clearTimer(sessionId)
    this.host.state.workStallNudgedTurns.delete(sessionId)
  }

  private clearTimer(sessionId: string): void {
    const existing = this.host.state.workStallTimers.get(sessionId)
    if (!existing) return
    clearTimeout(existing)
    this.host.state.workStallTimers.delete(sessionId)
  }

  /** Re-check shortly after the work the turn is waiting on has settled. */
  private deferForInFlightWork(sessionId: string): void {
    this.clearTimer(sessionId)
    this.host.state.workStallTimers.set(
      sessionId,
      setTimeout(() => void this.fire(sessionId), IN_FLIGHT_RECHECK_MS)
    )
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

  private async arm(sessionId: string): Promise<void> {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info || info.ephemeral) return
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
    if (this.host.state.workStallNudgedTurns.has(sessionId)) return
    this.clearTimer(sessionId)
    this.host.state.workStallTimers.set(
      sessionId,
      setTimeout(() => void this.fire(sessionId), minutes * 60_000)
    )
  }

  private async fire(sessionId: string): Promise<void> {
    this.host.state.workStallTimers.delete(sessionId)
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info) {
      this.host.state.workStallNudgedTurns.delete(sessionId)
      return
    }
    const turnKey = info.activeTurnId ?? 'unbound'
    if (this.host.state.workStallNudgedTurns.get(sessionId) === turnKey) return
    const state = this.host.sessionStatuses.get(sessionId)?.state
    if (state !== 'working' && state !== 'waiting') {
      // The turn ended while the clock ran: nothing to steer.
      this.host.state.workStallNudgedTurns.delete(sessionId)
      return
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(info.driverId, info.accountId)
    // A session can still claim `working` after its driver released the turn
    // (the idle event may be in flight). An internal prompt sent then would open
    // a brand-new turn instead of steering the one that stalled, so hold off.
    if (driver?.hasActiveTurn && !driver.hasActiveTurn(sessionId)) {
      this.host.state.workStallNudgedTurns.delete(sessionId)
      return
    }
    // A turn waiting on real work is not stalling, however quiet its own tools
    // look: an open shell command or a running sub-agent is the work. The child
    // sessions come from the harness-neutral `subagent` part the app folds every
    // driver's child activity into, so this holds for every harness that reports
    // children at all. Defer and look again when that work is over.
    if (this.hasInFlightWork(sessionId, info)) {
      this.deferForInFlightWork(sessionId)
      return
    }
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    if (!thread?.settings) return
    const minutes = (await this.host.storage.getConfig()).steerToStartWorkMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    // Spend the turn's one nudge before sending: the send re-announces the
    // working state, and that must not arm a second clock for this same turn.
    this.host.state.workStallNudgedTurns.set(sessionId, turnKey)
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
      this.host.state.workStallNudgedTurns.delete(sessionId)
      Logger.dev('Work-stall steer could not be delivered:', error)
    }
  }
}
