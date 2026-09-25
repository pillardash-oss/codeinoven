import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { AgentMessage, AgentProviderIssue } from '$shared/types'
import {
  EMPTY_MESSAGES,
  mergePageMessages,
  mergeReconciledMessages,
  threadKey,
  type ThreadMessagesEntry
} from './thread-messages-merge'
/** Frame-aligned stream notification cadence: deltas paint within one frame
 *  of arrival so the reveal trail stays fed and the stream never looks stalled. */
const STREAM_NOTIFICATION_DELAY_MS = 16
/** How many messages to reveal per frame when a large conversation first loads,
 *  so the heavy markdown render spreads across frames instead of mounting
 *  dozens of blocks in one synchronous flush (which blocks the composer). */
const LOAD_REVEAL_BATCH_SIZE = 6
/** Pause between reveal batches, one frame lets the renderer paint and the
 *  composer accept input between batches. */
const LOAD_REVEAL_INTERVAL_MS = 16
/** Bounded navigation pages should land atomically; reveal only large explicit
 *  transcript loads where spreading the work across frames is worthwhile. */
const LOAD_REVEAL_THRESHOLD = 80

/**
 * Reactive cache and reconciliation core for thread messages.
 *
 * Owns the per-thread entries, the published reactive snapshot, stream
 * notification batching, the batched large-load reveal, and the session
 * routing table. The ThreadMessagesStore composition root delegates reads and
 * mutation primitives here while it owns transport (load/send/steer) and
 * agent-event application.
 */
export class ThreadMessagesCache {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #threads = new Map<string, ThreadMessagesEntry>()
  #streamNotifyTimer: ReturnType<typeof setTimeout> | undefined
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #streamDirtyKeys = new Set<string>()
  /** Pending batched-reveal state for a large initial load, keyed by thread. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #revealTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #revealGens = new Map<string, number>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #revealPending = new Map<string, { entry: ThreadMessagesEntry; merged: AgentMessage[] }>()
  /** Keys whose pending stream batch must also republish the structure map. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #streamStructuralKeys = new Set<string>()

  /** Reactive cache keyed by `projectId:threadId`. */
  threads = new SvelteMap<string, ThreadMessagesEntry>()

  /**
   * Per-thread message arrays re-published ONLY when the transcript's shape
   * changes: messages added or removed, an id or timestamp rewritten, a part
   * appearing, or an entry flag that the turn index reads. A streamed text delta
   * mutates a part in place and bumps the content revision without touching this
   * map.
   *
   * That split is the difference between one transcript pass per structural
   * change and one per streamed frame. `threads` still changes on every publish,
   * so anything that renders message *content* keeps using `messages()`; readers
   * that only care about identity, role, and timestamps (the turn index, the
   * history list, the mounted window) use this and the stream stops waking them.
   *
   * The array published here is the live one, so its message objects are shared
   * and mutated in place by a delta. Read it for shape only   never hold a part
   * object from it across a publish.
   */
  structureMessages = new SvelteMap<string, AgentMessage[]>()

  /** Active session IDs per thread, used to filter streaming events. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #sessionIds = new Map<string, string>()
  /** Reverse lookup keeps inactive threads subscribed to their live session stream. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #threadsBySession = new Map<string, { projectId: string; threadId: string }>()

  /** Return or create a cache entry for the given thread. */
  entry(projectId: string, threadId: string): ThreadMessagesEntry {
    const key = threadKey(projectId, threadId)
    let entry = this.#threads.get(key)
    if (!entry) {
      entry = {
        messages: [],
        revision: 0,
        loaded: false,
        loading: false,
        hasOlder: false,
        error: '',
        runIssue: null,
        heldSteerIds: new SvelteSet<string>()
      }
      this.#threads.set(key, entry)
      this.threads.set(key, { ...entry })
      this.structureMessages.set(key, entry.messages)
    }
    return entry
  }

  /** Current message list for a thread, safe to use in deriveds/effects. */
  messages(projectId: string, threadId: string): AgentMessage[] {
    return this.threads.get(threadKey(projectId, threadId))?.messages ?? EMPTY_MESSAGES
  }

  /** Changes whenever this thread's cached transcript is published. */
  streamRevision(projectId: string, threadId: string): number {
    return this.threads.get(threadKey(projectId, threadId))?.revision ?? 0
  }

  /** Seed a freshly created empty thread as instantly loaded so the
   *  composer never shows "Loading conversation..." and typing is
   *  available on the very first frame. Idempotent and never clobbers
   *  an already-loaded thread with history. */
  seedEmpty(projectId: string, threadId: string): void {
    const entry = this.entry(projectId, threadId)
    if (entry.loaded) return
    // A new thread has no messages; mark it loaded immediately so
    // ThreadView can render the composer without waiting for the
    // bounded mirror IPC round-trip.
    entry.messages = []
    entry.loaded = true
    entry.loading = false
    entry.hasOlder = false
    entry.error = ''
    this.notify(projectId, threadId)
  }

  /** Whether the thread has finished its first load. */
  loaded(projectId: string, threadId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.loaded ?? false
  }

