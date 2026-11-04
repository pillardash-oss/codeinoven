import {
  FOLLOW_UP_BUSY_DEFER_MS,
  FOLLOW_UP_MAX_DEFERRALS,
  FOLLOW_UP_MAX_HORIZON_MS,
  FOLLOW_UP_MIN_LEAD_MS,
  type FollowUp,
  type FollowUpRequest
} from '../../lib/follow-up'
import type { ThreadSettings } from '../../lib/types/agent'
import type { ThreadStatus } from '../../lib/types/thread'
import { Logger } from '../system/logger'
import type { FollowUpStore } from './follow-up-store'

/**
 * The longest a single timer is allowed to sleep before the service re-reads its
 * own store. A timer armed for nine hours is wrong after a sleep, a clock change
 * or a laptop that was closed: waking early to look again costs nothing, because
 * a tick that finds nothing due simply re-arms.
 *
 * It is also the lateness bound for a wake another instance armed: the store is
 * shared on disk, so a wake written by a secondary is picked up by the owner on
 * its next slice, and a minute is short enough that the time the user agreed to
 * is still the time the thread wakes.
 */
const TIMER_SLICE_MS = 60 * 1000

/** The thread facts a wake needs, resolved by the app that owns thread rows. */
export interface FollowUpThread {
  projectId: string
  status: ThreadStatus
  settings?: ThreadSettings
  title: string
}

export interface FollowUpServiceDeps {
  store: FollowUpStore
  /**
   * Whether this process owns the scheduled work of the config root.
   *
   * Exactly one live instance may wake a thread, the same rule the assistant
   * scheduler follows: a wake that ran in every window started the same turn
   * twice, which is what two open instances did to one thread before this gate
   * existed.
   */
  isOwner: () => boolean
  /** Read a thread row, or null when it no longer exists. */
  findThread: (threadId: string) => FollowUpThread | null
  /** Resume a thread with an internal turn, the same way the app resumes its own. */
  sendPrompt: (input: {
    projectId: string
    threadId: string
    settings: ThreadSettings
    text: string
    visible: boolean
  }) => Promise<void>
  now?: () => number
}

/** A turn already owns the thread; the wake has to wait for it. */
const BUSY_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

/**
 * FollowUpService   the one place a thread is woken at a time it agreed to.
 *
 * Two properties matter more than the scheduling itself. It is *gated*: the timer
 * exists only while a wake is armed, so an app with nothing scheduled holds no
 * clock at all. And it is *single-flight*: ticks are serialized and each wake is
 * claimed from the store before the turn is dispatched, so a slow tick, a second
 * instance or a restart can never send the same wake twice.
 */
export class FollowUpService {
  private timer: ReturnType<typeof setTimeout> | null = null
  private tickChain: Promise<void> = Promise.resolve()
  private disposed = false
  private loaded = false
  /** Called after anything that changes the armed set, so a watcher can repaint. */
  private changeListener: (() => void) | null = null

  constructor(private readonly deps: FollowUpServiceDeps) {}

  /**
   * Watch the armed set. The row badge and the residency check both read it, and
   * neither may poll a scheduler to find out it changed.
   */
  attachChangeListener(listener: (() => void) | null): void {
    this.changeListener = listener
  }

  private changed(): void {
    this.changeListener?.()
  }

  /** The one clock this service and its capability read. */
  now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Load the persisted wakes and arm the clock. Called once after paint. */
  async start(): Promise<void> {
    await this.refresh()
    this.arm()
    if (this.deps.store.hasAnyPending()) {
      Logger.info('Follow-ups restored', {
        pending: this.deps.store.list().length,
        owner: this.deps.isOwner()
      })
    }
  }

  /**
   * Re-read the store from disk.
   *
   * The file is shared by every instance of the config root, so an in-memory copy
   * is only ever a cache: a wake armed, held or cancelled in another window is
   * invisible until this runs. The tick calls it before deciding anything due,
   * and the panel's own read calls it so the list is the same list everywhere.
   */
  async refresh(): Promise<void> {
    await this.deps.store.load()
    this.loaded = true
  }

