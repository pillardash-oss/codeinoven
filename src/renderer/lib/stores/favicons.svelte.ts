import { invoke } from '$lib/ipc.svelte'

/**
 * Shared, reactive cache of website favicons keyed by hostname.
 *
 * External links in conversation output and the sources panel want the site's
 * favicon. The renderer CSP blocks remote images, so hostnames are batched and
 * resolved through main, which returns `data:` URLs. Every successful batch
 * bumps a reactive version so `$derived` rendering re-runs and the icon appears.
 */
interface FaviconStateCache {
  /** hostname -> data URL, or null when the host has no discoverable icon. */
  resolved: Map<string, string | null>
  /** hostnames already sent to main (positive or negative). */
  requested: Set<string>
  /** hostnames queued for the next batch resolution. */
  pending: Set<string>
}

class FaviconState {
  private readonly cache = new Map<string, FaviconStateCache>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Reactive version — bumped whenever a batch resolution updates the cache. */
  private refreshKey = $state(0)

  private cacheFor(): FaviconStateCache {
    let cache = this.cache.get('global')
    if (!cache) {
      cache = { resolved: new Map(), requested: new Set(), pending: new Set() }
      this.cache.set('global', cache)
    }
    return cache
  }

  /** Reactive version — read to subscribe to favicon resolution changes. */
  get version(): number {
    return this.refreshKey
  }

  /** Extract the hostname from a URL, or null when it is not an http(s) URL. */
  hostnameOf(url: string): string | null {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.hostname.toLowerCase().replace(/\.$/u, '')
    } catch {
      return null
    }
  }

  /** External http(s) URLs found in a markdown text blob. */
  externalUrlsFromText(text: string): string[] {
    const pattern = /https?:\/\/[^\s<>"'`)\]}]+/gu
    return [...text.matchAll(pattern)].map((match) => match[0].replace(/[.,;:!?]+$/gu, ''))
  }

  /**
   * The favicon data URL for a host, or null when none was found. Reads the
   * reactive version so callers re-run when a favicon resolves.
   */
  faviconFor(url: string): string | null {
    void this.refreshKey
    const hostname = this.hostnameOf(url)
    if (!hostname) return null
    return this.cacheFor().resolved.get(hostname) ?? null
  }

  /** Queue favicon resolution for every unique hostname in the given URLs. */
  ensureResolved(urls: string[]): void {
    const cache = this.cacheFor()
    for (const url of urls) {
      const hostname = this.hostnameOf(url)
      if (!hostname || cache.requested.has(hostname)) continue
      cache.requested.add(hostname)
      cache.pending.add(hostname)
    }
    if (cache.pending.size === 0 || this.inflight.has('global')) return

    const drain = this.drain(cache)
    this.inflight.set('global', drain)
    void drain.finally(() => {
      if (this.inflight.get('global') === drain) this.inflight.delete('global')
    })
  }

  private async drain(cache: FaviconStateCache): Promise<void> {
    while (cache.pending.size > 0) {
      const batch = [...cache.pending]
      cache.pending.clear()
      try {
        const resolved = await invoke('web:favicon', batch)
        for (const [hostname, dataUrl] of Object.entries(resolved)) {
          cache.resolved.set(hostname, dataUrl)
        }
      } catch {
        // Unresolvable hosts simply never show a favicon.
        for (const hostname of batch) {
          if (!cache.resolved.has(hostname)) cache.resolved.set(hostname, null)
        }
      }
      this.refreshKey++
    }
  }
}

export const faviconState = new FaviconState()
