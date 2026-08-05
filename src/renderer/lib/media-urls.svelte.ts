import { fileUrlToPath } from './mime'
import type { AppBridge } from '../../preload/index'

declare global {
  interface Window {
    api: AppBridge
  }
}

/**
 * Manages conversion of `file://` URLs to `blob:` Object URLs for reliable
 * display in the Electron renderer (file:// URLs are blocked on http:// origins).
 *
 * Usage:
 *   const images = new FileBlobUrlManager()
 *   $effect(() => { for (const part of parts) images.load(part.url, part.mime) })
 *   // in template: src={images.getUrl(part.url)}
 *   onDestroy(() => images.destroy())
 *
 * Because the read is asynchronous and can fail (a transient error, a missing
 * file, or an `onerror` on the element firing before the blob resolves), every
 * renderer that shows these images must also wire `onerror` to
 * {@link FileBlobUrlManager#bindImage} so the element can be repaired in place.
 */
export class FileBlobUrlManager {
  urls = $state<Record<string, string>>({})
  #pending: Record<string, true> = {}

  /** Best-effort conversion. Fails are marked retryable, never permanent. */
  async load(url: string, mime: string): Promise<void> {
    if (!url.startsWith('file://') || this.urls[url] || this.#pending[url]) return
    this.#pending[url] = true
    try {
      const objectUrl = await this.#toObjectUrl(url, mime)
      this.urls = { ...this.urls, [url]: objectUrl }
    } catch {
      // Blob URL failed; fall back to file:// URL and allow a later retry.
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
    if (!img) return
    const resolved = this.urls[url]
    if (img.src === resolved) return
    try {
      const objectUrl = resolved ?? (await this.#toObjectUrl(url, mime))
      this.urls = { ...this.urls, [url]: objectUrl }
      img.src = objectUrl
    } catch {
      // The original src stays in place; nothing else we can do.
    }
  }

  async #toObjectUrl(url: string, mime: string): Promise<string> {
    const path = fileUrlToPath(url)
    const data = await window.api.readFile(path)
    return URL.createObjectURL(new Blob([data], { type: mime }))
  }

  destroy(): void {
    for (const objectUrl of Object.values(this.urls)) {
      URL.revokeObjectURL(objectUrl)
    }
  }
}
