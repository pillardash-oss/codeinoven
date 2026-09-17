/**
 * Post-paint deferral for work that must never delay a view switch.
 *
 * Opening a thread has exactly one hard requirement: the conversation and its
 * composer are mounted and interactive on the frame the user asked for. Every
 * job that only *enriches* that view afterwards — Git status and branches, scope
 * worktree health, source process counts, harness command and capability
 * discovery, the provider-account registry — belongs here instead of running
 * inline, so it can never occupy the switch frame or compete with the message
 * read for the main process.
 *
 * A deferred task runs only after the switch frame has been painted and the
 * renderer is idle, which is also the moment the user's first keystrokes are
 * already being handled. Nothing is ever dropped: every task runs exactly once,
 * bounded by `timeoutMs` so a busy renderer can never starve it.
 *
 * Scheduling the same key again replaces the pending task (latest wins). A fast
 * series of switches therefore leaves one pending job per concern rather than a
 * queue of work for threads the user has already left.
 */

/** Hard upper bound on how long background work may wait for an idle window. */
const DEFAULT_IDLE_TIMEOUT_MS = 400

export interface DeferredWorkOptions {
  /** Upper bound, in milliseconds, on how long the task may wait for idle. */
  timeoutMs?: number
}

interface DeferredEntry {
  task: () => void
  frame: number
  idle: number | null
  timer: ReturnType<typeof setTimeout> | null
}

const pending = new Map<string, DeferredEntry>()

function release(entry: DeferredEntry): void {
  if (entry.frame !== 0 && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(entry.frame)
  }
  if (entry.idle !== null && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(entry.idle)
  }
  if (entry.timer !== null) clearTimeout(entry.timer)
}

function run(key: string, entry: DeferredEntry): void {
  // A newer task for this key replaced us between scheduling and idle.
  if (pending.get(key) !== entry) return
  pending.delete(key)
  // Deliberately unguarded: a failing background job must surface as an
  // uncaught renderer error (captured by the app error panel) instead of
  // silently disappearing. This module intentionally imports no store so a
  // deferred scheduler can never create an import cycle with one.
  entry.task()
}

/**
 * Run `task` after the current switch has been painted and the renderer is idle.
 * Replaces any pending task already scheduled under `key`.
 */
export function scheduleDeferredWork(
  key: string,
  task: () => void,
  options: DeferredWorkOptions = {}
): void {
  cancelDeferredWork(key)
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const entry: DeferredEntry = { task, frame: 0, idle: null, timer: null }
  pending.set(key, entry)

  const requestIdle = (): void => {
    if (pending.get(key) !== entry) return
    if (typeof requestIdleCallback === 'function') {
      entry.idle = requestIdleCallback(() => run(key, entry), { timeout: timeoutMs })
      return
    }
    entry.timer = setTimeout(() => run(key, entry), 0)
  }

  if (typeof requestAnimationFrame !== 'function') {
    entry.timer = setTimeout(requestIdle, 0)
    return
  }
  // Two frames: the first frame is the one that paints the switched-to view,
  // the second proves that paint has landed before any deferred job may take
  // the renderer or the main process.
  entry.frame = requestAnimationFrame(() => {
    if (pending.get(key) !== entry) return
    entry.frame = requestAnimationFrame(requestIdle)
  })
}

/** Drop a pending deferred task. Safe to call for keys that are not scheduled. */
export function cancelDeferredWork(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  release(entry)
}
