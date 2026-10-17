/**
 * The last value that was not null, remembered for a child that is on its way
 * out.
 *
 * Svelte reads a child's props through getters that re-evaluate their source for
 * as long as the child is mounted, including the frame it unmounts on. When that
 * source is a nullable derived (a panel on screen while the thing it describes
 * goes away, a native stage playing a tab that just stopped being the one in
 * front), those reads throw out of the child's own cleanup. The throw unwinds
 * through the parent's render flush, so the block that was replacing the child
 * never finishes: the pane is left blank, its fallback empty state never paints,
 * and whatever the child was running (a poll, an observer) is never stopped.
 *
 * Reading the *gate* and the *props* from two different answers is what fixes it.
 * The gate keeps reading the nullable value, so the child is still dropped the
 * moment it should be; the props read the last answer that was not null, so they
 * stay answerable for the length of that teardown.
 *
 * Deliberately not reactive state: the memory is written while the derived that
 * reads it recomputes, and that derived is already invalidated by the source.
 */
export class LastKnown<T> {
  #last: T | null = null

  /** The value when there is one, else the last one there was. */
  get(value: T | null): T | null {
    if (value !== null) this.#last = value
    return this.#last
  }
}
