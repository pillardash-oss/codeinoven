import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.dismissedTodo.v1`

/** Ceiling on remembered dismissals, so the record cannot grow with every thread
 *  the user ever opens. */
const MAX_ENTRIES = 250

/** Thread id -> signature of the task list that thread's user closed. */
type DismissalRecord = Record<string, string>

function load(): DismissalRecord {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const dismissed: DismissalRecord = {}
    for (const [threadId, signature] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof signature === 'string' && signature.length > 0) dismissed[threadId] = signature
    }
    return dismissed
  } catch {
    // Corrupt or unavailable storage must not break the conversation.
    return {}
  }
}

/**
 * Task lists the user closed with the task card's close button, remembered per
 * thread.
 *
 * The card is rebuilt from the transcript, so component-local state loses the
 * dismissal the moment the view remounts (switching away from a thread and back
 * recreates `ThreadView`). Keeping it here is what makes closing the card stick;
 * a list whose signature changed, because the agent moved a task, shows again.
 */
class DismissedTodoStore {
  #dismissed = $state<DismissalRecord>(load())

  /** True when this exact task list was closed by the user in this thread. */
  isDismissed(threadId: string, signature: string): boolean {
    return this.#dismissed[threadId] === signature
  }

  dismiss(threadId: string, signature: string): void {
    if (this.#dismissed[threadId] === signature) return
    this.#dismissed = this.#trim({ ...this.#dismissed, [threadId]: signature })
    this.#persist()
  }

  /** Drop the oldest entries once the record exceeds its ceiling. Object keys keep
   *  insertion order, so dismissing again in a thread makes that entry the newest. */
  #trim(record: DismissalRecord): DismissalRecord {
    const threadIds = Object.keys(record)
    if (threadIds.length <= MAX_ENTRIES) return record
    const kept: DismissalRecord = {}
    for (const threadId of threadIds.slice(threadIds.length - MAX_ENTRIES)) {
      kept[threadId] = record[threadId]
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

export const dismissedTodo = new DismissedTodoStore()
