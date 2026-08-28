import { subscribe, invoke } from '$lib/ipc.svelte'
import {
  contextSidebarState,
  type TemporaryChatContextTab
} from '$lib/stores/context-sidebar.svelte'
import { messageId } from '$shared/id'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentSessionStatus,
  PromptAttachment,
  PromptReference,
  ThreadSettings
} from '$shared/types'
import type { ConversationController, SendPayload } from '../threads/ConversationController.svelte'

/**
 * Union two renderings of the same assistant message without ever dropping a
 * part the UI already streamed. The harness mirror is authoritative for the
 * content of parts it knows, but its snapshot can lag or omit live-only parts
 * (step markers, in-flight reasoning); wholesale replacement shrank the working
 * trace mid-turn, so parts merge by ID — incoming content wins, existing
 * positions and live-only parts are preserved.
 */
function mergeAssistantMessage(existing: AgentMessage, incoming: AgentMessage): AgentMessage {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const byId = new Map<string, AgentPart>()
  const order: string[] = []
  for (const part of [...existing.parts, ...incoming.parts]) {
    if (byId.has(part.id)) {
      byId.set(part.id, part)
      continue
    }
    byId.set(part.id, part)
    order.push(part.id)
  }
  return {
    ...incoming,
    parts: order.map((id) => byId.get(id) as AgentPart)
  }
}

export class TemporaryChatController implements ConversationController {
  readonly kind = 'temporary-chat' as const
  readonly projectId: string
  readonly conversationId: string

  #tab: TemporaryChatContextTab
  #unsubscribeEvent: (() => void) | null = null
  #unsubscribeExpiry: (() => void) | null = null
  #reconcileTimer: ReturnType<typeof setInterval> | null = null
  #reconcileInFlight = false
  /** Bumped whenever the authoritative final response is applied; stale
   *  reconciliation results must never overwrite it. */
  #applyGeneration = 0
  #mounted = false
  /** Monotonic sequence of turn submissions. A settled older submission must
   *  never clear `busy` while a newer one is still in flight — that race is
   *  what left follow-up turns without any working indicator. */
  #sendSequence = 0

  /**
   * Fallback poll interval while a turn is in flight. Live `agent:event`
   * broadcasts are the primary stream, but a dropped subscription window (tab
   * remount, missed `temporary-chat.started`) must never leave the panel blank
   * while the agent works — merging the harness mirror restores the streaming
   * parts and detects completion even without events.
   */
  static readonly RECONCILE_INTERVAL_MS = 1_500

  constructor(tab: TemporaryChatContextTab) {
    this.#tab = tab
    this.projectId = tab.projectId
    this.conversationId = tab.temporaryChatId
  }

  get settings(): ThreadSettings {
    return this.#tab.settings
  }

  updateSettings(updated: ThreadSettings): void {
    this.#tab.settings = updated
  }

  get messages(): AgentMessage[] {
    return this.#tab.messages
  }

  get loaded(): boolean {
    return this.#tab.sessionStarted ? this.#tab.messages.length > 0 || !this.#tab.busy : true
  }

  get loading(): boolean {
    return false
  }

  get hasOlder(): boolean {
    return false
  }

  get busy(): boolean {
    return this.#tab.busy
  }

  get error(): string {
    return this.#tab.error
  }

  get runIssue(): AgentProviderIssue | null {
    return this.#tab.status?.state === 'error' ? this.#tab.status.issue : null
  }

  get status(): AgentSessionStatus | null {
    if (this.#tab.status) return this.#tab.status
    if (!this.#tab.error) return null
    return {
      state: 'error',
      issue: {
        kind: 'unknown',
        message: this.#tab.error,
        harnessId: this.#tab.settings.harnessId ?? 'opencode',
        retryable: false
      }
    }
  }

  get activeTurnStartTime(): number | undefined {
    for (let i = this.#tab.messages.length - 1; i >= 0; i--) {
      const msg = this.#tab.messages[i]
      if (msg.role === 'user') return msg.createdAt
    }
    return undefined
  }

  get references(): PromptReference[] {
    if (!this.#tab.selectionAttached || this.#tab.selections.length === 0) return []
    return this.#tab.selections.map((selection, index) => ({
      id: `${this.#tab.temporaryChatId}:selection:${index}`,
      label: `Selection ${index + 1}`,
      text: selection
    }))
  }

