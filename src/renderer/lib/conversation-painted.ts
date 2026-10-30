/**
 * The point at which the conversation is on the glass.
 *
 * Startup is ordered, not merely deferred. The first screen is the conversation:
 * its transcript, its composer, its title and the rail. Everything that only
 * enriches the app afterwards, and especially the context-sidebar and global
 * panels whose chunks are hundreds of kilobytes, must not compete with the
 * restore's own reads and renders. An idle callback is not that gate: the
 * renderer can go idle between two batches of a tail-first transcript load and
 * the panels would then start fetching while the conversation is still arriving.
 *
 * So the reveal is a real milestone. It is exactly the moment the renderer tells
 * the main process the first screen is up (the signal the splash is released on),
 * and work queued here runs after it, in the order it was queued. Nothing here
 * changes the frame that is already painted: this module only decides when the
 * work after that frame may begin.
 *
 * Like `deferred-work`, this imports no store, so a queue registered from a store
 * can never create an import cycle.
 */

const queued: (() => void)[] = []
let painted = false

/** Whether the conversation has already painted. */
export function hasConversationPainted(): boolean {
  return painted
}

/**
 * Record that the conversation painted and release everything waiting on it.
 *
 * Idempotent: a renderer reload, a second restore or a repeated signal must not
 * run the queued work twice. Tasks are drained before they run, so a task that
 * queues more work lands in the next turn of the queue instead of growing the
 * list being iterated.
 */
export function markConversationPainted(): void {
  if (painted) return
  painted = true
  while (queued.length > 0) {
    const task = queued.shift()
    if (!task) continue
    // Deliberately unguarded: a failing background job must surface as an
    // uncaught renderer error instead of silently disappearing, exactly as
    // `scheduleDeferredWork` treats its own tasks.
    task()
  }
}

/**
 * Run `task` after the conversation has painted, or immediately when it already
 * has. Runs at most once per call.
 */
export function whenConversationPainted(task: () => void): void {
  if (painted) {
    task()
    return
  }
  queued.push(task)
}
