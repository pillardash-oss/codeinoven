<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    AudioLines,
    Brain,
    Check,
    Clock3,
    Copy,
    Ellipsis,
    FileText,
    GitFork,
    Loader2,
    MessageSquare,
    Pencil,
    RotateCcw,
    Trash2,
    Video,
    X,
    Zap
  } from '@lucide/svelte'
  import ChatComposer from './ChatComposer.svelte'
  import MediaPreview from './MediaPreview.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import WorkingTrace from '../threads/WorkingTrace.svelte'
  import AgentProviderStatusCard from '../threads/AgentProviderStatusCard.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { fastBaseModelId, fastVariantForModelId } from '$shared/fast-inference'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import SpeechPlaybackButton from '../speech/SpeechPlaybackButton.svelte'
  import { messageId } from '$shared/id'
  import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { isImageMime, isVideoMime, isAudioMime } from '$lib/mime'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { INBOX_PROJECT_ID } from '$shared/types'
  import type {
    AgentContextUsage,
    AgentMessage,
    AgentEvent,
    AgentPart,
    AgentProviderIssue,
    AgentSessionStatus,
    PromptAttachment,
    PromptReference,
    ProviderCatalog,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'

  interface Props {
    tabId: string
    /** Promote the side chat into a regular thread, then open it. */
    onContinueInThread?: (tab: TemporaryChatContextTab) => void | Promise<void>
  }

  let { tabId, onContinueInThread }: Props = $props()

  function resolveTab(): TemporaryChatContextTab {
    const current = contextSidebarState.temporaryChatTab(tabId)
    if (!current) throw new Error(`Temporary chat tab is unavailable: ${tabId}`)
    return current
  }

  const tab = resolveTab()
  /** Reactive provider catalog for the tab's project — seeded from the cache
   *  and kept current when the model picker lazily refreshes the store. */
  let providers = $derived(providerCatalog.cached(tab.projectId) ?? providerCatalog.allCached())
  let previewFile = $state<Extract<AgentPart, { type: 'file' }> | null>(null)
  let imageUrls = new FileBlobUrlManager()
  let references = $derived<PromptReference[]>(
    tab.selections.map((selection, index) => ({
      id: `${tab.id}:selection:${index}`,
      label: `Selection ${index + 1}`,
      text: selection
    }))
  )
  let modelLabel = $derived.by((): string | null => {
    const modelId = tab.settings.modelId
    if (!modelId) return null
    const model = providers
      .flatMap((p) => p.models)
      .find(
        (m) =>
          m.id === modelId && (!tab.settings.providerId || m.providerId === tab.settings.providerId)
      )
    return model?.name ?? modelId
  })
  let providerName = $derived(
    providers.find((p) => p.id === tab.settings.providerId)?.name ?? undefined
  )
  let harnessName = $derived(
    tab.settings.harnessId
      ? (getAgentIcon(tab.settings.harnessId)?.name ?? tab.settings.harnessId)
      : null
  )

  /** Provider status card shown above the composer, mirroring the main chat: a
   *  rich waiting/error status when the session reported one, falling back to a
   *  generic issue built from the plain error string otherwise. */
  const visibleStatus = $derived.by<Extract<
    AgentSessionStatus,
    { state: 'waiting' | 'error' }
  > | null>(() => {
    if (tab.status) return tab.status
    if (!tab.error) return null
    return {
      state: 'error',
      issue: {
        kind: 'unknown',
        message: tab.error,
        harnessId: tab.settings.harnessId ?? 'opencode',
        retryable: false
      }
    }
  })

  function setError(issue: AgentProviderIssue | null | undefined, fallback: string | null): void {
    tab.error = issue?.message ?? fallback ?? ''
    tab.status = issue ? { state: 'error', issue } : null
  }

  function textFor(message: AgentMessage): string {
    return message.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  function fileParts(message: AgentMessage): Extract<AgentPart, { type: 'file' }>[] {
    return message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'file' }> => part.type === 'file'
    )
  }

  function workingParts(message: AgentMessage): AgentPart[] {
    return message.parts.filter((part) => part.type !== 'text' && part.type !== 'question')
  }

  // ─── Turn footer actions (Copy / Continue in a new thread) ─────────────

  let copiedMessageId = $state<string | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined
  let convertingMessageId = $state<string | null>(null)
  let continueError = $state('')

  /** A turn footer is shown on finished assistant turns only — the active
   *  streaming turn has no output to copy yet. */
  function turnFinished(message: AgentMessage): boolean {
    return !tab.busy || message.completedAt != null
  }

  async function copyMessage(message: AgentMessage): Promise<void> {
    try {
      await copyText(textFor(message))
      copiedMessageId = message.id
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copiedMessageId = null), 1500)
    } catch {
      tab.error = 'The message could not be copied to the clipboard.'
    }
  }

  async function continueInThread(message: AgentMessage): Promise<void> {
    if (!onContinueInThread || convertingMessageId) return
    convertingMessageId = message.id
    continueError = ''
    try {
      await onContinueInThread(tab)
    } catch (error) {
      continueError =
        error instanceof Error ? error.message : 'The side chat could not be continued.'
    } finally {
      convertingMessageId = null
    }
  }

  // ─── Turn attribution (harness / model / time) ─────────────────────────

  let allModels = $derived(providers.flatMap((p) => p.models))

  /** Thinking level used for the chat's turns, when the chat's model reasons. */
  let thinkingLevel = $derived.by((): ThinkingLevel | null => {
    const modelId = tab.settings.modelId
    if (!modelId) return null
    const model =
      allModels.find(
        (m) =>
          m.id === fastBaseModelId(modelId) &&
          (!tab.settings.providerId || m.providerId === tab.settings.providerId)
      ) ?? allModels.find((m) => m.id === fastBaseModelId(modelId))
    const presets = model?.thinkingPresets ?? []
    if (presets.length === 0) return null
    return resolveDefaultThinkingLevel(presets, undefined, tab.settings.thinkingLevel) ?? null
  })

  /** Thinking level used for a specific message's turn, when its model reasons. */
  function messageThinkingLevel(message: AgentMessage): ThinkingLevel | null {
    const modelId = message.modelId ?? tab.settings.modelId
    if (!modelId) return null
    const model =
      allModels.find(
        (m) =>
          m.id === fastBaseModelId(modelId) &&
          (!message.providerId || m.providerId === message.providerId)
      ) ?? allModels.find((m) => m.id === fastBaseModelId(modelId))
    const presets = model?.thinkingPresets ?? []
    // A model known not to reason never shows a thinking badge, even when a
    // generic level was stamped onto its rows.
    if (model && presets.length === 0) return null
    // Prefer the level actually persisted for this turn (historical truth),
    // falling back to the chat's current level when a message has no
    // persisted thinking level.
    if (message.thinkingLevel) return message.thinkingLevel
    if (presets.length === 0) return null
    return resolveDefaultThinkingLevel(presets, undefined, tab.settings.thinkingLevel) ?? null
  }

  /** Provider catalog entry for the message, falling back to the chat's model. */
  function messageProvider(message: AgentMessage): ProviderCatalog | undefined {
    const modelId = message.modelId ?? tab.settings.modelId
    if (!modelId) return undefined
    return providers.find((p) => p.models.some((m) => m.id === modelId))
  }

  /** Human model name for the message, falling back to the chat's model. */
  function messageModelLabel(message: AgentMessage): string | null {
    const modelId = message.modelId ?? tab.settings.modelId
    if (!modelId) return null
    const model =
      allModels.find(
        (m) => m.id === modelId && (!message.providerId || m.providerId === message.providerId)
      ) ?? allModels.find((m) => m.id === modelId)
    if (model) return model.name
    return fastVariantForModelId(modelId)?.label ?? modelId
  }

  /** Harness that produced the message — falls back to the chat's harness. */
  function messageHarnessId(message: AgentMessage): string {
    return message.harnessId ?? tab.settings.harnessId ?? 'opencode'
  }

  function messageHarnessName(message: AgentMessage): string {
    return getAgentIcon(messageHarnessId(message))?.name ?? messageHarnessId(message)
  }

  const contextUsage = $derived.by((): AgentContextUsage | undefined => {
    let latest: AgentMessage | undefined
    let costUsd = 0
    for (const message of tab.messages) {
      if (message.role !== 'assistant') continue
      costUsd += message.cost ?? 0
      if (
        message.tokens ||
        message.contextUsed !== undefined ||
        message.contextWindow !== undefined ||
        message.rateLimits?.length ||
        message.credits
      ) {
        latest = message
      }
    }
    if (!latest) return undefined
    const modelId = latest.modelId ?? tab.settings.modelId
    const providerId = latest.providerId
    const contextWindow =
      latest.contextWindow ??
      providers
        .flatMap((provider) => provider.models)
        .find((model) => model.id === modelId && (!providerId || model.providerId === providerId))
        ?.contextWindow
    const contextUsed = latest.contextUsed ?? latest.tokens?.total
    return {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextUsed === undefined ? {} : { contextUsed }),
      ...(contextUsed !== undefined && latest.contextEstimated ? { contextEstimated: true } : {}),
      ...(contextWindow !== undefined && contextUsed !== undefined
        ? { contextPercent: Math.min(100, (contextUsed / contextWindow) * 100) }
        : {}),
      costUsd,
      ...(latest.tokens ? { tokens: latest.tokens } : {}),
      rateLimits: latest.rateLimits ?? [],
      ...(latest.credits ? { credits: latest.credits } : {})
    }
  })

  function formatTime(ts: number): string {
    if (!ts) return ''
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return '<1s'
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    const m = Math.floor(total / 60)
    const s = total % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }

  /** Duration from the preceding user prompt to this assistant message's completion. */
  function turnDuration(messageIndex: number): number | null {
    const assistant = tab.messages[messageIndex]
    if (assistant?.role !== 'assistant' || !assistant.completedAt) return null
    let start = messageIndex - 1
    while (start >= 0 && tab.messages[start]?.role === 'assistant') start--
    const userMsg = tab.messages[start]
    if (userMsg?.role !== 'user' || !userMsg.createdAt) return null
    return assistant.completedAt - userMsg.createdAt
  }

  /** When the agent started working on the turn an assistant message belongs to. */
  function turnStartTime(messageIndex: number): number | undefined {
    for (let i = messageIndex - 1; i >= 0; i--) {
      const candidate = tab.messages[i]
      if (candidate.role === 'user') return candidate.createdAt
    }
    return undefined
  }

  function upsertPart(part: AgentPart): void {
    const messageIndex = tab.messages.findIndex((message) => message.id === part.messageID)
    if (messageIndex < 0) {
      tab.messages = [
        ...tab.messages,
        {
          id: part.messageID,
          role: 'assistant',
          parts: [part],
          createdAt: Date.now()
        }
      ]
      return
    }
    const message = tab.messages[messageIndex]
    const partIndex = message.parts.findIndex((candidate) => candidate.id === part.id)
    const parts =
      partIndex < 0
        ? [...message.parts, part]
        : message.parts.map((candidate, index) => (index === partIndex ? part : candidate))
    tab.messages = tab.messages.map((candidate, index) =>
      index === messageIndex ? { ...message, parts } : candidate
    )
  }

  function applyDelta(messageId: string, partId: string, field: string, delta: string): void {
    if (field !== 'text') return
    tab.messages = tab.messages.map((message) => {
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

  function mergeLoadedQuickChatMessages(messages: AgentMessage[]): void {
    const assistants = messages.filter((message) => message.role === 'assistant')
    const incomingById = new Map(assistants.map((message) => [message.id, message]))
    const existingIds = new Set(tab.messages.map((message) => message.id))
    tab.messages = [
      ...tab.messages.map((message) => incomingById.get(message.id) ?? message),
      ...assistants.filter((message) => !existingIds.has(message.id))
    ]
  }

  function handleEvent(event: AgentEvent): void {
    if (!('sessionId' in event)) return
    if (event.type === 'temporary-chat.started') {
      tab.sessionId = event.sessionId
      return
    }
    if (!tab.sessionId || event.sessionId !== tab.sessionId) return
    switch (event.type) {
      case 'message.part.updated':
        upsertPart(event.part)
        break
      case 'message.part.delta':
        applyDelta(event.messageId, event.partId, event.field, event.delta)
        break
      case 'message.completed':
        tab.messages = tab.messages.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                completedAt: Date.now(),
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
      case 'usage.updated':
        tab.messages = tab.messages.map((message) =>
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
        setError(event.issue, event.error ?? 'The temporary chat session failed.')
        tab.busy = false
        break
      case 'session.status':
        if (event.status.state === 'error') {
          setError(event.status.issue, null)
          tab.busy = false
        } else if (event.status.state === 'waiting') {
          tab.status = event.status
        } else {
          tab.status = null
        }
        break
      case 'session.idle':
        break
    }
  }

  function userMessage(
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

  function touch(): void {
    if (tab.expired) return
    contextSidebarState.touchTemporaryChat(tab)
    if (!tab.sessionStarted) return
    const temporaryChatId = tab.temporaryChatId
    void invoke('agent:touchTemporaryChat', temporaryChatId).then((status) => {
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      if (!status.active) {
        contextSidebarState.expireTemporaryChat(tab, false)
        return
      }
      if (status.expiresAt) {
        contextSidebarState.touchTemporaryChat(tab, status.expiresAt)
      }
    })
  }

  function restart(): void {
    contextSidebarState.restartTemporaryChat(tab)
    if (tab.mode === 'elaborate') {
      tab.autoPromptSent = true
      void sendElaboratePrompt()
    }
  }

  /** Record the model when a temporary-chat turn actually starts. */
  function recordModelUse(): void {
    if (!tab.settings.harnessId || !tab.settings.providerId || !tab.settings.modelId) return
    rendererRecovery.addChatRecentModel(
      modelKey(tab.settings.harnessId, tab.settings.providerId, tab.settings.modelId)
    )
  }

  const DEFAULT_ELABORATE_PROMPT =
    'Explain this selection in detail. Be clear and explain in simple terms, ensure you do not overwhelm the user with so much jargons, unless explicitly asked to. Do not perform any execution, make code changes, run tests, or do anything beyond: read-only and findings based on the available context. Focus on answering just the selection and avoiding mentioning anything unrelated!'

  function sendElaboratePrompt(): Promise<void> {
    return send(
      tab.autoPrompt ?? DEFAULT_ELABORATE_PROMPT,
      [],
      tab.autoPrompt ? '*Explain this question.*' : '*Elaborate.*'
    )
  }

  /** A message queued while the agent is working — sent automatically when the
   *  turn finishes, or steered into the live turn on demand. */
  interface QueuedTemporaryPrompt {
    text: string
    attachments: PromptAttachment[]
    selections: string[]
    selectionAttached: boolean
  }

  let queued = $state<QueuedTemporaryPrompt | null>(null)
  let showQueueMenu = $state(false)
  /** Bumped to remount the composer with a restored draft after editing the queue. */
  let composerRestoreKey = $state(0)
  /** Shortcut label for the steer combo — macOS shows ⌘⇧, others Ctrl+Shift+. */
  const steerModifierLabel =
    navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘⇧' : 'Ctrl+Shift+'
  /** Attachments to restore into the composer after an Edit of the queue. */
  let restoredAttachments = $state<PromptAttachment[]>([])
  /** True while a user-initiated stop is settling — suppresses the expected
   *  "stopped" rejection from surfacing as an error banner. */
  let aborting = $state(false)

  async function send(
    text: string,
    attachments: PromptAttachment[] = [],
    presentationText = text,
    direct = false
  ): Promise<void> {
    const prompt = text.trim()
    if (!prompt || tab.expired) return
    touch()
    // While the agent is working, the message is queued unless the user
    // force-sends it (Cmd/Ctrl+Shift+Enter) as a steer intervention.
    if (tab.busy) {
      const pending: QueuedTemporaryPrompt = {
        text: prompt,
        attachments,
        selections: tab.selectionAttached ? [...tab.selections] : [],
        selectionAttached: tab.selectionAttached
      }
      tab.selections = []
      tab.selectionAttached = false
      if (direct) {
        await steerQueuedMessage(pending)
      } else {
        queued = pending
      }
      return
    }
    recordModelUse()
    const temporaryChatId = tab.temporaryChatId
    const attachedSelections = tab.selectionAttached ? [...tab.selections] : []
    const outgoing = userMessage(
      presentationText,
      attachments,
      attachedSelections.map((selection, index) => ({
        id: `${temporaryChatId}:selection:${index}`,
        label: `Selection ${index + 1}`,
        text: selection
      }))
    )
    tab.messages = [...tab.messages, outgoing]
    if (attachedSelections.length > 0) tab.selectionMessageId = outgoing.id
    tab.selections = []
    tab.selectionAttached = false
    tab.draft = ''
    tab.busy = true
    tab.error = ''
    tab.status = null
    tab.sessionStarted = true
    try {
      const response = await invoke(
        'agent:sendTemporaryPrompt',
        tab.projectId,
        tab.threadId,
        temporaryChatId,
        tab.settings,
        prompt,
        attachments,
        attachedSelections,
        tab.messages.length === 1 ? tab.initialContext : undefined
      )
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      const responseIndex = tab.messages.findIndex((message) => message.id === response.id)
      tab.messages =
        responseIndex < 0
          ? [...tab.messages, response]
          : tab.messages.map((message, index) =>
              index === responseIndex ? { ...message, ...response } : message
            )
      touch()
    } catch (error) {
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      if (aborting) {
        aborting = false
        return
      }
      tab.error = error instanceof Error ? error.message : 'The temporary chat could not respond.'
    } finally {
      aborting = false
      if (tab.temporaryChatId === temporaryChatId && !tab.expired) {
        tab.busy = false
        // Auto-send a message queued while the agent was working. The queue
        // captured its selections, so restore them before sending.
        const pending = queued
        if (pending) {
          queued = null
          showQueueMenu = false
          tab.selections = pending.selectionAttached ? [...pending.selections] : []
          tab.selectionAttached = pending.selectionAttached
          void send(pending.text, pending.attachments, pending.text)
        }
      }
    }
  }

  /** Abort the running temporary chat turn. */
  async function stopRun(): Promise<void> {
    if (!tab.busy || tab.expired) return
    aborting = true
    queued = null
    showQueueMenu = false
    try {
      await invoke('agent:abortTemporaryChat', tab.projectId, tab.threadId, tab.temporaryChatId)
    } catch (error) {
      aborting = false
      tab.error = error instanceof Error ? error.message : 'The request could not be stopped.'
    }
  }

  /** Retry the most recent user prompt, mirroring the main chat's retry of a
   *  failed/errored turn. Clears the error card and re-sends the last prompt. */
  async function retryLastTurn(): Promise<void> {
    if (tab.busy || tab.expired) return
    const lastUser = [...tab.messages].reverse().find((message) => message.role === 'user')
    const text = lastUser ? textFor(lastUser) : ''
    if (!text.trim()) {
      tab.error = ''
      tab.status = null
      return
    }
    tab.error = ''
    tab.status = null
    await send(text, [], text)
  }

  /**
   * Steer — deliver a message into the live temporary-chat turn as an
   * intervention (Cmd/Ctrl+Shift+Enter in the composer, or the queue card's
   * Steer button). If the turn finished before delivery the message is
   * restored to the queue instead of being lost.
   */
  async function steerQueuedMessage(pendingOverride?: QueuedTemporaryPrompt): Promise<void> {
    const pending = pendingOverride ?? queued
    if (!pending || !tab.busy || tab.expired) return
    showQueueMenu = false
    if (!pendingOverride) queued = null
    touch()
    const temporaryChatId = tab.temporaryChatId
    const outgoing = userMessage(
      pending.text,
      pending.attachments,
      pending.selectionAttached
        ? pending.selections.map((selection, index) => ({
            id: `${temporaryChatId}:selection:${index}`,
            label: `Selection ${index + 1}`,
            text: selection
          }))
        : []
    )
    tab.messages = [...tab.messages, outgoing]
    if (pending.selectionAttached && pending.selections.length > 0) {
      tab.selectionMessageId = outgoing.id
    }
    tab.sessionStarted = true
    recordModelUse()
    try {
      await invoke(
        'agent:steerTemporaryPrompt',
        tab.projectId,
        tab.threadId,
        temporaryChatId,
        tab.settings,
        pending.text,
        pending.attachments,
        pending.selections
      )
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      touch()
    } catch (error) {
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      // The steer was not delivered — restore the queue and drop the optimistic copy.
      if (!queued) {
        queued = pending
        tab.messages = tab.messages.filter((message) => message.id !== outgoing.id)
      }
      tab.error =
        error instanceof Error ? error.message : 'The steer message could not be delivered.'
    }
  }

  /** Return the queued message to the composer for editing. */
  function editQueuedMessage(): void {
    showQueueMenu = false
    const pending = queued
    if (!pending) return
    tab.draft = pending.text
    tab.selections = pending.selectionAttached ? [...pending.selections] : []
    tab.selectionAttached = pending.selectionAttached
    restoredAttachments = pending.attachments
    queued = null
    composerRestoreKey += 1
  }

  /** Delete the queued message. */
  function deleteQueuedMessage(): void {
    showQueueMenu = false
    queued = null
  }

  function updateSettings(settings: ThreadSettings): void {
    tab.settings = {
      ...settings,
      engineeringMode: false,
      permissionLevel: 'auto_review'
    }
  }

  onMount(() => {
    const unsubscribeExpiry = subscribe('agent:temporaryChatExpired', (temporaryChatId) => {
      if (temporaryChatId === tab.temporaryChatId) {
        contextSidebarState.expireTemporaryChat(tab, false)
      }
    })
    const unsubscribeEvents = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (event) handleEvent(event)
    })
    if (tab.sessionStarted) {
      const temporaryChatId = tab.temporaryChatId
      void invoke('agent:getTemporaryChatStatus', temporaryChatId).then((status) => {
        if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
        if (!status.active) {
          contextSidebarState.expireTemporaryChat(tab, false)
          return
        }
        if (status.expiresAt) {
          contextSidebarState.touchTemporaryChat(tab, status.expiresAt)
        }
      })
      void invoke('agent:loadTemporaryChatMessages', temporaryChatId)
        .then((messages) => {
          if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
          mergeLoadedQuickChatMessages(messages)
        })
        .catch(() => {
          // Live events and the in-flight send still reconcile the response.
        })
    }
    if (tab.mode === 'elaborate' && !tab.autoPromptSent) {
      tab.autoPromptSent = true
      void sendElaboratePrompt()
    }
    return () => {
      unsubscribeExpiry()
      unsubscribeEvents()
    }
  })

  // Convert file:// attachment URLs to blob: Object URLs so attached images and
  // media render reliably in the Electron renderer.
  $effect(() => {
    for (const message of tab.messages) {
      for (const part of message.parts) {
        if (
          part.type === 'file' &&
          (isImageMime(part.mime) || isVideoMime(part.mime) || isAudioMime(part.mime)) &&
          part.url.startsWith('file://')
        ) {
          void imageUrls.load(part.url, part.mime)
        }
      }
    }
  })

  onDestroy(() => imageUrls.destroy())
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  {#if previewFile}
    <MediaPreview
      src={imageUrls.getUrl(previewFile.url)}
      filename={previewFile.filename ?? 'file'}
      mime={previewFile.mime}
      onClose={() => (previewFile = null)}
      onLoadError={(el) => {
        const target = previewFile
        if (target) void imageUrls.bindMedia(target.url, target.mime, el)
      }}
    />
  {/if}
  {#if tab.expired}
    <div class="flex min-h-0 flex-1 items-center justify-center px-6">
      <div class="w-full max-w-sm rounded-xl border border-border bg-surface p-5 text-center">
        <Clock3 size={20} class="mx-auto text-dimmed" />
        <p class="mt-3 text-sm font-semibold text-foreground">Side chat has expired</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Its temporary history and agent session were discarded after three hours of inactivity.
        </p>
        <button
          type="button"
          class="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover"
          onclick={restart}
        >
          <RotateCcw size={13} />
          Start new side chat
        </button>
      </div>
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-5">
        {#each tab.messages as message, messageIndex (message.id)}
          {#if message.role === 'user'}
            <div class="ml-auto max-w-[90%]">
              {#if message.references?.length}
                <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                  {#each message.references as reference (reference.id)}
                    <span
                      class="flex max-w-full items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-[11px]"
                      title={reference.comment
                        ? `${reference.comment}\n\n${reference.text}`
                        : reference.text}
                    >
                      <MessageSquare size={11} class="shrink-0 text-accent" />
                      <span class="font-medium text-foreground">{reference.label}</span>
                      <span class="truncate text-muted">{reference.text}</span>
                      {#if reference.comment}
                        <span class="max-w-48 truncate italic text-foreground">
                          “{reference.comment}”
                        </span>
                      {/if}
                    </span>
                  {/each}
                </div>
              {/if}
              {#if fileParts(message).length > 0}
                <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                  {#each fileParts(message) as part (part.id)}
                    {#if isImageMime(part.mime)}
                      <button
                        type="button"
                        class="group relative overflow-hidden rounded-lg border border-border transition-shadow hover:shadow-md"
                        title="Preview {part.filename ?? 'image'}"
                        aria-label="Preview {part.filename ?? 'image'}"
                        onclick={() => (previewFile = part)}
                      >
                        <img
                          src={imageUrls.getUrl(part.url)}
                          alt={part.filename ?? 'image'}
                          class="h-16 w-24 object-cover"
                          onerror={(e: Event) =>
                            void imageUrls.bindImage(
                              part.url,
                              part.mime,
                              e.currentTarget as HTMLImageElement
                            )}
                        />
                        <span
                          class="absolute inset-0 flex items-center justify-center bg-black/0 text-[10px] font-medium text-white opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100"
                        >
                          Preview
                        </span>
                      </button>
                    {:else if isVideoMime(part.mime) || isAudioMime(part.mime)}
                      <button
                        type="button"
                        class="flex max-w-full cursor-pointer items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted transition-colors hover:bg-elevated/80 hover:text-foreground"
                        title="Preview {part.filename ?? 'media'}"
                        aria-label="Preview {part.filename ?? 'media'}"
                        onclick={() => (previewFile = part)}
                      >
                        {#if isVideoMime(part.mime)}
                          <Video size={11} class="shrink-0" />
                        {:else}
                          <AudioLines size={11} class="shrink-0" />
                        {/if}
                        <span class="max-w-32 truncate"
                          >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                        >
                      </button>
                    {:else}
                      <span
                        class="flex max-w-full items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted"
                        title={part.filename ?? part.url}
                      >
                        <FileText size={11} class="shrink-0" />
                        <span class="max-w-32 truncate"
                          >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                        >
                      </span>
                    {/if}
                  {/each}
                </div>
              {/if}
              <div class="rounded-lg bg-surface px-3 py-2 text-sm text-foreground">
                <MarkdownView text={textFor(message)} />
              </div>
            </div>
          {:else if textFor(message)}
            {@const traceParts = workingParts(message)}
            <div class="group flex min-w-0 flex-col gap-2.5 text-sm text-foreground">
              {#if traceParts.length > 0}
                <WorkingTrace
                  parts={traceParts}
                  open={tab.busy}
                  busy={tab.busy}
                  latest={tab.busy}
                  startTime={turnStartTime(messageIndex)}
                  {modelLabel}
                  {thinkingLevel}
                  {providerName}
                  harnessId={tab.settings.harnessId}
                  {harnessName}
                />
              {/if}
              <MarkdownView text={textFor(message)} />
              {#if turnFinished(message)}
                {@render turnFooter(message, messageIndex)}
              {/if}
            </div>
          {:else if workingParts(message).length > 0}
            <div class="group flex min-w-0 flex-col gap-2.5">
              <WorkingTrace
                parts={workingParts(message)}
                open={tab.busy}
                busy={tab.busy}
                latest={tab.busy}
                startTime={turnStartTime(messageIndex)}
                {modelLabel}
                {thinkingLevel}
                {providerName}
                harnessId={tab.settings.harnessId}
                {harnessName}
              />
              {#if turnFinished(message)}
                {@render turnFooter(message, messageIndex)}
              {/if}
            </div>
          {/if}
        {/each}

        {#if tab.busy}
          <div class="flex items-center gap-2 text-xs text-dimmed">
            <Loader2 size={13} class="animate-spin text-info" />
            Reading context…
          </div>
        {/if}

        {#if continueError}
          <div
            class="flex items-start justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <span>{continueError}</span>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 transition-colors hover:bg-danger/10"
              title="Dismiss error"
              aria-label="Dismiss continue-in-thread error"
              onclick={() => (continueError = '')}
            >
              <X size={12} />
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if queued}
      <div class="shrink-0 border-t border-border bg-app px-3 pt-2">
        <div class="mx-auto max-w-2xl">
          <div class="rounded-t-xl border border-border bg-surface shadow-sm">
            <div class="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed"
                >Queued</span
              >
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="rounded-md px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-elevated"
                  title={`Steer — ${steerModifierLabel}Enter — send this message to the agent now`}
                  onclick={() => void steerQueuedMessage()}
                >
                  Steer
                </button>
                <div class="relative">
                  <button
                    type="button"
                    class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    aria-label="Queued message actions"
                    title="Queued message actions"
                    onclick={() => (showQueueMenu = !showQueueMenu)}
                    oncontextmenu={(e: MouseEvent) => {
                      e.preventDefault()
                      showQueueMenu = true
                    }}
                  >
                    <Ellipsis size={13} />
                  </button>
                  {#if showQueueMenu}
                    <button
                      type="button"
                      class="fixed inset-0 z-30 cursor-default"
                      aria-label="Close menu"
                      onclick={() => (showQueueMenu = false)}
                    ></button>
                    <div
                      class="absolute bottom-8 right-0 z-40 w-32 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                      role="menu"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-elevated"
                        role="menuitem"
                        onclick={editQueuedMessage}
                      >
                        <Pencil size={13} class="text-muted" />
                        Edit
                      </button>
                      <div class="mx-2 my-1 border-t"></div>
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
                        role="menuitem"
                        onclick={deleteQueuedMessage}
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
            {#if queued.selectionAttached && queued.selections.length > 0}
              <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                {#each queued.selections as selection, index (index)}
                  <span
                    class="flex max-w-full items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-[11px]"
                    title={selection}
                  >
                    <MessageSquare size={11} class="shrink-0 text-accent" />
                    <span class="font-medium text-foreground">Selection {index + 1}</span>
                    <span class="truncate text-muted">{selection}</span>
                  </span>
                {/each}
              </div>
            {/if}
            {#if queued.attachments.length > 0}
              <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                {#each queued.attachments as attachment (attachment.url)}
                  <span
                    class="flex max-w-full items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted"
                    title={attachment.filename ?? attachment.url}
                  >
                    <FileText size={11} class="shrink-0" />
                    <span class="max-w-32 truncate"
                      >{attachment.filename ?? attachment.url.split('/').pop() ?? 'file'}</span
                    >
                  </span>
                {/each}
              </div>
            {/if}
            <p class="px-3 pb-2.5 text-[12px] text-muted line-clamp-3">{queued.text}</p>
          </div>
        </div>
      </div>
    {/if}
    {#if visibleStatus}
      <div class="shrink-0 border-t border-border bg-app px-3 pb-2 pt-3">
        <div class="mx-auto max-w-2xl">
          <AgentProviderStatusCard
            status={visibleStatus}
            providerName={harnessName ?? tab.settings.harnessId ?? 'OpenCode'}
            settings={tab.settings}
            {providers}
            projectId={tab.projectId}
            favoriteModels={rendererRecovery.chatFavoriteModels}
            recentModels={rendererRecovery.chatRecentModels}
            onModelChange={updateSettings}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleChatFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
            onStop={stopRun}
            onRetry={() => void retryLastTurn()}
            onDismiss={() => {
              tab.error = ''
              tab.status = null
            }}
            retryLabel="Retry"
          />
        </div>
      </div>
    {/if}
    <div class="shrink-0 border-t border-border bg-app px-3 py-3">
      <div class="mx-auto max-w-2xl">
        {#key composerRestoreKey}
          <ChatComposer
            placeholder={tab.busy
              ? 'The agent is working — type to queue a question'
              : 'Ask a read-only question…'}
            autofocus
            working={tab.busy}
            onStop={stopRun}
            settings={tab.settings}
            onSettingsChange={updateSettings}
            {providers}
            projectId={tab.projectId}
            attachmentStorage={{
              kind: tab.projectId === INBOX_PROJECT_ID ? 'chat' : 'project',
              projectId: tab.projectId,
              threadId: tab.threadId
            }}
            harnessId={tab.settings.harnessId}
            {contextUsage}
            showEngineeringMode={false}
            readOnlyMode
            allowAttachments
            hidePermissionSelector
            enableImageDescriptorGate={false}
            favoriteModels={rendererRecovery.chatFavoriteModels}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleChatFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
            recentModels={rendererRecovery.chatRecentModels}
            onModelUsed={(modelKey) => rendererRecovery.addChatRecentModel(modelKey)}
            {references}
            onRemoveReference={(id) => {
              const index = references.findIndex((reference) => reference.id === id)
              if (index < 0) return
              tab.selections = tab.selections.filter((_, i) => i !== index)
              tab.selectionAttached = tab.selections.length > 0
            }}
            initialValue={tab.draft}
            initialAttachments={restoredAttachments}
            onValueChange={(value) => {
              tab.draft = value
              touch()
            }}
            onSend={(message, attachments, direct) =>
              void send(message, attachments, message, direct)}
          />
        {/key}
      </div>
    </div>
  {/if}
</div>

{#snippet turnFooter(message: AgentMessage, messageIndex: number)}
  {@const msgModelLabel = messageModelLabel(message)}
  {@const msgFastVariant = fastVariantForModelId(message.modelId ?? tab.settings.modelId)}
  {@const msgThinking = messageThinkingLevel(message)}
  {@const msgDuration = turnDuration(messageIndex)}
  <div class="flex items-center gap-1.5">
    <div class="flex items-center gap-0.5">
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Copy message"
        title="Copy"
        onclick={() => copyMessage(message)}
      >
        {#if copiedMessageId === message.id}
          <Check size={12} class="text-success" />
        {:else}
          <Copy size={12} />
        {/if}
      </button>
      <SpeechPlaybackButton messageId={message.id} markdown={textFor(message)} />
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Continue in a new thread"
        title="Continue in a new thread"
        disabled={convertingMessageId !== null}
        onclick={() => continueInThread(message)}
      >
        {#if convertingMessageId === message.id}
          <Loader2 size={12} class="animate-spin" />
        {:else}
          <GitFork size={12} />
        {/if}
      </button>
    </div>
    <div
      class="pointer-events-none flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <span class="flex items-center gap-1 text-[10px] text-dimmed">
        <AgentIcon agentId={messageHarnessId(message)} size={14} />
        {messageHarnessName(message)}
      </span>
      {#if msgModelLabel}
        <span class="text-[10px] text-dimmed">·</span>
        <span class="flex items-center gap-1 text-[10px] text-dimmed">
          <VendorIcon name={messageProvider(message)?.name ?? msgModelLabel} size={12} />
          {msgModelLabel}
          {#if msgFastVariant}
            <Zap
              size={10}
              class="text-accent"
              fill="currentColor"
              aria-label="Fast inference"
              title={`Fast inference — ~${msgFastVariant.multiplier}× usage`}
            />
          {/if}
        </span>
        {#if msgThinking}
          <span
            class="flex items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[9px] capitalize text-muted"
            title={`Thinking level: ${msgThinking}`}
            aria-label={`Thinking level: ${msgThinking}`}
          >
            <Brain size={9} />
            {msgThinking}
          </span>
        {/if}
      {/if}
      <span class="text-[10px] text-dimmed"
        >· {formatTime(message.completedAt ?? message.createdAt)}</span
      >
      {#if msgDuration !== null}
        <span class="text-[10px] text-dimmed tabular-nums">· {formatDuration(msgDuration)}</span>
      {:else if message.completedAt && message.createdAt}
        <span class="text-[10px] text-dimmed tabular-nums"
          >· {formatDuration(message.completedAt - message.createdAt)}</span
        >
      {/if}
    </div>
  </div>
{/snippet}
