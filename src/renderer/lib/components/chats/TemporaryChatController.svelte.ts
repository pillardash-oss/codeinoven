import { invoke, subscribe } from '$lib/ipc.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import {
  contextSidebarState,
  type TemporaryChatContextTab
} from '$lib/stores/context-sidebar.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import type {
  AgentEvent,
  AgentMessage,
  AgentProviderIssue,
  AgentSessionStatus,
  PromptReference,
  ThreadSettings
} from '$shared/types'
import type { ConversationController, SendPayload } from '../threads/ConversationController.svelte'

/**
 * Conversation adapter for temporary side chats.
 *
 * This is deliberately thin: the conversation itself (messages, streaming
 * parts, busy state, working trace, error/run state) lives in the same
 * `threadMessages` / `agentRuns` pipeline that drives regular threads, keyed
 * by `projectId:temporaryChatId`. The controller only supplies what is
 * peculiar to a side chat:
 *
 * - the read-only temporary-chat backend transports,
 * - the seeded explain prompt (committed as a sent user message at open time),
 * - the session binding when the isolated harness session comes up,
 * - the inactivity-expiry lifecycle and selection reference management.
 */
export class TemporaryChatController implements ConversationController {
  readonly kind = 'temporary-chat' as const
  readonly projectId: string
  readonly conversationId: string

