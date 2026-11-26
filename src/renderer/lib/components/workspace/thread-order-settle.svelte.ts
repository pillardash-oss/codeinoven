import { SvelteMap } from 'svelte/reactivity'
import { threadVisitKey } from '$lib/stores/recent-visits.svelte'
import type { Thread, ThreadStatus } from '$shared/types'

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
/**
 * How long a thread that has just started waiting to retry keeps the slot it
 * already had.
 *
 * A retry is a run that stopped, waited, and started again: the status flips to
 * `working-paused` and back to `working` every few seconds for as long as the
 * provider keeps refusing, and every flip is a status change, so the list would
 * re-sort on each one and rows a reader is watching would fight over slots. A
 * retry wait that has actually lasted this long is one the reader has to see; a
 * flash shorter than this moved nothing at all. Measured from the first retry
 * held, so a thread that keeps retrying settles into its retry slot once and
 * never keeps postponing it, and every retry that lands inside the same window
 * commits with it.
 */
const RETRY_PAUSE_SETTLE_MS = 4000
/** The status a retry wait holds back, and the only one held. */
const RETRY_PAUSE_STATUS = 'working-paused'

/** Book-keeping for one list. Plain fields: never read reactively. */
interface SettledList {
  /** The list this pane was last handed, compared by row identity. */
  desired: readonly Thread[]
  /** Position-relevant field signature per row, to tell a moved row from a tick. */
  keys: Map<string, string>
  /** The status each row had at the last sync, to spot a retry being entered. */
  statuses: Map<string, ThreadStatus>
  /** When the pending move was first held back, so the cap can be measured. */
  pendingSince: number
  /**
   * When the first retry was held back, undefined while no retry is held.
   *
   * Undefined rather than zero, because zero is a real timestamp: a retry held
   * on the very first tick of a clock would otherwise look like no hold at all.
   */
  retrySince: number | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The fields that legitimately move a row in the sidebar.
 *
 * Anything else arriving on a `thread:updated` broadcast - above all the activity
 * stamp every tick rewrites - is what {@link ThreadOrderSettle} holds back.
 *
 * The status leads, so the rest of a row's position can be compared without it
 * (see `rowLayoutKey`): that is how a retry, which changes nothing but the
 * status, is told apart from a real move.
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
 * - A status change into `working-paused` is the one status change that is not a
 *   move on its own. A provider retry flips a thread in and out of that status
 *   every few seconds, so the change is held for {@link RETRY_PAUSE_SETTLE_MS}
 *   from the first retry of the burst: a flash that is back to work before then
 *   moved nothing, and every retry inside the window settles in one commit.
 *   Every other change in the window still commits at once, and a row leaving
 *   the status is free to move straight away.
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
  sync(
    key: string,
    desired: readonly Thread[],
    draftThreadKeys?: ReadonlySet<string> | null
  ): void {
    let list = this.#lists.get(key)
    if (list === undefined) {
      list = {
        desired,
        keys: positionKeys(desired, draftThreadKeys),
        statuses: statusMap(desired),
        pendingSince: 0,
        retrySince: undefined,
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
    const previousStatuses = list.statuses
    list.desired = desired
    list.keys = positionKeys(desired, draftThreadKeys)
    list.statuses = statusMap(desired)

    const ids = threadIds(desired)
    const order = this.#orders.get(key)
    const structural = order === undefined || order.length !== ids.length
    const keysChanged = !sameKeys(previousKeys, list.keys)
    // A retry is the one status change that is held back, and only while it is
    // the whole of what changed: a row that appeared, a read, a pin, a drop, a
    // thread settling into Done, or a row leaving the retry is a move on its own.
    const retryOnly =
      !structural &&
      keysChanged &&
      isRetryEntryOnlyChange(previousKeys, list.keys, previousStatuses, list.statuses)
    // A move that is not the retry itself ends any hold the retry opened: the
    // wait is no longer the reason this list stood still, so the row is free to
    // go wherever the move puts it.
    if (structural || keysChanged) {
      if (!retryOnly) this.#releaseRetry(list)
    }
    // The pane is already showing this arrangement: nothing moved, so there is
    // nothing to commit and nothing to hold.
    if (order !== undefined && sameOrder(order, ids)) return
    if (retryOnly) {
      this.#holdRetry(key, list)
      return
    }
    if (structural || keysChanged) {
      this.#commit(key, list, desired)
      return
    }

    // Activity while a retry is held is part of the move that retry will make,
    // not a second move: the held commit carries the freshest list, so nothing
    // may be committed ahead of it or the row would settle into its retry slot
    // before the window elapsed.
    if (list.retrySince !== undefined) return

    this.#schedule(key, list)
  }

  /**
   * The rows to render for a list: the ones the pane was handed, arranged in the
   * last committed order.
   *
   * A set that no longer matches the committed order (a row just appeared or
   * left) is shown as handed over, because the settle has no arrangement for it
   * yet, and dropping a row would be worse than one frame of the sort the `sync`
   * that follows immediately commits. The hand-over is copied, so the mutable
   * array a caller renders can never alias a caller's own readonly list.
   */
  view(key: string, desired: readonly Thread[]): Thread[] {
    const order = this.#orders.get(key)
    if (order === undefined || order.length !== desired.length) return [...desired]
    // Same scratch-index reasoning as the sync side above.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byId = new Map<string, Thread>()
    for (const thread of desired) byId.set(thread.id, thread)
    const arranged: Thread[] = []
    for (const id of order) {
      const row = byId.get(id)
      if (row === undefined) return [...desired]
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

  /**
   * Drop a hold a retry opened, because something else is moving the list now.
   *
   * While a retry is held its timer is the only one armed, so this ends that
   * timer and nothing else: the row keeps the slot it has until the move that
   * superseded the retry commits.
   */
  #releaseRetry(list: SettledList): void {
    if (list.retrySince === undefined) return
    list.retrySince = undefined
    if (list.timer !== undefined) clearTimeout(list.timer)
    list.timer = undefined
  }

  /**
   * Hold a retry back until the wait has lasted {@link RETRY_PAUSE_SETTLE_MS}.
   *
   * One timer per list, armed from the first retry of the burst: a second thread
   * entering the same wait does not extend the window, it waits out the one
   * already running, so a project where several retries overlap still makes one
   * move when the window elapses.
   */
  #holdRetry(key: string, list: SettledList): void {
    const now = Date.now()
    if (list.retrySince === undefined) list.retrySince = now
    if (list.timer !== undefined) clearTimeout(list.timer)
    // A quiet hold this retry replaced is over: its cap measured a wait the list
    // is no longer making, and the retry window bounds this one instead.
    list.pendingSince = 0
    const waited = now - list.retrySince
    const delay = Math.max(0, RETRY_PAUSE_SETTLE_MS - waited)
    list.timer = setTimeout(() => {
      this.#commit(key, list, list.desired)
    }, delay)
  }

  #commit(key: string, list: SettledList, desired: readonly Thread[]): void {
    if (list.timer !== undefined) clearTimeout(list.timer)
    list.timer = undefined
    list.pendingSince = 0
    list.retrySince = undefined
    const ids = threadIds(desired)
    const order = this.#orders.get(key)
    if (order !== undefined && sameOrder(order, ids)) return
    this.#orders.set(key, ids)
  }
}

/**
 * Whether the only thing that changed about this list is one or more rows
 * entering a retry wait.
 *
 * The list is held back for that and nothing else, so the check is deliberately
 * strict: every row still has to be there with the same read, pin, anchor and
 * draft, and each row that moved has to have moved from another status *into*
 * `working-paused`. A row that left the status, or a retry that arrived with any
 * other change, is not a retry to hold.
 */
function isRetryEntryOnlyChange(
  previousKeys: ReadonlyMap<string, string>,
  nextKeys: ReadonlyMap<string, string>,
  previousStatuses: ReadonlyMap<string, ThreadStatus>,
  nextStatuses: ReadonlyMap<string, ThreadStatus>
): boolean {
  if (previousKeys.size !== nextKeys.size) return false
  let entered = false
  for (const [id, key] of nextKeys) {
    const keyBefore = previousKeys.get(id)
    const statusBefore = previousStatuses.get(id)
    const statusNow = nextStatuses.get(id)
    if (keyBefore === undefined || statusBefore === undefined || statusNow === undefined)
      return false
    if (statusBefore === statusNow) {
      // A row that did not change status has to be otherwise untouched too,
      // otherwise the status change is not the only thing this sync carries.
      if (keyBefore !== key) return false
      continue
    }
    if (statusNow !== RETRY_PAUSE_STATUS) return false
    // The rest of a row's position (read, pin, anchor, draft) has to match: only
    // the status may have moved.
    if (rowLayoutKey(keyBefore) !== rowLayoutKey(key)) return false
    entered = true
  }
  return entered
}

function threadIds(threads: readonly Thread[]): string[] {
  const ids: string[] = []
  for (const thread of threads) ids.push(thread.id)
  return ids
}

/**
 * The part of a row's position key after the status it leads with.
 *
 * {@link threadRowPositionKey} puts the status first on purpose, so a retry that
 * changed nothing but the status can be told apart from the rest of a move.
 */
function rowLayoutKey(key: string): string {
  return key.slice(key.indexOf('|') + 1)
}

/** The status per row, compared as one map. Never read reactively. */
function statusMap(threads: readonly Thread[]): Map<string, ThreadStatus> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const statuses = new Map<string, ThreadStatus>()
  for (const thread of threads) statuses.set(thread.id, thread.status)
  return statuses
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
