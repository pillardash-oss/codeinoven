import { invoke } from '$lib/ipc.svelte'
import { imageUrlsFromMarkdown } from '$lib/markdown-remote-images'

/**
 * Shared, reactive cache of remote images embedded in provider-authored markdown,
 * keyed by the image URL.
 *
 * The renderer CSP blocks remote image hosts, so URLs are batched and resolved
 * through main, which returns `data:` URLs, the same route avatars and link
 * favicons take. Markdown renders synchronously, so `imageFor` answers with
 * whatever is known right now (null before the picture lands) while resolution
 * happens in the background. Every landed batch bumps a reactive version so the
 * `$derived` that draws the markdown re-runs and the picture appears in place.
 * A URL main could not fetch is cached as null, which stops the question being
 * asked again for the rest of the session.
 */
class GithubImageState {
  /** URLs per IPC call, matching the avatar/favicon batches and main's per-call cap. */
  private static readonly BATCH_SIZE = 32

  /** URL -> data URL, or null once main reported that the image cannot be fetched. */
  private readonly resolved = new Map<string, string | null>()
  /** URLs already sent to main, positive or negative. */
  private readonly requested = new Set<string>()
  /** URLs waiting for the next batch. */
  private readonly pending = new Set<string>()
  private inflight: Promise<void> | null = null
  /** Reactive version, bumped whenever a batch lands. */
  private refreshKey = $state(0)

  /** Reactive version, read to subscribe to image resolution. */
  get version(): number {
    return this.refreshKey
  }

  /**
   * The image data URL for a URL, or null while it is unknown or missing. Reads the
   * reactive version so markdown re-renders when its picture arrives.
   */
  imageFor(url: string): string | null {
    void this.refreshKey
    return this.resolved.get(url) ?? null
  }

  /** Queue resolution for every image URL that has not been asked about yet. */
  ensureResolved(urls: readonly string[]): void {
    let queued = false
    for (const url of urls) {
      if (!this.isResolvable(url) || this.requested.has(url)) continue
      this.requested.add(url)
      this.pending.add(url)
      queued = true
    }
    if (!queued || this.inflight !== null) return

    const drain = this.drain()
    this.inflight = drain
    void drain.finally(() => {
      if (this.inflight === drain) this.inflight = null
    })
  }

  /**
   * Image URLs in a markdown source, for the effect that queues resolution.
   *
   * The extraction itself is shared with the renderer's own `<img>` rewrite, so
   * the store can never queue one set of URLs while the renderer waits on
   * another.
   */
  imageUrlsFromText(text: string): string[] {
    return imageUrlsFromMarkdown(text)
  }

  /**
   * Only `https:` is queued. The duplication with main is deliberate: main
   * validates because it is the thing that actually fetches (and it also refuses
   * literal private hosts), while the store filters because it must not spend an
   * IPC round trip on a URL that provably cannot resolve.
   */
  private isResolvable(url: string): boolean {
    try {
      return new URL(url).protocol === 'https:'
    } catch {
      return false
    }
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = [...this.pending].slice(0, GithubImageState.BATCH_SIZE)
      for (const url of batch) this.pending.delete(url)
      try {
        const resolved = await invoke('github:image', batch)
        for (const [url, dataUrl] of Object.entries(resolved)) {
          this.resolved.set(url, dataUrl)
        }
      } catch {
        // A batch that fails leaves every URL in it without an image, and the
        // markdown falls back to its alt text or link.
        for (const url of batch) {
          if (!this.resolved.has(url)) this.resolved.set(url, null)
        }
      }
      this.refreshKey++
    }
  }
}

export const githubImageState = new GithubImageState()