  /**
   * Take the schedule over: the registry just made this process the owner, so the
   * wakes another instance was holding must come due here, now.
   */
  async takeOver(): Promise<void> {
    if (this.disposed || !this.deps.isOwner()) return
    await this.tick()
    this.arm()
  }

  /** Stand down: another instance owns the schedule, so this one holds no clock. */
  standDown(): void {
    this.clearTimer()
  }

  /** Whether this instance is the one allowed to wake threads right now. */
  ownsSchedule(): boolean {
    return this.deps.isOwner()
  }

  /** Stop the clock. Pending wakes stay on disk for the next launch. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  /** Await the store's pending write, so a quit cannot lose a just-armed wake. */
  async flush(): Promise<void> {
    await this.deps.store.flush()
  }

  /** Every pending wake, soonest first. */
  list(): FollowUp[] {
    return this.deps.store.list()
  }

  /** The wakes armed on one thread. */
  listForThread(threadId: string): FollowUp[] {
    return this.deps.store.listForThread(threadId)
  }

  /** When the next wake is due, or null. Read by the residency check. */
  nextDueAt(): number | null {
    return this.deps.store.nextDueAt()
  }

  /**
   * Arm a wake. An agent may only ever schedule one on the thread it is running
   * in, which the caller enforces by supplying that thread's own ids.
   */
  async schedule(
    input: Omit<FollowUpRequest, 'projectId' | 'threadId'> & {
      projectId: string
      threadId: string
    }
  ): Promise<FollowUp> {
    if (!this.loaded) await this.refresh()
    const now = this.now()
    const dueAt = Math.round(input.dueAt)
    if (!Number.isFinite(dueAt)) throw new Error('dueAt must be a valid time in milliseconds')
    if (dueAt - now < FOLLOW_UP_MIN_LEAD_MS) {
      throw new Error(
        'A follow-up must be at least a minute from now. For work that finishes sooner, keep polling in this turn.'
      )
    }
    if (dueAt - now > FOLLOW_UP_MAX_HORIZON_MS) {
      throw new Error('A follow-up cannot be scheduled more than 30 days ahead')
    }
    const thread = this.deps.findThread(input.threadId)
    if (!thread) throw new Error('That thread no longer exists, so nothing can be scheduled on it')
    if (thread.projectId !== input.projectId) {
      throw new Error('A follow-up can only be scheduled on the thread that is running')
    }
    const followUp = this.deps.store.add({ ...input, dueAt })
    this.arm()
    this.changed()
    Logger.info('Follow-up scheduled', {
      projectId: followUp.projectId,
      threadId: followUp.threadId,
      followUpId: followUp.id,
      inMinutes: Math.round((dueAt - now) / 60_000)
    })
    return followUp
  }

  /** Cancel one wake. Returns whether it was armed. */
  cancel(id: string): boolean {
    const removed = this.deps.store.remove(id)
    if (removed) {
      this.arm()
      this.changed()
    }
    return removed
  }

  /**
   * Hold one wake. The row keeps its schedule and the time it was armed for, and
   * nothing is lost if the user changes their mind.
   */
  pause(id: string): FollowUp | null {
    const paused = this.deps.store.pause(id, this.now())
    this.arm()
    this.changed()
    return paused
  }

  /** Release a held wake. If its time already passed, it comes due on the next tick. */
  resume(id: string): FollowUp | null {
    const resumed = this.deps.store.resume(id)
    this.arm()
    this.changed()
    return resumed
  }

  /** Cancel every wake armed on a thread, which is what deleting it does. */
  cancelForThread(threadId: string): number {
    const removed = this.deps.store.removeForThread(threadId)
    if (removed > 0) {
      this.arm()
      this.changed()
    }
    return removed
  }

