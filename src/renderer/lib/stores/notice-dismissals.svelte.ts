import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.noticeDismissals.v1`

/** Ceiling on remembered dismissals, so the record cannot grow with every
 *  project, panel and thread the user ever visits. */
const MAX_ENTRIES = 250

/** Notice id -> signature of the condition the notice was showing when the user
 *  closed it. */
type DismissalRecord = Record<string, string>

function load(): DismissalRecord {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const dismissed: DismissalRecord = {}
    for (const [id, signature] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof signature === 'string' && signature.length > 0) dismissed[id] = signature
    }
    return dismissed
  } catch {
    // Corrupt or unavailable storage must not break the panels the notices live in.
    return {}
  }
}

/**
 * Notices the user closed with a dismiss button, app-wide.
 *
 * A notice is not an event: the Git panel, a stale-scope toolbar and the
 * instance-role bar are all rebuilt from the same state every time their host
 * remounts, and every one of those hosts remounts on an ordinary thread switch,
 * project switch or panel toggle. Keeping the dismissal here is what makes
 * closing a notice stick instead of snapping back on the next visit.
 *
 * Dismissal is remembered per condition, not per notice, which is what keeps it
 * honest. The caller passes the text the notice is about (the permission
 * message, the remote verdict, the conflicted paths, the stale sentence), so a
 * notice whose condition changed shows again on its own: a second rebase, a
 * different remote failure, or a new reason for the panel being stale all
 * produce a different signature and reappear without the user having to find a
 * setting to reset. What never comes back is the exact problem the user already
 * chose to ignore.
 */
class NoticeDismissalsStore {
  #dismissed = $state<DismissalRecord>(load())

  /** True when the user dismissed this notice under exactly this condition. An
   *  empty condition is never dismissible, so a notice that has nothing to
   *  fingerprint cannot be silenced by a stale entry. */
  isDismissed(id: string, condition: string): boolean {
    if (condition.length === 0) return false
    return this.#dismissed[id] === condition
  }

  dismiss(id: string, condition: string): void {
    if (condition.length === 0 || this.#dismissed[id] === condition) return
    this.#dismissed = this.#trim({ ...this.#dismissed, [id]: condition })
    this.#persist()
  }

  /** Drop the oldest entries once the record exceeds its ceiling. Object keys keep
   *  insertion order, so dismissing again on a notice makes that entry the newest. */
  #trim(record: DismissalRecord): DismissalRecord {
    const ids = Object.keys(record)
    if (ids.length <= MAX_ENTRIES) return record
    const kept: DismissalRecord = {}
    for (const id of ids.slice(ids.length - MAX_ENTRIES)) {
      kept[id] = record[id]
    }
    return kept
  }

  #persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#dismissed))
    } catch {
      // The dismissal is a convenience; unavailable storage must not break the UI.
    }
  }
}

export const noticeDismissals = new NoticeDismissalsStore()
