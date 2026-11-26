import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { AgentMessage, AgentProviderIssue } from '$shared/types'
import { isTurnTransparentUserMessage } from '../components/threads/thread-turn-parts'
import { CONVERSATION_SLOTS, planSlots, pushOpenedSlot } from './thread-conversation-slots'
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

/**
 * One thread's last "which prompt does this run belong to" answer.
 *
 * Held with the message it was read from, so a single identity check proves the
 * transcript still answers the same way (see `latestUserMessageId`).
 */
interface LatestUserMessageMemo {
  length: number
  heldSteers: number
  index: number
  message: AgentMessage | undefined
  value: string | undefined
}
/** Publish interval for a thread with no mounted view. Keeps a background run's
 *  cache current without paying the on-screen cadence for it. */
const UNOBSERVED_STREAM_NOTIFICATION_DELAY_MS = 250
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
  /**
   * Threads a mounted view is reading right now, by key.
   *
   * A thread nobody is watching still streams, and it used to publish at the
   * same frame cadence as the one on screen: with seventeen runs going that is
   * seventeen transcripts copied and seventeen map slots rewritten sixty times a
   * second, on the renderer's only thread, for one conversation the reader can
   * actually see. Assembly stays exact either way   only the publish rate of an
   * unobserved thread drops, and mounting its view publishes it immediately.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #observedKeys = new Map<string, number>()
  /** When each thread last published a content change, for the interval above. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #streamPublishedAt = new Map<string, number>()

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

  /**
   * How many threads may hold a cached transcript at once.
   *
   * The cache had no limit at all: every thread opened this session kept its
   * window of messages resident, and clearing was only ever explicit (a delete, a
   * drop). A long session across a few dozen threads grew the renderer by
   * hundreds of megabytes for conversations nobody was looking at, which is what
   * a rising Tab working set in the trace turned out to be. Least-recently-read
   * entries are evicted past this, never one with a mounted reader: a thread on
   * screen is never the one that gets dropped, so the conversation cannot blank.
   */
  static readonly MAX_CACHED_THREADS = CONVERSATION_SLOTS

  /** The transcript the user is looking at. Everything else is frozen. */
  #activeKey: string | null = null

  /**
   * Every conversation that is on screen, oldest below, the one on top live.
   *
   * A stack rather than a single key because surfaces do stack: a temporary side
   * chat opens over the thread that spawned it, and while it is up that thread is
   * behind it   frozen, correctly   and when the side chat closes the thread
   * underneath is the one on screen again without anyone having to reopen it.
   * With one key, closing the side chat left its thread frozen and stale until
   * the reader left and came back.
   */
  #activeStack: string[] = []

  /**
   * The conversations the reader opened, oldest first.
   *
   * This, and not the map's own order, is what fills a slot. `entry()` is called
   * by every agent event and every preload, so insertion order records *touches*:
   * a thread streaming in the background   one nobody has opened and nobody can
   * see   would otherwise count as the most recently used conversation and push a
   * frozen slot the reader is actually switching between out of the cache. Only
   * an open moves a conversation, which is what makes "the last three" true.
   */
  #openOrder: string[] = []

  /**
   * Put a conversation on top of the stack of what is on screen.
   *
   * One thread is live; the other two slots are snapshots that must not be fed.
   * `null` is the empty state, where nothing is on screen, no transcript may keep
   * working in the background, and every slot is given back because there is no
   * conversation the reader is coming back to.
   */
  setActive(projectId: string | null, threadId: string | null): void {
    if (projectId === null || threadId === null) {
      this.#activeStack = []
      this.#activeKey = null
      this.#openOrder = []
      this.#enforceSlots()
      return
    }
    const key = threadKey(projectId, threadId)
    this.#activeStack = this.#activeStack.filter((candidate) => candidate !== key)
    this.#activeStack.push(key)
    this.#activeKey = key
    this.#openOrder = pushOpenedSlot(this.#openOrder, key)
    // Opening is the one moment the stack changes, and the one moment the memory
    // an evicted slot held is worth reclaiming.
    this.#enforceSlots()
  }

  /**
   * Take a conversation off the stack of what is on screen.
   *
   * The surface below it becomes live again, which is what a side chat closing
   * over its thread needs: the thread was frozen while the side chat was up and
   * must start receiving its own run's events the moment it is visible again.
   */
  releaseActive(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
    if (!this.#activeStack.includes(key)) return
    this.#activeStack = this.#activeStack.filter((candidate) => candidate !== key)
    this.#activeKey = this.#activeStack[this.#activeStack.length - 1] ?? null
  }

  /** The active transcript's key, or null when the app is showing an empty state. */
  get activeKey(): string | null {
    return this.#activeKey
  }

  /**
   * Whether a thread's transcript is frozen: held in a slot, not on screen.
   *
   * A thread with no slot at all is not frozen — it is simply absent, and the
   * event path is what creates its slot. Only a transcript we are deliberately
   * keeping but not showing is frozen, because that is the one that would
   * otherwise spend a whole run updating pixels nobody can see.
   */
  isFrozen(projectId: string, threadId: string): boolean {
    if (this.#activeKey === null) return false
    const key = threadKey(projectId, threadId)
    if (key === this.#activeKey) return false
    return this.#threads.has(key)
  }

  /** Return or create a cache entry for the given thread. */
  entry(projectId: string, threadId: string): ThreadMessagesEntry {
    const key = threadKey(projectId, threadId)
    const existing = this.#threads.get(key)
    if (existing !== undefined) return existing
    const created: ThreadMessagesEntry = {
      messages: [],
      revision: 0,
      loaded: false,
      loading: false,
      hasOlder: false,
      error: '',
      runIssue: null,
      waitingIssue: null,
      heldSteerIds: new SvelteSet<string>()
    }
    this.#threads.set(key, created)
    this.threads.set(key, { ...created })
    this.structureMessages.set(key, created.messages)
    // A transcript nobody opened arrives here from a preload or a background
    // event. Creating one is how the cache grows, so it is also the moment to
    // bring it back to the open stack; the headroom keeps a burst of new entries
    // from running the whole pass once per event.
    if (this.#threads.size > CONVERSATION_SLOTS * 2) this.#enforceSlots()
    return created
  }

  /**
   * Bring the resident transcripts back to the open stack.
   *
   * A mounted reader, a load in flight and a pending reveal are all reasons a
   * transcript is still being used, so the plan holds them whatever the stack
   * says and the stack itself is untouched by them. Everything else outside the
   * last {@link CONVERSATION_SLOTS} opened conversations is dropped.
   */
  #enforceSlots(): void {
    if (this.#threads.size === 0) return
    const held = [...this.#threads.keys()].filter(
      (key) =>
        key === this.#activeKey ||
        this.#observedKeys.has(key) ||
        this.#revealPending.has(key) ||
        this.#threads.get(key)?.loading === true
    )
    const plan = planSlots({
      openOrder: this.#openOrder,
      resident: [...this.#threads.keys()],
      held
    })
    this.#openOrder = plan.openOrder
    for (const key of plan.evicted) {
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      this.clear(key.slice(0, separator), key.slice(separator + 1))
    }
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
    // A settled failure and an active provider wait are the same slot on screen,
    // so writing either one clears the other: a run that ends in an error is no
    // longer parked, and a run that starts or settles is not waiting.
    const hadWaiting = entry.waitingIssue !== null
    entry.waitingIssue = null
    if (entry.runIssue === issue) {
      if (hadWaiting) this.notify(projectId, threadId)
      return
    }
    entry.runIssue = issue
    this.notify(projectId, threadId)
  }

  /** The provider wait this thread is parked on, when it has one. */
  waitingIssue(projectId: string, threadId: string): AgentProviderIssue | null {
    return this.threads.get(threadKey(projectId, threadId))?.waitingIssue ?? null
  }

  setWaitingIssue(projectId: string, threadId: string, issue: AgentProviderIssue | null): void {
    const entry = this.entry(projectId, threadId)
    if (entry.waitingIssue === issue) return
    entry.waitingIssue = issue
    this.notify(projectId, threadId)
  }

  /** Whether this user message is held by the engine before harness delivery
   *  (the steer-undo window). */
  isSteerHeld(projectId: string, threadId: string, messageId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.heldSteerIds.has(messageId) ?? false
  }

  /**
   * Remove one message the agent never received.
   *
   * Used by recall: the words go back to the composer, so the row that carried
   * the failure must not stay behind as a message the harness has no record of.
   */
  removeUnsentMessage(projectId: string, threadId: string, messageId: string): void {
    const entry = this.threads.get(threadKey(projectId, threadId))
    if (!entry) return
    if (!entry.messages.some((message) => message.id === messageId)) return
    entry.messages = entry.messages.filter((message) => message.id !== messageId)
    entry.heldSteerIds.delete(messageId)
    this.notify(projectId, threadId)
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
    // The first batch publishes in the same turn that marks the thread loaded.
    // Deferring it opened a window where the thread read as loaded with an empty
    // transcript: the skeleton had already been replaced, so the conversation
    // flashed an empty container and the composer jumped to the middle of the
    // column (the centered head start is for a thread with no messages) before
    // the tail arrived and pushed it back down. Six messages cost one small
    // render, so there is nothing to gain by deferring them.
    publishBatch()
  }

  /**
   * Whether this thread's large initial load is still being revealed in
   * batches. A window that reads its messages mid-reveal holds a partial set,
   * so anything that measures or anchors the transcript has to wait for it.
   */
  revealing(projectId: string, threadId: string): boolean {
    return this.#revealPending.has(threadKey(projectId, threadId))
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

  /**
   * Replace the cached messages of a conversation after a removal.
   *
   * `keep` is the message an edit is rewriting: it belongs at the end of the
   * kept prefix because an edit replaces the history *below* it, never the
   * message itself. Dropping it here is what made the message the user was
   * editing vanish from the conversation until its replacement was persisted.
   */
  applyRemoval(
    projectId: string,
    threadId: string,
    kept: AgentMessage[],
    keep?: AgentMessage
  ): void {
    const key = threadKey(projectId, threadId)
    this.#cancelReveal(key)
    const entry = this.entry(projectId, threadId)
    entry.messages = keep ? [...kept.filter((message) => message.id !== keep.id), keep] : kept
    entry.loaded = true
    entry.error = ''
    this.#sessionIds.delete(key)
    this.notify(projectId, threadId)
  }

  /**
   * Rewrite one message in place and drop everything after it, in a single
   * publish.
   *
   * The edited message keeps its id and its position, so the bubble the reader
   * is looking at is never unmounted: they see their own words take the new
   * text at the instant they submit the edit, not after the mirror has been
   * truncated and the turn has been re-persisted.
   */
  applyEdit(
    projectId: string,
    threadId: string,
    messageId: string,
    rewrite: (message: AgentMessage) => AgentMessage
  ): AgentMessage | null {
    const key = threadKey(projectId, threadId)
    this.#cancelReveal(key)
    const entry = this.entry(projectId, threadId)
    const index = entry.messages.findIndex((message) => message.id === messageId)
    if (index < 0) return null
    const current = entry.messages[index]
    if (!current) return null
    const edited = rewrite(current)
    entry.messages = [...entry.messages.slice(0, index), edited]
    entry.loaded = true
    entry.error = ''
    this.notify(projectId, threadId)
    return edited
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
    this.#streamStructuralKeys.delete(key)
    this.#streamPublishedAt.delete(key)
    this.#observedKeys.delete(key)
    this.#latestUserMessageMemo.delete(key)
    this.threads.delete(key)
    this.structureMessages.delete(key)
  }

  matchesSession(projectId: string, threadId: string, sessionId: string): boolean {
    return this.#sessionIds.get(threadKey(projectId, threadId)) === sessionId
  }

  /** The reverse scan's last answer, per thread. A live turn publishes its
   *  transcript up to sixty times a second and every one of those publishes
   *  needs the id of the prompt the run is anchored to, which used to mean
   *  walking back from the tail to the previous user message on every event. The
   *  answer only moves when a message is added, removed, or replaced, and one
   *  identity check on the message it was read from proves none of those
   *  happened. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #latestUserMessageMemo = new Map<string, LatestUserMessageMemo>()

  latestUserMessageId(projectId: string, threadId: string): string | undefined {
    const entry = this.entry(projectId, threadId)
    const { messages } = entry
    const key = threadKey(projectId, threadId)
    const memo = this.#latestUserMessageMemo.get(key)
    // A reload replaces the message objects, a new prompt changes the length, a
    // held steer changes whether the newest user row counts: the identity check
    // and the two counters catch all three without rescanning.
    if (
      memo &&
      memo.length === messages.length &&
      memo.heldSteers === entry.heldSteerIds.size &&
      messages[memo.index] === memo.message
    ) {
      return memo.value
    }
    const found = this.#scanLatestUserMessageId(entry)
    this.#latestUserMessageMemo.set(key, {
      length: messages.length,
      heldSteers: entry.heldSteerIds.size,
      index: found.index,
      message: found.message,
      value: found.value
    })
    return found.value
  }

  #scanLatestUserMessageId(entry: ThreadMessagesEntry): {
    index: number
    message: AgentMessage | undefined
    value: string | undefined
  } {
    const { messages } = entry
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      // A held steer has not reached the harness yet, so it does not open a
      // turn: the run stays anchored to the prompt it is steering, and the
      // held message renders under that turn's live working trace.
      if (entry.heldSteerIds.has(message.id)) continue
      // A row written into the running turn   a compaction notice, a sub-agent
      // envelope, an app continuation, the record of an answered question
      // rides the turn it arrived under instead of opening one. Anchoring the
      // run to it made every later streamed part look like a brand-new turn,
      // and opening a new turn resets the working trace's fold: the trace the
      // reader had just opened closed itself again while the work they were
      // reading kept arriving.
      if (isTurnTransparentUserMessage(message)) continue
      return { index, message, value: message.id }
    }
    return { index: -1, message: undefined, value: undefined }
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
    this.#scheduleStreamFlush()
  }

  /**
   * Count one mounted reader of this thread's transcript.
   *
   * Returns the release, so a view can hold it for exactly its own lifetime.
   * Mounting publishes right away: the reader asked for this thread, so it must
   * not wait out the slower unobserved interval.
   */
  retain(projectId: string, threadId: string): () => void {
    const key = threadKey(projectId, threadId)
    const count = this.#observedKeys.get(key) ?? 0
    this.#observedKeys.set(key, count + 1)
    this.#publish(key, false)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.#observedKeys.get(key) ?? 1) - 1
      if (remaining > 0) this.#observedKeys.set(key, remaining)
      else this.#observedKeys.delete(key)
    }
  }

  /** How long a thread may go between content publishes. */
  #publishInterval(key: string): number {
    return this.#observedKeys.has(key)
      ? STREAM_NOTIFICATION_DELAY_MS
      : UNOBSERVED_STREAM_NOTIFICATION_DELAY_MS
  }

  /**
   * Run the next publish that is actually due.
   *
   * The dirty set is shared by every streaming thread, and each thread's due
   * time differs by its interval, so the tick publishes what is due and leaves
   * the rest dirty instead of publishing everything at the fastest cadence.
   */
  #scheduleStreamFlush(): void {
    if (this.#streamNotifyTimer !== undefined) return
    this.#streamNotifyTimer = setTimeout(() => {
      this.#streamNotifyTimer = undefined
      const dirtyKeys = [...this.#streamDirtyKeys]
      const now = Date.now()
      for (const key of dirtyKeys) {
        const dueAt = (this.#streamPublishedAt.get(key) ?? 0) + this.#publishInterval(key)
        if (dueAt > now) continue
        this.#streamDirtyKeys.delete(key)
        this.#streamPublishedAt.set(key, now)
        const structural = this.#streamStructuralKeys.has(key)
        this.#streamStructuralKeys.delete(key)
        this.#publish(key, structural)
      }
      // Anything left was not due yet: keep the tick alive so it lands on time.
      if (this.#streamDirtyKeys.size > 0) this.#scheduleStreamFlush()
    }, STREAM_NOTIFICATION_DELAY_MS)
  }

  notify(projectId: string, threadId: string, structural = true): void {
    const key = threadKey(projectId, threadId)
    this.#streamDirtyKeys.delete(key)
    this.#streamStructuralKeys.delete(key)
    this.#publish(key, structural)
  }

  #notifyByKey(key: string, structural = true): void {
    this.#streamDirtyKeys.delete(key)
    this.#streamStructuralKeys.delete(key)
    this.#publish(key, structural)
  }

  #publish(key: string, structural = false): void {
    const entry = this.#threads.get(key)
    if (!entry) return
    // Content-only stream events share one frame-aligned publish. Replace the
    // message array once here so Svelte sees the content change without making
    // every incoming token copy the full transcript.
    if (!structural) entry.messages = [...entry.messages]
    entry.revision += 1
    this.threads.set(key, { ...entry })
    // Every structural mutation path replaces `entry.messages` with a fresh
    // array, so publishing the reference is enough to invalidate shape readers.
    if (structural) this.structureMessages.set(key, entry.messages)
  }
}
