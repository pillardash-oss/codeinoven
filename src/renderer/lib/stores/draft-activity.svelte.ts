import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'

/**
 * Global composer-draft activity pub/sub plus the DB draft-commit coordinator.
 *
 * Surfaces subscribe to know when any thread enters or leaves the draft state,
 * and every transition is forwarded to the main process so pending
 * human-decision countdowns stay paused while the user is typing. A non-empty
 * draft re-pings at a throttled pace (one call per {@link ACTIVITY_PING_INTERVAL_MS}
 * of active typing) so a long stretch of keystrokes keeps the pause alive
 * without one IPC call per keystroke; going empty forwards once and stops.
 *
 * Draft persistence is debounced: the draft content is committed to the DB
 * only after 10s of draft inactivity, and cleared drafts flush immediately so
 * a sent message never leaves a stale draft behind.
 *
 * A thread's draft is one shared slot, so the same pub/sub has to carry the
 * other direction too: a draft committed away by another window or a sibling
 * instance is published back to the surfaces holding a mirror of it, or the
 * thread reads as drafted long after its message was sent.
 */

/** Delay between the last draft activity and its DB content commit. */
const DRAFT_COMMIT_DEBOUNCE_MS = 10_000

/** Minimum gap between composer activity pings for one thread while drafting. */
const ACTIVITY_PING_INTERVAL_MS = 10_000

interface PendingDraftCommit {
  timer: ReturnType<typeof setTimeout>
  projectId: string
  threadId: string
  drafting: boolean
  draftJson: string | null
}

const pendingDraftCommits = new SvelteMap<string, PendingDraftCommit>()

type DraftActivityListener = (projectId: string, threadId: string, drafting: boolean) => void
type RemoteDraftClearListener = (projectId: string, threadId: string) => void

const listeners = new SvelteSet<DraftActivityListener>()
const remoteClearListeners = new SvelteSet<RemoteDraftClearListener>()

/** Last time each thread forwarded a composer activity ping, so pings throttle. */
const lastActivityPingAt = new SvelteMap<string, number>()

/** Subscribe to draft activity transitions across every thread. */
export function onDraftActivity(listener: DraftActivityListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Subscribe to drafts that were committed away somewhere other than the
 * composer showing them.
 *
 * The draft store drops its own mirror of such a draft, but a mounted composer
 * holds the words in its editor and not in the store, so it needs the same
 * notice to empty itself. Surfaces pass their thread and ignore everyone
 * else's, so one listener can be registered per open conversation.
 */
export function onRemoteDraftCleared(listener: RemoteDraftClearListener): () => void {
  remoteClearListeners.add(listener)
  return () => remoteClearListeners.delete(listener)
}

/**
 * Announce that a thread's draft was cleared outside this composer.
 *
 * Published after the store has already dropped the draft, so listeners only
 * ever react to a clear that really happened, and the composer's throttle is
 * forgotten with it: the next keystroke in that thread is the first one again.
 */
export function publishRemoteDraftCleared(projectId: string, threadId: string): void {
  lastActivityPingAt.delete(`${projectId}:${threadId}`)
  for (const listener of remoteClearListeners) listener(projectId, threadId)
}

/**
 * Whether this thread still owes the database a draft commit.
 *
 * A commit waiting out the debounce is the one thing that is newer than what
 * the database holds, so a draft committed or cleared elsewhere must not win
 * over it: the user is typing here right now, and their pending commit is what
 * re-asserts their words.
 */
export function hasPendingDraftCommit(projectId: string, threadId: string): boolean {
  return pendingDraftCommits.has(`${projectId}:${threadId}`)
}

/** Publish a thread's current drafted-content state. */
export function publishDraftActivity(projectId: string, threadId: string, drafting: boolean): void {
  for (const listener of listeners) listener(projectId, threadId, drafting)
  const key = `${projectId}:${threadId}`
  if (drafting) {
    const now = Date.now()
    if (now - (lastActivityPingAt.get(key) ?? 0) < ACTIVITY_PING_INTERVAL_MS) return
    lastActivityPingAt.set(key, now)
  } else {
    lastActivityPingAt.delete(key)
  }
  void invoke('thread:draftActivity', projectId, threadId, drafting).catch(() => {
    lastActivityPingAt.delete(key)
  })
}

/**
 * Schedule the DB commit of a thread's draft state (flag + content), pushing
 * the commit back by the debounce window on every draft edit so the DB write
 * lands only after 10s of draft inactivity.
 */
export function scheduleDraftCommit(
  projectId: string,
  threadId: string,
  drafting: boolean,
  draftJson: string | null
): void {
  if (!projectId || !threadId) return
  const key = `${projectId}:${threadId}`
  const pending = pendingDraftCommits.get(key)
  if (pending) clearTimeout(pending.timer)
  const timer = setTimeout(() => {
    pendingDraftCommits.delete(key)
    void invoke('thread:setDraftState', projectId, threadId, drafting, draftJson).catch(() => {})
  }, DRAFT_COMMIT_DEBOUNCE_MS)
  pendingDraftCommits.set(key, { timer, projectId, threadId, drafting, draftJson })
}

/**
 * Commit a thread's draft state immediately, cancelling any pending debounce.
 * Used for clears/sends (no stale draft may outlive the message) and for
 * settling a capture that ended without inserting a transcript.
 */
export function commitDraftStateNow(
  projectId: string,
  threadId: string,
  drafting: boolean,
  draftJson: string | null
): void {
  const key = `${projectId}:${threadId}`
  const pending = pendingDraftCommits.get(key)
  if (pending) {
    clearTimeout(pending.timer)
    pendingDraftCommits.delete(key)
  }
  void invoke('thread:setDraftState', projectId, threadId, drafting, draftJson).catch(() => {})
}

/** Flush every pending draft commit — window unload / app hidden. */
export function flushAllDraftCommits(): void {
  for (const pending of [...pendingDraftCommits.values()]) {
    clearTimeout(pending.timer)
    pendingDraftCommits.delete(`${pending.projectId}:${pending.threadId}`)
    void invoke(
      'thread:setDraftState',
      pending.projectId,
      pending.threadId,
      pending.drafting,
      pending.draftJson
    ).catch(() => {})
  }
}
