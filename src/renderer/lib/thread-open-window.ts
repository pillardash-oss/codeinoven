import { tick } from 'svelte'

/**
 * The reads a thread open triggers that are not the thread.
 *
 * Opening a thread runs one conversation read and, in the same flush, every
 * surface that reacts to the selection starts its own: the git panels, the
 * checkpoint cards, the design coordinator, orchestration dispatches, the
 * process list, the citation resolver, the command catalog. Each is a renderer
 * request that lands in the main process's queue, and that queue is FIFO, so the
 * conversation's own page waits behind a dozen reads for panels the reader may
 * never open. Measured on a real session, one thread open fired around thirty of
 * them and the conversation's page arrived eight seconds later.
 *
 * They are not wrong to want the data. They are wrong to want it *now*: none of
 * them sits between the click and the conversation on screen. So an open window
 * exists, these channels wait for it, and it closes once the opened thread has
 * had its frame. The panels lose a task nobody can see; the conversation stops
 * queueing behind them.
 *
 * The list is explicit and narrow on purpose: a channel belongs here only when
 * the conversation renders without it.
 */
export const DEFERRED_BEHIND_THREAD_OPEN: ReadonlySet<string> = new Set([
  // Repository and pull-request panels.
  'git:status',
  'git:branches',
  'git:remotes',
  'git:stashList',
  'git:getIdentity',
  'git:getCredentialStatus',
  'repository:remoteOrigin',
  'pr:page',
  // Turn cards, checkpoint summaries and the changes panel.
  'checkpoint:list',
  'checkpoint:latestSummary',
  'checkpoint:activeSummary',
  'thread:openDigest',
  'thread:loadUserMessages',
  // Design, authored-work and orchestration panels.
  'design:state',
  'design:projectWork',
  'orchestration:dispatches',
  // Source and process panels riding the context dock.
  'agent:listProcesses',
  'agent:listCommands',
  'agent:listContextCapabilities',
  // Citation resolution for message references.
  'projectFiles:resolveCitationPaths',
  'projectFiles:resolveExternalCitationPaths',
  // Memory proposals shown in the sources panel.
  'memory:getPendingProposals'
])

/** Longest a panel read waits for the thread that was just opened. */
const OPEN_WINDOW_MS = 400

interface OpenWindow {
  promise: Promise<void>
  release: () => void
}

let window: OpenWindow | null = null
let heldTimer: ReturnType<typeof setTimeout> | null = null

/** Close the window and let every held panel read go. */
function closeWindow(): void {
  heldTimer = null
  const open = window
  window = null
  open?.release()
}

/**
 * A thread is being opened: hold the panel reads until it has had its frame.
 *
 * Two tasks, not a frame callback. A window that is hidden or covered runs no
 * frame callbacks at all, and a panel read must never wait for a paint that is
 * not coming. The first task is the one that mounts the conversation, the second
 * is the one after it.
 */
export function beginThreadOpenWindow(): void {
  if (window === null) {
    let release = (): void => undefined
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    window = { promise, release }
    // A window that is never closed cannot hold a panel read: the wait is
    // bounded, and the bound only matters for a bug.
    setTimeout(() => {
      if (window !== null) closeWindow()
    }, OPEN_WINDOW_MS)
  }
  if (heldTimer !== null) clearTimeout(heldTimer)
  heldTimer = setTimeout(() => {
    heldTimer = setTimeout(closeWindow, 0)
  }, 0)
}

/** Whether a channel waits behind the open window at all. */
export function waitsBehindThreadOpen(channel: string): boolean {
  return DEFERRED_BEHIND_THREAD_OPEN.has(channel)
}

/**
 * Resolve once the thread that was just opened is on screen.
 *
 * Called by the IPC layer for the channels above and nothing else, so the
 * conversation's own reads never reach it.
 */
export async function settleBehindThreadOpen(): Promise<void> {
  const open = window
  if (open === null) return
  await open.promise
}

/**
 * Run work on the task after the open thread's state has been applied.
 *
 * `tick()` is Svelte's own statement that the pending state changes are in the
 * DOM; the timer after it is the task in which that DOM can be presented. It
 * replaces a frame callback everywhere the deferral is about *the thread that
 * was just opened*, because a covered window runs no frame callbacks and every
 * one of these deferrals must still happen.
 */
export function afterShellPaint(run: () => void): () => void {
  let cancelled = false
  void (async () => {
    await tick()
    if (cancelled) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (cancelled) return
    run()
  })()
  return () => {
    cancelled = true
  }
}
