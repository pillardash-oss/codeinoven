import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread, ThreadStatus } from '$shared/types'
import { ThreadOrderSettle } from '$lib/components/workspace/thread-order-settle.svelte'

/**
 * How long a thread has to stay in a retry wait before the sidebar is allowed to
 * move its row into the retry position.
 */
const RETRY_PAUSE_SETTLE_MS = 4000
/** The recency quiet window, which a retry hold must not be mistaken for. */
const QUIET_MS = 450
/**
 * How long a row that moved down on its own activity keeps the slot it had, so a
 * drop that is coming straight back never shows.
 */
const DESCENT_HOLD_MS = 1500

function makeThread(id: string, status: ThreadStatus = 'executing'): Thread {
  return {
    id,
    projectId: 'project-1',
    providerId: 'pi',
    title: `Thread ${id}`,
    titleSource: 'default',
    status,
    pinned: false,
    archived: false,
    read: true,
    createdAt: 0,
    updatedAt: 0,
    lastActivity: 0,
    workingDirectory: '/work'
  }
}

/** The rows a pane would draw for this list, as ids, in the order it draws them. */
function rows(settle: ThreadOrderSettle, desired: readonly Thread[]): string[] {
  return settle.view('threads', desired).map((thread) => thread.id)
}

/**
 * A provider retry flips a thread into `working-paused` and back out of it every
 * few seconds, and each flip arrives as a status change the sidebar would
 * otherwise treat as a move of its own. These pin the promise the reader is
 * given instead: a retry that does not last keeps every row where it was, a
 * retry that does last settles into its slot once, and every other move still
 * happens the moment it arrives.
 */
describe('thread order settle: retry wait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds a status change into the retry wait for the whole window', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])
    expect(rows(settle, [a, b, c])).toEqual(['a', 'b', 'c'])

    // The retry lands with the row sorted ahead, the way a retried run arrives
    // carrying its new activity.
    const retrying = [makeThread('b', 'working-paused'), a, c]
    settle.sync('threads', retrying)
    expect(rows(settle, retrying)).toEqual(['a', 'b', 'c'])

    vi.advanceTimersByTime(RETRY_PAUSE_SETTLE_MS - 1)
    expect(rows(settle, retrying)).toEqual(['a', 'b', 'c'])

    vi.advanceTimersByTime(1)
    expect(rows(settle, retrying)).toEqual(['b', 'a', 'c'])
  })

  it('moves nothing when the retry flash is over before the window elapses', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])

    const retrying = [makeThread('b', 'working-paused'), a, c]
    settle.sync('threads', retrying)
    vi.advanceTimersByTime(1000)
    expect(rows(settle, retrying)).toEqual(['a', 'b', 'c'])

    // Back to work in the slot it always had: leaving the retry commits at once,
    // and there is nothing to commit because the order never changed.
    const working = [a, makeThread('b', 'executing'), c]
    settle.sync('threads', working)
    expect(rows(settle, working)).toEqual(['a', 'b', 'c'])
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(RETRY_PAUSE_SETTLE_MS)
    expect(rows(settle, working)).toEqual(['a', 'b', 'c'])
  })

  it('settles several retries that start in the same window in one commit', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    const d = makeThread('d')
    settle.sync('threads', [a, b, c, d])

    let desired: Thread[] = [makeThread('b', 'working-paused'), a, c, d]
    settle.sync('threads', desired)
    vi.advanceTimersByTime(1500)

    // A second thread starts retrying inside the window the first opened, with a
    // slot of its own: it waits out that window rather than opening another, so
    // there is still one timer and no row has moved yet.
    desired = [makeThread('d', 'working-paused'), makeThread('b', 'working-paused'), a, c]
    settle.sync('threads', desired)
    expect(vi.getTimerCount()).toBe(1)
    expect(rows(settle, desired)).toEqual(['a', 'b', 'c', 'd'])

    // 2.5s of the first window is left, so both settle then, together.
    vi.advanceTimersByTime(2499)
    expect(rows(settle, desired)).toEqual(['a', 'b', 'c', 'd'])
    vi.advanceTimersByTime(1)
    expect(rows(settle, desired)).toEqual(['d', 'b', 'a', 'c'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('draws one move for a whole window of retries and the activity under them', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    const d = makeThread('d')
    settle.sync('threads', [a, b, c, d])

    // Every arrangement the pane actually drew, in order.
    const drawn: string[] = []
    const record = (desired: readonly Thread[]): void => {
      const order = rows(settle, desired).join(',')
      if (drawn[drawn.length - 1] !== order) drawn.push(order)
    }
    record([a, b, c, d])

    let desired: Thread[] = [makeThread('b', 'working-paused'), a, c, d]
    settle.sync('threads', desired)
    record(desired)

    // A recency tick arrives under the hold, reordering two other rows. It is
    // part of the move the retry will make, not a move of its own.
    desired = [makeThread('b', 'working-paused'), c, a, d]
    settle.sync('threads', desired)
    vi.advanceTimersByTime(RETRY_PAUSE_SETTLE_MS - 1)
    record(desired)

    vi.advanceTimersByTime(1)
    record(desired)

    expect(drawn).toEqual(['a,b,c,d', 'b,c,a,d'])
  })

  it('commits a row leaving the retry wait at once and drops the hold', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])

    const retrying = [makeThread('b', 'working-paused'), a, c]
    settle.sync('threads', retrying)
    expect(rows(settle, retrying)).toEqual(['a', 'b', 'c'])

    // The retry is over and the row lands where the run left it. That is not the
    // retry's move to hold, so it happens now.
    const resumed = [makeThread('b', 'executing'), a, c]
    settle.sync('threads', resumed)
    expect(rows(settle, resumed)).toEqual(['b', 'a', 'c'])
    expect(vi.getTimerCount()).toBe(0)

    // The hold went with it: nothing is left to fire and move the row again.
    vi.advanceTimersByTime(RETRY_PAUSE_SETTLE_MS * 2)
    expect(rows(settle, resumed)).toEqual(['b', 'a', 'c'])
  })

  it('commits a read change and a row leaving at once', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    settle.sync('threads', [a, b])

    const marked = [b, { ...a, read: false }]
    settle.sync('threads', marked)
    expect(rows(settle, marked)).toEqual(['b', 'a'])
    expect(vi.getTimerCount()).toBe(0)

    // A row leaving the list is structural: it is shown as handed over at once.
    settle.sync('threads', [b])
    expect(rows(settle, [b])).toEqual(['b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still holds recency-only noise for the quiet window', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    settle.sync('threads', [a, b])
    expect(rows(settle, [a, b])).toEqual(['a', 'b'])

    const ticked = [b, a]
    settle.sync('threads', ticked)
    expect(rows(settle, ticked)).toEqual(['a', 'b'])
    vi.advanceTimersByTime(QUIET_MS)
    expect(rows(settle, ticked)).toEqual(['b', 'a'])
  })
})

