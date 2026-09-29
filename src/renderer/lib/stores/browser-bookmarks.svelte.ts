/**
 * The app's saved pages.
 *
 * Bookmarks belong to the person, not to a project or a profile, so one list
 * serves every browser surface the app shows: the star beside any address, the
 * spotlight, and the rail's bookmarks panel. They are durable app state owned by
 * the main process (`browser:loadBookmarks` / `browser:saveBookmarks`), the same
 * contract the browsing history follows and for the same reason.
 *
 * Nothing here evicts: a bookmark is an intent, so the list only ever shrinks
 * because the user said so. The stored file is bounded by the parser instead.
 */

import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  BROWSER_LIBRARY_SAVE_COALESCE_MS,
  MAX_BROWSER_BOOKMARKS,
  browserBookmarkMatches,
  browserLibraryHost,
  normalizeBrowserLibraryUrl,
  parseBrowserBookmarksSnapshot,
  type BrowserBookmark,
  type BrowserBookmarksSnapshot
} from '$shared/browser/browser-library'
import { reportError } from './app-errors.svelte'

/** An empty list, shared so a panel's derived value does not churn on every read. */
const EMPTY_BOOKMARKS: BrowserBookmark[] = []

export class BrowserBookmarkState {
  /** Every saved page, newest first. */
  bookmarks: BrowserBookmark[] = $state(EMPTY_BOOKMARKS)

  /** True once the stored list has been read; nothing is written before then. */
  hydrated = $state(false)

  private saveTimer: number | null = null
  /** Whether this session changed the list while the stored list was still
   *  arriving, which is what makes the read merge instead of replace. */
  private mutatedSinceBoot = false
  private started = false

  get count(): number {
    return this.bookmarks.length
  }

  /** Wire the runtime and read the stored list. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    subscribe('window:beforeQuit', () => this.flush())
    void this.hydrate()
  }

  dispose(): void {
    this.started = false
    this.cancelPendingSave()
  }

  /** The saved page for an address, or null. */
  find(url: string): BrowserBookmark | null {
    const normalized = normalizeBrowserLibraryUrl(url)
    if (normalized === null) return null
    return this.bookmarks.find((bookmark) => bookmark.url === normalized) ?? null
  }

  isBookmarked(url: string): boolean {
    return this.find(url) !== null
  }

  /**
   * Save the page on screen, or take it out of the list again.
   *
   * Returns whether the page is bookmarked afterwards, so a surface that toggles
   * can say what happened without re-reading the list.
   */
  toggle(url: string, title: string): boolean {
    const existing = this.find(url)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    return this.add(url, title) !== null
  }

  /** Save a page. A page already saved is left as it is, so clicking the star
   *  twice never makes two rows for one address. */
  add(url: string, title: string): BrowserBookmark | null {
    const normalized = normalizeBrowserLibraryUrl(url)
    if (normalized === null) return null
    const existing = this.find(normalized)
    if (existing) return existing
    if (this.bookmarks.length >= MAX_BROWSER_BOOKMARKS) return null
    const trimmed = title.trim()
    const bookmark: BrowserBookmark = {
      id: `bookmark:${crypto.randomUUID()}`,
      url: normalized,
      // A page that never reported a title is still worth saving: its host is the
      // label every surface shows in that case.
      title: trimmed === '' ? browserLibraryHost(normalized) : trimmed,
      createdAt: Date.now()
    }
    this.mutatedSinceBoot = true
    this.bookmarks = [bookmark, ...this.bookmarks]
    this.persist()
    return bookmark
  }

  remove(id: string): void {
    if (!this.bookmarks.some((bookmark) => bookmark.id === id)) return
    this.mutatedSinceBoot = true
    this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id)
    this.persist()
  }

  /** The saved pages answering a query, in list order. */
  search(query: string): BrowserBookmark[] {
    const needle = query.trim()
    if (needle === '') return this.bookmarks
    return this.bookmarks.filter((bookmark) => browserBookmarkMatches(bookmark, needle))
  }

  /** Forget every saved page. Applied in main as well, for the same reason the
   *  history clear is: a pending write must not put back what was cleared. */
  async clear(): Promise<void> {
    this.cancelPendingSave()
    this.bookmarks = EMPTY_BOOKMARKS
    try {
      await invoke('browser:clearBookmarks')
    } catch (error) {
      reportError(error, 'The bookmarks could not be cleared.')
    }
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  private async hydrate(): Promise<void> {
    let stored: BrowserBookmarksSnapshot | null = null
    try {
      stored = await invoke('browser:loadBookmarks')
    } catch (error) {
      reportError(error, 'The saved bookmarks could not be read.')
    }
    const bookmarks = parseBrowserBookmarksSnapshot(stored).bookmarks
    if (bookmarks.length > 0) {
      this.bookmarks = this.mutatedSinceBoot ? this.merge(bookmarks) : bookmarks
    }
    this.hydrated = true
    if (this.mutatedSinceBoot) this.persist()
  }

  /** The stored list folded under the saves this session already made, one row
   *  per address, newest first. */
  private merge(stored: readonly BrowserBookmark[]): BrowserBookmark[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(this.bookmarks.map((bookmark) => bookmark.url))
    const merged = [...this.bookmarks]
    for (const bookmark of stored) {
      if (known.has(bookmark.url)) continue
      known.add(bookmark.url)
      merged.push(bookmark)
    }
    merged.sort((a, b) => b.createdAt - a.createdAt)
    return merged
  }

  private persist(): void {
    if (!this.started || !this.hydrated) return
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.flush(), BROWSER_LIBRARY_SAVE_COALESCE_MS)
  }

  private flush(): void {
    this.cancelPendingSave()
    if (!this.hydrated) return
    const snapshot: BrowserBookmarksSnapshot = { bookmarks: $state.snapshot(this.bookmarks) }
    void invoke('browser:saveBookmarks', snapshot).catch((error: unknown) => {
      reportError(error, 'The bookmarks could not be saved.')
    })
  }

  private cancelPendingSave(): void {
    if (this.saveTimer === null) return
    window.clearTimeout(this.saveTimer)
    this.saveTimer = null
  }
}

export const browserBookmarks = new BrowserBookmarkState()
