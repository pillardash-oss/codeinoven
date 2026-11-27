/**
 * The row the pointer went down on, painted before the click does anything.
 *
 * Selecting a thread is one state write, and the conversation it opens takes a
 * frame's worth of work to mount. Svelte applies every reaction to a state change
 * in one flush, and that flush is shared: the rows light only once the thread
 * they selected has been built. On a real account the click measured 200 ms to
 * the row reading as selected, and a busy one took half a second — the row
 * trailing behind the user's own hand.
 *
 * A press is not the selection, and it does not need the selection's flush. The
 * pointer going down is its own, tiny state change that only rows react to, so
 * the row the user is aiming at lights on the press, in the frame the press
 * happened in, and the selection catches up underneath it. If the click never
 * comes — the pointer is dragged away, or a long press takes over — the mark
 * goes away with the release.
 *
 * A row's press mark is cleared when the release settles, never on the release
 * itself: `pointerup` lands before `click`, so clearing there would drop the mark
 * for the frames the click's own flush spends working, and the row would blink.
 */
class ThreadRowPress {
  #id = $state<string | null>(null)

  /** The thread whose row is held down, if any. */
  get id(): string | null {
    return this.#id
  }

  /** The pointer went down on this thread's row. */
  press(threadId: string): void {
    this.#id = threadId
  }

  /** The release settled: drop the mark, unless another row was pressed since. */
  release(threadId: string): void {
    if (this.#id === threadId) this.#id = null
  }

  /** A press that never became a click (Escape, a cancelled pointer). */
  releaseAll(): void {
    this.#id = null
  }
}

/** The one press the sidebar rows share. */
export const threadRowPress = new ThreadRowPress()
