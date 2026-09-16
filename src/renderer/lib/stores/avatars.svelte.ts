import { invoke } from '$lib/ipc.svelte'

/**
 * Shared, reactive cache of GitHub avatars keyed by login.
 *
 * The renderer CSP blocks remote image hosts, so logins are batched and resolved
 * through main, which returns `data:` URLs, the same route link favicons take. Every
 * batch bumps a reactive version so `$derived` rendering re-runs and the picture
 * replaces the monogram once it arrives. A login GitHub has no picture for is cached
 * as null, which keeps the monogram and stops the question being asked twice.
 */
class AvatarState {
  /** Logins per IPC call, matching the favicon batches and the main-side cap. */
  private static readonly BATCH_SIZE = 32

  /** login -> data URL, or null once main reported that there is no picture. */
  private readonly resolved = new Map<string, string | null>()
  /** logins already sent to main, positive or negative. */
  private readonly requested = new Set<string>()
  /** logins waiting for the next batch. */
  private readonly pending = new Set<string>()
  private inflight: Promise<void> | null = null
  /** Reactive version, bumped whenever a batch lands. */
  private refreshKey = $state(0)

  /** Reactive version, read to subscribe to avatar resolution. */
  get version(): number {
    return this.refreshKey
  }

  /**
   * The avatar data URL for a login, or null while it is unknown or missing. Reads
   * the reactive version so a row re-renders when its picture arrives.
   */
  avatarFor(login: string): string | null {
    void this.refreshKey
    return this.resolved.get(login) ?? null
  }

  /** Queue resolution for every login that has not been asked about yet. */
  ensureResolved(logins: readonly string[]): void {
    let queued = false
    for (const login of logins) {
      if (login.length === 0 || this.requested.has(login)) continue
      this.requested.add(login)
      this.pending.add(login)
      queued = true
    }
    if (!queued || this.inflight !== null) return

    const drain = this.drain()
    this.inflight = drain
    void drain.finally(() => {
      if (this.inflight === drain) this.inflight = null
    })
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = [...this.pending].slice(0, AvatarState.BATCH_SIZE)
      for (const login of batch) this.pending.delete(login)
      try {
        const resolved = await invoke('github:avatars', batch)
        for (const [login, dataUrl] of Object.entries(resolved)) {
          this.resolved.set(login, dataUrl)
        }
      } catch {
        // A batch that fails leaves every login in it without a picture, and the
        // monogram stands in.
        for (const login of batch) {
          if (!this.resolved.has(login)) this.resolved.set(login, null)
        }
      }
      this.refreshKey++
    }
  }
}

export const avatarState = new AvatarState()