  #tab: TemporaryChatContextTab
  #unsubscribeEvent: (() => void) | null = null
  #unsubscribeExpiry: (() => void) | null = null
  #mounted = false

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
    return threadMessages.messages(this.projectId, this.conversationId)
  }

  get loaded(): boolean {
    return threadMessages.loaded(this.projectId, this.conversationId)
  }

  get loading(): boolean {
    return threadMessages.loading(this.projectId, this.conversationId)
  }

  get hasOlder(): boolean {
    return false
  }

  get busy(): boolean {
    return agentRuns.isBusy(this.projectId, this.conversationId)
  }

  get error(): string {
    return threadMessages.error(this.projectId, this.conversationId)
  }

  get runIssue(): AgentProviderIssue | null {
    return threadMessages.runIssue(this.projectId, this.conversationId)
  }

  get status(): AgentSessionStatus | null {
    const issue = this.runIssue
    if (!issue) return null
    return { state: 'error', issue }
  }

  get activeTurnStartTime(): number | undefined {
    return agentRuns.busySince(this.projectId, this.conversationId)
  }

  get references(): PromptReference[] {
    if (!this.#tab.selectionAttached || this.#tab.selections.length === 0) return []
    return this.#tab.selections.map((selection, index) => ({
      id: `${this.#tab.temporaryChatId}.selection.${index}`,
      label: `Selection ${index + 1}`,
      text: selection
    }))
  }

  removeReference(id: string): void {
    const index = Number(id.split('.').pop())
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
        contextSidebarState.expireTemporaryChat(this.#tab, false)
      }
    })

    // The shared event pipeline ignores events until a session is bound, so the
    // only event the controller listens for is the one that carries the binding.
    this.#unsubscribeEvent = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (!event || event.type !== 'temporary-chat.started') return
      if (event.temporaryChatId !== this.#tab.temporaryChatId) return
      this.#tab.sessionId = event.sessionId
      threadMessages.setSessionId(this.projectId, this.conversationId, event.sessionId)
    })

    // Remount into an already-started conversation: the store's session map
    // survives across mounts, but rebinding is idempotent and covers a store
    // entry that was cleared in between.
    if (this.#tab.sessionId) {
      threadMessages.setSessionId(this.projectId, this.conversationId, this.#tab.sessionId)
    }

    // Explain tabs carry an auto-prompt that should be sent immediately so the
    // user gets an explanation without having to type anything first. Show a
    // short action label in the UI while still sending the full instruction to
    // the agent.
    const alreadyStarted = this.#tab.sessionStarted
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
      // Remount hygiene: expire a side chat whose backend counterpart is gone —
      // but never while a turn is in flight, since `sendTemporaryPrompt` only
      // registers the backend chat after assembling the isolated session.
      const temporaryChatId = this.#tab.temporaryChatId
      void invoke('agent:getTemporaryChatStatus', temporaryChatId)
        .then((status) => {
          if (!status) return
          if (this.#tab.temporaryChatId !== temporaryChatId || this.#tab.expired) return
          if (!status.active && !agentRuns.isBusy(this.projectId, this.conversationId)) {
            contextSidebarState.expireTemporaryChat(this.#tab, false)
            return
          }
          if (status.expiresAt) contextSidebarState.touchTemporaryChat(this.#tab, status.expiresAt)
        })
        .catch(() => {
          // Teardown races can reject this probe; the expiry watchdog covers it.
        })
    }
  }

  unmount(): void {
    this.#mounted = false
    this.#unsubscribeExpiry?.()
    this.#unsubscribeEvent?.()
    this.#unsubscribeExpiry = null
    this.#unsubscribeEvent = null
  }

  clearError(): void {
    threadMessages.clearLoadError(this.projectId, this.conversationId)
  }

  clearStatus(): void {
    threadMessages.setRunIssue(this.projectId, this.conversationId, null)
    threadMessages.clearLoadError(this.projectId, this.conversationId)
  }

  async load(): Promise<void> {
    await threadMessages.loadTemporary(this.projectId, this.conversationId)
  }

  async loadOlder(): Promise<void> {
    // Temporary chats have no older-history pagination.
  }

  async abort(): Promise<void> {
    if (!agentRuns.isBusy(this.projectId, this.conversationId) || this.#tab.expired) return
    try {
      await invoke(
        'agent:abortTemporaryChat',
        this.#tab.projectId,
        this.#tab.threadId,
        this.#tab.temporaryChatId
      )
    } catch (error) {
      threadMessages.setRunIssue(this.projectId, this.conversationId, {
        kind: 'unknown',
        message: error instanceof Error ? error.message : 'The request could not be stopped.',
        harnessId: this.#tab.settings.harnessId ?? 'opencode',
        retryable: false
      })
    }
  }

  async send(payload: SendPayload): Promise<void> {
    const { text, attachments, transportText, promptReferences: _promptReferences } = payload
    const prompt = text.trim()
    const backendPrompt = (transportText ?? text).trim()
    if (!prompt || !backendPrompt || this.#tab.expired) return

    this.#touch()

    const references = this.#selectionReferences()
    const userMessageId = this.#tab.autoPromptMessageId ?? undefined
    this.#tab.autoPromptMessageId = null
    // The parent-conversation recap rides only the very first turn.
    const initialContext =
      threadMessages.messages(this.projectId, this.conversationId).length <= 1
        ? this.#tab.initialContext
        : undefined

    this.#tab.selections = []
    this.#tab.selectionAttached = false
    this.#tab.sessionStarted = true

    try {
      await threadMessages.sendTemporary(
        this.#tab.projectId,
        this.#tab.threadId,
        this.#tab.temporaryChatId,
        this.#tab.settings,
        {
          text: prompt,
          transportText: backendPrompt,
          attachments,
          references,
          initialContext,
          userMessageId
        }
      )
      this.#touch()
    } catch (error) {
      if (this.#tab.expired) return
      if (
        error instanceof Error &&
        (error.name === 'TemporaryChatCancelledError' ||
          error.message.includes('Temporary chat stopped by user') ||
          error.message.includes('Temporary chat closed'))
      ) {
        // Expected teardown while the turn was in flight — settle quietly.
        this.clearError()
        return
      }
    } finally {
      this.#syncTemporaryLifecycle()
    }
  }

  async steer(payload: SendPayload): Promise<void> {
    const { text, attachments, promptReferences: _promptReferences } = payload
    const prompt = text.trim()
    if (!agentRuns.isBusy(this.projectId, this.conversationId) || this.#tab.expired) return

    this.#touch()
    const references = this.#selectionReferences()
    this.#tab.sessionStarted = true

    try {
      await threadMessages.steerTemporary(
        this.#tab.projectId,
        this.#tab.threadId,
        this.#tab.temporaryChatId,
        this.#tab.settings,
        prompt,
        attachments,
        references
      )
      this.#touch()
    } catch (error) {
      if (this.#tab.expired) return
      if (error instanceof Error && error.message.includes('no longer active')) {
        this.clearError()
        return
      }
    } finally {
      this.#syncTemporaryLifecycle()
    }
  }

  #selectionReferences(): PromptReference[] {
    if (!this.#tab.selectionAttached) return []
    const references = this.references
    this.#tab.selections = []
    this.#tab.selectionAttached = false
    return references
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
        if (!status.active && !agentRuns.isBusy(this.projectId, this.conversationId)) {
          contextSidebarState.expireTemporaryChat(this.#tab, false)
          return
        }
        if (status.expiresAt) contextSidebarState.touchTemporaryChat(this.#tab, status.expiresAt)
      })
      .catch(() => {
        // Best-effort keep-alive; the expiry watchdog covers failures.
      })
  }

  /** Keep the tab's inactivity window fresh after turn activity. */
  #syncTemporaryLifecycle(): void {
    if (this.#tab.temporaryChatId && !this.#tab.expired) {
      contextSidebarState.touchTemporaryChat(this.#tab)
    }
  }
}
