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
import { SvelteMap } from 'svelte/reactivity'
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

interface ThreadMessagesEntry {
  messages: AgentMessage[]
  loaded: boolean
  loading: boolean
  error: string
  runIssue: AgentProviderIssue | null
}

/** Bounded window warmed on hover, matching the ThreadView history window so a
 *  preloaded thread opens to the same recent-message tail it would load live. */
export const THREAD_MESSAGE_PRELOAD_WINDOW = 40

const EMPTY_MESSAGES: AgentMessage[] = []
const STREAM_NOTIFICATION_DELAY_MS = 50

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
      entry = { messages: [], loaded: false, loading: false, error: '', runIssue: null }
      this.#threads.set(key, entry)
      this.threads.set(key, { ...entry })
    }
    return entry
  }

  /** Current message list for a thread — safe to use in deriveds/effects. */
  messages(projectId: string, threadId: string): AgentMessage[] {
    return this.threads.get(threadKey(projectId, threadId))?.messages ?? EMPTY_MESSAGES
  }

  /** Whether the thread has finished its first load. */
  loaded(projectId: string, threadId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.loaded ?? false
  }

  /** Whether the thread is currently loading messages. */
  loading(projectId: string, threadId: string): boolean {
    return this.threads.get(threadKey(projectId, threadId))?.loading ?? false
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
    const entry = this.entry(projectId, threadId)
    if (entry.loading) return
    entry.loading = true
    entry.error = ''
    this.#notify(projectId, threadId)

    try {
      const serverMessages =
        recentLimit === undefined
          ? await invoke('agent:loadMessages', projectId, threadId)
          : (await invoke('thread:loadMessages', projectId, threadId, undefined, recentLimit))
              .messages
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
    if (entry.loaded || entry.loading) return
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

    entry.messages = merged
    entry.loaded = true
    this.#notify(projectId, threadId)
  }

  /** Merge a bounded history page without discarding pages already loaded for the thread. */
  mergePage(projectId: string, threadId: string, pageMessages: AgentMessage[]): void {
    const entry = this.entry(projectId, threadId)
    const mergedById = new SvelteMap(entry.messages.map((message) => [message.id, message]))
    for (const message of pageMessages) {
      const cached = mergedById.get(message.id)
      mergedById.set(message.id, cached ? mergeMessageSnapshot(cached, message) : message)
    }
    entry.messages = [...mergedById.values()].sort((a, b) => {
      const timeDiff = a.createdAt - b.createdAt
      if (timeDiff !== 0) return timeDiff
      return a.id.localeCompare(b.id)
    })
    entry.loaded = true
    this.#notify(projectId, threadId)
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
    const entry = this.entry(projectId, threadId)
    const messageId = userMessageId ?? createMessageId()
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
    entry.error = error instanceof Error ? error.message : 'Message failed to send.'
    entry.messages = entry.messages.filter((message) => message.id !== messageId)
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

  /** Apply a streaming part update to the cached messages. */
  upsertPart(projectId: string, threadId: string, sessionId: string, part: AgentPart): void {
    if (!this.#matchesSession(projectId, threadId, sessionId)) return
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
    const key = threadKey(projectId, threadId)
    const entry = this.entry(projectId, threadId)
    entry.messages = kept
    entry.loaded = true
    entry.error = ''
    this.#sessionIds.delete(key)
    this.#notify(projectId, threadId)
    return kept
  }

  /** Clear the cache for a thread (e.g. on deletion). */
  clear(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
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

  #handleAgentEvent(event: AgentEvent): void {
    if (!('sessionId' in event)) return
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
          agentRuns.setIdle(projectId, threadId)
        }
        break
      case 'session.idle':
        agentRuns.setIdle(projectId, threadId)
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

  #publish(key: string): void {
    const entry = this.#threads.get(key)
    if (entry) this.threads.set(key, { ...entry })
  }
}

export const threadMessages = new ThreadMessagesStore()
