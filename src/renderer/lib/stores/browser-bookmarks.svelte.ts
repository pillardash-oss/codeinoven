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
  MAX_BROWSER_BOOKMARK_GROUPS,
  MAX_BROWSER_BOOKMARKS,
  browserBookmarkMatches,
  browserLibraryHost,
  normalizeBookmarkAddress,
  normalizeBrowserLibraryUrl,
  parseBrowserBookmarksSnapshot,
  type BrowserBookmark,
  type BrowserBookmarkGroup,
  type BrowserBookmarksSnapshot
} from '$shared/browser/browser-library'
import {
  DEFAULT_BOX_ID,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_PAGE_TITLE_LENGTH,
  isStorableBrowserFavicon,
  type BrowserAppearance
} from '$shared/browser/global-browser-tabs'
import { faviconState } from './favicons.svelte'
import { reportError } from './app-errors.svelte'

/** An empty list, shared so a panel's derived value does not churn on every read. */
const EMPTY_BOOKMARKS: BrowserBookmark[] = []
/** The empty group list, shared for the same reason as {@link EMPTY_BOOKMARKS}. */
const EMPTY_GROUPS: BrowserBookmarkGroup[] = []

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

  /** Every saved-page group, in the order the user put them in. */
  groups: BrowserBookmarkGroup[] = $state(EMPTY_GROUPS)

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
    subscribe('browser:state', (state) => this.notePageIcon(state.url, state.favicon, state.boxId))
    void this.hydrate()
  }

  dispose(): void {
    this.started = false
    this.cancelPendingSave()
  }

  /** The saved page for an address, or null. */
  find(url: string, boxId: string | null = null): BrowserBookmark | null {
    const normalized = normalizeBrowserLibraryUrl(url)
    if (normalized === null) return null
    const box = boxId === DEFAULT_BOX_ID ? null : boxId
    return (
      this.bookmarks.find(
        (bookmark) => bookmark.url === normalized && (bookmark.boxId ?? null) === box
      ) ?? null
    )
  }

  isBookmarked(url: string, boxId: string | null = null): boolean {
    return this.find(url, boxId) !== null
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
  toggle(
    url: string,
    title: string,
    favicon: string | null = null,
    boxId: string | null = null
  ): boolean {
    const existing = this.find(url, boxId)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    return this.add(url, title, favicon, boxId) !== null
  }

  /** Save a page. A page already saved is left as it is, so clicking the star
   *  twice never makes two rows for one address. */
  add(
    url: string,
    title: string,
    favicon: string | null = null,
    boxId: string | null = null
  ): BrowserBookmark | null {
    const normalized = normalizeBrowserLibraryUrl(url)
    if (normalized === null) return null
    const existing = this.find(normalized, boxId)
    if (existing) return existing
    if (this.bookmarks.length >= MAX_BROWSER_BOOKMARKS) return null
    const trimmed = title.trim()
    const bookmark: BrowserBookmark = {
      id: `bookmark:${crypto.randomUUID()}`,
      url: normalized,
      boxId: boxId === DEFAULT_BOX_ID ? null : boxId,
      // A page that never reported a title is still worth saving: its host is the
      // label every surface shows in that case.
      title: trimmed === '' ? browserLibraryHost(normalized) : trimmed,
      createdAt: Date.now(),
      favicon: isStorableBrowserFavicon(favicon) ? favicon : null,
      iconType: null,
      customSvg: null,
      imagePath: null,
      groupId: null
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
    if (
      this.bookmarks.some(
        (candidate) =>
          candidate.id !== id &&
          candidate.url === url &&
          (candidate.boxId ?? null) === (existing.boxId ?? null)
      )
    ) {
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
   * never order the list differently. A page dropped beside another adopts that
   * page's group, which is what makes a drag across a fold a move into it.
   */
  moveBefore(id: string, beforeId: string | null): void {
    if (beforeId === id) return
    const moving = this.bookmarks.find((bookmark) => bookmark.id === id)
    if (!moving) return
    const rest = this.bookmarks.filter((bookmark) => bookmark.id !== id)
    const target = beforeId === null ? -1 : rest.findIndex((bookmark) => bookmark.id === beforeId)
    const insertIndex = target < 0 ? rest.length : target
    const groupId = beforeId === null ? moving.groupId : (rest[target]?.groupId ?? moving.groupId)
    const placed = groupId === moving.groupId ? moving : { ...moving, groupId }
    const next = [...rest]
    next.splice(insertIndex, 0, placed)
    if (
      next.every(
        (bookmark, index) =>
          bookmark.id === this.bookmarks[index]?.id &&
          bookmark.groupId === this.bookmarks[index]?.groupId
      )
    ) {
      return
    }
    this.mutatedSinceBoot = true
    this.bookmarks = next
    this.persist()
  }

  /**
   * File a saved page under a group, or take it out of one when `groupId` is null.
   *
   * This is the gesture a drop on a fold header makes: the page joins the group at
   * the end of its run, so a drag that lands on a header reads the way it looks.
   */
  moveToGroup(id: string, groupId: string | null): void {
    this.moveToGroupBefore(id, groupId, null)
  }

  /**
   * File a saved page under a group and place it in one step.
   *
   * A drop that lands on a row names both the group and the position, so this is
   * one write rather than a move followed by a reorder. A null `beforeId` leaves
   * the page at the end of its group's run.
   */
  moveToGroupBefore(id: string, groupId: string | null, beforeId: string | null): void {
    if (groupId !== null && !this.groups.some((group) => group.id === groupId)) return
    const bookmark = this.bookmarks.find((candidate) => candidate.id === id)
    if (!bookmark) return
    const rest = this.bookmarks.filter((candidate) => candidate.id !== id)
    let insertIndex: number
    if (beforeId !== null) {
      const target = rest.findIndex((candidate) => candidate.id === beforeId)
      insertIndex = target < 0 ? rest.length : target
    } else {
      const lastIndex = groupId === null ? -1 : rest.findLastIndex((c) => c.groupId === groupId)
      insertIndex = lastIndex < 0 ? rest.length : lastIndex + 1
    }
    const next = [...rest]
    next.splice(insertIndex, 0, { ...bookmark, groupId })
    if (
      next.every(
        (candidate, index) =>
          candidate.id === this.bookmarks[index]?.id &&
          candidate.groupId === this.bookmarks[index]?.groupId
      )
    ) {
      return
    }
    this.mutatedSinceBoot = true
    this.bookmarks = next
    this.persist()
  }

  // ─── Groups ─────────────────────────────────────────────────────────────

  /** One group by id, or null once it has been removed. */
  groupById(id: string): BrowserBookmarkGroup | null {
    return this.groups.find((group) => group.id === id) ?? null
  }

  /** The saved pages filed under a group, in list order. */
  inGroup(id: string): BrowserBookmark[] {
    return this.bookmarks.filter((bookmark) => bookmark.groupId === id)
  }

  /**
   * Make a group and return its id.
   *
   * At the cap the call is a no-op that returns an unusable id, the way the tab
   * group cap is enforced, so a caller cannot keep making folds without bound.
   */
  createGroup(name: string, appearance: Partial<BrowserAppearance> = {}): string {
    const id = `bookmark-group:${crypto.randomUUID()}`
    if (this.groups.length >= MAX_BROWSER_BOOKMARK_GROUPS) return id
    this.mutatedSinceBoot = true
    this.groups = [
      ...this.groups,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH) || 'New group',
        color: appearance.color ?? null,
        iconType: appearance.iconType ?? null,
        customSvg: appearance.customSvg ?? null,
        imagePath: appearance.imagePath ?? null
      }
    ]
    this.persist()
    if (appearance.imagePath) void this.ensureGroupIconLoaded(id)
    return id
  }

  updateGroup(id: string, patch: Partial<Omit<BrowserBookmarkGroup, 'id'>>): void {
    const group = this.groups.find((candidate) => candidate.id === id)
    if (!group) return
    this.mutatedSinceBoot = true
    this.groups = this.groups.map((candidate) => {
      if (candidate.id !== id) return candidate
      let name = candidate.name
      if (patch.name !== undefined) {
        const trimmed = patch.name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH)
        if (trimmed) name = trimmed
      }
      return {
        ...candidate,
        name,
        color: patch.color !== undefined ? patch.color : candidate.color,
        iconType: patch.iconType !== undefined ? patch.iconType : candidate.iconType,
        customSvg: patch.customSvg !== undefined ? patch.customSvg : candidate.customSvg,
        imagePath: patch.imagePath !== undefined ? patch.imagePath : candidate.imagePath
      }
    })
    // A new or cleared image must not keep showing the previous one's bytes.
    if (patch.imagePath !== undefined) {
      this.iconUrls.delete(id)
      void this.ensureGroupIconLoaded(id)
    }
    this.persist()
  }

  /** Remove a group. Its pages stay saved and become ungrouped, because losing a
   *  fold must never lose a bookmark. */
  deleteGroup(id: string): void {
    if (!this.groups.some((group) => group.id === id)) return
    this.mutatedSinceBoot = true
    this.groups = this.groups.filter((group) => group.id !== id)
    this.iconUrls.delete(id)
    this.bookmarks = this.bookmarks.map((bookmark) =>
      bookmark.groupId === id ? { ...bookmark, groupId: null } : bookmark
    )
    this.persist()
  }

  /** Move a group to sit just before `beforeId`, or to the end when it is null. */
  moveGroupBefore(id: string, beforeId: string | null): void {
    if (beforeId === id) return
    const moving = this.groups.find((group) => group.id === id)
    if (!moving) return
    const rest = this.groups.filter((group) => group.id !== id)
    const target = beforeId === null ? -1 : rest.findIndex((group) => group.id === beforeId)
    const next = [...rest]
    next.splice(target < 0 ? rest.length : target, 0, moving)
    if (next.every((group, index) => group.id === this.groups[index]?.id)) return
    this.mutatedSinceBoot = true
    this.groups = next
    this.persist()
  }

  /** Read a group's picked image icon into a data URL, once. Best-effort: a
   *  missing file leaves the group on its colour or library icon. */
  async ensureGroupIconLoaded(id: string): Promise<void> {
    const group = this.groups.find((candidate) => candidate.id === id)
    if (!group?.imagePath) {
      this.iconUrls.delete(id)
      return
    }
    if (this.iconUrls.has(id)) return
    try {
      const url = await invoke('file:readAsDataUrl', group.imagePath)
      if (url) this.iconUrls.set(id, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
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
    this.groups = EMPTY_GROUPS
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
    if (!isStorableBrowserFavicon(resolved)) return
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
  private notePageIcon(url: string, favicon: string | null, boxId: string | null): void {
    if (!isStorableBrowserFavicon(favicon)) return
    const bookmark = this.find(url, boxId)
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
    const parsed = parseBrowserBookmarksSnapshot(stored)
    if (parsed.bookmarks.length > 0) {
      this.bookmarks = this.mutatedSinceBoot ? this.merge(parsed.bookmarks) : parsed.bookmarks
    }
    if (parsed.groups.length > 0) {
      this.groups = this.mutatedSinceBoot ? this.mergeGroups(parsed.groups) : parsed.groups
    }
    this.hydrated = true
    if (this.mutatedSinceBoot) this.persist()
  }

  /** The stored list folded under the saves this session already made, one row
   *  per address, in the user's order: this session's list first, then whatever
   *  the file held that it did not. */
  private merge(stored: readonly BrowserBookmark[]): BrowserBookmark[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(
      this.bookmarks.map((bookmark) => JSON.stringify([bookmark.boxId ?? null, bookmark.url]))
    )
    const merged = [...this.bookmarks]
    for (const bookmark of stored) {
      const identity = JSON.stringify([bookmark.boxId ?? null, bookmark.url])
      if (known.has(identity)) continue
      known.add(identity)
      merged.push(bookmark)
    }
    return merged
  }

  /** The stored groups folded under the ones this session already made, one group
   *  per id: this session's groups first, then whatever the file held that it did
   *  not. */
  private mergeGroups(stored: readonly BrowserBookmarkGroup[]): BrowserBookmarkGroup[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const known = new Set(this.groups.map((group) => group.id))
    const merged = [...this.groups]
    for (const group of stored) {
      if (known.has(group.id)) continue
      known.add(group.id)
      merged.push(group)
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
    const snapshot: BrowserBookmarksSnapshot = {
      bookmarks: $state.snapshot(this.bookmarks),
      groups: $state.snapshot(this.groups)
    }
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
