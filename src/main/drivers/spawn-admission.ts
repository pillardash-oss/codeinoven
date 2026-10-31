/**
 * Admission control for harness process spawns.
 *
 * Starting a harness process is the most expensive thing this app does per turn:
 * a Node or Electron runtime boots, the app's own extension bundle is loaded, and
 * the provider registry is read. What that costs depends far more on how many
 * processes start at the same moment than on any single one of them, which is why
 * a low-end machine turns "one turn" into a minute.
 *
 * Measured on 2026-10-28, one real turn on this machine: the user's pi process took
 * 5.4 s to come up while four background one-shot sessions were spawned beside it,
 * and the same kind of spawn on an idle machine takes around 1.5 s. The one
 * second of app work in front of that turn was already down to 265 ms, so the
 * contention is what was left.
 *
 * The rules are asymmetric on purpose:
 *
 * - a turn the user is waiting on never queues, so it takes its slot immediately;
 * - background one-shot work (titles, summaries, verdicts) spawns strictly one at
 *   a time, and only while no turn is starting, because nothing it produces is
 *   worth a second of chat latency.
 *
 * This generalizes the FIFO gate `claude-code` uses for its own one-shot spawns:
 * same slot counting, plus the background lane that yields to a turn.
 */
export type SpawnKind = 'interactive' | 'background'

export class SpawnAdmission {
  private interactive = 0
  private backgroundActive = false
  private readonly waiting: Array<() => void> = []

  /**
   * Wait for a slot, and return the release to call once the process is up.
   *
   * The release is idempotent: a caller that releases in both a success path and
   * a `finally` cannot free two slots for one spawn.
   */
  async enter(kind: SpawnKind): Promise<() => void> {
    if (kind === 'interactive') {
      this.interactive += 1
      return this.releaseOnce(() => {
        this.interactive -= 1
        this.wakeBackground()
      })
    }
    // A background spawn starts only into an idle machine, and the loop re-checks
    // after every wake because a turn may have claimed a slot in the meantime.
    while (this.backgroundActive || this.interactive > 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.backgroundActive = true
    return this.releaseOnce(() => {
      this.backgroundActive = false
      this.wakeBackground()
    })
  }

  /** Wake every background waiter; each one re-checks the conditions. */
  private wakeBackground(): void {
    if (this.backgroundActive || this.interactive > 0) return
    for (const wake of this.waiting.splice(0)) wake()
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }
}
