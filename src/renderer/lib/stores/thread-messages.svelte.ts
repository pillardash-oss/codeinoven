/**
 * Navigation-safe cache for thread messages.
 *
 * Messages are kept keyed by thread so switching away and back does not lose
 * optimistic user messages or the in-progress agent turn. The store reconciles
 * server state with local optimistic state and applies streaming agent events
 * even when the thread view is not mounted.
 */
import { invoke, subscribe } from '$lib/ipc.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { messageId as createMessageId } from '$shared/id'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  BrainstormTraceUpdate,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  ThreadSettings,
  UserMessagePresentation
} from '$shared/types'

interface ThreadMessagesEntry {
  messages: AgentMessage[]
  /** Monotonic renderer revision for stream-driven DOM effects such as tailing. */
  revision: number
  loaded: boolean
  loading: boolean
  hasOlder: boolean
  error: string
  runIssue: AgentProviderIssue | null
  /** User messages held by the chat engine before delivery to the harness —
   *  the steer-undo window. Keyed by user message id. */
  heldSteerIds: Set<string>
}

/** Bounded window warmed on hover, matching the ThreadView history window so a
 *  preloaded thread opens to the same recent-message tail it would load live. */
export const THREAD_MESSAGE_PRELOAD_WINDOW = 40

const EMPTY_MESSAGES: AgentMessage[] = []
const STREAM_NOTIFICATION_DELAY_MS = 50
/** How many messages to reveal per frame when a large conversation first loads,
 *  so the heavy markdown render spreads across frames instead of mounting
 *  dozens of blocks in one synchronous flush (which blocks the composer). */
const LOAD_REVEAL_BATCH_SIZE = 6
/** Pause between reveal batches — one frame lets the renderer paint and the
 *  composer accept input between batches. */
const LOAD_REVEAL_INTERVAL_MS = 16
/** Bounded navigation pages should land atomically; reveal only large explicit
 * transcript loads where spreading the work across frames is worthwhile. */
const LOAD_REVEAL_THRESHOLD = 80

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

