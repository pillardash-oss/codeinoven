import { attachmentPreviewKind, fileUrlToPath } from './mime'
import { localFilePreviewUrl } from './file-preview'
import type { AppBridge } from '../../preload/index'
import { SvelteSet } from 'svelte/reactivity'

declare global {
  interface Window {
    api: AppBridge
  }
}

/**
 * Resolves local media to scoped streaming URLs, since file:// URLs are blocked
 * on HTTP origins. Unsupported active formats such as SVG retain blob isolation.
 *
 * Usage:
 *   const images = new FileBlobUrlManager()
 *   $effect(() => { for (const part of parts) images.load(part.url, part.mime) })
 *   // in template: src={images.getUrl(part.url)}
 *   onDestroy(() => images.destroy())
 *
 * Because the read is asynchronous and can fail (a transient error, a missing
 * file, or an `onerror` on the element firing before the URL resolves), every
 * renderer that shows these images must also wire `onerror` to
 * {@link FileBlobUrlManager#bindImage} so the element can be repaired in place.
 */
export class FileBlobUrlManager {
  urls = $state<Record<string, string>>({})
  #pending: Record<string, true> = {}
  #unavailable = new SvelteSet<string>()

  /** Best-effort conversion. Failed sources are ignored for this manager's lifetime. */
  async load(url: string, mime: string): Promise<void> {
    if (
      !url.startsWith('file://') ||
      this.urls[url] ||
      this.#pending[url] ||
      this.#unavailable.has(url)
    )
      return
    this.#pending[url] = true
    try {
      const objectUrl = await this.#resolveUrl(url, mime)
      this.urls = { ...this.urls, [url]: objectUrl }
    } catch {
      // Missing or unapproved sources stay unavailable until this manager is
      // recreated with a changed attachment source; reactive updates do not retry.
      this.#unavailable.add(url)
    } finally {
      delete this.#pending[url]
    }
  }

  /**
   * Resolve the blob URL synchronously when already loaded, otherwise fall
   * back to the original URL.
   */
  getUrl(url: string): string {
    return this.urls[url] ?? url
  }

  /**
   * Repair an `<img>` that failed to render its current `src`. Used from the
   * element's `onerror` handler so the conversation recovers when the reactive
   * blob load finished after the element's first paint (or the read failed and
   * the raw file:// src is blocked on http origins).
   *
   * A failed element is rebound at most once per resolved URL — if the blob
   * itself is corrupt, `onerror` fires again and the guard below stops retrying.
   */
  async bindImage(url: string, mime: string, img: HTMLImageElement): Promise<void> {
    if (!img || this.#pending[url] || this.#unavailable.has(url)) return
    const resolved = this.urls[url]
    if (img.src === resolved) return
    try {
      const objectUrl = resolved ?? (await this.#resolveUrl(url, mime))
      this.urls = { ...this.urls, [url]: objectUrl }
      img.src = objectUrl
    } catch {
      this.#unavailable.add(url)
    }
  }

  /**
   * Same repair as {@link bindImage} but for `<video>`/`<audio>` elements
   * mounted before their streaming URL was resolved.
   */
  async bindMedia(url: string, mime: string, el: HTMLMediaElement): Promise<void> {
    if (!el || this.#pending[url] || this.#unavailable.has(url)) return
    const resolved = this.urls[url]
    if (el.currentSrc === resolved) return
    try {
      const objectUrl = resolved ?? (await this.#resolveUrl(url, mime))
      this.urls = { ...this.urls, [url]: objectUrl }
      el.src = objectUrl
    } catch {
      this.#unavailable.add(url)
    }
  }

  async #resolveUrl(url: string, mime: string): Promise<string> {
    const path = fileUrlToPath(url)
    const streamingUrl = localFilePreviewUrl(path, mime)
    if (streamingUrl) return streamingUrl
    const kind = attachmentPreviewKind(mime, path)
    if (kind === 'video' || kind === 'audio') {
      throw new Error('This media format has no streaming preview')
    }
    const data = await window.api.readFile(path)
    return URL.createObjectURL(new Blob([data], { type: mime }))
  }

  destroy(): void {
    for (const objectUrl of Object.values(this.urls)) {
      if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
    }
    this.#unavailable.clear()
  }
}