  /** Cancel every wake of a project that was removed. */
  cancelForProject(projectId: string): number {
    const removed = this.deps.store.removeForProject(projectId)
    if (removed > 0) {
      this.arm()
      this.changed()
    }
    return removed
  }

  /** Run every due wake now, then re-arm. Serialized: one tick at a time. */
  async tick(): Promise<void> {
    this.tickChain = this.tickChain.then(() => this.runTick())
    await this.tickChain
  }

  private async runTick(): Promise<void> {
    if (this.disposed) return
    // The owner is the only process that wakes a thread, which is what keeps two
    // open windows from starting the same turn twice.
    if (!this.deps.isOwner()) {
      this.clearTimer()
      return
    }
    await this.refresh()
    const now = this.now()
    // A held wake is deliberately not due, however far its clock has run: that is
    // the whole promise the pause control makes.
    const due = this.deps.store
      .list()
      .filter((followUp) => followUp.pausedAt === undefined && followUp.dueAt <= now)
    for (const followUp of due) await this.fire(followUp)
    this.arm()
    if (due.length > 0) this.changed()
  }

  /**
   * Wake one thread, or defer it when that thread is mid-turn.
   *
   * The wake is claimed before the turn is dispatched: at-most-once is the right
   * trade here, because a duplicated wake would start a second turn on a thread
   * that just answered, while a lost one is visible to the user as a follow-up
   * that never arrived and is reported as such.
   */
  private async fire(followUp: FollowUp): Promise<void> {
    const thread = this.deps.findThread(followUp.threadId)
    if (!thread || thread.projectId !== followUp.projectId) {
      this.deps.store.remove(followUp.id)
      Logger.info('Follow-up dropped: its thread is gone', {
        threadId: followUp.threadId,
        followUpId: followUp.id
      })
      return
    }
    if (BUSY_STATUSES.has(thread.status)) {
      if (followUp.deferred >= FOLLOW_UP_MAX_DEFERRALS) {
        this.deps.store.remove(followUp.id)
        Logger.info('Follow-up dropped: the thread stayed busy', {
          threadId: followUp.threadId,
          followUpId: followUp.id,
          deferrals: followUp.deferred
        })
        return
      }
      this.deps.store.defer(followUp.id, this.now() + FOLLOW_UP_BUSY_DEFER_MS)
      Logger.dev('Follow-up deferred: the thread is mid-turn', {
        threadId: followUp.threadId,
        followUpId: followUp.id
      })
      return
    }
    if (!thread.settings) {
      this.deps.store.remove(followUp.id)
      Logger.info('Follow-up dropped: its thread has no model bound', {
        threadId: followUp.threadId,
        followUpId: followUp.id
      })
      return
    }
    // Claim first, then dispatch. The turn itself is not awaited: a settled wake
    // can run for an hour, and the tick must stay short enough to serve the next
    // due wake.
    this.deps.store.remove(followUp.id)
    const text = `Scheduled follow-up: ${followUp.note}\n\n${followUp.prompt}`
    try {
      await this.deps.sendPrompt({
        projectId: followUp.projectId,
        threadId: followUp.threadId,
        settings: thread.settings,
        text,
        visible: true
      })
      Logger.info('Follow-up fired', {
        projectId: followUp.projectId,
        threadId: followUp.threadId,
        followUpId: followUp.id
      })
    } catch (error) {
      Logger.error('Follow-up could not be dispatched', {
        projectId: followUp.projectId,
        threadId: followUp.threadId,
        followUpId: followUp.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Arm one timer for the next due wake, or hold none when nothing is armed. */
  private arm(): void {
    this.clearTimer()
    if (this.disposed) return
    if (!this.deps.isOwner()) return
    const next = this.deps.store.nextDueAt()
    if (next === null) return
    const delay = Math.min(Math.max(next - this.now(), 0), TIMER_SLICE_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().catch((error) => {
        Logger.error('Follow-up tick failed', error)
      })
    }, delay)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