  /** Whether the thread is currently loading messages. */
  loading(projectId: string, threadId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.loading ?? false
  }

  hasOlder(projectId: string, threadId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.hasOlder ?? false
  }

  /** Last load error for the thread, if any. */
  error(projectId: string, threadId: string): string {
    return this.threads.get(threadKey(projectId, threadId))?.error ?? ''
  }

  /** Terminal agent/session failure, kept separate from transcript-loading errors. */
  runIssue(projectId: string, threadId: string): AgentProviderIssue | null {
    return this.threads.get(threadKey(projectId, threadId))?.runIssue ?? null
  }

  setRunIssue(projectId: string, threadId: string, issue: AgentProviderIssue | null): void {
    const entry = this.entry(projectId, threadId)
    if (entry.runIssue === issue) return
    entry.runIssue = issue
    this.notify(projectId, threadId)
  }

  /** Whether this user message is held by the engine before harness delivery
   *  (the steer-undo window). */
  isSteerHeld(projectId: string, threadId: string, messageId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.heldSteerIds.has(messageId) ?? false
  }

  clearLoadError(projectId: string, threadId: string): void {
    const entry = this.entry(projectId, threadId)
    if (!entry.error) return
    entry.error = ''
    this.notify(projectId, threadId)
  }

  /** Bind a session ID to a thread so streaming events are routed correctly. */
  setSessionId(projectId: string, threadId: string, sessionId: string | undefined): void {
    const key = threadKey(projectId, threadId)
    const previousSessionId = this.#sessionIds.get(key)
    if (previousSessionId && previousSessionId !== sessionId) {
      this.#threadsBySession.delete(previousSessionId)
    }
    if (sessionId) {
      this.#sessionIds.set(key, sessionId)
      this.#threadsBySession.set(sessionId, { projectId, threadId })
    } else {
      this.#sessionIds.delete(key)
    }
  }

  /**
   * The conversation a live session currently streams into, or null when no
   * conversation owns it.
   *
   * Events that carry nothing but a session id (permission requests) have no
   * conversation identity of their own; this is the same routing table the
   * streaming path uses, so temporary side chats and threads resolve
   * identically.
   */
  conversationForSession(sessionId: string): { projectId: string; conversationId: string } | null {
    const owner = this.#threadsBySession.get(sessionId)
    return owner ? { projectId: owner.projectId, conversationId: owner.threadId } : null
  }

  /**
   * Commit a pre-built message into a temporary conversation immediately,
   * used by side chats that must show their seeded selection prompt the instant
   * the tab opens, before any turn is submitted. The message joins the same
   * cache a thread uses, so later mirror reconciles merge against it.
   */
  seedMessage(projectId: string, conversationId: string, message: AgentMessage): void {
    this.#cancelReveal(threadKey(projectId, conversationId))
    const entry = this.entry(projectId, conversationId)
    if (entry.messages.some((candidate) => candidate.id === message.id)) return
    entry.messages = [...entry.messages, message]
    entry.loaded = true
    entry.loading = false
    entry.hasOlder = false
    entry.error = ''
    this.notify(projectId, conversationId)
  }

  /** Non-destructively merge server messages with the local cache. */
  reconcile(
    projectId: string,
    threadId: string,
    serverMessages: AgentMessage[],
    activeTurnUserMessageId: string | null | undefined
  ): void {
    const entry = this.entry(projectId, threadId)
    const merged = mergeReconciledMessages(entry.messages, serverMessages, activeTurnUserMessageId)
    this.#applyLoadedMessages(projectId, threadId, entry, merged)
  }

  /** Merge a bounded history page without discarding pages already loaded for the thread. */
  mergePage(projectId: string, threadId: string, pageMessages: AgentMessage[]): void {
    const entry = this.entry(projectId, threadId)
    const merged = mergePageMessages(entry.messages, pageMessages)
    this.#applyLoadedMessages(projectId, threadId, entry, merged.messages, merged.structural)
  }

