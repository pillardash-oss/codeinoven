/**
 * One shared wall-clock reading behind every relative age on screen.
 *
 * `formatCompactAge` answers "how long ago?" by comparing a stored timestamp
 * against the current instant, and Svelte only re-evaluates that comparison
 * when one of the expression's dependencies changes. A thread row's stamp
 * therefore froze at whatever it read on its last render: a thread that had
 * been quiet for three minutes kept reading "Now" until some unrelated update
 * happened to re-render the row.
 *
 * This module is the single "now" those stamps are measured against. One timer
 * and one reactive value serve every row on screen -- never a timer per thread
 * -- and the timer only runs while rows are actually mounted and the window is
 * visible, so a hidden window and an empty list cost nothing.
 *
 * Opening a thread refreshes the reading at that instant (see
 * `WorkspaceStore.openThread`), so the row the user just entered never shows a
 * stamp from up to a tick ago.
 */

/**
 * How often the shared reading advances. Every relative age the app renders is
 * a whole minute, so a half-minute cadence keeps each label inside half a
 * minute of the truth without re-rendering rows more often than the labels can
 * change.
 */
const TICK_MS = 30_000

class RelativeTimeClock {
  #now = $state(Date.now())
  #timer: ReturnType<typeof setInterval> | null = null
  /** How many mounted consumers are currently asking for a live reading. */
  #holders = 0

  /**
   * The instant relative labels are measured against.
   *
   * While the shared timer is not running -- no rows mounted, or the window is
   * hidden -- this reads the machine clock directly, so a label is never staler
   * than its own render and no timer is needed to keep it honest.
   */
  get now(): number {
    return this.#timer === null ? Date.now() : this.#now
  }

  /**
   * Take a live reading for as long as a consumer is mounted. The returned
   * release function is the consumer's cleanup, so the shared timer is armed by
   * the first row on screen and disarmed by the last one.
   */
  hold(): () => void {
    this.#holders++
    this.#arm()
    let released = false
    return () => {
      if (released) return
      released = true
      this.#holders = Math.max(0, this.#holders - 1)
      if (this.#holders === 0) this.#disarm()
    }
  }

  /**
   * Re-read the machine clock now instead of waiting for the next tick. Called
   * when a thread is opened, so the row the user just entered is stamped
   * against this moment.
   */
  refresh(): void {
    if (this.#timer === null) return
    this.#now = Date.now()
  }

  #arm(): void {
    // Refresh on the way in: the module may have been imported minutes before
    // the first row mounted.
    this.#now = Date.now()
    if (this.#timer !== null) return
    document.addEventListener('visibilitychange', this.#handleVisibilityChange)
    this.#start()
  }

  #disarm(): void {
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange)
    this.#stop()
  }

  #start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      this.#now = Date.now()
    }, TICK_MS)
  }

  #stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** A hidden window has nothing to keep current: stop ticking, and take a
   *  fresh reading the moment it is shown again. */
  #handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.#stop()
      return
    }
    this.#now = Date.now()
    this.#start()
  }
}

/** The one reading every relative age in the app shares. */
export const relativeTimeClock = new RelativeTimeClock()
