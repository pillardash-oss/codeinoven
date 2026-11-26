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

/**
 * The first line of a draft that still holds something once its markdown is
 * stripped.
 *
 * Walks the text line by line and stops at the first one that survives, because
 * the label is only ever the first line: splitting a long draft into every line
 * on every keystroke (this runs per keystroke for the composer and per row for
 * the sidebar) allocated the whole document to read its first words.
 */
function firstContentLine(text: string): string {
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const stripped = text
      .slice(start, end)
      .replace(/^[#>\-*\s`]+/, '')
      .trim()
    if (stripped.length > 0) return stripped
    if (newline === -1) return ''
    start = newline + 1
  }
  return ''
}

/** Derive a short label from draft text (first non-empty line, markdown stripped). */
export function deriveDraftLabel(text: string): string | null {
  const collapsed = firstContentLine(text).replace(/\s+/g, ' ').replace(/`/g, '').trim()
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

/**
 * How long a label write waits for the typing around it to settle.
 *
 * A draft arrives one keystroke at a time, and `document.cookie` is a
 * synchronous, origin-wide write: doing it per keystroke is the most expensive
 * thing in a comment box. Nothing on screen reads the cookie while this window
 * types — the sidebar and the header read the live draft, and the cookie is only
 * the fallback for a surface that has no live draft to read (another window
 * after a navigation, or a surface restored after a restart) — so the write is
 * coalesced behind the last keystroke of a burst instead of running on each one.
 * The window is deliberately shorter than the comment commit debounce, so the
 * persisted label is never waiting on the database write.
 */
export const DRAFT_LABEL_COOKIE_COALESCE_MS = 500

interface PendingLabelWrite {
  /** The latest text of the burst, so the last keystroke is the one written. */
  text: string
  timer: ReturnType<typeof setTimeout> | undefined
}

/** The text each thread's next cookie write will carry, one entry per burst. */
const pendingLabelWrites = new Map<string, PendingLabelWrite>()

let unloadFlushAttached = false

/**
 * Write the coalesced labels before this window goes away.
 *
 * A coalesced write is a write that has not happened yet, and a window that
 * closes mid-burst must still leave its label behind, because a restart reads
 * the cookie before any draft can be typed again. `pagehide` and a hidden
 * document both fire on the paths that end a window, and the write is
 * synchronous, so neither can race it.
 */
function attachUnloadFlush(): void {
  if (unloadFlushAttached || typeof window === 'undefined') return
  unloadFlushAttached = true
  window.addEventListener('pagehide', flushDraftLabelCookies)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraftLabelCookies()
  })
}

/** Write every coalesced label now (window close, or a forced settle). */
export function flushDraftLabelCookies(): void {
  if (pendingLabelWrites.size === 0) return
  for (const [threadId, pending] of [...pendingLabelWrites]) {
    pendingLabelWrites.delete(threadId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    writeDraftLabelCookie(threadId, pending.text)
  }
}

/** Mirror the draft-derived label into a 24h cookie, or clear it when empty. */
export function setDraftLabelCookie(threadId: string, text: string): void {
  if (typeof document === 'undefined') return
  const previous = pendingLabelWrites.get(threadId)
  if (previous?.timer !== undefined) clearTimeout(previous.timer)
  const pending: PendingLabelWrite = { text, timer: undefined }
  pending.timer = setTimeout(() => {
    // A newer keystroke replaced this entry; its own timer writes instead.
    if (pendingLabelWrites.get(threadId) !== pending) return
    pendingLabelWrites.delete(threadId)
    writeDraftLabelCookie(threadId, pending.text)
  }, DRAFT_LABEL_COOKIE_COALESCE_MS)
  pendingLabelWrites.set(threadId, pending)
  attachUnloadFlush()
}

/** The actual cookie write, once the burst it belongs to has settled. */
function writeDraftLabelCookie(threadId: string, text: string): void {
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
  // A clear beats any write still waiting on its burst: the draft is gone, so
  // re-adding its label afterwards would label an empty thread.
  const pending = pendingLabelWrites.get(threadId)
  if (pending) {
    pendingLabelWrites.delete(threadId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
  }
  document.cookie = `${cookieName(threadId)}=; path=/; max-age=0`
}

/**
 * The title to render for a thread in the UI.
 *
 * Returns the real title once it has been generated or manually set. Until
 * then it shows the draft-derived label when one exists (live draft text,
 * falling back to the persisted cookie), otherwise the "New Thread" placeholder.
 *
 * When the composer is empty but the thread already has a message queued (e.g.
 * scheduled behind another thread via "start after"), the queued message text
 * labels the row just as a draft would, so a brand-new scheduled thread never
 * reads as a blank "New Thread".
 *
 * Reads the live draft + queue from the renderer recovery store, so this
 * becomes reactive when called inside a `$derived`.
 */
export function effectiveThreadTitle(thread: {
  id: string
  projectId: string
  title: string
}): string {
  if (thread.title !== DEFAULT_THREAD_TITLE) return thread.title
  const { projectId, id } = thread
  const draftText = rendererRecovery.draftFor(projectId, id)
  const draftLabel = deriveDraftLabel(draftText)
  if (draftLabel) return draftLabel
  const queued = rendererRecovery.queuedMessageFor(projectId, id)
  const queuedLabel = queued ? deriveDraftLabel(queued.text) : null
  if (queuedLabel) return queuedLabel
  return draftLabelFromCookie(id) ?? thread.title
}
