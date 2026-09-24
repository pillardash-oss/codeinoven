/**
 * Navigation-safe cache for thread messages.
 *
 * Messages are kept keyed by thread so switching away and back does not lose
 * optimistic user messages or the in-progress agent turn. The store reconciles
 * server state with local optimistic state and applies streaming agent events
 * even when the thread view is not mounted. The reactive cache, reveal
 * batching, and session routing live in `thread-messages-cache.svelte.ts`, the
 * pure merge rules in `thread-messages-merge.ts`, and streaming/event
 * application in `thread-messages-events.svelte.ts`.
 */
import { invoke, subscribe } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { messageId as createMessageId } from '$shared/id'
import { classifyProviderIssue, parseUsageResetAt } from '$shared/provider-issue'
import { ThreadMessagesCache } from './thread-messages-cache.svelte'
import { ThreadMessagesEvents } from './thread-messages-events.svelte'
import {
  containsNewestTurnPrompt,
  EMPTY_MESSAGES,
  threadKey,
  THREAD_MESSAGE_PRELOAD_WINDOW,
  type ThreadMessagesEntry
} from './thread-messages-merge'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  ThreadSettings,
  UserMessagePresentation
} from '$shared/types'

export { THREAD_MESSAGE_PRELOAD_WINDOW }

/** Extra older pages a bounded load may fetch to reach the newest turn's
 *  prompt. A long working trace spans many rows, so the raw tail window can
 *  start mid-trace; the user's message must never be cut off by the cache. */
const MAX_TURN_ALIGNMENT_PAGES = 4

class ThreadMessagesStore {
  #loadPromises = new Map<string, Promise<void>>()
  private cache = new ThreadMessagesCache()
  private events = new ThreadMessagesEvents(this.cache)

  /** Reactive cache keyed by `projectId:threadId`. */
  get threads() {
    return this.cache.threads
  }

