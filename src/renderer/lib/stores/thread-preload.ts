import { WORKING_TRACE_PAGE_SIZE, type Thread, type ThreadStatus } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { isThreadLiveWorking } from '$lib/thread-status-badge'
import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadTraceCache } from '$lib/stores/thread-trace-cache.svelte'

/**
 * Warm everything a thread needs to paint the moment it is opened.
 *
 * Messages were already warmed on hover, but the working trace was not, and it
 * is both the read that makes a live thread show its tail and the most
 * expensive read in the open path: the main process has to hydrate the
 * thread's append-only stream log the first time anything asks for it. A thread
 * that had never been opened therefore painted its header with only the handful
 * of parts the message mirror had persisted and grew its real tail seconds
 * later, while a reopened thread was instant. Every surface that can open a
 * thread (row hover, pointer press, switcher highlight, restored navigation)
 * routes through here, so a first open warms exactly like a reopen.
 */

/** A fold read within this window is what the open will paint anyway. */
const TRACE_FRESH_MS = 2_000

/**
 * Statuses whose turn is still open, so no completed turn has closed its
 * transcript yet and the durable stream log is the only record of the work.
 */
const OPEN_TURN_STATUSES: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>([
  'planning',
  'executing',
  'awaiting_approval',
  'working-paused'
])

/** Reads already in flight, so a pointer pass over a row never duplicates one. */
const traceReadsInFlight = new Set<string>()

/**
 * Whether a thread can render a working trace at all.
 *
 * A settled thread draws its turn from the message mirror, so hydrating its
 * multi-megabyte log on a pointer pass would buy nothing. Live work, work owned
 * by another instance (the log is shared on disk), and a turn that is still
 * open in any form are the cases where the trace is the only source.
 */
function mayHoldOpenTrace(thread: Thread): boolean {
  if (isThreadLiveWorking(thread)) return true
  if (foreignRuns.isForeign(thread.projectId, thread.id)) return true
  return OPEN_TURN_STATUSES.has(thread.status)
}

/**
 * Read a thread's newest durable trace window into the shared fold.
 *
 * The read is bounded (one window, the same page the mounted view mounts) and
 * best effort: a failure leaves the open path to read the fold itself exactly as
 * it does today.
 */
export function prefetchThreadTrace(thread: Thread): void {
  if (!mayHoldOpenTrace(thread)) return
  const key = `${thread.projectId}:${thread.id}`
  if (traceReadsInFlight.has(key)) return
  const cached = threadTraceCache.peek(thread.projectId, thread.id)
  if (cached?.windowReadAt != null && Date.now() - cached.windowReadAt < TRACE_FRESH_MS) return
  traceReadsInFlight.add(key)
  void invoke('thread:loadStreamParts', thread.projectId, thread.id, {
    limit: WORKING_TRACE_PAGE_SIZE
  })
    .then((page) => {
      if (page.kind !== 'window') return
      threadTraceCache.scope(thread.projectId, thread.id).adoptWindow(page)
    })
    .catch(() => {
      // Best effort. Opening the thread still reads the fold itself.
    })
    .finally(() => {
      traceReadsInFlight.delete(key)
    })
}

/** Warm a thread's whole conversation before it is opened. */
export function preloadThreadConversation(thread: Thread): void {
  prefetchThreadTrace(thread)
  if (threadMessages.loaded(thread.projectId, thread.id)) return
  void threadMessages.preload(thread.projectId, thread.id)
}

/**
 * Warm the conversation this launch is going to restore.
 *
 * Startup used to read that thread's transcript only after `thread:listRecentPerProject`
 * resolved, found the saved row, and called `openThread`: three steps that all
 * had to finish before the first message IPC even left the renderer. Reading it
 * from the persisted selection the moment the renderer boots overlaps that read
 * with the whole hydration pass, so the view mounts into a warm cache instead
 * of starting its own read, and the conversation is on screen as soon as the
 * thread does. Idempotent and safe when nothing was selected.
 */
export function preloadRestoredThreadConversation(): void {
  const saved = rendererRecovery.selectedThread
  if (!saved) return
  if (threadMessages.loaded(saved.projectId, saved.threadId)) return
  void threadMessages.preload(saved.projectId, saved.threadId)
}
