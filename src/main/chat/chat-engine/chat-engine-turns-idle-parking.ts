import { Logger } from '../../system/logger'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { AgentEvent } from '../../../lib/types'

/**
 * Delays after which a parked idle is re-examined.
 *
 * An idle that arrives while the driver still registers its turn is parked
 * rather than honoured, because that is what a resume inside one logical turn
 * looks like. When the driver releases the registration without ever sending a
 * second idle (the release and the signal cross, and the harness is then
 * disposed), nothing was left to settle the turn and the thread sat at
 * "working" with no run behind it. The re-checks are bounded: a turn that never
 * releases its registration is the watchdog's problem, not this one's.
 */
export const PARKED_IDLE_RECHECKS_MS = [2_000, 30_000, 120_000, 600_000, 1_800_000] as const

/**
 * Re-check interval once the schedule above is spent.
 *
 * A registrant that never releases its turn is a bug, not one of pi's own gaps
 * (a compaction or a provider retry lasts seconds to minutes, never half an
 * hour). Dropping the parked idle there left the turn unsettled with no run
 * behind it: the thread read as "working" forever and every queued message
 * waited behind a turn that would never end. So the schedule keeps a slow beat
 * instead of ending, and the adjudication below settles the turn as soon as the
 * harness stops reporting work.
 */
export const PARKED_IDLE_SLOW_RECHECK_MS = 300_000

/** One idle signal, kept until the driver that parked it lets the turn go. */
export interface ParkedIdle {
  /** The session whose turn this idle ends, named once so hooks need no cast. */
  sessionId: string
  event: AgentEvent
  driverId: string
  sourceDriver?: HarnessDriver
}

/** What parking needs to ask the turn lifecycle while a signal waits. */
export interface ParkedIdleHooks {
  /** Whether the emitting driver still registers a live turn for the session. */
  driverHoldsTurn(idle: ParkedIdle): boolean
  /** Whether the harness itself still reports the session busy. */
  harnessBusy(sessionId: string, idle: ParkedIdle): Promise<boolean>
  /** Deliver a parked idle once the turn can no longer resume. */
  settle(idle: ParkedIdle): void
}

interface ParkedEntry extends ParkedIdle {
  /** How many re-checks have already been scheduled. */
  attempt: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Idle signals parked because their driver still registered the turn.
 *
 * A driver that keeps the registration is going to resume the turn, so the
 * engine must not finalize on the idle it just saw. A driver that releases the
 * registration guarantees the turn cannot resume, so the parked idle becomes
 * the turn's real end and is delivered. Waiting on two questions   the
 * registration, then the harness itself   is what closes the crossing window
 * without ever settling a turn the driver still owns.
 *
 * In memory only: a parked signal is a live instruction for one turn, and a
 * restart has no turn left to settle.
 */
export class IdleSignalParking {
  private readonly parked = new Map<string, ParkedEntry>()

  constructor(private readonly hooks: ParkedIdleHooks) {}

  /** Park an idle the driver still holds, and schedule its first re-check. */
  park(sessionId: string, idle: Omit<ParkedIdle, 'sessionId'>): void {
    this.cancel(sessionId)
    this.parked.set(sessionId, { ...idle, sessionId, attempt: 0 })
    this.schedule(sessionId)
  }

  /** Whether a signal is currently waiting for its session. */
  has(sessionId: string): boolean {
    return this.parked.has(sessionId)
  }

  /**
   * Forget a parked idle.
   *
   * Any later event for the session means the turn is alive again: the idle it
   * parked was genuinely intermediate, and the turn's own end will arrive on
   * its own. Also called when an idle is honoured, so a parked copy can never
   * settle the same turn a second time.
   */
  cancel(sessionId: string): void {
    const entry = this.parked.get(sessionId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.parked.delete(sessionId)
  }

  /** Forget every parked idle (teardown). */
  cancelAll(): void {
    for (const sessionId of [...this.parked.keys()]) this.cancel(sessionId)
  }

  /**
   * Schedule the next re-check.
   *
   * The bounded schedule is a cadence, never a deadline: once it is spent the
   * checks continue slowly. A registration that outlives it is a driver that
   * lost its turn, and the only safe way to end one is to keep asking whether
   * the harness still reports work and settle the moment it stops. Dropping the
   * signal instead (the old behavior) stranded the turn permanently.
   */
  private schedule(sessionId: string): void {
    const entry = this.parked.get(sessionId)
    if (!entry) return
    const bounded = PARKED_IDLE_RECHECKS_MS[entry.attempt]
    const delay = bounded ?? PARKED_IDLE_SLOW_RECHECK_MS
    entry.attempt += 1
    const timer = setTimeout(() => void this.recheck(sessionId), delay)
    // A parked idle must never keep the process alive on its own.
    timer.unref?.()
    entry.timer = timer
  }

  /**
   * Settle a parked idle once the turn can no longer resume.
   *
   * Two questions decide it, both answered by the side that owns the turn: has
   * the driver released the registration, and does the harness still consider
   * the session busy? A compaction gap releases the registration but leaves the
   * harness working, so this waits through it instead of settling a turn that
   * is about to be re-prompted. A disposed harness is not busy and has no
   * registration, which is exactly the case this closes.
   */
  private async recheck(sessionId: string): Promise<void> {
    const entry = this.parked.get(sessionId)
    if (!entry) return
    entry.timer = undefined
    const idle: ParkedIdle = {
      sessionId,
      event: entry.event,
      driverId: entry.driverId,
      ...(entry.sourceDriver ? { sourceDriver: entry.sourceDriver } : {})
    }
    const spent = entry.attempt > PARKED_IDLE_RECHECKS_MS.length
    if (this.hooks.driverHoldsTurn(idle)) {
      // Past the bounded schedule the driver's registration has stopped being
      // evidence: a live harness that is genuinely working keeps it, and one
      // that is not is exactly what this settles. Ask the harness.
      if (!spent) {
        this.schedule(sessionId)
        return
      }
      if (await this.hooks.harnessBusy(sessionId, idle)) {
        if (this.parked.get(sessionId) !== entry) return
        this.schedule(sessionId)
        return
      }
      if (this.parked.get(sessionId) !== entry) return
      this.parked.delete(sessionId)
      Logger.info('Settling a turn whose driver never released it and whose harness is idle', {
        sessionId,
        driverId: entry.driverId,
        rechecks: entry.attempt
      })
      this.hooks.settle(idle)
      return
    }
    if (await this.hooks.harnessBusy(sessionId, idle)) {
      // The signal may have been cancelled or replaced while the probe ran.
      if (this.parked.get(sessionId) !== entry) return
      this.schedule(sessionId)
      return
    }
    if (this.parked.get(sessionId) !== entry) return
    this.parked.delete(sessionId)
    Logger.dev('Settling a parked idle after the driver released the turn', { sessionId })
    this.hooks.settle(idle)
  }
}
