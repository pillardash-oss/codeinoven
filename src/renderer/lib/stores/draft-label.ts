import { DEFAULT_THREAD_TITLE } from '$shared/types'
import { rendererRecovery } from './renderer-recovery.svelte'

/**
 * Draft-derived thread labels.
 *
 * A freshly created thread shows the placeholder "New Thread" until its first
 * prompt triggers auto-titling. Drafting feels anonymous when several such
 * threads are open side by side. This module derives a short, human-readable
 * label from the composer draft so the sidebar and app header can show what
 * the user is actually typing instead of a wall of "New Thread" rows.
 *
 * The label is:
 *  - derived from the live draft (reactive) so it updates as the user types;
 *  - mirrored into a cookie keyed by thread id so it persists across restarts
 *    for up to 24 hours;
 *  - discarded as soon as a real title is generated (title != DEFAULT) or the
 *    draft is cleared, and it self-expires via the cookie's max-age.
 */

/** Longest label derived from draft text, matching the title fallback cap. */
const MAX_LABEL = 48

const COOKIE_PREFIX = 'codeinoven_draft_label'
const COOKIE_TTL_SECONDS = 60 * 60 * 24

/** Derive a short label from draft text (first non-empty line, markdown stripped). */
export function deriveDraftLabel(text: string): string | null {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.replace(/^[#>\-*\s`]+/, '').trim())
      .find((line) => line.length > 0) ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ').replace(/`/g, '').trim()
  if (!collapsed) return null
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL).trimEnd()}…` : collapsed
}

function cookieName(threadId: string): string {
  return `${COOKIE_PREFIX}_${threadId}`
}

/** Read the persisted draft label for a thread, or null when absent/expired. */
export function draftLabelFromCookie(threadId: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${cookieName(threadId)}=`
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  if (!cookie) return null
  const raw = cookie.slice(prefix.length)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** Mirror the draft-derived label into a 24h cookie, or clear it when empty. */
export function setDraftLabelCookie(threadId: string, text: string): void {
  if (typeof document === 'undefined') return
  const label = deriveDraftLabel(text)
  if (!label) {
    clearDraftLabelCookie(threadId)
    return
  }
  document.cookie = `${cookieName(threadId)}=${encodeURIComponent(
    label
  )}; path=/; max-age=${COOKIE_TTL_SECONDS}; samesite=lax`
}

/** Remove the persisted draft label for a thread (e.g. after title generation). */
export function clearDraftLabelCookie(threadId: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${cookieName(threadId)}=; path=/; max-age=0`
}

/**
 * The title to render for a thread in the UI.
 *
 * Returns the real title once it has been generated or manually set. Until
 * then it shows the draft-derived label when one exists (live draft text,
 * falling back to the persisted cookie), otherwise the "New Thread" placeholder.
 *
 * Reads the live draft from the renderer recovery store, so this becomes
 * reactive when called inside a `$derived`.
 */
export function effectiveThreadTitle(thread: {
  id: string
  projectId: string
  title: string
}): string {
  if (thread.title !== DEFAULT_THREAD_TITLE) return thread.title
  const draftText = rendererRecovery.draftFor(thread.projectId, thread.id)
  return deriveDraftLabel(draftText) ?? draftLabelFromCookie(thread.id) ?? thread.title
}
