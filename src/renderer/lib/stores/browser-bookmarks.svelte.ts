/**
 * The app's saved pages.
 *
 * Bookmarks belong to the person, not to a project or a profile, so one list
 * serves every browser surface the app shows: the star beside the global
 * browser's address, the history panel's own star, and the rail's bookmarks
 * panel. They are durable app state owned by the main process
 * (`browser:loadBookmarks` / `browser:saveBookmarks`), the durable contract the
 * global browser's history keeps as well.
 *
 * A bookmark is the user's own record, so it is editable: its title, its address,
 * its icon and its place in the list. And it is quick access rather than an
 * archive, so its default icon is the page's own favicon, copied into the record
 * when the page was saved instead of looked up afterwards; a chosen icon replaces
 * it, and asking for the page's own icon back drops it again. The list's order is
 * the stored order, which is what makes a move durable.
 *
 * Nothing here evicts: a bookmark is an intent, so the list only ever shrinks
 * because the user said so. The stored file is bounded by the parser instead.
 */

import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  BROWSER_LIBRARY_SAVE_COALESCE_MS,
  MAX_BROWSER_BOOKMARKS,
  browserBookmarkMatches,
  browserLibraryHost,
  isStorableBookmarkFavicon,
  normalizeBookmarkAddress,
  normalizeBrowserLibraryUrl,
  parseBrowserBookmarksSnapshot,
  type BrowserBookmark,
  type BrowserBookmarksSnapshot
} from '$shared/browser/browser-library'
import { MAX_BROWSER_TAB_PAGE_TITLE_LENGTH } from '$shared/browser/global-browser-tabs'
import { faviconState } from './favicons.svelte'
import { reportError } from './app-errors.svelte'

/** An empty list, shared so a panel's derived value does not churn on every read. */
const EMPTY_BOOKMARKS: BrowserBookmark[] = []

/**
 * What the bookmark editor sends back.
 *
 * The address is raw: the store owns what a bookmark's address may be, so the
 * editor cannot disagree with it.
 */
export interface BrowserBookmarkEdit {
  /** The label the row shows. Blank falls back to the page's host. */
  title: string
  /** The address, as the user typed it. */
  url: string
  iconType: string | null
  customSvg: string | null
  imagePath: string | null
}

export class BrowserBookmarkState {
  /** Every saved page, in the order the user put them in. */
  bookmarks: BrowserBookmark[] = $state(EMPTY_BOOKMARKS)

  /** True once the stored list has been read; nothing is written before then. */
  hydrated = $state(false)

  /** Data URLs for bookmarks wearing a picked image icon, keyed by bookmark id. */
  iconUrls: SvelteMap<string, string> = $state(new SvelteMap())

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
    // A saved page's icon is captured when the page is saved, and this is the
    // second chance at it: a page that comes back on screen with an icon the
    // record never got fills itself in. It rides a report the app is already
    // sending, so it is not a lookup of its own, and it is the only way the list
    // is ever filled in later.
    subscribe('browser:state', (state) => this.notePageIcon(state.url, state.favicon))
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

  /** The loaded data URL for a saved page's picked image icon, when it has one. */
  iconUrl(id: string): string | null {
    return this.iconUrls.get(id) ?? null
  }

