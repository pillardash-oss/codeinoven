/**
 * Which harness is still holding resources for which project.
 *
 * Residency belongs to a harness, never to a project as a whole. Pi work in a
 * folder says nothing about whether Codex still needs the app-server it opened
 * there, and one project-wide clock is what kept a finished Codex server, and
 * the code-mode host it spawned, alive for hours because a Pi thread in the same
 * folder had something to do. Every harness therefore keeps its own clock, its
 * own released flag and its own set of working directories, so one going quiet
 * releases its own runtime while its neighbour keeps working.
 *
 * This is bookkeeping only: it records what each harness may still be holding
 * and which of them have gone quiet, and hands the releases that are due to the
 * caller that owns the drivers.
 */

/** One harness's resources for one project. */
export interface HarnessProjectEntry {
  projectId: string
  driverId: string
  /** Working directories this harness may still hold resources in. */
  paths: Set<string>
}

/** One harness's resources that have gone unused past the grace period. */
export interface HarnessProjectRelease {
  projectId: string
  driverId: string
  paths: string[]
}

/** Key for one harness in one project. NUL cannot appear in either id. */
export function harnessProjectKey(projectId: string, driverId: string): string {
  return `${projectId}\u0000${driverId}`
}

export class HarnessIdleLedger {
  /** One entry per harness in each project it has been used in. */
  readonly #entries = new Map<string, HarnessProjectEntry>()
  /** Since when each harness has had nothing in flight. */
  readonly #idleSince = new Map<string, number>()
  /**
   * Harnesses whose resources for a project are already released. Holding the
   * flag per harness is what stops a busy neighbour from making an idle one
   * release the same runtime every grace period.
   */
  readonly #released = new Set<string>()

  /** Harnesses still holding working directories, so the reaper has work left. */
  get pending(): number {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.paths.size > 0) count += 1
    }
    return count
  }

  /** Record a working directory a harness may allocate resources in. */
  notePath(projectId: string, driverId: string, projectPath: string): void {
    const key = harnessProjectKey(projectId, driverId)
    const entry = this.#entries.get(key) ?? { projectId, driverId, paths: new Set<string>() }
    entry.paths.add(projectPath)
    this.#entries.set(key, entry)
  }

  /**
   * Live work in a harness. Without a driver, every harness of the project.
   *
   * Resetting the clock is also what makes a released harness eligible again:
   * the next burst of work reopens the question of when its runtime may go.
   */
  markActive(projectId: string, driverId?: string): void {
    if (driverId !== undefined) {
      const key = harnessProjectKey(projectId, driverId)
      this.#idleSince.delete(key)
      this.#released.delete(key)
      return
    }
    for (const key of [...this.#entries.keys()]) {
      if (!key.startsWith(`${projectId}\u0000`)) continue
      this.#idleSince.delete(key)
      this.#released.delete(key)
    }
  }

  /**
   * Take every harness release that is due as of `now`.
   *
   * A caller marks each harness that has work in flight before calling this, so
   * an entry nobody marked is one that has been quiet since the moment it was
   * last marked and its own clock, not its project's, decides its fate.
   */
  releaseDue(now: number, graceMs: number): HarnessProjectRelease[] {
    const releases: HarnessProjectRelease[] = []
    for (const [key, entry] of this.#entries) {
      if (this.#released.has(key)) continue
      const since = this.#idleSince.get(key) ?? now
      if (now - since < graceMs) {
        this.#idleSince.set(key, since)
        continue
      }
      this.#idleSince.delete(key)
      this.#released.add(key)
      // Nothing tracked means the harness never held anything here; the flag is
      // worth keeping, the empty release is not.
      if (entry.paths.size === 0) continue
      releases.push({
        projectId: entry.projectId,
        driverId: entry.driverId,
        paths: [...entry.paths]
      })
      entry.paths.clear()
    }
    return releases
  }
}
