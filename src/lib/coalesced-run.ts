/**
 * Collapses a burst of "it may have changed" notices into a few runs of the work.
 *
 * Two places in this app are told about something on every event and have to
 * answer it by reading state: the queued-message dispatcher (every idle
 * transition and every settled thread row asks the waiting threads' gates again)
 * and the keep-awake service (every persisted thread update asks the database
 * whether any turn is still running). Both notices arrive in bursts — a worker
 * finishing, several threads parking on the same provider window, a turn ending —
 * and each burst would otherwise become one read per event on the single
 * database connection every click waits behind.
 *
 * The rule is leading plus trailing: the first notice after a quiet spell runs at
 * once, so the app still reacts the moment it is told, and everything that
 * arrives inside the window collapses into one run at the end of it. A single
 * notice is never delayed, and a burst of fifty costs two runs instead of fifty.
 *
 * The clock and the scheduler are injectable so a test can script a burst without
 * waiting on real time.
 */
export interface CoalescedRunOptions {
  /** Shortest gap between two runs. */
  intervalMs: number
  /** The work a notice asks for. */
  run: () => void
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export class CoalescedRun {
  readonly #intervalMs: number
  readonly #run: () => void
  readonly #now: () => number
  readonly #setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** When the last run started, or null before the first one. */
  #lastRunAt: number | null = null
  /** The pending trailing run, when notices arrived inside the window. */
  #trailing: ReturnType<typeof setTimeout> | undefined = undefined

  constructor(options: CoalescedRunOptions) {
    this.#intervalMs = options.intervalMs
    this.#run = options.run
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** A notice: run now, or fold into the pending trailing run. */
  request(): void {
    const lastRunAt = this.#lastRunAt
    if (lastRunAt === null || this.#now() - lastRunAt >= this.#intervalMs) {
      this.#dropTrailing()
      this.#fire()
      return
    }
    if (this.#trailing !== undefined) return
    const wait = Math.max(0, this.#intervalMs - (this.#now() - lastRunAt))
    this.#trailing = this.#setTimer(() => {
      this.#trailing = undefined
      this.#fire()
    }, wait)
  }

  /** Drop a pending trailing run without running it (teardown, or a forced run). */
  cancel(): void {
    this.#dropTrailing()
  }

  #fire(): void {
    this.#lastRunAt = this.#now()
    this.#run()
  }

  #dropTrailing(): void {
    if (this.#trailing === undefined) return
    this.#clearTimer(this.#trailing)
    this.#trailing = undefined
  }
}