  constructor() {
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event) this.events.handle(event)
    })
  }

  /** Current message list for a thread, safe to use in deriveds/effects. */
  messages(projectId: string, threadId: string): AgentMessage[] {
    return this.cache.messages(projectId, threadId)
  }

  /**
   * The thread's transcript as of its last structural change: the same message
   * objects, but a reference that only moves when messages are added, removed,
   * or reshaped. A streamed delta does not touch it.
   *
   * Read it for identity, role, and timestamps only. The message objects are
   * shared with the live cache, so a part's text read through this array can
   * change under you without the reference moving.
   */
  structureMessages(projectId: string, threadId: string): AgentMessage[] {
    return this.cache.structureMessages.get(threadKey(projectId, threadId)) ?? EMPTY_MESSAGES
  }

  /** Changes whenever this thread's cached transcript is published. */
  streamRevision(projectId: string, threadId: string): number {
    return this.cache.streamRevision(projectId, threadId)
  }

  /** Seed a freshly created empty thread as instantly loaded so the
   *  composer never shows "Loading conversation..." and typing is
   *  available on the very first frame. Idempotent and never clobbers
   *  an already-loaded thread with history. */
  seedEmpty(projectId: string, threadId: string): void {
    this.cache.seedEmpty(projectId, threadId)
  }

  /** Whether the thread has finished its first load. */
  loaded(projectId: string, threadId: string): boolean {
    return this.cache.loaded(projectId, threadId)
  }

  /** Whether the thread is currently loading messages. */
  loading(projectId: string, threadId: string): boolean {
    return this.cache.loading(projectId, threadId)
  }

  hasOlder(projectId: string, threadId: string): boolean {
    return this.cache.hasOlder(projectId, threadId)
  }

  async waitForLoad(projectId: string, threadId: string): Promise<void> {
    await this.#loadPromises.get(threadKey(projectId, threadId))
  }

  /** Last load error for the thread, if any. */
  error(projectId: string, threadId: string): string {
    return this.cache.error(projectId, threadId)
  }

  /** Terminal agent/session failure, kept separate from transcript-loading errors. */
  runIssue(projectId: string, threadId: string): AgentProviderIssue | null {
    return this.cache.runIssue(projectId, threadId)
  }

  setRunIssue(projectId: string, threadId: string, issue: AgentProviderIssue | null): void {
    this.cache.setRunIssue(projectId, threadId, issue)
  }

  /** Whether this user message is held by the engine before harness delivery
   *  (the steer-undo window). */
  isSteerHeld(projectId: string, threadId: string, messageId: string): boolean {
    return this.cache.isSteerHeld(projectId, threadId, messageId)
  }

  /** Ask the engine to drop a held steer before it reaches the harness. */
  async discardSteer(projectId: string, threadId: string, messageId: string): Promise<void> {
    await invoke('agent:discardSteer', projectId, threadId, messageId)
  }

  clearLoadError(projectId: string, threadId: string): void {
    this.cache.clearLoadError(projectId, threadId)
  }

  /** Bind a session ID to a thread so streaming events are routed correctly. */
  setSessionId(projectId: string, threadId: string, sessionId: string | undefined): void {
    this.cache.setSessionId(projectId, threadId, sessionId)
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
    return this.cache.conversationForSession(sessionId)
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
   * Temporary conversations share every primitive with threads (cache entry,
   * reconcile merge, event application, busy tracking) and differ only in
   * where their mirror lives (`agent:loadTemporaryChatMessages`) and that the
   * mirror is unpaged.
   */
  async loadTemporary(projectId: string, conversationId: string): Promise<void> {
    const key = threadKey(projectId, conversationId)
    const existing = this.#loadPromises.get(key)
    if (existing) return existing
    const loadPromise = (async (): Promise<void> => {
      const entry = this.cache.entry(projectId, conversationId)
      entry.loading = true
      entry.error = ''
      this.cache.notify(projectId, conversationId)
      try {
        const serverMessages = await invoke('agent:loadTemporaryChatMessages', conversationId)
        this.reconcile(projectId, conversationId, serverMessages)
        entry.hasOlder = false
        entry.loaded = true
      } catch (err) {
        entry.error = err instanceof Error ? err.message : 'Could not load messages.'
      } finally {
        entry.loading = false
        this.cache.notify(projectId, conversationId)
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
   * Commit a pre-built message into a temporary conversation immediately,
   * used by side chats that must show their seeded selection prompt the instant
   * the tab opens, before any turn is submitted. The message joins the same
   * cache a thread uses, so later mirror reconciles merge against it.
   */
  seedMessage(projectId: string, conversationId: string, message: AgentMessage): void {
    this.cache.seedMessage(projectId, conversationId, message)
  }

  async #load(projectId: string, threadId: string, recentLimit?: number): Promise<void> {
    const entry = this.cache.entry(projectId, threadId)
    entry.loading = true
    entry.error = ''
    this.cache.notify(projectId, threadId)

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
        // Turn-aligned tail: a bounded tail window that starts mid-turn cuts
        // the user's message out of the cached page, the view would begin at
        // the working trace with the prompt missing until "Load earlier
        // messages" was clicked. Extend the fetch just far enough to include
        // the newest turn's prompt, bounded so a pathological mega-turn cannot
        // turn navigation into an unbounded read.
        let alignmentPages = 0
        while (
          serverMessages.length > 0 &&
          entry.hasOlder &&
          !containsNewestTurnPrompt(serverMessages) &&
          alignmentPages < MAX_TURN_ALIGNMENT_PAGES
        ) {
          const oldest = serverMessages[0]
          if (!oldest) break
          const older = await invoke(
            'thread:loadMessages',
            projectId,
            threadId,
            { createdAt: oldest.createdAt, id: oldest.id },
            recentLimit
          )
          if (older.messages.length === 0) {
            entry.hasOlder = false
            break
          }
          serverMessages = [...older.messages, ...serverMessages]
          entry.hasOlder = older.hasOlder
          alignmentPages++
        }
      }
      this.reconcile(projectId, threadId, serverMessages)
      entry.loaded = true
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'Could not load messages.'
    } finally {
      entry.loading = false
      this.cache.notify(projectId, threadId)
    }
  }

  /** Bounded warmup for the message cache so opening the thread (sidebar
   *  click, Ctrl+Tab) renders instantly instead of showing the loading
   *  spinner. Non-destructive: merges into the cache, never marks read, and
   *  never clobbers newer live data. Skipped when the thread already has
   *  messages or a load is in flight. */
  async preload(projectId: string, threadId: string): Promise<void> {
    const entry = this.cache.entry(projectId, threadId)
    if (entry.loaded) return
    await this.load(projectId, threadId, THREAD_MESSAGE_PRELOAD_WINDOW)
  }

  /** Non-destructively merge server messages with the local cache. */
  reconcile(projectId: string, threadId: string, serverMessages: AgentMessage[]): void {
    this.cache.reconcile(
      projectId,
      threadId,
      serverMessages,
      agentRuns.currentTurnUserMessageId(projectId, threadId)
    )
  }

  /** Merge a bounded history page without discarding pages already loaded for the thread. */
  mergePage(projectId: string, threadId: string, pageMessages: AgentMessage[]): void {
    this.cache.mergePage(projectId, threadId, pageMessages)
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
    this.cache.flushReveal(threadKey(projectId, threadId))
    const entry = this.cache.entry(projectId, threadId)
    const messageId = userMessageId ?? createMessageId()
    // A pre-seeded message (the side chat's explain prompt committed at open
    // time) already occupies this ID, reuse it instead of appending a duplicate.
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
    this.cache.notify(projectId, threadId)
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
    this.cache.notify(projectId, threadId)
  }

  /**
   * Reject an optimistic user message after its backend invoke failed.
   *
   * A temporary turn failure (`markNotSent: false`) is settled through the
   * provider-issue card pipeline instead: `agent:sendTemporaryPrompt` spans the
   * whole turn, so the invoke can reject mid-stream after the prompt was
   * already dispatched and even partially streamed, so stamping it "Not sent"
   * would be misleading; the card carries the classified message plus raw
   * error instead.
   */
  private rejectOptimistic(
    projectId: string,
    threadId: string,
    entry: ThreadMessagesEntry,
    messageId: string,
    error: unknown,
    options: { markNotSent?: boolean } = {}
  ): void {
    if (options.markNotSent === false) {
      // Keep the optimistic user prompt as-is; the card carries the failure.
      return
    }
    const messageError = error instanceof Error ? error.message : 'Message failed to send.'
    entry.error = messageError
    // Keep the user's prompt when transport fails. Removing it makes a send
    // failure look like the conversation was wiped and loses retry context.
    entry.messages = entry.messages.map((message) =>
      message.id === messageId ? { ...message, error: messageError } : message
    )
    this.cache.notify(projectId, threadId)
  }

  /**
   * Settle a temporary chat turn whose backend invoke rejected (e.g. a
   * pre-dispatch usage-limit failure). Regular threads recover through
   * `session.idle`/`session.error` broadcast events, but a rejection that
   * happens before the harness session streams anything never produces those
   * events, so the busy flag set optimistically must be cleared here, and the
   * failure classified into the same provider-issue card pipeline regular
   * threads use (quota kind, retry countdown from the reset time).
   */
  #settleFailedTemporaryTurn(
    projectId: string,
    conversationId: string,
    harnessId: string,
    error: unknown
  ): void {
    const raw = error instanceof Error ? error.message : 'Message failed to send.'
    const message = ipcErrorMessage(error, raw)
    const kind = classifyProviderIssue(message)
    const retryAt =
      kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
    this.cache.setRunIssue(projectId, conversationId, {
      kind,
      message,
      rawError: raw,
      harnessId: harnessId || 'unknown',
      retryable: true,
      ...(retryAt === undefined ? {} : { retryAt })
    })
    agentRuns.setIdle(projectId, conversationId)
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
    this.cache.setRunIssue(projectId, threadId, null)
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
    this.cache.setRunIssue(projectId, threadId, null)
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
    // Point the busy run at the steered message immediately. Without this the
    // run keeps the original turn's user message id until the first post-steer
    // part event arrives, so the steered message dangles under a still-live
    // working trace instead of opening its own fresh trace shell right away.
    // This mirrors the regular send path, where the harness 'started' update
    // rebinds the run to the new user message as soon as the turn opens.
    agentRuns.setBusy(projectId, threadId, true, messageId)
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
   * Temporary conversations are ordinary entries in this store, same
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
    const {
      text,
      transportText,
      attachments = [],
      references,
      initialContext,
      userMessageId
    } = options
    this.cache.setRunIssue(projectId, conversationId, null)
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
      // Do NOT stamp the optimistic user message "Not sent":
      // `agent:sendTemporaryPrompt` spans the entire turn, so a rejection can
      // arrive mid-stream after the prompt was dispatched and even partially
      // streamed. The failure settles through the provider-issue card pipeline
      // below, which shows the classified message plus the raw error modal.
      this.#settleFailedTemporaryTurn(projectId, conversationId, settings.harnessId, error)
      this.rejectOptimistic(projectId, conversationId, entry, messageId, error, {
        markNotSent: false
      })
      throw error
    }
  }

  /** Steer, append a user intervention into a temporary chat's active turn. */
  async steerTemporary(
    projectId: string,
    threadId: string,
    conversationId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[] = [],
    references: PromptReference[] = []
  ): Promise<void> {
    this.cache.setRunIssue(projectId, conversationId, null)
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
      // Same as `sendTemporary`: never stamp "Not sent" onto a temporary turn;
      // the provider-issue card is the single, deep error surface.
      this.#settleFailedTemporaryTurn(projectId, conversationId, settings.harnessId, error)
      this.rejectOptimistic(projectId, conversationId, entry, messageId, error, {
        markNotSent: false
      })
      throw error
    }
  }

  /** Apply a streaming part update to the cached messages. */
  upsertPart(projectId: string, threadId: string, sessionId: string, part: AgentPart): void {
    this.events.upsertPart(projectId, threadId, sessionId, part)
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
    this.events.applyDelta(projectId, threadId, sessionId, messageId, partId, field, delta)
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
    credits?: AgentMessage['credits'],
    bankedResets?: AgentMessage['bankedResets']
  ): void {
    this.events.markCompleted(
      projectId,
      threadId,
      sessionId,
      messageId,
      error,
      compaction,
      tokens,
      contextWindow,
      contextUsed,
      contextEstimated,
      rateLimits,
      credits,
      bankedResets
    )
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
    credits?: AgentMessage['credits'],
    bankedResets?: AgentMessage['bankedResets']
  ): void {
    this.events.updateUsage(
      projectId,
      threadId,
      sessionId,
      messageId,
      tokens,
      contextWindow,
      contextUsed,
      contextEstimated,
      cost,
      rateLimits,
      credits,
      bankedResets
    )
  }

  /** Drop a message and everything after it from the cache. */
  async truncate(projectId: string, threadId: string, messageId: string): Promise<AgentMessage[]> {
    const kept = await invoke('agent:truncateMessages', projectId, threadId, messageId)
    this.cache.applyRemoval(projectId, threadId, kept)
    return kept
  }

  /** Replace the cached messages of a conversation with the kept set returned
   *  by a temporary-chat history deletion. */
  applyKept(projectId: string, threadId: string, kept: AgentMessage[]): void {
    this.cache.applyRemoval(projectId, threadId, kept)
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
    this.cache.applyRemoval(projectId, threadId, kept)
    return kept
  }

  /** Clear the cache for a thread (e.g. on deletion). */
  clear(projectId: string, threadId: string): void {
    this.cache.clear(projectId, threadId)
  }
}

export const threadMessages = new ThreadMessagesStore()