  removeReference(id: string): void {
    const index = Number(id.split(':').pop())
    if (Number.isNaN(index)) return
    this.#tab.selections = this.#tab.selections.filter((_, i) => i !== index)
    if (this.#tab.selections.length === 0) this.#tab.selectionAttached = false
  }

  clearReferences(): void {
    this.#tab.selections = []
    this.#tab.selectionAttached = false
  }

  addSelection(text: string): void {
    if (!text.trim() || this.#tab.expired) return
    this.#tab.selections = [...this.#tab.selections, text]
    this.#tab.selectionAttached = true
    this.#touch()
  }

  mount(): void {
    if (this.#mounted) return
    this.#mounted = true

    this.#unsubscribeExpiry = subscribe('agent:temporaryChatExpired', (temporaryChatId) => {
      if (temporaryChatId === this.#tab.temporaryChatId) {
        this.#stopReconciling()
        contextSidebarState.expireTemporaryChat(this.#tab, false)
      }
    })

    this.#unsubscribeEvent = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event) this.#handleEvent(event)
    })

    // Capture before the auto-send below flips `sessionStarted`. The status and
    // mirror probes are remount hygiene: on the turn a mount itself starts, the
    // backend has not registered the temporary chat yet (`sendTemporaryPrompt`
    // only registers it after assembling the isolated harness session), so an
    // immediate probe reports `active: false` and would expire a healthy tab —
    // wiping the seeded selection message and blocking every follow-up.
    const alreadyStarted = this.#tab.sessionStarted

    // Explain tabs carry an auto-prompt that should be sent immediately so the
    // user gets an explanation without having to type anything first. Show a
    // short action label in the UI while still sending the full instruction to
    // the agent.
    if (this.#tab.autoPrompt && !this.#tab.autoPromptSent && !alreadyStarted) {
      const autoPrompt = this.#tab.autoPrompt
      this.#tab.autoPromptSent = true
      const displayText = this.#tab.mode === 'elaborate' ? this.#tab.title || 'Explain' : autoPrompt
      void this.send({
        text: displayText,
        attachments: [],
        promptReferences: [],
        transportText: autoPrompt
      })
    }

    if (alreadyStarted) {
      const temporaryChatId = this.#tab.temporaryChatId
      void invoke('agent:getTemporaryChatStatus', temporaryChatId)
        .then((status) => {
          if (!status) return
          if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
          // A busy tab has an in-flight `sendTemporaryPrompt` that may still be
          // registering the backend chat — only an idle tab with no backend
          // counterpart is genuinely dead.
          if (!status.active && !this.#tab.busy) {
            this.#stopReconciling()
            contextSidebarState.expireTemporaryChat(this.#tab, false)
            return
          }
          if (status.expiresAt) contextSidebarState.touchTemporaryChat(this.#tab, status.expiresAt)
        })
        .catch(() => {
          // Teardown races can reject this probe; the expiry watchdog covers it.
        })

      void invoke('agent:loadTemporaryChatMessages', temporaryChatId)
        .then((messages) => {
          if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
          this.#mergeLoaded(messages as AgentMessage[])
        })
        .catch(() => {
          // Live events and the in-flight send still reconcile the response.
        })
    }

    // While a turn is already in flight at mount time (remount mid-run), start
    // reconciling immediately so the trace rebuilds even without live events.
    this.#syncReconciling()
  }

  unmount(): void {
    this.#mounted = false
    this.#stopReconciling()
    this.#unsubscribeExpiry?.()
    this.#unsubscribeEvent?.()
    this.#unsubscribeExpiry = null
    this.#unsubscribeEvent = null
  }

  clearError(): void {
    this.#tab.error = ''
  }

  clearStatus(): void {
    this.#tab.status = null
    this.#tab.error = ''
  }

  async load(): Promise<void> {
    // Temporary chats load eagerly on mount and through live events.
  }

  async loadOlder(): Promise<void> {
    // Temporary chats have no older-history pagination.
  }

  async abort(): Promise<void> {
    if (!this.#tab.busy || this.#tab.expired) return
    try {
      await invoke(
        'agent:abortTemporaryChat',
        this.#tab.projectId,
        this.#tab.threadId,
        this.#tab.temporaryChatId
      )
    } catch (error) {
      this.#tab.error = error instanceof Error ? error.message : 'The request could not be stopped.'
    }
  }

  async send(payload: SendPayload): Promise<void> {
    const { text, attachments, transportText, promptReferences: _promptReferences } = payload
    const prompt = text.trim()
    const backendPrompt = (transportText ?? text).trim()
    if (!prompt || !backendPrompt || this.#tab.expired) return

    this.#touch()
    this.#recordModelUse()

    const temporaryChatId = this.#tab.temporaryChatId
    const attachedSelections = this.#tab.selectionAttached ? [...this.#tab.selections] : []
    // Explain tabs seed their user message at open time (the store commits it
    // the instant the tab opens) — reuse it instead of appending a duplicate.
    const seededMessageId = this.#tab.autoPromptMessageId
    this.#tab.autoPromptMessageId = null
    const seededMessage =
      seededMessageId !== null
        ? this.#tab.messages.find(
            (message) => message.id === seededMessageId && message.role === 'user'
          )
        : undefined
    const outgoing =
      seededMessage ??
      this.#createUserMessage(
        prompt,
        attachments,
        attachedSelections.map((selection, index) => ({
          id: `${temporaryChatId}:selection:${index}`,
          label: `Selection ${index + 1}`,
          text: selection
        }))
      )

    if (!seededMessage) this.#tab.messages = [...this.#tab.messages, outgoing]
    if (attachedSelections.length > 0) this.#tab.selectionMessageId = outgoing.id
    this.#tab.selections = []
    this.#tab.selectionAttached = false
    this.#tab.draft = ''
    const sendSequence = ++this.#sendSequence
    this.#tab.busy = true
    this.#tab.error = ''
    this.#tab.status = null
    this.#tab.sessionStarted = true
    this.#syncReconciling()

    try {
      const response = (await invoke(
        'agent:sendTemporaryPrompt',
        this.#tab.projectId,
        this.#tab.threadId,
        temporaryChatId,
        this.#tab.settings,
        backendPrompt,
        attachments,
        attachedSelections,
        this.#tab.messages.length === 1 ? this.#tab.initialContext : undefined
      )) as AgentMessage | undefined

      if (!response) return
      if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
      // Invalidate any in-flight reconciliation read before the authoritative
      // final response lands — a stale mirror must never overwrite it.
      this.#applyGeneration += 1
      const responseIndex = this.#tab.messages.findIndex((message) => message.id === response.id)
      this.#tab.messages =
        responseIndex < 0
          ? [...this.#tab.messages, response]
          : this.#tab.messages.map((message, index) =>
              index === responseIndex ? mergeAssistantMessage(message, response) : message
            )
      this.#touch()
    } catch (error) {
      if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
      if (
        error instanceof Error &&
        (error.name === 'TemporaryChatCancelledError' ||
          error.message === 'Temporary chat stopped by user' ||
          error.message === 'Temporary chat closed')
      ) {
        return
      }
      this.#tab.error =
        error instanceof Error ? error.message : 'The temporary chat could not respond.'
    } finally {
      // Only the newest submission may settle the flag — an older overlapping
      // turn resolving later must not kill the newer turn's working indicator.
      if (
        this.#tab.temporaryChatId === temporaryChatId &&
        !this.#tab.expired &&
        sendSequence === this.#sendSequence
      ) {
        this.#tab.busy = false
      }
      this.#syncReconciling()
    }
  }

  async steer(payload: SendPayload): Promise<void> {
    const { text, attachments, promptReferences: _promptReferences } = payload
    const prompt = text.trim()
    if (!this.#tab.busy || this.#tab.expired) return

    this.#touch()
    const temporaryChatId = this.#tab.temporaryChatId
    const outgoing = this.#createUserMessage(
      prompt,
      attachments,
      this.#tab.selectionAttached
        ? this.#tab.selections.map((selection, index) => ({
            id: `${temporaryChatId}:selection:${index}`,
            label: `Selection ${index + 1}`,
            text: selection
          }))
        : []
    )

