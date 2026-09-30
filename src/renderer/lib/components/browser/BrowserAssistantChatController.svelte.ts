import { invoke } from '$lib/ipc.svelte'
import { messageId } from '$shared/id'
import { classifyProviderIssue } from '$shared/provider-issue'
import type {
  AgentMessage,
  AgentProviderIssue,
  AgentSessionStatus,
  Thread,
  ThreadSettings
} from '$shared/types'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { browserAssistant } from '$lib/stores/browser-assistant.svelte'
import { browserAgentPageContext, globalBrowser } from '$lib/stores/global-browser.svelte'
import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
import { THREAD_MESSAGE_PRELOAD_WINDOW, threadMessages } from '$lib/stores/thread-messages.svelte'
import type { ConversationController, SendPayload } from '../threads/ConversationController.svelte'

/**
 * Conversation adapter for a browser tab's assistant chat.
 *
 * The conversation is a real thread of the reserved hidden browser project, so it
 * needs no conversation backend of its own: the transcript, the session binding,
 * the busy state and the streamed parts all live in the same
 * `threadMessages` / `agentRuns` pipeline every thread uses, keyed by
 * `projectId:threadId`. What this adapter supplies is the little that separates a
 * panel from the primary conversation surface:
 *
 * - the app's own page context, restated on every turn, so a question about
 *   "this page" is about the page the user is looking at right now;
 * - the settings of the thread row, written back to the row as the composer
 *   changes them;
 * - the failure of a send that never started, settled on this conversation's own
 *   run issue so the provider card appears in the panel.
 *
 * `kind` is `'thread'` on purpose: this is not a synthetic side chat, and the
 * view has to treat it as the durable thread it is (the "continue in a project"
 * promotion is a side chat's affair and is not offered here).
 */
export class BrowserAssistantChatController implements ConversationController {
  readonly kind = 'thread' as const
  readonly projectId: string
  readonly conversationId: string
  readonly #browserTabId: string
  /** The settings the composer last wrote. Held until the row's own refresh
   *  lands, so a model switch does not flicker back to the previous one. */
  #chosen = $state<ThreadSettings | null>(null)
  #hasOlder = $state<boolean | null>(null)

  constructor(chat: { threadId: string; browserTabId: string; thread: Thread }) {
    this.projectId = chat.thread.projectId
    this.conversationId = chat.threadId
    this.#browserTabId = chat.browserTabId
  }

  get settings(): ThreadSettings {
    if (this.#chosen) return this.#chosen
    return this.#threadRow()?.settings ?? DEFAULT_SETTINGS
  }

  updateSettings(updated: ThreadSettings): void {
    this.#chosen = updated
    // The choice has to outlive the panel: a thread persists its own settings, so
    // closing the rail and reopening it keeps the model that was picked.
    void invoke('thread:updateSettings', this.projectId, this.conversationId, updated).catch(
      () => {}
    )
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
    return this.#hasOlder ?? threadMessages.hasOlder(this.projectId, this.conversationId)
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

  mount(): void {
    // Bind the stored session before the first stream arrives, so a panel opened
    // onto a turn that is already running routes its events to this conversation
    // instead of dropping them.
    const sessionId = this.#threadRow()?.sessionId
    if (sessionId) threadMessages.setSessionId(this.projectId, this.conversationId, sessionId)
  }

  unmount(): void {
    // Nothing to release: the conversation outlives the panel, and its session
    // mapping is exactly what keeps a remount (another browser tab, another
    // window) attached to the same stream.
  }

  async load(): Promise<void> {
    await threadMessages.load(this.projectId, this.conversationId, THREAD_MESSAGE_PRELOAD_WINDOW)
  }

  /** One page of older history per request. The thread view's own paging aligns to
   *  turn boundaries; a rail panel only has to keep reading backward. */
  async loadOlder(): Promise<void> {
    const oldest = this.messages[0]
    if (!oldest || !this.hasOlder) return
    const page = await invoke('thread:loadMessages', this.projectId, this.conversationId, {
      createdAt: oldest.createdAt,
      id: oldest.id
    })
    this.#hasOlder = page.hasOlder
    if (page.messages.length > 0) {
      threadMessages.mergePage(this.projectId, this.conversationId, page.messages)
    }
  }

  async abort(): Promise<void> {
    if (!this.busy) return
    await invoke('agent:abort', this.projectId, this.conversationId)
  }

  async send(payload: SendPayload): Promise<void> {
    const text = payload.text.trim()
    if (!text) return
    const userMessageId = messageId()
    agentRuns.setBusy(this.projectId, this.conversationId, true, userMessageId)
    try {
      await threadMessages.send(
        this.projectId,
        this.conversationId,
        this.settings,
        text,
        payload.attachments,
        payload.specAction,
        userMessageId,
        undefined,
        this.#turnContext(payload.promptContext),
        payload.promptReferences,
        payload.projectReferences,
        payload.presentation,
        payload.taskReferences
      )
    } catch (error) {
      this.#settleFailedSend(error)
    }
  }

  async steer(payload: SendPayload): Promise<void> {
    const text = payload.text.trim()
    if (!text || !this.busy) return
    try {
      await threadMessages.steer(
        this.projectId,
        this.conversationId,
        text,
        payload.attachments,
        messageId(),
        this.#turnContext(payload.promptContext),
        payload.promptReferences,
        payload.projectReferences,
        payload.presentation,
        payload.taskReferences
      )
    } catch (error) {
      this.#settleFailedSend(error)
    }
  }

  clearError(): void {
    threadMessages.clearLoadError(this.projectId, this.conversationId)
  }

  clearStatus(): void {
    threadMessages.setRunIssue(this.projectId, this.conversationId, null)
    threadMessages.clearLoadError(this.projectId, this.conversationId)
  }

  /** Which page the question is about, restated every turn: the conversation
   *  lasts as long as its tab, and the tab may have navigated many times since. */
  #turnContext(promptContext?: string): string | undefined {
    const tab = globalBrowser.tabById(this.#browserTabId)
    const page = tab ? browserAgentPageContext(tab) : ''
    const extra = promptContext?.trim() ?? ''
    const combined = [page, extra].filter((part) => part !== '').join('\n\n')
    return combined === '' ? undefined : combined
  }

  #threadRow(): Thread | null {
    return browserAssistant.chatForThread(this.conversationId)?.thread ?? null
  }

  /** A send that never started: the turn reports through this conversation's own
   *  run issue, which is what the panel draws as its provider card. */
  #settleFailedSend(error: unknown): void {
    const message = error instanceof Error ? error.message : 'The message could not be sent.'
    threadMessages.setRunIssue(this.projectId, this.conversationId, {
      kind: classifyProviderIssue(message),
      message,
      rawError: message,
      harnessId: this.settings.harnessId ?? 'unknown',
      retryable: true
    })
    agentRuns.setIdle(this.projectId, this.conversationId)
  }
}
