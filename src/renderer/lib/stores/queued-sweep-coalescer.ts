/**
 * Collapses a burst of "something may have become free" notices into a few sweeps.
 *
 * The queued-message dispatcher is asked to sweep on every idle transition of any
 * session and on every thread row that settles, and each sweep asks every waiting
 * thread's gates again. A working project produces those notices in bursts   a
 * worker finishing, a row settling, a turn ending   so the notice itself cannot
 * be the trigger of a round-trip each.
 *
 * The rule is leading plus trailing: the first notice after a quiet spell runs at
 * once, so a message still leaves the moment its turn ends, and everything that
 * arrives inside the window collapses into one run at the end of it. A single
 * notice is therefore never delayed, and a storm costs two sweeps instead of one
 * per event.
 *
 * The clock and the scheduler are injectable so a test can script a burst without
 * waiting on real time.
 */
export interface SweepCoalescerOptions {
  /** Shortest gap between two runs. */
  intervalMs: number
  /** The work a notice asks for. */
  run: () => void
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export class SweepCoalescer {
  readonly #intervalMs: number
  readonly #run: () => void
  readonly #now: () => number
  readonly #setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** When the last run started, or null before the first one. */
  #lastRunAt: number | null = null
  /** The pending trailing run, when notices arrived inside the window. */
  #trailing: ReturnType<typeof setTimeout> | undefined = undefined

  constructor(options: SweepCoalescerOptions) {
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