  /**
   * Apply a freshly loaded message set without ever freezing the renderer.
   *
   * Small sets (a warm cache, an incremental refresh, a short conversation)
   * land atomically. A large initial load is marked `loaded` immediately so the
   * "Loading conversation..." placeholder clears and the composer stays live, then
   * revealed tail-first in small batches across frames, each batch yields to
   * the event loop so the heavy per-message markdown render never blocks typing.
   *
   * A newer authoritative set (another load, a streaming event) cancels any
   * in-flight reveal and applies the whole thing, so nothing is ever lost.
   */
  #applyLoadedMessages(
    projectId: string,
    threadId: string,
    entry: ThreadMessagesEntry,
    merged: AgentMessage[],
    structural = true
  ): void {
    const key = threadKey(projectId, threadId)
    // Incremental/small sets and any merge into an already-loaded thread apply
    // in full: the tail-reveal exists to soften a cold thread's first paint,
    // not to re-animate every background sync (thread:updated refreshes,
    // brainstorm trace updates) that lands after the thread is already on
    // screen. Without this guard, every such merge on a thread with more than
    // LOAD_REVEAL_THRESHOLD total messages truncated the visible list back
    // down to a handful of messages and regrew it, flickering the working
    // trace and any content past the truncated tail.
    if (merged.length <= LOAD_REVEAL_THRESHOLD || entry.loaded) {
      this.#cancelReveal(key)
      entry.messages = merged
      entry.loaded = true
      this.notify(projectId, threadId, structural)
      return
    }
    this.#cancelReveal(key)
    entry.loaded = true
    const generation = (this.#revealGens.get(key) ?? 0) + 1
    this.#revealGens.set(key, generation)
    this.#revealPending.set(key, { entry, merged })

    let revealed = LOAD_REVEAL_BATCH_SIZE
    const publishBatch = (): void => {
      if (this.#revealGens.get(key) !== generation) return
      // Tail-first: the newest, most-visible messages render before older ones.
      entry.messages = merged.slice(merged.length - revealed)
      this.notify(projectId, threadId, structural)
      if (revealed >= merged.length) {
        this.#revealTimers.delete(key)
        this.#revealPending.delete(key)
        return
      }
      revealed = Math.min(merged.length, revealed + LOAD_REVEAL_BATCH_SIZE)
      this.#revealTimers.set(key, setTimeout(publishBatch, LOAD_REVEAL_INTERVAL_MS))
    }
    this.#revealTimers.set(key, setTimeout(publishBatch, LOAD_REVEAL_INTERVAL_MS))
  }

  /** Stop any in-flight batched reveal for a thread. */
  #cancelReveal(key: string): void {
    const timer = this.#revealTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#revealTimers.delete(key)
    }
    const generation = this.#revealGens.get(key)
    if (generation !== undefined) this.#revealGens.set(key, generation + 1)
    this.#revealPending.delete(key)
  }

  /**
   * Flush a pending batched reveal immediately. Used when live streaming or an
   * optimistic mutation needs the complete message set so a batch tick never
   * overwrites newer streaming data with an older partial slice.
   */
  flushReveal(key: string): void {
    const pending = this.#revealPending.get(key)
    if (!pending) return
    this.#cancelReveal(key)
    pending.entry.messages = pending.merged
    this.#notifyByKey(key)
  }

  /** Replace the cached messages of a conversation after a removal. */
  applyRemoval(projectId: string, threadId: string, kept: AgentMessage[]): void {
    const key = threadKey(projectId, threadId)
    this.#cancelReveal(key)
    const entry = this.entry(projectId, threadId)
    entry.messages = kept
    entry.loaded = true
    entry.error = ''
    this.#sessionIds.delete(key)
    this.notify(projectId, threadId)
  }

  /** Clear the cache for a thread (e.g. on deletion). */
  clear(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
    this.#cancelReveal(key)
    const sessionId = this.#sessionIds.get(key)
    if (sessionId) this.#threadsBySession.delete(sessionId)
    this.#threads.delete(key)
    this.#sessionIds.delete(key)
    this.#streamDirtyKeys.delete(key)
    this.threads.delete(key)
    this.structureMessages.delete(key)
  }

  matchesSession(projectId: string, threadId: string, sessionId: string): boolean {
    return this.#sessionIds.get(threadKey(projectId, threadId)) === sessionId
  }

  latestUserMessageId(projectId: string, threadId: string): string | undefined {
    const messages = this.entry(projectId, threadId).messages
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user') return messages[index].id
    }
    return undefined
  }

  /**
   * Publish a streamed content change on the next frame.
   *
   * `structural` must be true whenever the change could alter the transcript's
   * shape (a message or part appearing, a timestamp moving). The ordinary delta
   * path   text appended to a part that already exists   passes false, which is
   * what keeps the turn index and the history list off the streaming cadence.
   */
  notifyStreaming(projectId: string, threadId: string, structural = false): void {
    const key = threadKey(projectId, threadId)
    this.#streamDirtyKeys.add(key)
    if (structural) this.#streamStructuralKeys.add(key)
    if (this.#streamNotifyTimer !== undefined) return
    this.#streamNotifyTimer = setTimeout(() => {
      this.#streamNotifyTimer = undefined
      const dirtyKeys = [...this.#streamDirtyKeys]
      const structuralKeys = this.#streamStructuralKeys
      this.#streamDirtyKeys.clear()
      this.#streamStructuralKeys.clear()
      for (const key of dirtyKeys) this.#publish(key, structuralKeys.has(key))
    }, STREAM_NOTIFICATION_DELAY_MS)
  }

  notify(projectId: string, threadId: string, structural = true): void {
    const key = threadKey(projectId, threadId)
    this.#streamDirtyKeys.delete(key)
    this.#publish(key, structural)
  }

  #notifyByKey(key: string, structural = true): void {
    this.#streamDirtyKeys.delete(key)
    this.#publish(key, structural)
  }

  #publish(key: string, structural = false): void {
    const entry = this.#threads.get(key)
    if (!entry) return
    entry.revision += 1
    this.threads.set(key, { ...entry })
    // Every structural mutation path replaces `entry.messages` with a fresh
    // array, so publishing the reference is enough to invalidate shape readers.
    if (structural) this.structureMessages.set(key, entry.messages)
  }
}
