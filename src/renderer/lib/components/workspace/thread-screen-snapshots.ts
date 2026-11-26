/**
 * Frozen pictures of the conversation screens the user just left.
 *
 * Rebuilding a thread's conversation and composer is the expensive part of a
 * switch, and the data is already warm by then (hover and press prefetch it).
 * When a thread is left, its rendered screen is kept as an inert, detached DOM
 * tree. Returning to it paints that tree at once, while the live view mounts
 * underneath and hydrates the new tail. The copies never update: only the open
 * thread is live, so a cached screen costs memory and nothing else.
 *
 * Keeping the screen must never be something the user can feel. It used to be a
 * `cloneNode(true)` of the whole conversation, run inside the switch's teardown
 * flush: opening a thread (Cmd+N, a sidebar click, a notification) copied every
 * message, trace row, diff and image of the thread being left, on the frame the
 * new one was mounting. Taking possession of the leaving tree instead is a
 * re-parent, not a copy, and the only remaining work - dropping ids so the copy
 * can never answer a lookup meant for the live screen - runs in idle time in
 * bounded slices, off the interaction path entirely.
 */

import { CONVERSATION_SLOTS } from '$lib/stores/thread-conversation-slots'

/**
 * How many left screens stay cached.
 *
 * The same policy as the conversation slots — "the last three you opened" — so
 * both read one constant. Tuned separately, the screen cache would park a
 * picture for a thread whose transcript had already been evicted, and the slot
 * stack would hold a transcript for a thread that had nothing left to show.
 */
const MAX_SNAPSHOTS = CONVERSATION_SLOTS

/** The transcript's own scroller, whose offset the copy has to restore. */
const SCROLLER_SELECTOR = '.conversation-scroll'

/**
 * Longest one sanitize slice may run before it hands the rest to the next idle
 * callback. The work is attribute removal on a document-less tree: it forces no
 * layout and paints nothing.
 */
const SANITIZE_SLICE_BUDGET_MS = 8

/** Fallback cadence where the platform has no idle callbacks. */
const IDLE_FALLBACK_MS = 120

export interface ThreadScreenSnapshot {
  node: HTMLElement
  scrollTop: number
}

const snapshots = new Map<string, ThreadScreenSnapshot>()

/**
 * The one holder detached screens are parked in.
 *
 * Never attached to the document: nothing in it is laid out, painted or
 * measured, so parking a screen there cannot cause a reflow of the app.
 */
const snapshotHolder = document.createElement('div')

/** Ids still waiting to be dropped, per parked screen (never read reactively). */
const pendingSanitize = new WeakSet<HTMLElement>()

/**
 * Keep a thread's rendered screen as it is torn down.
 *
 * Svelte removes the keyed subtree before the pane's attachment cleanup runs, so
 * the tree handed here is already off the document and complete. Moving it into
 * the holder keeps exactly what was on screen: no deep copy, no second layout,
 * and no work on the frame the switch happens. Form values come across for free
 * (a moved node keeps its own `value`), and the ids are dropped later, in idle
 * time.
 */
export function captureThreadScreen(threadId: string, root: HTMLElement, scrollTop: number): void {
  snapshotHolder.appendChild(root)
  storeThreadScreen(threadId, { node: root, scrollTop })
  scheduleSanitize(root)
}

/** Keep a screen as the newest entry, dropping the oldest past the cap. */
function storeThreadScreen(threadId: string, snapshot: ThreadScreenSnapshot): void {
  const previous = snapshots.get(threadId)
  if (previous !== undefined && previous.node !== snapshot.node) previous.node.remove()
  snapshots.delete(threadId)
  snapshots.set(threadId, snapshot)
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) break
    snapshots.get(oldest)?.node.remove()
    snapshots.delete(oldest)
  }
}

/** Drop a parked screen's ids in idle slices, so a lookup never hits the copy. */
function scheduleSanitize(node: HTMLElement): void {
  if (pendingSanitize.has(node)) return
  pendingSanitize.add(node)
  whenIdle(() => {
    node.removeAttribute('id')
    // One query over a document-less tree is cheap and forces no layout; the
    // removals are what get sliced so a huge conversation can never become one
    // long task.
    stripIdsInSlices(Array.from(node.querySelectorAll('[id]')), () => {
      pendingSanitize.delete(node)
    })
  })
}

/** Drop the ids of `elements`, handing the rest of the list to the next idle slice. */
function stripIdsInSlices(elements: Element[], done: () => void): void {
  const startedAt = Date.now()
  let index = 0
  while (index < elements.length) {
    while (index < elements.length && Date.now() - startedAt < SANITIZE_SLICE_BUDGET_MS) {
      elements[index]?.removeAttribute('id')
      index += 1
    }
    if (index < elements.length) {
      const rest = elements.slice(index)
      whenIdle(() => stripIdsInSlices(rest, done))
      return
    }
  }
  done()
}

/** Run work when the browser has nothing better to do, with a bounded fallback. */
function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => run(), { timeout: IDLE_FALLBACK_MS * 10 })
    return
  }
  setTimeout(run, IDLE_FALLBACK_MS)
}

/** A thread's cached screen, if it was left recently. */
export function peekThreadScreen(threadId: string): ThreadScreenSnapshot | null {
  return snapshots.get(threadId) ?? null
}

/** Whether an element is the transcript scroller whose offset a copy restores. */
export function isThreadScreenScroller(element: HTMLElement): boolean {
  return element.matches(SCROLLER_SELECTOR)
}

/** Paint a cached screen into its host at the offset the user left it at. */
export function mountThreadScreen(host: HTMLElement, snapshot: ThreadScreenSnapshot): void {
  host.replaceChildren(snapshot.node)
  const scroller = snapshot.node.querySelector(SCROLLER_SELECTOR)
  if (scroller) scroller.scrollTop = snapshot.scrollTop
}
