import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadCardFold.v1`

/** Ceiling on remembered threads, so the record cannot grow with every thread the
 *  user ever opens. Object keys keep insertion order, so re-folding makes a
 *  thread the newest again. */
const MAX_THREADS = 250

/** Thread id -> card key -> the fold state the reader chose for that card. */
type FoldRecord = Record<string, Record<string, boolean>>

function load(): FoldRecord {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record: FoldRecord = {}
    for (const [threadId, cards] of Object.entries(parsed as Record<string, unknown>)) {
      if (cards === null || typeof cards !== 'object' || Array.isArray(cards)) continue
      const folded: Record<string, boolean> = {}
      for (const [cardKey, value] of Object.entries(cards as Record<string, unknown>)) {
        if (typeof value === 'boolean') folded[cardKey] = value
      }
      if (Object.keys(folded).length > 0) record[threadId] = folded
    }
    return record
  } catch {
    // Corrupt or unavailable storage must not break the conversation.
    return {}
  }
}

/**
 * Fold state for the cards that stack on the composer, remembered per thread.
 *
 * A card's fold control is component-local, so it loses the reader's choice the
 * moment the view remounts: switching away from a thread and back recreates
 * `ThreadView`, and every card unfolds. Keeping the choice here is what makes a
 * folded card stay folded (and a deliberately unfolded one stay open) when the
 * reader returns to the thread.
 *
 * Only a choice the reader actually made is stored. A card with no entry reads
 * its own default, so a fresh thread opens unfolded without writing anything.
 */
class ThreadCardFoldStore {
  #folded = $state<FoldRecord>(load())

  /** The reader's stored choice for a card, or `undefined` if they never chose. */
  preferenceFor(threadId: string, cardKey: string): boolean | undefined {
    return this.#folded[threadId]?.[cardKey]
  }

  /** The card's fold state, falling back to its own default when unset. */
  isFolded(threadId: string, cardKey: string, fallback = false): boolean {
    return this.preferenceFor(threadId, cardKey) ?? fallback
  }

  setFolded(threadId: string, cardKey: string, folded: boolean): void {
    if (this.#folded[threadId]?.[cardKey] === folded) return
    const next: FoldRecord = { ...this.#folded }
    const cards = { ...(next[threadId] ?? {}) }
    cards[cardKey] = folded
    // Reassign so the thread becomes the newest key for the ceiling below.
    delete next[threadId]
    next[threadId] = cards
    this.#folded = this.#trim(next)
    this.#persist()
  }

  #trim(record: FoldRecord): FoldRecord {
    const threadIds = Object.keys(record)
    if (threadIds.length <= MAX_THREADS) return record
    const kept: FoldRecord = {}
    for (const threadId of threadIds.slice(threadIds.length - MAX_THREADS)) {
      kept[threadId] = record[threadId]
    }
    return kept
  }

  #persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#folded))
    } catch {
      // The preference is a convenience; unavailable storage must not break the UI.
    }
  }
}

export const threadCardFold = new ThreadCardFoldStore()