/**
 * A row that moves down on its own activity - a thread settling into Done, a
 * draft that was just sent away - is the move a running thread undoes a moment
 * later by starting its next turn. These pin the promise instead: the descent
 * waits out its window, so a drop that is coming straight back never shows, and
 * only a descent that lasts is drawn at all.
 */
describe('thread order settle: descent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds a thread settling into Done, and shows nothing when it resumes', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])
    expect(rows(settle, [a, b, c])).toEqual(['a', 'b', 'c'])

    // The thread finishes and sinks below the two rows that were under it.
    const settled = [a, c, makeThread('b', 'completed')]
    settle.sync('threads', settled)
    expect(rows(settle, settled)).toEqual(['a', 'b', 'c'])
    expect(vi.getTimerCount()).toBe(1)

    // The next turn starts inside the window, so the drop is never drawn: the
    // row rises from the slot it still holds and the held move is dropped.
    vi.advanceTimersByTime(DESCENT_HOLD_MS - 1)
    expect(rows(settle, settled)).toEqual(['a', 'b', 'c'])

    const resumed = [makeThread('b', 'executing'), a, c]
    settle.sync('threads', resumed)
    expect(rows(settle, resumed)).toEqual(['b', 'a', 'c'])
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(DESCENT_HOLD_MS * 2)
    expect(rows(settle, resumed)).toEqual(['b', 'a', 'c'])
  })

  it('commits a descent that lasts the whole window', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])

    const settled = [a, c, makeThread('b', 'completed')]
    settle.sync('threads', settled)
    expect(rows(settle, settled)).toEqual(['a', 'b', 'c'])
    expect(vi.getTimerCount()).toBe(1)

    // Nothing brought the row back, so the drop is a real placement and lands
    // when the window is over.
    vi.advanceTimersByTime(DESCENT_HOLD_MS + 1)
    expect(rows(settle, settled)).toEqual(['a', 'c', 'b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('commits a drop the reader made at once, in either direction', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    settle.sync('threads', [a, b])

    // `a` was dragged below `b`: the manual anchor changed, so this is the
    // reader's placement, not a descent to hold.
    const dragged = [b, { ...a, sortOrder: 1 }]
    settle.sync('threads', dragged)
    expect(rows(settle, dragged)).toEqual(['b', 'a'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('commits at once when another row rises in the same pass', () => {
    const settle = new ThreadOrderSettle()
    const a = makeThread('a')
    const b = makeThread('b')
    const c = makeThread('c')
    settle.sync('threads', [a, b, c])

    // A neighbour's activity lifts it over the settling row: the rise is what a
    // reader has to see now, so the pass commits and carries the descent.
    const mixed = [makeThread('c', 'completed'), a, makeThread('b', 'completed')]
    settle.sync('threads', mixed)
    expect(rows(settle, mixed)).toEqual(['c', 'a', 'b'])
  })
})
