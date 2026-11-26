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
 * How long a row that moved down because of its own activity keeps the slot it
 * already had.
 *
 * A thread settling into Done, a draft that was just sent away, a turn that
 * ended: each of those lands as a descent, and the very next commit - a queued
 * message starting, the thread waking up again - brings the row straight back
 * up. Committed at once, the list showed the row dropping and rising again,
 * which reads as the row fighting itself. Held instead, a descent that is undone
 * inside this window never shows at all: nothing was committed, so the ascent
 * that follows is measured from the slot the row still holds, and an ascent that
 * lands it back where it was commits nothing whatsoever.
 *
 * Measured from the first descent held, so a project settling a batch of rows
 * into Done still commits one window after the first of them instead of
 * postponing the move with every row that follows.
 */
const DESCENT_HOLD_MS = 1500
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
/** No committed statuses for a list, so grouping falls back to the live status. */
const EMPTY_STATUSES: ReadonlyMap<string, ThreadStatus> = new Map()

/** Book-keeping for one list. Plain fields: never read reactively. */
interface SettledList {
  /** The list this pane was last handed, compared by row identity. */
  desired: readonly Thread[]
  /** Position-relevant field signature per row, to tell a moved row from a tick. */
  keys: Map<string, string>
  /**
   * The field signature of every row in the arrangement on screen, so a row's
   * own move is measured against what the reader can see rather than against the
   * last sync - a list syncs several times while one move is held.
   */
  committedKeys: Map<string, string>
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
  /**
   * When the first descent was held back, undefined while none is held.
   *
   * Undefined rather than zero for the same reason as {@link retrySince}: zero is
   * a real timestamp, so a descent held on the very first tick of a clock would
   * otherwise look like no hold at all.
   */
  descentSince: number | undefined
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
 * - A row that moves *down* because of its own activity (its status settled, its
 *   draft was sent away) is held for {@link DESCENT_HOLD_MS}, because that is the
 *   move a running thread undoes a moment later by starting its next turn. A row
 *   that rises is news and commits at once, and a placement the reader made - a
 *   drop, a pin, an unpin - commits at once in either direction.
 *
 * A row's status is also the heading it is drawn under, so the headings are read
 * from the arrangement on screen rather than from the rows as they are now: see
 * {@link groupingStatuses}.
 *
 * `sync` is the write side and belongs in an effect; `view` and
 * `groupingStatuses` are the read side and belong in a derivation.
 */
export class ThreadOrderSettle {
  /** Committed row order per list. */
  #orders = new SvelteMap<string, readonly string[]>()
  /**
   * The status of every row in the arrangement on screen, per list.
   *
   * A SvelteMap because grouping reads it: a status change that is committed
   * without moving a row still has to re-run the headings, and the order it
   * does not touch carries no signal for that.
   */
  #committedStatuses = new SvelteMap<string, ReadonlyMap<string, ThreadStatus>>()
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
      const keys = positionKeys(desired, draftThreadKeys)
      list = {
        desired,
        keys,
        committedKeys: keys,
        statuses: statusMap(desired),
        pendingSince: 0,
        retrySince: undefined,
        descentSince: undefined,
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
    // The pane is already showing this arrangement: nothing moved, so there is
    // nothing to commit. A move held earlier whose arrangement came back to what
    // is on screen undid itself, and its hold ends here rather than committing a
    // move the list no longer wants.
    if (order !== undefined && sameOrder(order, ids)) {
      // No row moved, but a status still may have - a thread parked on the user,
      // a retry entered and left inside the window. Committing it is what keeps
      // the headings honest (see {@link groupingStatuses}); the commit itself
      // does no work for an order that already matches the screen.
      this.#commit(key, list, desired)
      return
    }
    if (retryOnly) {
      this.#holdRetry(key, list)
      return
    }
    // Rows only move against an arrangement that already holds every one of
    // them; a row that appeared or left is a restructure and shows at once.
    if (structural || order === undefined) {
      this.#commit(key, list, desired)
      return
    }
    if (keysChanged) {
      // A row that moved down because of its own activity is the row that may be
      // coming straight back (see {@link DESCENT_HOLD_MS}), so its descent waits
      // like recency noise does. Everything else - a row that rose, a drop, a
      // pin - commits on the frame it happens.
      if (ownMoveDirection(list.committedKeys, list.keys, order, ids) === 'descent') {
        this.#holdDescent(key, list)
        return
      }
      this.#commit(key, list, desired)
      return
    }

    // Activity while a move is held is part of the move that hold will make, not
    // a second move: the held commit carries the freshest list, so nothing may
    // be committed ahead of it or the row would settle into its held slot before
    // the window elapsed.
    if (list.retrySince !== undefined || list.descentSince !== undefined) return

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
   * The status each row is grouped under: the one it carries in the arrangement
   * on screen, not necessarily the one it carries now.
   *
   * The Threads view sorts rows into headings by status, so a status change is a
   * move between headings as much as a move between slots - and it is the same
   * descent the settle holds back (see {@link DESCENT_HOLD_MS}). Grouping by the
   * live status would jump the row to its new heading on the sync whose move was
   * held, which is the drop the hold exists to keep off screen: a thread settling
   * into Done and starting its next turn a moment later would go down and come
   * back up instead of never moving at all. Grouping by the committed status
   * instead changes a row's heading on the commit that moves it, and nowhere
   * else.
   *
   * Every row whose status is not being held appears here with the status it
   * already has, so a caller can hand the whole map over.
   */
  groupingStatuses(key: string): ReadonlyMap<string, ThreadStatus> {
    return this.#committedStatuses.get(key) ?? EMPTY_STATUSES
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
    for (const key of [...this.#committedStatuses.keys()]) {
      if (!activeKeys.has(key)) this.#committedStatuses.delete(key)
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
    // is no longer making, and the retry window bounds this one instead. A
    // descent being held is over too: the retry is the move that owns the row
    // now, so the reader sees one move instead of two windows fighting.
    list.pendingSince = 0
    list.descentSince = undefined
    const waited = now - list.retrySince
    const delay = Math.max(0, RETRY_PAUSE_SETTLE_MS - waited)
    list.timer = setTimeout(() => {
      this.#commit(key, list, list.desired)
    }, delay)
  }

  /**
   * Hold a descent back until it has lasted {@link DESCENT_HOLD_MS}.
   *
   * One timer per list, armed from the first descent of the burst: a second row
   * settling into Done does not extend the window, it waits out the one already
   * running, so a project where several rows settle together still makes one
   * move when the window elapses.
   */
  #holdDescent(key: string, list: SettledList): void {
    const now = Date.now()
    if (list.descentSince === undefined) list.descentSince = now
    if (list.timer !== undefined) clearTimeout(list.timer)
    // Quiet and retry holds this descent replaced are over: their windows
    // measured waits the list is no longer making, and the descent window bounds
    // this one instead.
    list.pendingSince = 0
    list.retrySince = undefined
    const waited = now - list.descentSince
    const delay = Math.max(0, DESCENT_HOLD_MS - waited)
    list.timer = setTimeout(() => {
      this.#commit(key, list, list.desired)
    }, delay)
  }

  #commit(key: string, list: SettledList, desired: readonly Thread[]): void {
    if (list.timer !== undefined) clearTimeout(list.timer)
    list.timer = undefined
    list.pendingSince = 0
    list.retrySince = undefined
    list.descentSince = undefined
    // What is committed is what the reader now sees, so the next sync measures
    // every row's own move against it, and every heading is chosen from it.
    list.committedKeys = list.keys
    this.#committedStatuses.set(key, list.statuses)
    const ids = threadIds(desired)
    const order = this.#orders.get(key)
    if (order !== undefined && sameOrder(order, ids)) return
    this.#orders.set(key, ids)
  }
}

/**
 * Which way the rows that moved because of their own fields went.
 *
 * `rise` and `none` both commit at once; only a `descent` waits (see
 * {@link DESCENT_HOLD_MS}). Every row is measured against the arrangement that
 * is on screen, not against the previous sync, because a list syncs several
 * times while one move is held and the descent is what the reader has not seen
 * yet. Any rise wins over every descent: the ascent is the move that has to be
 * seen now, and holding it would make the list look stuck instead.
 *
 * A row the committed arrangement never held is new to it (a row replaced
 * another without changing the length), so it is shown at once rather than
 * guessed about.
 */
function ownMoveDirection(
  committedKeys: ReadonlyMap<string, string>,
  nextKeys: ReadonlyMap<string, string>,
  order: readonly string[],
  ids: readonly string[]
): 'rise' | 'descent' | 'none' {
  // Same scratch-index reasoning as the settle's own maps: this is compared once
  // and never read reactively.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const committedIndex = new Map<string, number>()
  for (const [index, id] of order.entries()) committedIndex.set(id, index)
  let descended = false
  for (const [index, id] of ids.entries()) {
    const before = committedKeys.get(id)
    const after = nextKeys.get(id)
    const was = committedIndex.get(id)
    if (before === undefined || after === undefined || was === undefined) return 'rise'
    if (before === after) continue
    if (index < was) return 'rise'
    if (index > was && settledFieldsChanged(before, after)) descended = true
  }
  return descended ? 'descent' : 'none'
}

/**
 * Whether the fields a row settles by changed: the status it moved into, or the
 * draft that was sent away.
 *
 * Those two are what a running thread undoes a moment later, so they are what a
 * descent is held for. A placement the reader made - a drop, a pin, an unpin -
 * changes neither, and goes wherever the reader put it on the frame it happens.
 * {@link threadRowPositionKey} leads with the status and ends with the draft, so
 * both are read off the ends of the key instead of parsed out of its middle.
 */
function settledFieldsChanged(before: string, after: string): boolean {
  return (
    rowStatusField(before) !== rowStatusField(after) ||
    rowDraftField(before) !== rowDraftField(after)
  )
}

/** The status field a position key leads with. */
function rowStatusField(key: string): string {
  return key.slice(0, key.indexOf('|'))
}

/** The draft field a position key ends with. */
function rowDraftField(key: string): string {
  return key.slice(key.lastIndexOf('|') + 1)
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
