import { APP_SLUG } from '$shared/brand'
import type { SkillMarketEntry } from '$shared/types'

const STORAGE_KEY = `${APP_SLUG}.skillBookmarks.v1`

/** Hard ceiling on stored bookmarks, so the list can never grow without bound. */
const MAX_BOOKMARKS = 500

/** A bookmarked marketplace skill, stored whole so the list renders offline. */
export interface SkillBookmark extends SkillMarketEntry {
  /** Epoch ms of the bookmark action; the list is ordered newest first. */
  bookmarkedAt: number
}

/**
 * Accessible label for a bookmark control, accurate in both states.
 *
 * Call sites pass the result as the control's required `title`, so the tooltip
 * and the accessible name always describe the action the click performs.
 */
export function skillBookmarkTitle(name: string, bookmarked: boolean): string {
  return bookmarked ? `Remove bookmark for ${name}` : `Bookmark ${name}`
}

/** Rebuild one stored bookmark, discarding anything that is not recognisable. */
function parseBookmark(value: unknown): SkillBookmark | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.skillId !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.source !== 'string' ||
    typeof record.url !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    skillId: record.skillId,
    name: record.name,
    source: record.source,
    url: record.url,
    installs: typeof record.installs === 'number' ? record.installs : 0,
    ...(record.isOfficial === true ? { isOfficial: true } : {}),
    bookmarkedAt: typeof record.bookmarkedAt === 'number' ? record.bookmarkedAt : Date.now()
  }
}

function load(): SkillBookmark[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(parseBookmark)
      .filter((bookmark): bookmark is SkillBookmark => bookmark !== null)
      .sort((left, right) => right.bookmarkedAt - left.bookmarkedAt)
      .slice(0, MAX_BOOKMARKS)
  } catch {
    // Corrupt or unavailable storage must not break the marketplace.
    return []
  }
}

/**
 * Marketplace skills the user bookmarked instead of installing.
 *
 * Bookmarks are renderer preferences, so they live in localStorage like every
 * other view preference and stay available without a marketplace round trip.
 */
class SkillBookmarkStore {
  /** Bookmarked skills, newest first. */
  bookmarks = $state<SkillBookmark[]>(load())

  /** Number of bookmarked skills, for tab badges and empty states. */
  get count(): number {
    return this.bookmarks.length
  }

  isBookmarked(id: string): boolean {
    return this.bookmarks.some((bookmark) => bookmark.id === id)
  }

  /** Adds or removes the skill; returns true when it is bookmarked afterwards. */
  toggle(entry: SkillMarketEntry): boolean {
    if (this.isBookmarked(entry.id)) {
      this.remove(entry.id)
      return false
    }
    this.bookmarks = [{ ...entry, bookmarkedAt: Date.now() }, ...this.bookmarks].slice(
      0,
      MAX_BOOKMARKS
    )
    this.persist()
    return true
  }

  remove(id: string): void {
    this.bookmarks = this.bookmarks.filter((bookmark) => bookmark.id !== id)
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bookmarks))
    } catch {
      // Bookmarks are optional; unavailable storage must not break the UI.
    }
  }
}

export const skillBookmarkState = new SkillBookmarkStore()
