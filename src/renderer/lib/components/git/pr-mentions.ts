import type { RepositoryMentionUser } from '$shared/types'

/**
 * Candidates the popover shows before it starts scrolling. Kept deliberately
 * small: the dock is a narrow column, so a longer list would scroll past the
 * point where a person can be recognised at a glance.
 */
const MENTION_LIMIT = 12

/**
 * The handle to insert for an account.
 *
 * App accounts carry a `[bot]` suffix on their login (`dependabot[bot]`), but the
 * mention is the app's own slug: bracketed text is Markdown link syntax, so
 * writing the raw login would either fail to resolve or swallow the suffix as a
 * label. Mentions therefore drop it, matching how GitHub's own UI links apps.
 */
export function mentionHandle(user: RepositoryMentionUser): string {
  return user.login.replace(/\[bot\]$/u, '')
}

/**
 * Accounts already visible on the pull request, built from the logins the bundle
 * carries (author, commenters, reviewers).
 *
 * These cost no network call, so they are what the popover opens with while the
 * repository directory is still loading. Duplicates are dropped by login, since
 * one person commonly authors several comments and reviews.
 */
export function participantMentionUsers(
  logins: readonly (string | null | undefined)[]
): RepositoryMentionUser[] {
  const seen = new Set<string>()
  const users: RepositoryMentionUser[] = []
  for (const raw of logins) {
    const login = raw?.trim()
    if (!login) continue
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    users.push({ login, name: null, avatarUrl: null, bot: login.endsWith('[bot]') })
  }
  return users
}

/**
 * Popover height bounds, in pixels. The upper bound is the most rows worth
 * showing before the list becomes a scroll hunt; the lower bound keeps two rows
 * visible even when the panel has almost no room above the composer.
 */
export const MENTION_MENU_MAX_HEIGHT = 208
export const MENTION_MENU_MIN_HEIGHT = 88

/**
 * Clamp an upward-opening popover to the room actually available above it.
 *
 * The dock is a clipping column (`overflow: hidden`), and the composer sits at
 * the bottom of it, so a fixed height would have its top rows cut off in a short
 * panel or with a long candidate list. Growing upward is still right: it keeps
 * the text being typed visible, so the height yields instead of the anchor.
 */
export function mentionMenuMaxHeight(available: number): number {
  if (!Number.isFinite(available)) return MENTION_MENU_MAX_HEIGHT
  return Math.max(MENTION_MENU_MIN_HEIGHT, Math.min(MENTION_MENU_MAX_HEIGHT, Math.floor(available)))
}

function matchesQuery(user: RepositoryMentionUser, query: string): boolean {
  if (!query) return true
  if (user.login.toLowerCase().includes(query)) return true
  return user.name?.toLowerCase().includes(query) ?? false
}

/**
 * What a key press should do while the mention popover is open.
 *
 * Kept pure and separate from the component so the decision is testable without
 * a browser. `passthrough` is the case that matters most: any key the popover
 * does not claim has to reach the editor untouched, otherwise ordinary typing and
 * caret movement break while the list happens to be open.
 */
export type MentionKeyAction =
  { kind: 'move'; delta: number } | { kind: 'select' } | { kind: 'close' } | { kind: 'passthrough' }

export function mentionKeyAction(key: string, candidateCount: number): MentionKeyAction {
  if (key === 'ArrowDown') {
    return candidateCount > 0 ? { kind: 'move', delta: 1 } : { kind: 'passthrough' }
  }
  if (key === 'ArrowUp') {
    return candidateCount > 0 ? { kind: 'move', delta: -1 } : { kind: 'passthrough' }
  }
  if (key === 'Tab' || key === 'Enter') {
    return candidateCount > 0 ? { kind: 'select' } : { kind: 'passthrough' }
  }
  // Escape closes even with nothing to choose from, because the popover is still
  // occupying the panel and the user expects it to go away.
  if (key === 'Escape') return { kind: 'close' }
  return { kind: 'passthrough' }
}

/**
 * Merge the on-screen participants with the repository directory, filtered by
 * the typed query.
 *
 * Participants lead because they are the likeliest target in a PR conversation
 * and they arrive before the directory does, so the list never reshuffles
 * underneath the user once the fetch lands: it only grows.
 */
export function mentionCandidates(
  participants: readonly RepositoryMentionUser[],
  directory: readonly RepositoryMentionUser[],
  query: string
): RepositoryMentionUser[] {
  const normalized = query.trim().toLowerCase()
  const seen = new Set<string>()
  const candidates: RepositoryMentionUser[] = []
  for (const user of [...participants, ...directory]) {
    const key = user.login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!matchesQuery(user, normalized)) continue
    candidates.push(user)
    if (candidates.length >= MENTION_LIMIT) break
  }
  return candidates
}