  /** Read a saved page's picked image icon into a data URL, once. Best-effort: a
   *  missing file leaves the row on its favicon or its library icon. */
  async ensureIconLoaded(id: string): Promise<void> {
    const bookmark = this.bookmarks.find((candidate) => candidate.id === id)
    if (!bookmark?.imagePath) {
      this.iconUrls.delete(id)
      return
    }
    if (this.iconUrls.has(id)) return
    try {
      const url = await invoke('file:readAsDataUrl', bookmark.imagePath)
      if (url) this.iconUrls.set(id, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  /**
   * Save the page on screen, or take it out of the list again.
   *
   * `favicon` is the page's own icon, when the surface asking has it. Returns
   * whether the page is bookmarked afterwards, so a surface that toggles can say
   * what happened without re-reading the list.
   */
  toggle(url: string, title: string, favicon: string | null = null): boolean {
    const existing = this.find(url)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    return this.add(url, title, favicon) !== null
  }

  /** Save a page. A page already saved is left as it is, so clicking the star
   *  twice never makes two rows for one address. */
  add(url: string, title: string, favicon: string | null = null): BrowserBookmark | null {
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
      createdAt: Date.now(),
      favicon: isStorableBookmarkFavicon(favicon) ? favicon : null,
      iconType: null,
      customSvg: null,
      imagePath: null
    }
    this.mutatedSinceBoot = true
    this.bookmarks = [bookmark, ...this.bookmarks]
    this.persist()
    // A page saved from somewhere that had no icon of its own (a history row)
    // still gets one: the page's favicon is what a bookmark wears by default.
    if (bookmark.favicon === null) void this.captureFavicon(bookmark.id)
    return bookmark
  }

  /**
   * Apply the editor's changes to a saved page.
   *
   * Returns null when it landed, or the one thing wrong with it, which is what
   * the editor shows. A bookmark's address is its identity, so an address the
   * browser would not open, or one another saved page already has, is refused
   * rather than written.
   */
  applyEdit(id: string, edit: BrowserBookmarkEdit): string | null {
    const existing = this.bookmarks.find((candidate) => candidate.id === id)
    if (!existing) return null
    const url = normalizeBookmarkAddress(edit.url)
    if (url === null) return 'Enter a web address, like https://example.com.'
    if (this.bookmarks.some((candidate) => candidate.id !== id && candidate.url === url)) {
      return 'Another saved page already has that address.'
    }
    const trimmed = edit.title.trim()
    const title = trimmed === '' ? browserLibraryHost(url) : trimmed
    const reAddressed = url !== existing.url
    this.mutatedSinceBoot = true
    this.bookmarks = this.bookmarks.map((bookmark) =>
      bookmark.id === id
        ? {
            ...bookmark,
            url,
            title: title.slice(0, MAX_BROWSER_TAB_PAGE_TITLE_LENGTH),
            // A stored favicon belongs to the page that was saved, so a new
            // address drops it and captures the new page's own instead.
            favicon: reAddressed ? null : bookmark.favicon,
            iconType: edit.iconType,
            customSvg: edit.customSvg,
            imagePath: edit.imagePath
          }
        : bookmark
    )
    if (reAddressed || existing.imagePath !== edit.imagePath) {
      this.iconUrls.delete(id)
      if (edit.imagePath !== null) void this.ensureIconLoaded(id)
    }
    this.persist()
    if (reAddressed) void this.captureFavicon(id)
    return null
  }

  /**
   * Move a saved page to sit just before `beforeId`, or to the end of the list
   * when it is null.
   *
   * The one reordering primitive. The panel's drag and its move commands both
   * resolve the neighbour they mean and land here, so the gesture and the menu can
   * never order the list differently.
   */
  moveBefore(id: string, beforeId: string | null): void {
    if (beforeId === id) return
    const moving = this.bookmarks.find((bookmark) => bookmark.id === id)
    if (!moving) return
    const rest = this.bookmarks.filter((bookmark) => bookmark.id !== id)
    const target = beforeId === null ? -1 : rest.findIndex((bookmark) => bookmark.id === beforeId)
    const next = [...rest]
    next.splice(target < 0 ? rest.length : target, 0, moving)
    if (next.every((bookmark, index) => bookmark.id === this.bookmarks[index]?.id)) return
    this.mutatedSinceBoot = true
    this.bookmarks = next
    this.persist()
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

  /**
   * Fill in a saved page's own icon when the app did not have it at the moment the
   * page was saved.
   *
   * A page's favicon is what a bookmark wears by default, and the app already
   * resolves a site's favicon for every other surface that shows one. This asks
   * the same resolver once, so a page saved from a history row carries the icon it
   * would have had if it had been saved from the page itself, and writes it down:
   * the icon is a copy, so it survives an offline restart. Best-effort, and never
   * overwriting an icon that arrived in the meantime.
   */
  private async captureFavicon(id: string): Promise<void> {
    const bookmark = this.bookmarks.find((candidate) => candidate.id === id)
    if (!bookmark || bookmark.favicon !== null) return
    // The address as it was when the lookup started: the user can re-address the
    // bookmark while it is in flight, and the page they left behind is not the
    // page the answer belongs to.
    const url = bookmark.url
    const resolved = await faviconState.resolve(url)
    if (!isStorableBookmarkFavicon(resolved)) return
    const current = this.bookmarks.find((candidate) => candidate.id === id)
    if (!current || current.url !== url || current.favicon !== null) return
    this.mutatedSinceBoot = true
    this.bookmarks = this.bookmarks.map((candidate) =>
      candidate.id === id ? { ...candidate, favicon: resolved } : candidate
    )
    this.persist()
  }

  /**
   * Fill in a saved page's icon from the page itself, when the page is on screen.
   *
   * The second chance at the default icon: a record whose lookup never answered
   * (the app quit first, or the site had nothing to answer with) takes the icon
   * from the next visit to that page. Only a record with no icon at all is filled,
   * and only its own address, so an icon the user chose is never overwritten.
   */
  private notePageIcon(url: string, favicon: string | null): void {
    if (!isStorableBookmarkFavicon(favicon)) return
    const bookmark = this.find(url)
    if (!bookmark) return
    if (
      bookmark.favicon !== null ||
      bookmark.iconType !== null ||
      bookmark.customSvg !== null ||
      bookmark.imagePath !== null
    ) {
      return
    }
    this.mutatedSinceBoot = true
    this.bookmarks = this.bookmarks.map((candidate) =>
      candidate.id === bookmark.id ? { ...candidate, favicon } : candidate
    )
    this.persist()
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
   *  per address, in the user's order: this session's list first, then whatever
   *  the file held that it did not. */
  private merge(stored: readonly BrowserBookmark[]): BrowserBookmark[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(this.bookmarks.map((bookmark) => bookmark.url))
    const merged = [...this.bookmarks]
    for (const bookmark of stored) {
      if (known.has(bookmark.url)) continue
      known.add(bookmark.url)
      merged.push(bookmark)
    }
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
