/**
 * Frozen pictures of the conversation screens the user just left.
 *
 * Rebuilding a thread's conversation and composer is the expensive part of a
 * switch, and the data is already warm by then (hover and press prefetch it).
 * When a thread is left, its rendered screen is copied into an inert, detached
 * DOM tree. Returning to it paints that copy at once, while the live view mounts
 * underneath and hydrates the new tail. The copies never update: only the open
 * thread is live, so a cached screen costs memory and nothing else.
 */

/** How many left screens stay cached. */
const MAX_SNAPSHOTS = 3

/** The transcript's own scroller, whose offset the copy has to restore. */
const SCROLLER_SELECTOR = '.conversation-scroll'

export interface ThreadScreenSnapshot {
  node: HTMLElement
  scrollTop: number
}

const snapshots = new Map<string, ThreadScreenSnapshot>()

/**
 * Copy a thread's rendered screen as it is torn down.
 *
 * The copy is taken from the leaving tree, which may already be detached, so the
 * scroll offset is handed in by the caller that tracked it while it was live.
 * Form values are not part of a node copy, so the composer's draft text is
 * carried across by hand, and ids are dropped so the copy can never answer a
 * lookup meant for the live screen.
 */
export function captureThreadScreen(threadId: string, root: HTMLElement, scrollTop: number): void {
  const node = root.cloneNode(true) as HTMLElement
  const sourceFields = root.querySelectorAll('textarea')
  const copiedFields = node.querySelectorAll('textarea')
  sourceFields.forEach((field, index) => {
    const copy = copiedFields[index]
    if (copy) copy.value = field.value
  })
  for (const element of node.querySelectorAll('[id]')) element.removeAttribute('id')
  node.removeAttribute('id')
  storeThreadScreen(threadId, { node, scrollTop })
}

/** Keep a screen as the newest entry, dropping the oldest past the cap. */
function storeThreadScreen(threadId: string, snapshot: ThreadScreenSnapshot): void {
  snapshots.delete(threadId)
  snapshots.set(threadId, snapshot)
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) break
    snapshots.delete(oldest)
  }
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
