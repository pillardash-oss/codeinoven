import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  autoAnswerConcernsThread,
  type AutoAnswerItem,
  type AutoAnswerThreadScope
} from '$shared/types'

/**
 * The gates the app resolved without the user: a question whose timer picked the
 * recommended option, a secret card that expired, an image-descriptor decision
 * that timed out. Main owns the durable records; this store is the renderer's
 * mirror of them, so the right rail and the attention panel render one list
 * instead of each fetching their own copy.
 *
 * A record is read relative to the conversation on screen, not globally: the
 * rail item only exists while the open thread (or its task, or its routine) has
 * an undismissed decision, so a decision made in one thread never lights the
 * rail in another.
 */
class AttentionState {
  private _items = $state<AutoAnswerItem[]>([])
  /** One app-lifetime subscription: a gate resolved while the panel is closed
   *  still has to light the rail, and a second `initialize()` must not stack
   *  another listener. */
  private subscribed = false

  /** Every record main has, newest first and including dismissed ones. */
  get items(): AutoAnswerItem[] {
    return this._items
  }

  /**
   * Undismissed records that concern `scope`, newest first: what the rail counts
   * and the panel renders for the thread on screen.
   */
  unreadFor(scope: AutoAnswerThreadScope): AutoAnswerItem[] {
    return this._items.filter(
      (item) => item.dismissedAt === undefined && autoAnswerConcernsThread(item, scope)
    )
  }

  /** How many undismissed records concern `scope`. */
  unreadCountFor(scope: AutoAnswerThreadScope): number {
    return this.unreadFor(scope).length
  }

  /** Load the recorded decisions once, then mirror live updates from main. */
  initialize(): void {
    if (this.subscribed) return
    this.subscribed = true
    void this.refresh()
    subscribe('assistant:autoAnswersChanged', (items) => {
      this._items = items
    })
  }

  private async refresh(): Promise<void> {
    try {
      this._items = await invoke('assistant:listAutoAnswers')
    } catch {
      // Main keeps the records; a failed read leaves the rail as it was.
    }
  }

  /** Mark one record read, clearing the rail before main answers. */
  async dismiss(id: string): Promise<void> {
    const item = this._items.find((candidate) => candidate.id === id)
    if (!item || item.dismissedAt !== undefined) return
    item.dismissedAt = Date.now()
    try {
      await invoke('assistant:dismissAutoAnswer', id)
    } catch {
      // The next `autoAnswersChanged` broadcast restores the authoritative
      // list, so a failed write corrects itself without a local rollback.
    }
  }

  /** Mark every unread record read in one pass. */
  async dismissAll(): Promise<void> {
    const now = Date.now()
    for (const item of this._items) {
      if (item.dismissedAt === undefined) item.dismissedAt = now
    }
    try {
      await invoke('assistant:dismissAllAutoAnswers')
    } catch {
      // Same as `dismiss`: the next broadcast is the source of truth.
    }
  }
}

export const attentionState = new AttentionState()