    this.#tab.messages = [...this.#tab.messages, outgoing]
    if (this.#tab.selectionAttached && this.#tab.selections.length > 0) {
      this.#tab.selectionMessageId = outgoing.id
    }
    this.#tab.sessionStarted = true

    try {
      await invoke(
        'agent:steerTemporaryPrompt',
        this.#tab.projectId,
        this.#tab.threadId,
        temporaryChatId,
        this.#tab.settings,
        prompt,
        attachments,
        this.#tab.selectionAttached ? this.#tab.selections : []
      )
      if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
      this.#touch()
    } catch (error) {
      if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
      this.#tab.error =
        error instanceof Error ? error.message : 'The steer message could not be delivered.'
    }
  }

  #touch(): void {
    if (this.#tab.expired) return
    contextSidebarState.touchTemporaryChat(this.#tab)
    if (!this.#tab.sessionStarted) return
    const temporaryChatId = this.#tab.temporaryChatId
    void invoke('agent:touchTemporaryChat', temporaryChatId)
      .then((status) => {
        if (!status) return
        if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
        // Same registration race as mount: a busy turn may still be creating
        // the backend chat, so only expire when nothing is in flight.
        if (!status.active && !this.#tab.busy) {
          this.#stopReconciling()
          contextSidebarState.expireTemporaryChat(this.#tab, false)
          return
        }
        if (status.expiresAt) contextSidebarState.touchTemporaryChat(this.#tab, status.expiresAt)
      })
      .catch(() => {
        // Best-effort keep-alive; the expiry watchdog covers failures.
      })
  }

  /** Keep the reconciliation poll alive exactly while a turn is in flight. */
  #syncReconciling(): void {
    if (!this.#mounted || this.#tab.expired || !this.#tab.busy) {
      this.#stopReconciling()
      return
    }
    if (this.#reconcileTimer) return
    this.#reconcileTimer = setInterval(
      () => void this.#reconcile(),
      TemporaryChatController.RECONCILE_INTERVAL_MS
    )
    void this.#reconcile()
  }

  #stopReconciling(): void {
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer)
      this.#reconcileTimer = null
    }
  }

  /**
   * Merge the harness mirror into the tab while busy. This is the safety net
   * for missed live events: the trace (reasoning, tools, sub-agents) and the
   * streaming text rebuild from the mirror, and a completed final message
   * settles the turn even if `session.idle` never arrived.
   */
  async #reconcile(): Promise<void> {
    if (this.#reconcileInFlight || !this.#mounted || this.#tab.expired || !this.#tab.busy) {
      if (!this.#tab.busy) this.#stopReconciling()
      return
    }
    this.#reconcileInFlight = true
    const temporaryChatId = this.#tab.temporaryChatId
    const generation = this.#applyGeneration
    try {
      const messages = (await invoke(
        'agent:loadTemporaryChatMessages',
        temporaryChatId
      )) as AgentMessage[]
      if (
        this.#tab.temporaryChatId !== temporaryChatId ||
        this.#tab.expired ||
        !this.#mounted ||
        !this.#tab.busy
      ) {
        return
      }
      // A final response that landed while the mirror was being read wins.
      if (generation !== this.#applyGeneration) return
      this.#mergeLoaded(messages)
      const assistants = messages.filter((message) => message.role === 'assistant')
      const finalAssistant = assistants.at(-1)
      if (finalAssistant?.completedAt !== undefined) {
        // The run finished but the idle event was missed — settle the turn.
        this.#tab.busy = false
        this.#tab.status = null
        this.#stopReconciling()
      }
    } catch {
      // The next tick retries; the in-flight send still settles the turn.
    } finally {
      this.#reconcileInFlight = false
      if (!this.#tab.busy || this.#tab.expired || !this.#mounted) this.#stopReconciling()
    }
  }

  #recordModelUse(): void {
    if (
      !this.#tab.settings.harnessId ||
      !this.#tab.settings.providerId ||
      !this.#tab.settings.modelId
    )
      return
    // Model recording is handled by the parent via ChatComposer's onModelUsed callback.
  }

  #createUserMessage(
    text: string,
    attachments: PromptAttachment[] = [],
    references: PromptReference[] = []
  ): AgentMessage {
    const id = messageId()
    const now = Date.now()
    return {
      id,
      role: 'user',
      parts: [
        { type: 'text', id: `${id}:text`, messageID: id, text },
        ...attachments.map((attachment, index): AgentPart => ({
          type: 'file',
          id: `${id}:file-${index}`,
          messageID: id,
          mime: attachment.mime,
          url: attachment.url,
          filename: attachment.filename
        }))
      ],
      references: references.length > 0 ? references : undefined,
      createdAt: now,
      completedAt: now
    }
  }

  #setError(issue: AgentProviderIssue | null | undefined, fallback: string | null): void {
    this.#tab.error = issue?.message ?? fallback ?? ''
    this.#tab.status = issue ? { state: 'error', issue } : null
  }

  // eslint-disable-next-line no-unused-private-class-members
  #textFor(message: AgentMessage): string {
    return message.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  #upsertPart(part: AgentPart): void {
    const messageIndex = this.#tab.messages.findIndex((message) => message.id === part.messageID)
    if (messageIndex < 0) {
      this.#tab.messages = [
        ...this.#tab.messages,
        {
          id: part.messageID,
          role: 'assistant',
          parts: [part],
          createdAt: Date.now()
        }
      ]
      return
    }
    const message = this.#tab.messages[messageIndex]
    const partIndex = message.parts.findIndex((candidate) => candidate.id === part.id)
    const parts =
      partIndex < 0
        ? [...message.parts, part]
        : message.parts.map((candidate, index) => (index === partIndex ? part : candidate))
    this.#tab.messages = this.#tab.messages.map((candidate, index) =>
      index === messageIndex ? { ...message, parts } : candidate
    )
  }

  #applyDelta(messageId: string, partId: string, field: string, delta: string): void {
    if (field !== 'text') return
    this.#tab.messages = this.#tab.messages.map((message) => {
      if (message.id !== messageId) return message
      return {
        ...message,
        parts: message.parts.map((part) => {
          if (part.id !== partId) return part
          if (part.type === 'text' || part.type === 'reasoning') {
            return { ...part, text: part.text + delta }
          }
          return part
        })
      }
    })
  }

  #mergeLoaded(messages: AgentMessage[]): void {
    const assistants = messages.filter((message) => message.role === 'assistant')
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const incomingById = new Map(assistants.map((message) => [message.id, message]))
    this.#tab.messages = [
      ...this.#tab.messages.map((message) => {
        const incoming = incomingById.get(message.id)
        return incoming ? mergeAssistantMessage(message, incoming) : message
      }),
      ...assistants.filter((message) => !this.#tab.messages.some((m) => m.id === message.id))
    ].sort((left, right) => left.createdAt - right.createdAt)
  }

  #handleEvent(event: AgentEvent): void {
    if (!('sessionId' in event)) return
    // An expired tab no longer owns a conversation — the store wiped its
    // messages, so late events for a dying session must not ghost-repopulate it.
    if (this.#tab.expired) return
    if (event.type === 'temporary-chat.started') {
      this.#tab.sessionId = event.sessionId
      return
    }
    if (!this.#tab.sessionId || event.sessionId !== this.#tab.sessionId) return

    switch (event.type) {
      case 'message.part.updated':
        this.#upsertPart(event.part)
        break
      case 'message.part.delta':
        this.#applyDelta(event.messageId, event.partId, event.field, event.delta)
        break
      case 'message.completed': {
        const now = Date.now()
        this.#tab.messages = this.#tab.messages.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                completedAt: now,
                error: event.error,
                ...(event.tokens ? { tokens: event.tokens } : {}),
                ...(event.normalizedUsage ? { normalizedUsage: event.normalizedUsage } : {}),
                ...(event.contextWindow === undefined
                  ? {}
                  : { contextWindow: event.contextWindow }),
                ...(event.contextUsed === undefined ? {} : { contextUsed: event.contextUsed }),
                ...(event.contextEstimated === undefined
                  ? {}
                  : { contextEstimated: event.contextEstimated }),
                ...(event.rateLimits ? { rateLimits: event.rateLimits } : {}),
                ...(event.credits ? { credits: event.credits } : {})
              }
            : message
        )
        break
      }
      case 'usage.updated':
        this.#tab.messages = this.#tab.messages.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                ...(event.tokens ? { tokens: event.tokens } : {}),
                ...(event.normalizedUsage ? { normalizedUsage: event.normalizedUsage } : {}),
                ...(event.contextWindow === undefined
                  ? {}
                  : { contextWindow: event.contextWindow }),
                ...(event.contextUsed === undefined ? {} : { contextUsed: event.contextUsed }),
                ...(event.contextEstimated === undefined
                  ? {}
                  : { contextEstimated: event.contextEstimated }),
                ...(event.cost === undefined ? {} : { cost: event.cost }),
                ...(event.rateLimits ? { rateLimits: event.rateLimits } : {}),
                ...(event.credits ? { credits: event.credits } : {})
              }
            : message
        )
        break
      case 'session.error':
        this.#setError(event.issue, event.error ?? 'The temporary chat session failed.')
        this.#tab.busy = false
        this.#syncReconciling()
        break
      case 'session.status':
        if (event.status.state === 'error') {
          this.#setError(event.status.issue, null)
          this.#tab.busy = false
          this.#syncReconciling()
        } else if (event.status.state === 'waiting') {
          this.#tab.status = event.status
        } else {
          this.#tab.status = null
        }
        break
      case 'session.idle':
        this.#tab.busy = false
        this.#tab.status = null
        this.#syncReconciling()
        break
    }
  }
}
