import { SvelteMap } from 'svelte/reactivity'
import { threadVisitKey } from '$lib/stores/recent-visits.svelte'
import type { Thread } from '$shared/types'

/**
 * How long a sidebar list waits for the activity to stop before it applies a
 * move. Long enough that two ticks landing a few frames apart are one move,
 * short enough that a thread finishing still reads as immediate.
 */
const QUIET_MS = 450
/**
 * Longest a change may sit unapplied while activity keeps arriving. A busy
 * project can tick several times a second for minutes, and the list must not
 * follow the sort only once that work stopped.
 */
const MAX_DELAY_MS = 1500

/** Book-keeping for one list. Plain fields: never read reactively. */
interface SettledList {
  /** The list this pane was last handed, compared by row identity. */
  desired: Thread[]
  /** Position-relevant field signature per row, to tell a moved row from a tick. */
  keys: Map<string, string>
  /** When the pending move was first held back, so the cap can be measured. */
  pendingSince: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The fields that legitimately move a row in the sidebar.
 *
 * Anything else arriving on a `thread:updated` broadcast - above all the activity
 * stamp every tick rewrites - is what {@link ThreadOrderSettle} holds back.
 */
export function threadRowPositionKey(
  thread: Thread,
  draftThreadKeys?: ReadonlySet<string> | null
): string {
  return [
    thread.status,
    thread.read ? 1 : 0,
    thread.pinned ? 1 : 0,
    thread.pinnedAt ?? -1,
    thread.sortOrder ?? -1,
    draftThreadKeys?.has(threadVisitKey(thread)) ? 1 : 0
  ].join('|')
}

/**
 * Keeps a sidebar list from re-sorting itself while somebody is reading it.
 *
 * The Threads list and the project folders order rows by last activity, and a
 * live project ticks constantly: a working thread, a worker finishing, a queued
 * message starting. Sorting the rows again on every tick means one thread's
 * activity moves every row below it, and two ticks a few frames apart start two
 * sliding animations that overlap - the rows visibly fight over the slot.
 *
 * The settle separates *what* changed from *when* it is shown:
 *
 * - A structural change (a row appeared or left) and a position-relevant field
 *   change (status, read, pin, the manual anchor, a draft) commit at once. Those
 *   are the moves a reader asked for or needs to see: the row they just dropped
 *   landing where they dropped it, or a thread settling into Done.
 * - A change that is only the order of the same rows on the same fields is
 *   recency noise. It is held until the activity stops for {@link QUIET_MS}, so a
 *   burst becomes one clean move, capped at {@link MAX_DELAY_MS}.
 *
 * `sync` is the write side and belongs in an effect; `view` is the read side and
 * belongs in a derivation.
 */
export class ThreadOrderSettle {
  /** Committed row order per list. */
  #orders = new SvelteMap<string, readonly string[]>()
  // Plain, not a SvelteMap: this is bookkeeping the render never reads, and a
  // signal behind every commit would invalidate the panes for nothing.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #lists = new Map<string, SettledList>()

  /**
   * Hand the settle the list a pane was just given, and decide whether it is
   * rendered now or held back.
   */
  sync(key: string, desired: Thread[], draftThreadKeys?: ReadonlySet<string> | null): void {
    let list = this.#lists.get(key)
    if (list === undefined) {
      list = {
        desired,
        keys: positionKeys(desired, draftThreadKeys),
        pendingSince: 0,
        timer: undefined
      }
      this.#lists.set(key, list)
      // First sight: there is nothing to settle against, so the pane shows the
      // list exactly as it was handed over.
      this.#commit(key, list, desired)
      return
    }
    // A tick that changes nothing about this list (a row of another project, a
    // field no row draws) leaves every row object untouched.
    if (sameRows(list.desired, desired)) return

    const previousKeys = list.keys
    list.desired = desired
    list.keys = positionKeys(desired, draftThreadKeys)

    const ids = threadIds(desired)
    const order = this.#orders.get(key)
    // The pane is already showing this arrangement: nothing moved, so there is
    // nothing to commit and nothing to hold.
    if (order !== undefined && sameOrder(order, ids)) return

    if (order === undefined || order.length !== ids.length || !sameKeys(previousKeys, list.keys)) {
      this.#commit(key, list, desired)
      return
    }

    this.#schedule(key, list)
  }

  /**
   * The rows to render for a list: the ones the pane was handed, arranged in the
   * last committed order.
   *
   * A set that no longer matches the committed order (a row just appeared or
   * left) is shown as handed over, because the settle has no arrangement for it
   * yet, and dropping a row would be worse than one frame of the sort the `sync`
   * that follows immediately commits.
   */
  view(key: string, desired: Thread[]): Thread[] {
    const order = this.#orders.get(key)
    if (order === undefined || order.length !== desired.length) return desired
    // Same scratch-index reasoning as the sync side above.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byId = new Map<string, Thread>()
    for (const thread of desired) byId.set(thread.id, thread)
    const arranged: Thread[] = []
    for (const id of order) {
      const row = byId.get(id)
      if (row === undefined) return desired
      arranged.push(row)
    }
    return arranged
  }

  /**
   * Let go of every list a caller is no longer handing over, e.g. a project that
   * was removed, so its order and timer cannot outlive it.
   */
  prune(activeKeys: ReadonlySet<string>): void {
    for (const key of [...this.#lists.keys()]) {
      if (activeKeys.has(key)) continue
      const list = this.#lists.get(key)
      if (list?.timer !== undefined) clearTimeout(list.timer)
      this.#lists.delete(key)
    }
    for (const key of [...this.#orders.keys()]) {
      if (!activeKeys.has(key)) this.#orders.delete(key)
    }
  }

  #schedule(key: string, list: SettledList): void {
    const now = Date.now()
    if (list.pendingSince === 0) list.pendingSince = now
    if (list.timer !== undefined) clearTimeout(list.timer)
    const waited = now - list.pendingSince
    const delay = Math.max(0, Math.min(QUIET_MS, MAX_DELAY_MS - waited))
    list.timer = setTimeout(() => {
      // The freshest list is the one to commit: activity that arrived while this
      // move was held is part of it, not a second move.
      this.#commit(key, list, list.desired)
    }, delay)
  }

  #commit(key: string, list: SettledList, desired: Thread[]): void {
    if (list.timer !== undefined) clearTimeout(list.timer)
    list.timer = undefined
    list.pendingSince = 0
    const ids = threadIds(desired)
    const order = this.#orders.get(key)
    if (order !== undefined && sameOrder(order, ids)) return
    this.#orders.set(key, ids)
  }
}

function threadIds(threads: readonly Thread[]): string[] {
  const ids: string[] = []
  for (const thread of threads) ids.push(thread.id)
  return ids
}

/** A position signature per row, compared as one map. Never read reactively. */
function positionKeys(
  threads: readonly Thread[],
  draftThreadKeys?: ReadonlySet<string> | null
): Map<string, string> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const keys = new Map<string, string>()
  for (const thread of threads) keys.set(thread.id, threadRowPositionKey(thread, draftThreadKeys))
  return keys
}

function sameRows(left: readonly Thread[], right: readonly Thread[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function sameKeys(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [id, key] of left) {
    if (right.get(id) !== key) return false
  }
  return true
}