function messageText(msg: AgentMessage): string {
  return msg.parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function mergePartSnapshot(cached: AgentPart, incoming: AgentPart): AgentPart {
  if (
    cached.type === incoming.type &&
    (cached.type === 'text' || cached.type === 'reasoning') &&
    (incoming.type === 'text' || incoming.type === 'reasoning') &&
    cached.text.length > incoming.text.length &&
    cached.text.startsWith(incoming.text)
  ) {
    return { ...incoming, text: cached.text }
  }
  return incoming
}

/** A disk/provider snapshot may trail the live event stream; never downgrade cached parts. */
function mergeMessageSnapshot(cached: AgentMessage, incoming: AgentMessage): AgentMessage {
  const incomingParts = new Map(incoming.parts.map((part) => [part.id, part]))
  const cachedPartIds = new Set(cached.parts.map((part) => part.id))
  return {
    ...cached,
    ...incoming,
    parts: [
      ...cached.parts.map((part) => {
        const replacement = incomingParts.get(part.id)
        return replacement ? mergePartSnapshot(part, replacement) : part
      }),
      ...incoming.parts.filter((part) => !cachedPartIds.has(part.id))
    ]
  }
}

class ThreadMessagesStore {
  #threads = new Map<string, ThreadMessagesEntry>()
  #streamNotifyTimer: ReturnType<typeof setTimeout> | undefined
  #streamDirtyKeys = new Set<string>()
  /** Pending batched-reveal state for a large initial load, keyed by thread. */
  #revealTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #revealGens = new Map<string, number>()
  #revealPending = new Map<string, { entry: ThreadMessagesEntry; merged: AgentMessage[] }>()
  #loadPromises = new Map<string, Promise<void>>()

  /** Reactive cache keyed by `projectId:threadId`. */
  threads = new SvelteMap<string, ThreadMessagesEntry>()

  /** Active session IDs per thread, used to filter streaming events. */
  #sessionIds = new Map<string, string>()
  /** Reverse lookup keeps inactive threads subscribed to their live session stream. */
  #threadsBySession = new Map<string, { projectId: string; threadId: string }>()

  constructor() {
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event) this.#handleAgentEvent(event)
    })
  }

  /** Return or create a cache entry for the given thread. */
  private entry(projectId: string, threadId: string): ThreadMessagesEntry {
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
    }
    return entry
  }

  /** Current message list for a thread — safe to use in deriveds/effects. */
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
    this.#notify(projectId, threadId)
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

  async waitForLoad(projectId: string, threadId: string): Promise<void> {
    await this.#loadPromises.get(threadKey(projectId, threadId))
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
    this.#notify(projectId, threadId)
  }

  /** Whether this user message is held by the engine before harness delivery
   *  (the steer-undo window). */
  isSteerHeld(projectId: string, threadId: string, messageId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.heldSteerIds.has(messageId) ?? false
  }

  /** Ask the engine to drop a held steer before it reaches the harness. */
  async discardSteer(projectId: string, threadId: string, messageId: string): Promise<void> {
    await invoke('agent:discardSteer', projectId, threadId, messageId)
  }

  clearLoadError(projectId: string, threadId: string): void {
    const entry = this.entry(projectId, threadId)
    if (!entry.error) return
    entry.error = ''
    this.#notify(projectId, threadId)
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

  /** Load the authoritative mirror and merge it with local optimistic state. */
  async load(projectId: string, threadId: string, recentLimit?: number): Promise<void> {
    const key = threadKey(projectId, threadId)
    const existing = this.#loadPromises.get(key)
    if (existing) return existing
    const loadPromise = this.#load(projectId, threadId, recentLimit)
    this.#loadPromises.set(key, loadPromise)
    try {
      await loadPromise
    } finally {
      if (this.#loadPromises.get(key) === loadPromise) this.#loadPromises.delete(key)
    }
  }

  /**
   * Load a temporary side chat from its harness mirror.
   *
   * Temporary conversations share every primitive with threads — cache entry,
   * reconcile merge, event application, busy tracking — and differ only in
   * where their mirror lives (`agent:loadTemporaryChatMessages`) and that the
   * mirror is unpaged.
   */
  async loadTemporary(projectId: string, conversationId: string): Promise<void> {
    const key = threadKey(projectId, conversationId)
    const existing = this.#loadPromises.get(key)
    if (existing) return existing
    const loadPromise = (async (): Promise<void> => {
      const entry = this.entry(projectId, conversationId)
      entry.loading = true
      entry.error = ''
      this.#notify(projectId, conversationId)
      try {
        const serverMessages = await invoke('agent:loadTemporaryChatMessages', conversationId)
        this.reconcile(projectId, conversationId, serverMessages)
        entry.hasOlder = false
        entry.loaded = true
      } catch (err) {
        entry.error = err instanceof Error ? err.message : 'Could not load messages.'
      } finally {
        entry.loading = false
        this.#notify(projectId, conversationId)
      }
    })()
    this.#loadPromises.set(key, loadPromise)
    try {
      await loadPromise
    } finally {
      if (this.#loadPromises.get(key) === loadPromise) this.#loadPromises.delete(key)
    }
  }

  /**
   * Commit a pre-built message into a temporary conversation immediately —
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
    this.#notify(projectId, conversationId)
  }

  async #load(projectId: string, threadId: string, recentLimit?: number): Promise<void> {
    const entry = this.entry(projectId, threadId)
    entry.loading = true
    entry.error = ''
    this.#notify(projectId, threadId)

    try {
      let serverMessages: AgentMessage[]
      if (recentLimit === undefined) {
        serverMessages = await invoke('agent:loadMessages', projectId, threadId)
        entry.hasOlder = false
      } else {
        const page = await invoke(
          'thread:loadMessages',
          projectId,
          threadId,
          undefined,
          recentLimit
        )
        // Bounded loads are used by thread switching and hover preloads. They
        // must remain mirror-only: a new thread, or a thread whose latest
        // mirror page contains only a user message, is a valid bounded result.
        // Falling back here to agent:loadMessages turns a cheap navigation into
        // an unbounded provider transcript read and can freeze the renderer on
        // long sessions. Callers that explicitly need the provider transcript
        // must use load() without a limit.
        serverMessages = page.messages
        entry.hasOlder = page.hasOlder
      }
      this.reconcile(projectId, threadId, serverMessages)
      entry.loaded = true
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'Could not load messages.'
    } finally {
      entry.loading = false
      this.#notify(projectId, threadId)
    }
  }

  /** Bounded warmup for the message cache so opening the thread (sidebar
   *  click, Ctrl+Tab) renders instantly instead of showing the loading
   *  spinner. Non-destructive: merges into the cache, never marks read, and
   *  never clobbers newer live data. Skipped when the thread already has
   *  messages or a load is in flight. */
  async preload(projectId: string, threadId: string): Promise<void> {
    const entry = this.entry(projectId, threadId)
    if (entry.loaded) return
    await this.load(projectId, threadId, THREAD_MESSAGE_PRELOAD_WINDOW)
  }

  /** Non-destructively merge server messages with the local cache. */
  reconcile(projectId: string, threadId: string, serverMessages: AgentMessage[]): void {
    const entry = this.entry(projectId, threadId)
    const local = entry.messages

    // Build a map of server messages by ID.
    const serverById = new Map(serverMessages.map((m) => [m.id, m]))
    const localById = new Map(local.map((message) => [message.id, message]))
    const activeTurnUserMessageId = agentRuns.currentTurnUserMessageId(projectId, threadId)
    const activeTurnStartedAt = activeTurnUserMessageId
      ? localById.get(activeTurnUserMessageId)?.createdAt
      : undefined

    // Stable renderer-generated IDs are forwarded through every driver. Keep
    // local optimistic messages until the server confirms that exact ID, and
    // retain live assistant messages from the active turn while the provider
    // or disk snapshot catches up with the event stream.
    const keptLocal = local.filter(
      (message) =>
        !serverById.has(message.id) &&
        (message.role === 'user' ||
          (activeTurnStartedAt !== undefined && message.createdAt >= activeTurnStartedAt))
    )

    // Merge by sorting all messages by createdAt, stable by ID.
    const merged = [
      ...serverMessages.map((message) => {
        const cached = localById.get(message.id)
        return cached ? mergeMessageSnapshot(cached, message) : message
      }),
      ...keptLocal
    ].sort((a, b) => {
      const timeDiff = a.createdAt - b.createdAt
      if (timeDiff !== 0) return timeDiff
      return a.id.localeCompare(b.id)
    })

    this.#applyLoadedMessages(projectId, threadId, entry, merged)
  }

  /** Merge a bounded history page without discarding pages already loaded for the thread. */
  mergePage(projectId: string, threadId: string, pageMessages: AgentMessage[]): void {
    const entry = this.entry(projectId, threadId)
    // This accumulator is deliberately plain data, not renderer state. A
    // reactive map here would add proxy tracking to every history-page load and
    // wake unrelated dependents while a live trace is streaming.
    const mergedById: Record<string, AgentMessage> = Object.fromEntries(
      entry.messages.map((message) => [message.id, message])
    )
    for (const message of pageMessages) {
      const cached = mergedById[message.id]
      mergedById[message.id] = cached ? mergeMessageSnapshot(cached, message) : message
    }
    const merged = Object.values(mergedById).sort((a, b) => {
      const timeDiff = a.createdAt - b.createdAt
      if (timeDiff !== 0) return timeDiff
      return a.id.localeCompare(b.id)
    })
    this.#applyLoadedMessages(projectId, threadId, entry, merged)
  }

  /**
   * Apply a freshly loaded message set without ever freezing the renderer.
   *
   * Small sets (a warm cache, an incremental refresh, a short conversation)
   * land atomically. A large initial load is marked `loaded` immediately so the
   * "Loading conversation…" placeholder clears and the composer stays live, then
   * revealed tail-first in small batches across frames — each batch yields to
   * the event loop so the heavy per-message markdown render never blocks typing.
   *
   * A newer authoritative set (another load, a streaming event) cancels any
   * in-flight reveal and applies the whole thing, so nothing is ever lost.
   */
  #applyLoadedMessages(
    projectId: string,
    threadId: string,
    entry: ThreadMessagesEntry,
    merged: AgentMessage[]
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
      this.#notify(projectId, threadId)
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
      this.#notify(projectId, threadId)
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
  #flushReveal(key: string): void {
    const pending = this.#revealPending.get(key)
    if (!pending) return
    this.#cancelReveal(key)
    pending.entry.messages = pending.merged
    this.#notifyByKey(key)
  }

  private appendOptimistic(
    projectId: string,
    threadId: string,
    text: string,
    attachments: PromptAttachment[],
    userMessageId?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    presentation?: UserMessagePresentation
  ): { entry: ThreadMessagesEntry; messageId: string } {
    this.#flushReveal(threadKey(projectId, threadId))
    const entry = this.entry(projectId, threadId)
    const messageId = userMessageId ?? createMessageId()
    // A pre-seeded message (the side chat's explain prompt committed at open
    // time) already occupies this ID — reuse it instead of appending a duplicate.
    if (entry.messages.some((candidate) => candidate.id === messageId)) {
      return { entry, messageId }
    }
    const optimistic: AgentMessage = {
      id: messageId,
      role: 'user',
      origin: 'user',
      visibility: 'conversation',
      parts: [
        ...(!presentation
          ? [
              {
                type: 'text' as const,
                id: `${messageId}-text`,
                messageID: messageId,
                text
              }
            ]
          : []),
        ...attachments.map((file, index): AgentPart => ({
          type: 'file',
          id: `${messageId}-file-${index}`,
          messageID: messageId,
          mime: file.mime,
          url: file.url,
          filename: file.filename
        })),
        ...(presentation
          ? [
              {
                type: 'user-presentation' as const,
                id: `${messageId}-presentation`,
                messageID: messageId,
                presentation
              }
            ]
          : [])
      ],
      references: promptReferences?.length ? promptReferences : undefined,
      projectReferences: projectReferences?.length ? projectReferences : undefined,
      createdAt: Date.now(),
      completedAt: Date.now()
    }
    entry.messages = [...entry.messages, optimistic]
    this.#notify(projectId, threadId)
    return { entry, messageId }
  }

  private confirmOptimistic(
    projectId: string,
    threadId: string,
    entry: ThreadMessagesEntry,
    messageId: string,
    confirmed: AgentMessage
  ): void {
    const index = entry.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return
    entry.messages = [
      ...entry.messages.slice(0, index),
      confirmed,
      ...entry.messages.slice(index + 1)
    ]
    this.#notify(projectId, threadId)
  }

  private rejectOptimistic(
    projectId: string,
    threadId: string,
    entry: ThreadMessagesEntry,
    messageId: string,
    error: unknown
  ): void {
    const messageError = error instanceof Error ? error.message : 'Message failed to send.'
    entry.error = messageError
    // Keep the user's prompt when transport fails. Removing it makes a send
    // failure look like the conversation was wiped and loses retry context.
    entry.messages = entry.messages.map((message) =>
      message.id === messageId ? { ...message, error: messageError } : message
    )
    this.#notify(projectId, threadId)
  }

  /**
   * Send a user message. Inserts an optimistic message immediately, persists it
   * on the server, and reconciles the optimistic ID with the confirmed ID.
   * Returns the message ID so callers can synchronously act on the optimistic
   * message (e.g. scroll to it).
   */
  async send(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    specAction: SpecActionIntent | undefined,
    userMessageId?: string,
    prepare?: () => Promise<void>,
    promptContext?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    presentation?: UserMessagePresentation,
    taskReferences?: PromptAssignmentTaskReference[]
  ): Promise<string> {
    this.setRunIssue(projectId, threadId, null)
    const { entry, messageId } = this.appendOptimistic(
      projectId,
      threadId,
      text,
      attachments,
      userMessageId,
      promptReferences,
      projectReferences,
      presentation
    )

    try {
      await prepare?.()
      const confirmed = await invoke(
        'agent:sendPrompt',
        projectId,
        threadId,
        settings,
        text,
        attachments,
        specAction,
        messageId,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      )
      this.confirmOptimistic(projectId, threadId, entry, messageId, confirmed)
    } catch (err) {
      this.rejectOptimistic(projectId, threadId, entry, messageId, err)
      throw err
    }
    return messageId
  }

  /** Append a user message to the harness's active native turn. */
  async steer(
    projectId: string,
    threadId: string,
    text: string,
    attachments: PromptAttachment[],
    userMessageId?: string,
    promptContext?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    presentation?: UserMessagePresentation,
    taskReferences?: PromptAssignmentTaskReference[]
  ): Promise<string> {
    this.setRunIssue(projectId, threadId, null)
    const { entry, messageId } = this.appendOptimistic(
      projectId,
      threadId,
      text,
      attachments,
      userMessageId,
      promptReferences,
      projectReferences,
      presentation
    )
    try {
      const confirmed = await invoke(
        'agent:steerPrompt',
        projectId,
        threadId,
        text,
        attachments,
        messageId,
        promptContext,
        promptReferences,
        projectReferences,
        presentation,
        taskReferences
      )
      this.confirmOptimistic(projectId, threadId, entry, messageId, confirmed)
    } catch (error) {
      this.rejectOptimistic(projectId, threadId, entry, messageId, error)
      throw error
    }
    return messageId
  }

  /**
   * Send a turn into a temporary side chat.
   *
   * Temporary conversations are ordinary entries in this store — same
   * optimistic append, same mirror reconciliation, same event-driven busy
   * tracking. Only the backend transport differs (`agent:sendTemporaryPrompt`,
   * read-only, returns the final assistant message instead of the confirmed
   * user message), and the visible text may differ from the transport text
   * (the explain tab shows a short action label while sending the full
   * instruction).
   */
  async sendTemporary(
    projectId: string,
    threadId: string,
    conversationId: string,
    settings: ThreadSettings,
    options: {
      text: string
      transportText?: string
      attachments?: PromptAttachment[]
      references?: PromptReference[]
      initialContext?: string
      userMessageId?: string
    }
  ): Promise<void> {
    const { text, transportText, attachments = [], references, initialContext, userMessageId } =
      options
    this.setRunIssue(projectId, conversationId, null)
    const { entry, messageId } = this.appendOptimistic(
      projectId,
      conversationId,
      text,
      attachments,
      userMessageId,
      references
    )
    agentRuns.setBusy(projectId, conversationId, true, messageId)
    try {
      const response = await invoke(
        'agent:sendTemporaryPrompt',
        projectId,
        threadId,
        conversationId,
        settings,
        transportText ?? text,
        attachments,
        references ?? [],
        initialContext,
        messageId,
        text
      )
      // The backend returns the authoritative final assistant message; merge it
      // through the same never-downgrade snapshot path a thread's mirror uses.
      if (response) this.mergePage(projectId, conversationId, [response])
    } catch (error) {
      this.rejectOptimistic(projectId, conversationId, entry, messageId, error)
      throw error
    }
  }

  /** Steer — append a user intervention into a temporary chat's active turn. */
  async steerTemporary(
    projectId: string,
    threadId: string,
    conversationId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[] = [],
    references: PromptReference[] = []
  ): Promise<void> {
    this.setRunIssue(projectId, conversationId, null)
    const { entry, messageId } = this.appendOptimistic(
      projectId,
      conversationId,
      text,
      attachments,
      undefined,
      references
    )
    agentRuns.setBusy(projectId, conversationId, true, messageId)
    try {
      await invoke(
        'agent:steerTemporaryPrompt',
        projectId,
        threadId,
        conversationId,
        settings,
        text,
        attachments,
        references,
        messageId,
        text
      )
    } catch (error) {
      this.rejectOptimistic(projectId, conversationId, entry, messageId, error)
      throw error
    }
  }

  /** Apply a streaming part update to the cached messages. */
  upsertPart(projectId: string, threadId: string, sessionId: string, part: AgentPart): void {
    if (!this.#matchesSession(projectId, threadId, sessionId)) return
    this.#flushReveal(threadKey(projectId, threadId))
    const entry = this.entry(projectId, threadId)
    const msgId = part.messageID
    const msgIndex = entry.messages.findLastIndex((message) => message.id === msgId)

    if (msgIndex === -1) {
      // If the part's text matches the last user's message, it's an echo from
      // the server — skip it to prevent a duplicate assistant message.
      if (part.type === 'text') {
        const lastUser = [...entry.messages].reverse().find((m) => m.role === 'user')
        if (lastUser && messageText(lastUser) === part.text) return
      }
      const newMsg: AgentMessage = {
        id: msgId,
        role: 'assistant',
        parts: [part],
        createdAt: Date.now()
      }
      entry.messages = [...entry.messages, newMsg]
    } else {
      const msg = entry.messages[msgIndex]
      // Providers overwhelmingly update the active tail part. Search backward
      // so a long-running trace stays constant-time in the common case.
      const partIndex = msg.parts.findLastIndex((candidate) => candidate.id === part.id)
      if (partIndex === -1) {
        msg.parts = [...msg.parts, part]
      } else {
        msg.parts[partIndex] = part
      }
      entry.messages = [...entry.messages]
    }
    this.#notifyStreaming(projectId, threadId)
  }

  /** Append streaming text to a specific part field. */
  applyDelta(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    partId: string,
    field: string,
    delta: string
  ): void {
    if (!this.#matchesSession(projectId, threadId, sessionId)) return
    this.#flushReveal(threadKey(projectId, threadId))
    const entry = this.entry(projectId, threadId)
    const msg = entry.messages.findLast((message) => message.id === messageId)
    if (!msg) return
    const part = msg.parts.findLast((candidate) => candidate.id === partId)
    if (!part) return
    if (field === 'text' && (part.type === 'text' || part.type === 'reasoning')) {
      part.text += delta
      entry.messages = [...entry.messages]
      this.#notifyStreaming(projectId, threadId)
    }
  }

  /** Mark a message as completed and stamp reasoning end times. */
  markCompleted(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    error?: string,
    compaction = false,
    tokens?: AgentMessage['tokens'],
    contextWindow?: number,
    contextUsed?: number,
    contextEstimated?: boolean,
    rateLimits?: AgentMessage['rateLimits'],
    credits?: AgentMessage['credits']
  ): void {
    if (!this.#matchesSession(projectId, threadId, sessionId)) return
    this.#flushReveal(threadKey(projectId, threadId))
    const entry = this.entry(projectId, threadId)
    const doneMsg = entry.messages.find((m) => m.id === messageId)
    if (!doneMsg) return
    const now = Date.now()
    doneMsg.completedAt = now
    doneMsg.error = error
    if (tokens) doneMsg.tokens = tokens
    if (contextWindow !== undefined) doneMsg.contextWindow = contextWindow
    if (contextUsed !== undefined) doneMsg.contextUsed = contextUsed
    if (contextEstimated !== undefined) doneMsg.contextEstimated = contextEstimated
    if (rateLimits) doneMsg.rateLimits = rateLimits
    if (credits) doneMsg.credits = credits
    if (compaction) {
      doneMsg.parts = doneMsg.parts.map((part): AgentPart =>
        part.type === 'text'
          ? {
              type: 'compaction-summary',
              id: part.id,
              messageID: part.messageID,
              text: part.text
            }
          : part
      )
    }
    for (const part of doneMsg.parts) {
      if (part.type === 'reasoning' && !part.time?.end) {
        part.time = { ...part.time, end: now }
      }
      // A tool still marked running when its message completes is finished by
      // definition — freeze its duration so the card stops counting while the
      // agent moves on to later tool calls.
      if (part.type === 'tool' && part.state.status === 'running' && !part.state.time?.end) {
        part.state.status = 'completed'
        part.state.time = { start: part.state.time?.start ?? now, end: now }
      }
      if (
        part.type === 'subagent' &&
        part.activity.status === 'running' &&
        !part.activity.time?.end
      ) {
        part.activity.status = 'completed'
        part.activity.time = { start: part.activity.time?.start ?? now, end: now }
      }
    }
    entry.messages = [...entry.messages]
    this.#notifyStreaming(projectId, threadId)
  }

  /** Apply provider account telemetry without creating a duplicate answer. */
  updateUsage(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    tokens?: AgentMessage['tokens'],
    contextWindow?: number,
    contextUsed?: number,
    contextEstimated?: boolean,
    cost?: number,
    rateLimits?: AgentMessage['rateLimits'],
    credits?: AgentMessage['credits']
  ): void {
    if (!this.#matchesSession(projectId, threadId, sessionId)) return
    this.#flushReveal(threadKey(projectId, threadId))
    const entry = this.entry(projectId, threadId)
    const message = entry.messages.find((candidate) => candidate.id === messageId)
    if (!message) return
    if (tokens) message.tokens = tokens
    if (contextWindow !== undefined) message.contextWindow = contextWindow
    if (contextUsed !== undefined) message.contextUsed = contextUsed
    if (contextEstimated !== undefined) message.contextEstimated = contextEstimated
    if (cost !== undefined) message.cost = cost
    if (rateLimits) message.rateLimits = rateLimits
    if (credits) message.credits = credits
    entry.messages = [...entry.messages]
    this.#notifyStreaming(projectId, threadId)
  }

  /** Drop a message and everything after it from the cache. */
  async truncate(projectId: string, threadId: string, messageId: string): Promise<AgentMessage[]> {
    const kept = await invoke('agent:truncateMessages', projectId, threadId, messageId)
    this.#applyRemoval(projectId, threadId, kept)
    return kept
  }

  /**
   * Delete history around a message: `down` keeps the prefix before it,
   * `single` removes the message and its turn's work trace and splices the
   * neighbours together, `up` keeps only later messages.
   */
  async remove(
    projectId: string,
    threadId: string,
    messageId: string,
    mode: 'down' | 'single' | 'up'
  ): Promise<AgentMessage[]> {
    const kept = await invoke('agent:deleteMessages', projectId, threadId, messageId, mode)
    this.#applyRemoval(projectId, threadId, kept)
    return kept
  }

  #applyRemoval(projectId: string, threadId: string, kept: AgentMessage[]): void {
    const key = threadKey(projectId, threadId)
    this.#cancelReveal(key)
    const entry = this.entry(projectId, threadId)
    entry.messages = kept
    entry.loaded = true
    entry.error = ''
    this.#sessionIds.delete(key)
    this.#notify(projectId, threadId)
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
  }

  #matchesSession(projectId: string, threadId: string, sessionId: string): boolean {
    return this.#sessionIds.get(threadKey(projectId, threadId)) === sessionId
  }

  /** Apply Brainstorm lifecycle events by thread identity so navigation never drops them. */
  #applyBrainstormTrace(projectId: string, threadId: string, update: BrainstormTraceUpdate): void {
    if (update.type === 'refresh.started') {
      agentRuns.setBackgroundBusy(projectId, threadId, 'brainstorm_report', update.startedAt)
      return
    }
    if (update.type === 'refresh.completed') {
      agentRuns.completeBackground(projectId, threadId, 'brainstorm_report')
      return
    }
    if (update.type === 'refresh.failed') {
      // A failed post-turn refresh must clear the background busy state (no
      // 'refresh.completed' will arrive) and surface the failure like any
      // other terminal run issue instead of silently dropping the version.
      agentRuns.completeBackground(projectId, threadId, 'brainstorm_report')
      this.setRunIssue(projectId, threadId, {
        kind: 'unknown',
        message: update.error,
        harnessId: update.harnessId,
        retryable: true
      })
      return
    }
    if (update.type === 'started' || update.type === 'completed') {
      this.mergePage(projectId, threadId, update.messages)
      if (update.type === 'started') {
        agentRuns.setBusy(projectId, threadId, true, this.#latestUserMessageId(projectId, threadId))
      } else {
        agentRuns.setIdle(projectId, threadId)
      }
      return
    }

    const entry = this.entry(projectId, threadId)
    const message = entry.messages.find((candidate) => candidate.id === update.messageId)
    if (!message) return
    if (update.type === 'part.updated') {
      const partIndex = message.parts.findIndex((part) => part.id === update.part.id)
      const parts =
        partIndex === -1
          ? [...message.parts, update.part]
          : message.parts.map((part, index) => (index === partIndex ? update.part : part))
      this.mergePage(projectId, threadId, [{ ...message, parts }])
      return
    }
    if (update.field !== 'text') return
    const parts = message.parts.map((part) => {
      if (part.id !== update.partId) return part
      if (part.type !== 'text' && part.type !== 'reasoning') return part
      return { ...part, text: `${part.text}${update.delta}` }
    })
    this.mergePage(projectId, threadId, [{ ...message, parts }])
  }

  #handleAgentEvent(event: AgentEvent): void {
    if (event.type === 'brainstorm.trace') {
      this.#applyBrainstormTrace(event.projectId, event.threadId, event.update)
      return
    }
    if (!('sessionId' in event)) return
    // A temporary chat's isolated session coming up — bind it so the shared
    // pipeline routes streaming events to the side chat like any thread.
    if (event.type === 'temporary-chat.started') {
      this.setSessionId(event.projectId, event.temporaryChatId, event.sessionId)
      return
    }
    const target = this.#threadsBySession.get(event.sessionId)
    if (!target) return
    const { projectId, threadId } = target

    // Live streaming activity is authoritative evidence the agent is still
    // working. A stray idle/status snapshot between activity blips must never
    // leave the thread idle — and fold its working trace — while parts keep
    // streaming (the definitive session.idle that ends the turn clears it).
    if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
      this.setRunIssue(projectId, threadId, null)
      agentRuns.setBusy(projectId, threadId, true, this.#latestUserMessageId(projectId, threadId))
    }

    switch (event.type) {
      case 'steer.held':
      case 'steer.delivered':
      case 'steer.discarded': {
        const entry = this.entry(projectId, threadId)
        if (event.type === 'steer.held') {
          entry.heldSteerIds.add(event.userMessageId)
        } else {
          entry.heldSteerIds.delete(event.userMessageId)
          if (event.type === 'steer.discarded') {
            // The steer never reached the harness — remove the optimistic
            // message so the conversation looks untouched.
            entry.messages = entry.messages.filter(
              (message) => message.id !== event.userMessageId
            )
          }
        }
        this.#notify(projectId, threadId)
        break
      }
      case 'message.part.updated':
        this.upsertPart(projectId, threadId, event.sessionId, event.part)
        break
      case 'message.part.delta':
        this.applyDelta(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.partId,
          event.field,
          event.delta
        )
        break
      case 'message.completed':
        this.markCompleted(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.error,
          event.compaction,
          event.tokens,
          event.contextWindow,
          event.contextUsed,
          event.contextEstimated,
          event.rateLimits,
          event.credits
        )
        break
      case 'usage.updated':
        this.updateUsage(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.tokens,
          event.contextWindow,
          event.contextUsed,
          event.contextEstimated,
          event.cost,
          event.rateLimits,
          event.credits
        )
        break
      case 'session.status':
        if (event.status.state === 'working' || event.status.state === 'waiting') {
          this.setRunIssue(projectId, threadId, null)
          agentRuns.setBusy(
            projectId,
            threadId,
            true,
            this.#latestUserMessageId(projectId, threadId)
          )
        } else if (event.status.state === 'idle') {
          agentRuns.completeSession(projectId, threadId)
        }
        break
      case 'session.idle':
        agentRuns.completeSession(projectId, threadId)
        break
      case 'session.error':
        agentRuns.setIdle(projectId, threadId)
        this.setRunIssue(
          projectId,
          threadId,
          event.issue ?? {
            kind: 'unknown',
            message: event.error ?? 'The agent stopped with an unknown error.',
            rawError: event.error,
            harnessId: 'unknown',
            retryable: true
          }
        )
        break
    }
  }

  #latestUserMessageId(projectId: string, threadId: string): string | undefined {
    const messages = this.entry(projectId, threadId).messages
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user') return messages[index].id
    }
    return undefined
  }

  #notifyStreaming(projectId: string, threadId: string): void {
    this.#streamDirtyKeys.add(threadKey(projectId, threadId))
    if (this.#streamNotifyTimer !== undefined) return
    this.#streamNotifyTimer = setTimeout(() => {
      this.#streamNotifyTimer = undefined
      const dirtyKeys = [...this.#streamDirtyKeys]
      this.#streamDirtyKeys.clear()
      for (const key of dirtyKeys) this.#publish(key)
    }, STREAM_NOTIFICATION_DELAY_MS)
  }

  #notify(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
    this.#streamDirtyKeys.delete(key)
    this.#publish(key)
  }

  #notifyByKey(key: string): void {
    this.#streamDirtyKeys.delete(key)
    this.#publish(key)
  }

  #publish(key: string): void {
    const entry = this.#threads.get(key)
    if (!entry) return
    entry.revision += 1
    this.threads.set(key, { ...entry })
  }
}

export const threadMessages = new ThreadMessagesStore()
