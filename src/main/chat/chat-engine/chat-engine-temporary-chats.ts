import { BrowserWindow } from 'electron'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { remapCopiedMessages } from '../../../lib/engines/thread-manager'
import type { IsolatedSessionHandle } from '../../drivers/isolated-session'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { notifyTemporaryChat } from '../thread-events'
import {
  currentHarnessVersion,
  episodeFromPieces,
  tokenUsageAttribution
} from '../token-usage-attribution'
import { leanAgentNameForMode } from '../../opencode/opencode-agent-definitions'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions, SteerPromptOptions } from '../../drivers/driver.interface'
import { isContinuationRelayPrompt } from '../../../lib/pending-request'
import { legacyHarnessAccountId } from '../../providers/harness-account-registry'
import type {
  AgentMessage,
  AgentPart,
  PromptAttachment,
  PromptReference,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { ASSISTANT_SPACE_ID, MAX_PROMPT_ATTACHMENTS } from '../../../lib/types'
import { modelKey } from '../../../lib/model-keys'
import { deriveTitleFromText } from '../title-generator'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import { messageId as createMessageId } from '../../../lib/id'
import type { TemporaryChatSession } from './chat-engine-types'
import { TemporaryChatCancelledError, rawErrorDetail } from './chat-engine-errors'
import { presentableMessages, stampHarnessId } from './chat-engine-message-merge'
import {
  formatHistoryRecap,
  formatTemporaryReferenceContext,
  textForMessage
} from './chat-engine-message-text'
import { assertHarnessRequestCapabilities, traceLeanAgent } from './chat-engine-constants'
import { TEMPORARY_CHAT_ALLOWED_TOOLS } from './chat-engine-prompts'
import { validatePromptReferences } from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine temporary-chats: one concern, moved verbatim from the composition root. */
export class ChatEngineTemporaryChats {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Delete history around a message inside a temporary side chat. The isolated
   * harness session still holds the removed span in its native transcript, so
   * it is destroyed and a replacement session is created lazily by the next
   * send   which replays the kept conversation as its hidden context. The kept
   * messages are promoted into the display overlay so a reload can never
   * resurrect the deleted span.
   */
  async deleteTemporaryMessages(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    messageId: string,
    mode: 'down' | 'single' | 'up'
  ): Promise<AgentMessage[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    messageId = validateEntityId(messageId, 'Message ID', 256)
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) throw new Error(`Temporary chat not found: ${temporaryChatId}`)
    if (temporary.projectId !== projectId || temporary.threadId !== threadId) {
      throw new Error('Temporary chat does not belong to this thread')
    }
    if (this.host.state.completionWaiters.has(temporary.sessionId)) {
      throw new Error('The agent is still working   wait for the turn to finish before editing.')
    }
    const conversation = await this.host.loadTemporaryConversation(temporaryChatId)
    const cutoff = conversation.findIndex((m) => m.id === messageId)
    // An id missing from the conversation was never mirrored (optimistic local
    // message)   nothing after it exists, so the conversation is kept whole.
    let kept: AgentMessage[]
    if (cutoff === -1) {
      kept = conversation
    } else if (mode === 'down') {
      kept = conversation.slice(0, cutoff)
    } else {
      // Same turn semantics as the thread mirror: a turn spans from its user
      // message to just before the next user message.
      let turnEnd = cutoff + 1
      while (turnEnd < conversation.length && conversation[turnEnd].role !== 'user') turnEnd++
      kept =
        mode === 'single'
          ? [...conversation.slice(0, cutoff), ...conversation.slice(turnEnd)]
          : conversation.slice(turnEnd)
    }
    // Working traces belong to the turn they were produced under   drop any
    // orphaned trace that would outlive its prompt.
    const removedSpanStart =
      cutoff !== -1 ? conversation[cutoff].createdAt : Number.POSITIVE_INFINITY
    kept = kept.filter(
      (message) =>
        !(message.visibility === 'working_trace' && message.createdAt >= removedSpanStart)
    )
    const pendingContext = kept.length > 0 ? formatHistoryRecap(kept) : ''
    await this.destroyTemporaryChat(temporaryChatId)
    // destroyTemporaryChat wiped the display history   rebuild it from the
    // kept conversation so the deleted span can never reappear on reload.
    this.host.state.temporaryChatDisplayMessages.set(temporaryChatId, {
      records: kept.map((message) => ({
        message,
        references: message.references ?? []
      })),
      ...(pendingContext ? { pendingContext } : {})
    })
    return presentableMessages(kept)
  }

  async sendTemporaryPrompt(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    references?: PromptReference[],
    initialContext?: string,
    userMessageId?: string,
    displayText?: string
  ): Promise<AgentMessage | undefined> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    settings = validateThreadSettings(settings)
    text = validateBoundedString(text, 'Prompt', 0, 200_000)
    const validatedReferences = validatePromptReferences(references)
    const safeDisplayText = displayText
      ? validateBoundedString(displayText, 'Display text', 1, 200_000)
      : text
    // The renderer optimistically commits the user message under this ID; using
    // it keeps the mirror reconcile 1:1 with the optimistic message instead of
    // duplicating it.
    const outboundUserMessageId = userMessageId
      ? validateBoundedString(userMessageId, 'User message ID', 1, 128)
      : createMessageId()
    this.host.units['turns'].markProjectActive(projectId)
    // A global-browser tab has no project folder; make sure its reserved scope
    // exists before the ownership and working-directory lookups below need it.
    await this.host.units['misc'].ensureGlobalBrowserScope(projectId)
    if (!Array.isArray(attachments)) {
      throw new TypeError('Temporary chat attachments must be an array')
    }
    if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
      throw new TypeError(`Attach at most ${MAX_PROMPT_ATTACHMENTS} files per message`)
    }
    let validatedAttachments = attachments.map((attachment) => {
      const url = validateBoundedString(attachment.url, 'Attachment URL', 1, 20_000)
      const mime = validateBoundedString(attachment.mime, 'Attachment MIME', 1, 512)
      return {
        mime,
        url,
        ...(attachment.filename
          ? { filename: validateBoundedString(attachment.filename, 'Attachment filename', 1, 1024) }
          : {})
      }
    })
    // A retried temporary-chat turn re-sends the request's files, and they can
    // be gone from disk by then; the relay drops what it cannot materialize.
    if (isContinuationRelayPrompt(text)) {
      validatedAttachments = await this.host.units['runtime-workflows'].relayAttachments(
        projectId,
        threadId,
        validatedAttachments
      )
    }
    const referenceBlock = formatTemporaryReferenceContext(validatedReferences)
    // The message may be nothing but its payload (a commented passage, a file),
    // exactly as a thread allows, but it can never be nothing at all.
    if (!text && !referenceBlock && validatedAttachments.length === 0) {
      throw new TypeError('A temporary chat message needs text, an attachment, or a comment')
    }
    let context = initialContext
      ? validateBoundedString(initialContext, 'Temporary chat context', 1, 100_000)
      : ''

    let temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) throw new Error(`Thread not found: ${threadId}`)
      if (!context) {
        // A history deletion destroyed the previous session   its kept
        // conversation is the context for the replacement session, not the
        // parent thread's mirror. Consumed once, then back to the default.
        const pendingRecap =
          this.host.state.temporaryChatDisplayMessages.get(temporaryChatId)?.pendingContext
        if (pendingRecap) {
          context = pendingRecap
          const history = this.host.state.temporaryChatDisplayMessages.get(temporaryChatId)
          this.host.state.temporaryChatDisplayMessages.set(temporaryChatId, {
            records: history?.records ?? []
          })
        } else {
          context = formatHistoryRecap(await this.host.loadMessages(projectId, threadId))
        }
      }
      const driverId = settings.harnessId || DEFAULT_HARNESS
      const accountId = (
        await this.host.state.accountRegistry.resolveForProvider(
          driverId,
          settings.providerId,
          settings.accountId
        )
      ).id
      const { driver, projectPath } = await this.host.resolve(
        projectId,
        driverId,
        threadId,
        accountId
      )
      const isolated = supportsIsolatedSessions(driver)
        ? await driver.createIsolatedSession(projectPath, 'Temporary read-only chat')
        : undefined
      const sessionId =
        isolated?.sessionId ?? (await driver.createSession(projectPath, 'Temporary read-only chat'))
      const expiresAt = Date.now() + ChatEngine.TEMPORARY_CHAT_INACTIVITY_MS
      temporary = {
        id: temporaryChatId,
        kind: 'chat',
        projectId,
        threadId,
        projectPath,
        driverId,
        accountId,
        providerId: settings.providerId,
        sessionId,
        isolated,
        contextApplied: false,
        inactivityMs: ChatEngine.TEMPORARY_CHAT_INACTIVITY_MS,
        expiresAt,
        expiryTimer: setTimeout(
          () => void this.expireTemporaryChat(temporaryChatId),
          ChatEngine.TEMPORARY_CHAT_INACTIVITY_MS
        )
      }
      this.host.state.temporaryChats.set(temporaryChatId, temporary)
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        projectPath,
        'auto_review',
        driverId,
        undefined,
        true
      )
      const registered = this.host.sessionRegistry.get(sessionId)
      if (registered) registered.accountId = accountId
    }
    if (temporary.projectId !== projectId || temporary.threadId !== threadId) {
      throw new Error('Temporary chat does not belong to this thread')
    }
    if (
      temporary.driverId !== settings.harnessId ||
      temporary.accountId !==
        (settings.accountId ?? legacyHarnessAccountId(settings.harnessId || DEFAULT_HARNESS))
    ) {
      throw new Error('The temporary chat harness or account cannot change after its first message')
    }
    this.refreshTemporaryChatExpiry(temporary)
    this.host.broadcast({
      type: 'temporary-chat.started',
      sessionId: temporary.sessionId,
      temporaryChatId: temporary.id,
      projectId: temporary.projectId
    })

    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      temporary.driverId,
      temporary.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${temporary.driverId}`)
    assertHarnessRequestCapabilities(driver, validatedAttachments, 'auto_review')
    const promptText = referenceBlock
      ? text
        ? `${referenceBlock}\n\nUser request:\n${text}`
        : referenceBlock
      : text
    const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
      temporary.sessionId,
      null,
      'Temporary chat'
    )
    try {
      const memoryPrompt = await this.host.state.memoryService.formatCurrent(
        projectId,
        threadId,
        modelKey(settings.harnessId, settings.providerId, settings.modelId)
      )
      const systemPrompt = [
        await this.host.units['turns-dispatch'].cioPrompt('temporary-chat'),
        memoryPrompt,
        temporary.contextApplied && context
          ? ''
          : context
            ? `Parent conversation context (hidden from the temporary chat UI):\n${context}`
            : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      const userMessageId = outboundUserMessageId
      // Presentation-safe record BEFORE the prompt leaves the process   the
      // same ordering guarantee `persistOutboundMessage` gives threads, so the
      // harness echo can never be the display source of truth.
      this.recordTemporaryDisplayMessage(
        temporary.id,
        temporary.sessionId,
        userMessageId,
        safeDisplayText,
        validatedAttachments,
        validatedReferences
      )
      const request: SendPromptOptions = {
        sessionId: temporary.sessionId,
        settings: {
          ...settings,
          permissionLevel: 'auto_review'
        },
        text: promptText,
        attachments: validatedAttachments,
        systemPrompt,
        allowedTools: TEMPORARY_CHAT_ALLOWED_TOOLS,
        readOnly: true,
        agent: leanAgentNameForMode('ephemeral'),
        userMessageId
      }
      traceLeanAgent('ephemeral', temporary.sessionId, temporary.driverId)
      const outboundIds =
        this.host.state.outboundMessageIdsBySession.get(temporary.sessionId) ?? new Set<string>()
      outboundIds.add(userMessageId)
      this.host.state.outboundMessageIdsBySession.set(temporary.sessionId, outboundIds)
      tokenUsageAttribution.recordPromptAttribution(
        episodeFromPieces({
          key: `eph:${temporary.sessionId}`,
          mode: 'ephemeral',
          driverId: temporary.driverId,
          pieces: [
            { title: 'System prompt', content: systemPrompt },
            { title: 'User text', content: promptText }
          ]
        })
      )
      if (temporary.isolated && supportsIsolatedSessions(driver)) {
        await driver.sendPrompt(temporary.projectPath, request, temporary.isolated)
      } else {
        await driver.sendPrompt(temporary.projectPath, request)
      }
      // Snapshot the selection this turn was dispatched with. Temporary
      // sessions are reused across turns, so this must happen on every send
      // completion-time attribution then reads what the turn ran with, never
      // the composer's mid-turn changes.
      this.host.state.sessionModelIds.set(temporary.sessionId, {
        providerId: settings.providerId,
        modelId: settings.modelId,
        thinkingLevel: settings.thinkingLevel ?? undefined
      })
      temporary.contextApplied = true
      await completion
      const messages =
        temporary.isolated && supportsIsolatedSessions(driver)
          ? await driver.loadMessages(
              temporary.projectPath,
              temporary.sessionId,
              temporary.isolated
            )
          : await driver.loadMessages(temporary.projectPath, temporary.sessionId)
      const response = [...messages].reverse().find((message) => message.role === 'assistant')
      if (!response) throw new Error('The temporary chat returned no response')
      if (response.error) throw new Error(response.error)
      tokenUsageAttribution.recordTurnTotals({
        key: `eph:${temporary.sessionId}`,
        agent: leanAgentNameForMode('ephemeral'),
        driverId: temporary.driverId,
        harnessVersion: currentHarnessVersion(),
        providerId: response.providerId ?? settings.providerId ?? null,
        modelId: response.modelId ?? settings.modelId ?? null,
        reportedInputTokens: response.normalizedUsage?.uncachedInput ?? null,
        reportedTotalTokens: response.normalizedUsage?.rawTotal ?? null
      })
      // A temporary chat is disposable, so its turn never reaches the durable
      // ledger through the normal finalization path. Record it here.
      this.host.units['messages-write'].recordEphemeralTurnUsage({
        projectId,
        threadId,
        sessionId: temporary.sessionId,
        callId: response.id,
        message: response
      })
      this.refreshTemporaryChatExpiry(temporary)
      await this.notifyTemporaryChatCompletion(projectId, threadId, temporary.id, 'completed')
      return response
    } catch (error) {
      this.host.units['runtime-connectivity'].clearCompletionWaiter(temporary.sessionId)
      if (
        error instanceof TemporaryChatCancelledError ||
        !this.host.state.temporaryChats.has(temporary.id)
      ) {
        // Expected teardown while the turn was in flight   settle quietly so
        // the renderer and the IPC layer never see an exception.
        Logger.dev('Temporary chat turn cancelled before completion:', error)
        return undefined
      }
      await this.notifyTemporaryChatCompletion(
        projectId,
        threadId,
        temporary.id,
        'error',
        rawErrorDetail(error)
      )
      throw error
    }
  }

  /**
   * Deliver a queued message into the live temporary chat session as an
   * intervention, without starting a new turn   the counterpart of the main
   * thread's `steerPrompt` for quick chats. The session must still be running
   * (`working`); otherwise the message is rejected so the renderer restores it
   * to its queue. Mirrors `sendTemporaryPrompt` for validation, selection
   * formatting, and read-only session semantics.
   */
  async steerTemporaryPrompt(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    references?: PromptReference[],
    userMessageId?: string,
    displayText?: string
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    settings = validateThreadSettings(settings)
    text = validateBoundedString(text, 'Prompt', 0, 200_000)
    const validatedReferences = validatePromptReferences(references)
    const safeDisplayText = displayText
      ? validateBoundedString(displayText, 'Display text', 1, 200_000)
      : text
    if (!Array.isArray(attachments)) {
      throw new TypeError('Temporary chat attachments must be an array')
    }
    if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
      throw new TypeError(`Attach at most ${MAX_PROMPT_ATTACHMENTS} files per message`)
    }
    const validatedAttachments = attachments.map((attachment) => {
      const url = validateBoundedString(attachment.url, 'Attachment URL', 1, 20_000)
      const mime = validateBoundedString(attachment.mime, 'Attachment MIME', 1, 512)
      return {
        mime,
        url,
        ...(attachment.filename
          ? { filename: validateBoundedString(attachment.filename, 'Attachment filename', 1, 1024) }
          : {})
      }
    })

    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary || temporary.kind !== 'chat') {
      throw new Error('The temporary chat session is no longer active')
    }
    if (temporary.projectId !== projectId || temporary.threadId !== threadId) {
      throw new Error('Temporary chat does not belong to this thread')
    }
    if (
      temporary.driverId !== settings.harnessId ||
      temporary.accountId !==
        (settings.accountId ?? legacyHarnessAccountId(settings.harnessId || DEFAULT_HARNESS))
    ) {
      throw new Error('The temporary chat harness or account cannot change after its first message')
    }
    if (this.host.sessionStatuses.get(temporary.sessionId)?.state !== 'working') {
      throw new Error('The quick chat turn finished before the steer message could be delivered')
    }
    this.refreshTemporaryChatExpiry(temporary)

    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      temporary.driverId,
      temporary.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${temporary.driverId}`)
    if (driver.capabilities?.steering !== true || !driver.steerPrompt) {
      throw new Error(`${driver.name} does not expose native active-turn steering`)
    }
    assertHarnessRequestCapabilities(driver, validatedAttachments, 'auto_review')
    const referenceBlock = formatTemporaryReferenceContext(validatedReferences)
    // Same rule as a fresh turn: a commented passage or a file is a steer even
    // with no text typed, but nothing at all is not.
    if (!text && !referenceBlock && validatedAttachments.length === 0) {
      throw new TypeError('A temporary chat message needs text, an attachment, or a comment')
    }
    const promptText = referenceBlock
      ? text
        ? `${referenceBlock}\n\nUser request:\n${text}`
        : referenceBlock
      : text
    const steerUserMessageId = userMessageId
      ? validateBoundedString(userMessageId, 'User message ID', 1, 128)
      : createMessageId()
    // Threads register steered outbound IDs so the live `message.part.updated`
    // echo never overwrites the display record; temporary steers skipped this.host,
    // letting the full transport prompt ghost into the conversation.
    const outboundIds =
      this.host.state.outboundMessageIdsBySession.get(temporary.sessionId) ?? new Set<string>()
    outboundIds.add(steerUserMessageId)
    this.host.state.outboundMessageIdsBySession.set(temporary.sessionId, outboundIds)
    this.recordTemporaryDisplayMessage(
      temporary.id,
      temporary.sessionId,
      steerUserMessageId,
      safeDisplayText,
      validatedAttachments,
      validatedReferences
    )
    const steerOptions = {
      sessionId: temporary.sessionId,
      text: promptText,
      attachments: validatedAttachments,
      userMessageId: steerUserMessageId
    }
    const steerTemporary = driver.steerPrompt.bind(driver) as (
      projectPath: string,
      opts: SteerPromptOptions,
      isolated?: IsolatedSessionHandle
    ) => Promise<void>
    const deliverTemporarySteer = async (): Promise<void> => {
      if (temporary.isolated && supportsIsolatedSessions(driver)) {
        await steerTemporary(temporary.projectPath, steerOptions, temporary.isolated)
      } else {
        await steerTemporary(temporary.projectPath, steerOptions)
      }
    }
    // Same undo window as thread steers: hold while a tool call is in flight.
    if (this.host.units['utilities-tools'].hasInFlightTool(temporary.sessionId)) {
      const temporaryChatId = temporary.id
      this.host.units['turns-steer'].trackHeldSteer(temporary.sessionId, {
        projectId,
        conversationId: temporaryChatId,
        userMessageId: steerUserMessageId,
        kind: 'temporary',
        deliverMidTurn: deliverTemporarySteer,
        deliverAfterTurn: async () => {
          // The turn ended while the steer was held   send as the next turn.
          await this.host.sendTemporaryPrompt(
            projectId,
            threadId,
            temporaryChatId,
            settings,
            text,
            validatedAttachments,
            validatedReferences,
            undefined,
            steerUserMessageId,
            safeDisplayText
          )
        },
        discard: async () => {
          // Drop the display record and outbound registration   the harness
          // never received the steer.
          const history = this.host.state.temporaryChatDisplayMessages.get(temporaryChatId)
          if (history) {
            this.host.state.temporaryChatDisplayMessages.set(temporaryChatId, {
              records: history.records.filter((entry) => entry.message.id !== steerUserMessageId)
            })
          }
          const outboundIds =
            this.host.state.outboundMessageIdsBySession.get(temporary.sessionId) ??
            new Set<string>()
          outboundIds.delete(steerUserMessageId)
        }
      })
      return
    }
    await deliverTemporarySteer()
  }

  /**
   * Abort the running temporary chat turn (the user clicked the stop button).
   * The session itself stays alive so a later message can reuse it. Rejects the
   * pending completion waiter so the in-flight send settles immediately.
   */
  async abortTemporaryChat(
    projectId: string,
    threadId: string,
    temporaryChatId: string
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary || temporary.kind !== 'chat') return
    if (temporary.projectId !== projectId || temporary.threadId !== threadId) {
      throw new Error('Temporary chat does not belong to this thread')
    }
    if (this.host.sessionStatuses.get(temporary.sessionId)?.state !== 'working') return
    this.host.state.userAbortedSessions.add(temporary.sessionId)
    {
      const waiter = this.host.state.completionWaiters.get(temporary.sessionId)
      if (waiter) {
        this.host.units['runtime-connectivity'].clearCompletionWaiter(temporary.sessionId)
        waiter.reject(new TemporaryChatCancelledError('Temporary chat stopped by user'))
      }
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      temporary.driverId,
      temporary.accountId
    )
    if (driver) {
      try {
        if (temporary.isolated && supportsIsolatedSessions(driver)) {
          await driver.abort(temporary.projectPath, temporary.sessionId, temporary.isolated)
        } else {
          await driver.abort(temporary.projectPath, temporary.sessionId)
        }
      } finally {
        this.host.sessionStatuses.set(temporary.sessionId, { state: 'idle' })
      }
    }
  }

  /**
   * Route a temporary chat completion through the parent thread's notification
   * channel so the user is told their side chat is done when they are not on
   * that thread.
   */
  async notifyTemporaryChatCompletion(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    kind: 'completed' | 'error',
    errorDetail?: string
  ): Promise<void> {
    // A global-browser agent sidebar is on screen beside the page it answers
    // about, so it never needs an out-of-view notification.
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) return
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) return
      notifyTemporaryChat(thread, temporaryChatId, kind, errorDetail)
    } catch (error) {
      Logger.dev('Temporary chat notification dispatch failed:', error)
    }
  }

  async closeTemporaryChat(temporaryChatId: string): Promise<void> {
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    await this.destroyTemporaryChat(temporaryChatId)
  }

  /**
   * Convert a temporary (quick) chat into a regular thread: a new thread is
   * created in the same project, the quick chat conversation is persisted as
   * its mirrored history, and the temporary session is closed so the user can
   * keep prompting from the new thread.
   */
  async convertTemporaryChatToThread(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    settings: ThreadSettings,
    title?: string
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    const safeSettings = validateThreadSettings(settings)
    const safeTitle = title ? validateBoundedString(title, 'Thread title', 1, 240) : ''

    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) {
      throw new Error('This side chat has expired   open a new one to continue the conversation')
    }
    if (temporary.projectId !== projectId || temporary.threadId !== threadId) {
      throw new Error('This side chat does not belong to the current thread')
    }

    const conversation = (await this.host.loadTemporaryConversation(temporaryChatId)).filter(
      (message) => message.role === 'user' || message.role === 'assistant'
    )
    if (conversation.length === 0) {
      throw new Error('There is nothing to continue from in this side chat')
    }

    const parent = await this.host.threadManager.getThread(projectId, threadId)
    const firstUserMessage = conversation.find((message) => message.role === 'user')
    const fallbackTitle = firstUserMessage
      ? deriveTitleFromText(textForMessage(firstUserMessage))
      : ''
    const threadTitle = safeTitle || fallbackTitle || 'Continued chat'

    /**
     * A side chat continued out of an assistant task stays inside its assistant,
     * exactly as a fork of that task does (`thread-manager-fork.ts`). Ownership
     * is all that travels: the continued conversation is a task-level thread, so
     * it is never the knowledge thread and never a run, and the task's own icon
     * and schedule override come along so the copy still reads as the same task.
     * Without the id the promoted row lands as an assistant-less thread sitting
     * outside the assistant it was continued from.
     */
    const assistantOwnership =
      projectId === ASSISTANT_SPACE_ID && parent?.assistantId !== undefined
        ? {
            assistantId: parent.assistantId,
            assistantIconType: parent.assistantIconType,
            assistantIcon: parent.assistantIcon,
            scheduleOverride: parent.scheduleOverride ?? null,
            scheduled: parent.scheduled
          }
        : {}

    const thread = await this.host.threadManager.createThread({
      projectId,
      providerId: parent?.providerId ?? DEFAULT_HARNESS,
      title: threadTitle,
      titleSource: safeTitle ? 'manual' : 'auto',
      settings: safeSettings,
      featureSlug: parent?.featureSlug,
      workingDirectory: temporary.projectPath,
      ...assistantOwnership
    })

    if (conversation.length > 0) {
      await this.host.threadManager.saveMessages(
        projectId,
        thread.id,
        remapCopiedMessages(conversation)
      )
    }

    await this.host.closeTemporaryChat(temporaryChatId)
    return thread
  }

  async loadTemporaryChatMessages(temporaryChatId: string): Promise<AgentMessage[]> {
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) return []
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      temporary.driverId,
      temporary.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${temporary.driverId}`)
    const messages =
      temporary.isolated && supportsIsolatedSessions(driver)
        ? await driver.loadMessages(temporary.projectPath, temporary.sessionId, temporary.isolated)
        : await driver.loadMessages(temporary.projectPath, temporary.sessionId)
    this.host.units['misc'].applyReasoningStamps(temporary.sessionId, messages)
    this.host.units['misc'].applyGenerationStamps(temporary.sessionId, messages)
    return stampHarnessId(messages, temporary.driverId)
  }

  /**
   * Commit the presentation-safe view of a temporary-chat user message   the
   * in-memory analog of the thread mirror's `persistOutboundMessage`. Must run
   * before the prompt leaves the process so the harness echo under the same ID
   * can never become the display source of truth.
   */
  recordTemporaryDisplayMessage(
    temporaryChatId: string,
    sessionId: string,
    messageId: string,
    displayText: string,
    attachments: Array<{ mime: string; url: string; filename?: string }>,
    references: PromptReference[]
  ): void {
    const fileParts = attachments.map((attachment, index): AgentPart => ({
      type: 'file',
      id: `${messageId}-file-${index}`,
      messageID: messageId,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename
    }))
    const message: AgentMessage = {
      id: messageId,
      role: 'user',
      origin: 'user',
      visibility: 'conversation',
      parts: [
        {
          type: 'text',
          id: `${messageId}-text`,
          messageID: messageId,
          text: displayText
        },
        ...fileParts
      ],
      references: references.length > 0 ? references : undefined,
      createdAt: Date.now(),
      completedAt: Date.now()
    }
    const records = this.host.state.temporaryChatDisplayMessages.get(temporaryChatId)?.records ?? []
    this.host.state.temporaryChatDisplayMessages.set(temporaryChatId, {
      records: [
        ...records.filter((existing) => existing.message.id !== messageId),
        { message, references }
      ]
    })
    const outboundIds =
      this.host.state.outboundMessageIdsBySession.get(sessionId) ?? new Set<string>()
    outboundIds.add(messageId)
    this.host.state.outboundMessageIdsBySession.set(sessionId, outboundIds)
  }

  /**
   * Presentation-safe temporary-conversation mirror: the harness transcript
   * overlaid with the display records committed at send/steer time. An echoed
   * harness user message under a recorded ID keeps that ID but demotes its raw
   * parts to `transportParts`   exactly the display/transport split
   * `persistOutboundMessage` gives threads. Records not yet echoed (turn still
   * streaming) appear from the overlay so a mid-turn reload shows them.
   */
  async loadTemporaryConversation(temporaryChatId: string): Promise<AgentMessage[]> {
    const messages = await this.host.loadTemporaryChatMessages(temporaryChatId)
    const history = this.host.state.temporaryChatDisplayMessages.get(temporaryChatId)
    if (!history || history.records.length === 0) return messages
    const recordsById = new Map(history.records.map((entry) => [entry.message.id, entry]))
    const overlaid: AgentMessage[] = []
    for (const message of messages) {
      const record = recordsById.get(message.id)
      if (!record) {
        overlaid.push(message)
        continue
      }
      // The echo keeps its ID but loses its raw payload   the display record
      // becomes the visible parts, the raw harness parts demote to transport.
      overlaid.push({
        ...message,
        origin: 'user',
        visibility: 'conversation',
        parts: record.message.parts,
        transportParts: message.parts,
        transportOrigin: 'orchestrator',
        references: record.references.length > 0 ? record.references : undefined
      })
    }
    // Records the transcript has not echoed yet (turn still streaming, or the
    // driver does not mirror user turns) still render: append them in recorded
    // order so a mid-turn reload keeps the conversation coherent.
    const echoedIds = new Set(messages.map((message) => message.id))
    for (const record of history.records) {
      if (echoedIds.has(record.message.id)) continue
      overlaid.push(record.message)
    }
    return overlaid.sort((left, right) => left.createdAt - right.createdAt)
  }

  getTemporaryChatStatus(temporaryChatId: string): {
    active: boolean
    expiresAt?: number
  } {
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    return temporary ? { active: true, expiresAt: temporary.expiresAt } : { active: false }
  }

  touchTemporaryChat(temporaryChatId: string): {
    active: boolean
    expiresAt?: number
  } {
    temporaryChatId = validateEntityId(temporaryChatId, 'Temporary chat ID', 256)
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) return { active: false }
    this.refreshTemporaryChatExpiry(temporary)
    return { active: true, expiresAt: temporary.expiresAt }
  }

  refreshTemporaryChatExpiry(temporary: TemporaryChatSession): void {
    clearTimeout(temporary.expiryTimer)
    temporary.expiresAt = Date.now() + temporary.inactivityMs
    temporary.expiryTimer = setTimeout(
      () => void this.expireTemporaryChat(temporary.id),
      temporary.inactivityMs
    )
  }

  async expireTemporaryChat(temporaryChatId: string): Promise<void> {
    if (!(await this.destroyTemporaryChat(temporaryChatId))) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        sendToRenderer(window.webContents, 'agent:temporaryChatExpired', temporaryChatId)
      }
    }
  }

  async destroyTemporaryChat(temporaryChatId: string): Promise<boolean> {
    const temporary = this.host.state.temporaryChats.get(temporaryChatId)
    if (!temporary) return false
    this.host.state.temporaryChats.delete(temporaryChatId)
    this.host.state.temporaryChatDisplayMessages.delete(temporaryChatId)
    this.host.state.outboundMessageIdsBySession.delete(temporary.sessionId)
    // A closed side chat can never receive a reply for its blocking request, so
    // drop the gate instead of leaving an unanswerable request behind.
    this.host.units['permissions'].clearPendingPermissionsForSession(temporary.sessionId)
    clearTimeout(temporary.expiryTimer)
    const completion = this.host.state.completionWaiters.get(temporary.sessionId)
    if (completion) {
      this.host.units['runtime-connectivity'].clearCompletionWaiter(temporary.sessionId)
      completion.reject(new TemporaryChatCancelledError('Temporary chat closed'))
    }
    this.host.sessionRegistry.delete(temporary.sessionId)
    this.host.sessionStatuses.delete(temporary.sessionId)
    this.host.state.reasoningTimes.delete(temporary.sessionId)
    this.host.state.toolTimes.delete(temporary.sessionId)
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      temporary.driverId,
      temporary.accountId
    )
    if (!driver) return true
    if (temporary.isolated && supportsIsolatedSessions(driver)) {
      try {
        await driver.abort(temporary.projectPath, temporary.sessionId, temporary.isolated)
      } catch (error) {
        Logger.dev('Temporary OpenCode chat abort was incomplete:', error)
      } finally {
        driver.disposeIsolatedSession(temporary.isolated)
      }
      return true
    }
    try {
      await driver.abort(temporary.projectPath, temporary.sessionId)
    } catch (error) {
      Logger.dev('Temporary chat abort was incomplete:', error)
    }
    try {
      await driver.deleteSession?.(temporary.projectPath, temporary.sessionId)
    } catch (error) {
      Logger.dev('Temporary chat deletion was incomplete:', error)
    }
    return true
  }

  /**
   * The temporary side chat that owns a live session, if any.
   *
   * Side chats register their isolated session against the parent thread   that
   * thread owns the project root, the audit trail, and the completion waiter  
   * so this lookup is the only way to tell a side chat's session apart from the
   * parent thread's own turn.
   */
  temporaryChatForSession(sessionId: string): TemporaryChatSession | undefined {
    for (const temporary of this.host.state.temporaryChats.values()) {
      if (temporary.sessionId === sessionId) return temporary
    }
    return undefined
  }
}
