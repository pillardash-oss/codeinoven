/**
 * One wall-clock tick shared by every live run duration on screen.
 *
 * The working trace header, each sub-agent card and the sub-agent session
 * header all count the same thing, and a long trace can render dozens of them
 * at once. Each owner starts a single timer while its run is live and stops it
 * the moment the run settles, so the frozen value it shows afterwards is the
 * last real tick rather than a number that keeps climbing after the work ended.
 */
export class ElapsedTimer {
  /** Last tick, or 0 before the first tick. */
  #now = $state(0)
  #ticks = $state(false)
  #timer: ReturnType<typeof setInterval> | null = null

  /** True while the timer is ticking (reactive). */
  get ticking(): boolean {
    return this.#ticks
  }

  /** Start ticking; repeated calls while running are ignored. */
  start(): void {
    if (this.#timer) return
    this.#now = Date.now()
    this.#ticks = true
    this.#timer = setInterval(() => {
      this.#now = Date.now()
    }, 1000)
  }

  /** Stop ticking. The last tick is kept so a settled run freezes its duration. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#ticks = false
  }

  /**
   * Pin the clock at one wall-clock instant without ticking. A restored run
   * that reports no end timestamp must show a stable duration instead of a
   * number that grows every time the trace re-renders.
   */
  snapshot(): void {
    if (this.#now === 0) this.#now = Date.now()
  }

  /** Current wall-clock milliseconds: the live tick, or now when never started. */
  now(): number {
    return this.#now || Date.now()
  }

  /** Whole elapsed seconds between `start` and an explicit `end` (or the live clock). */
  seconds(start: number | undefined, end?: number): number {
    if (!start || start <= 0) return 0
    return Math.max(0, Math.floor(((end ?? this.now()) - start) / 1000))
  }
}
