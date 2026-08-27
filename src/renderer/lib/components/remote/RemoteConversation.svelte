<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'
  import {
    Brain,
    Check,
    ChevronDown,
    Copy,
    FileText,
    GitFork,
    Loader2,
    MessageSquareDashed,
    X
  } from '@lucide/svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import {
    threadSettings,
    chatSettings,
    chatEffectiveSettings
  } from '$lib/stores/thread-settings.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { contextSidebarState, EXPLAIN_SELECTION_PROMPT } from '$lib/stores/context-sidebar.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { messageId } from '$shared/id'
  import { isTodoToolPart } from '$lib/agent-todos'
  import { copyText } from '$lib/copy-text'
  import SpeechPlaybackButton from '../speech/SpeechPlaybackButton.svelte'
  import { speechController } from '../../speech/speech-controller.svelte'
  import { attachmentPreviewKind, fileUrlToPath } from '$lib/mime'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { fastVariantForModelId } from '$shared/fast-inference'
  import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { mobileState } from '$lib/remote/mobile-state.svelte'
  import ChatComposer from '../chats/ChatComposer.svelte'
  import EngineeringFlowCancelModal from '../threads/EngineeringFlowCancelModal.svelte'
  import EngineeringEntryCard from '../chats/EngineeringEntryCard.svelte'
  import AttachmentPreview from '../chats/AttachmentPreview.svelte'
  import ResponseSelectionPopover from '../chats/ResponseSelectionPopover.svelte'
  import AgentProviderStatusCard from '../threads/AgentProviderStatusCard.svelte'
  import WorkingTrace from '../threads/WorkingTrace.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import BottomSheet from '../ui/BottomSheet.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    AgentMessage,
    AgentPart,
    AgentProviderIssue,
    AgentSessionStatus,
    BrainstormDocument,
    PromptAttachment,
    PromptReference,
    EngineeringLifecycleSelectionInput,
    EngineeringLifecycleState,
    PrdWorkflowState,
    Thread,
    ThreadSettings
  } from '$shared/types'
  import {
    hasSelectedStage,
    normalizeLifecycleStages,
    representativeLifecycleSelection
  } from '$shared/engines/engineering-lifecycle-engine'
  import type { ThinkingLevel } from '$shared/types'

  type StartAfterSelection = Pick<Thread, 'id' | 'title'>

  interface Props {
    thread: Thread
    chatMode: boolean
    jumpTarget: { id: string; content: string; nonce: number } | null
  }

  let { thread, chatMode, jumpTarget }: Props = $props()

  let messages = $derived(threadMessages.messages(thread.projectId, thread.id))
  let loaded = $derived(threadMessages.loaded(thread.projectId, thread.id))
  let loading = $derived(threadMessages.loading(thread.projectId, thread.id))
  let loadError = $derived(threadMessages.error(thread.projectId, thread.id))
  let runIssue = $derived(threadMessages.runIssue(thread.projectId, thread.id))
  let busy = $derived(agentRuns.isBusy(thread.projectId, thread.id))

  let sendError = $state('')
  let engineeringLifecycle = $state<EngineeringLifecycleState | null>(null)
  let prdWorkflow = $state<PrdWorkflowState | null>(null)
  let gateBrainstorm = $state<BrainstormDocument | null>(null)
  let continueWithoutHifi = $state(false)
  let pendingLifecycleSelection = $state<EngineeringLifecycleSelectionInput | null>(null)
  /** True only after a user send that must replace active Engineering work; the
   *  Toolbox toggle itself never opens the guard. */
  let lifecycleGuardOpen = $state(false)
  /** A user send parked behind the replacement guard, resubmitted after confirm. */
  let guardedSend = $state<{
    text: string
    attachments: PromptAttachment[]
    promptContext?: string
    promptReferences?: PromptReference[]
  } | null>(null)
  /** Draft restore for a send parked behind the replacement guard. */
  let composerRestore = $state<{ text: string; attachments: PromptAttachment[] } | null>(null)
  let composerRestoreKey = $state(0)
  let lifecycleChoiceBusy = $state(false)
  let failedDelivery = $state<{ text: string; attachments: PromptAttachment[] } | null>(null)
  let errorRetrying = $state(false)
  let scrollEl = $state<HTMLDivElement>()
  /** Whether the user has scrolled away from the live tail. While away, the
   *  auto-follow must stay released until they scroll back to the bottom. */
  let userScrolledAway = $state(false)
  /** Tracks the last consumed history jump so auto-scroll resumes afterwards. */
  let lastJumpNonce = -1

  const SCROLL_AT_BOTTOM_THRESHOLD = 60

  function isAtBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  }

  function onScroll(): void {
    if (!scrollEl) return
    userScrolledAway = !isAtBottom(scrollEl)
  }

  function scrollToLatest(): void {
    if (!scrollEl) return
    userScrolledAway = false
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' })
  }

  const captureScrollElement: Attachment<HTMLDivElement> = (element) => {
    scrollEl = element
    return () => {
      if (scrollEl === element) scrollEl = undefined
    }
  }

  /** Message roots keyed by id — lets history jumps scroll without a DOM query. */
  const messageElements = new SvelteMap<string, HTMLDivElement>()
  const registerMessageElement: Attachment<HTMLDivElement> = (element) => {
    const id = element.dataset.messageId
    if (id) messageElements.set(id, element)
    return () => {
      if (id) messageElements.delete(id)
    }
  }

  /** Effective agent settings for this thread — chats keep their own model.
   *  Held as local state (not a pure derive) so the composer's toolbar edits
   *  (model/permission/thinking) are reflected immediately without a round
   *  trip, matching desktop's ThreadView. */
  // Intentional initial-value capture — this component is keyed per thread.
  // svelte-ignore state_referenced_locally
  let settings = $state<ThreadSettings>(
    chatMode ? chatEffectiveSettings() : threadSettings.initialFor(thread)
  )

  function updateSettings(updated: ThreadSettings): void {
    settings = updated
  }

  function settingsForEngineeringState(state: EngineeringLifecycleState | null): ThreadSettings {
    if (!state || (state.selectedStages.length === 0 && !state.autopilot)) {
      return {
        ...settings,
        engineeringMode: false,
        assignmentMode: false,
        loopMode: false
      }
    }
    const { selectedStages, autopilot } = state
    return {
      ...settings,
      engineeringMode:
        autopilot ||
        selectedStages.includes('brainstorm') ||
        selectedStages.includes('prd') ||
        selectedStages.includes('spec'),
      assignmentMode: autopilot || selectedStages.includes('assignment'),
      loopMode: autopilot || selectedStages.includes('achievement')
    }
  }

  // Provider/model catalog — hydrate this project's catalog if it hasn't
  // been fetched yet (desktop's App.svelte seeds every project at startup;
  // mobile only ever opens one project's threads at a time).
  let providers = $derived(providerCatalog.cached(thread.projectId) ?? [])
  onMount(() => {
    if (!providerCatalog.cached(thread.projectId)) {
      void providerCatalog.refresh(thread.projectId)
    }
  })

  // Selection capture lives at the document level so a long-press that ends
  // outside the transcript (over the composer, for instance) still resolves.
  onMount(() => {
    document.addEventListener('pointerup', captureResponseSelection)
    return () => document.removeEventListener('pointerup', captureResponseSelection)
  })

  onMount(() => {
    const { projectId, id } = thread
    // Keep mobile hydration below the encrypted transport's frame cap. Older
    // history remains available through the existing paged thread API.
    const hydrate = async (): Promise<void> => {
      await threadMessages.load(projectId, id, 40)
      // A thread opened while its turn is still running has its accumulated
      // working trace only in the live harness session — the mirror persists
      // assistant parts only when the turn idles/completes. Pull the live
      // transcript so the in-progress work renders immediately instead of a
      // bare user message that only fills in after the turn ends.
      try {
        const status = await invoke('agent:getSessionStatus', projectId, id)
        if (
          status?.state === 'working' ||
          status?.state === 'waiting' ||
          thread.status === 'planning' ||
          thread.status === 'executing' ||
          thread.status === 'working-paused'
        ) {
          await threadMessages.load(projectId, id)
        }
      } catch {
        // Status is best-effort; the paged mirror already loaded.
      }
    }
    void hydrate()
    if (!chatMode) void refreshEngineeringLifecycle()
    const bind = (sessionId: string | undefined): void => {
      if (sessionId) threadMessages.setSessionId(projectId, id, sessionId)
    }
    if (thread.sessionId) {
      bind(thread.sessionId)
    } else {
      void invoke('thread:get', projectId, id)
        .then((data) => {
          bind(data?.sessionId)
        })
        .catch(() => undefined)
    }
  })

  async function refreshEngineeringLifecycle(): Promise<void> {
    const [lifecycle, workflow] = await Promise.all([
      invoke('engineeringLifecycle:get', thread.projectId, thread.id),
      invoke('prd:getWorkflow', thread.projectId, thread.id)
    ])
    engineeringLifecycle = lifecycle
    prdWorkflow = workflow
    gateBrainstorm =
      lifecycle?.humanGate === 'prototype_selection' ||
      lifecycle?.humanGate === 'brainstorm_finalization'
        ? await invoke('brainstorm:getActive', thread.projectId, thread.id)
        : null
    if (lifecycle?.humanGate !== 'prototype_selection') continueWithoutHifi = false
  }

  async function applyLifecycleSelection(input: EngineeringLifecycleSelectionInput): Promise<void> {
    engineeringLifecycle = await invoke(
      'engineeringLifecycle:select',
      thread.projectId,
      thread.id,
      input
    )
    settings = settingsForEngineeringState(engineeringLifecycle)
    await invoke('thread:updateSettings', thread.projectId, thread.id, settings)
  }

  /** Toolbox toggles are intent, never action: the selection is only staged here
   *  and applied when the user actually sends a message. Flipping switches while
   *  playing around in the composer must not apply settings or open the guard. */
  function selectEngineeringLifecycle(input: EngineeringLifecycleSelectionInput): void {
    pendingLifecycleSelection = input
  }

  async function confirmLifecycleReplacement(): Promise<void> {
    const replacement = pendingLifecycleSelection ?? { stages: [], autopilot: false }
    engineeringLifecycle = await invoke(
      'engineeringLifecycle:cancel',
      thread.projectId,
      thread.id,
      true
    )
    pendingLifecycleSelection = null
    lifecycleGuardOpen = false
    if (replacement.stages.length > 0 || replacement.autopilot) {
      await applyLifecycleSelection(replacement)
    }
    const parked = guardedSend
    if (parked) {
      guardedSend = null
      await deliver(parked.text, parked.attachments, parked.promptContext, parked.promptReferences)
      composerRestore = null
      composerRestoreKey += 1
    }
  }

  async function choosePrdEntry(choice: 'brainstorm_first' | 'start_prd'): Promise<void> {
    lifecycleChoiceBusy = true
    sendError = ''
    try {
      if (!engineeringLifecycle?.activeStage) {
        engineeringLifecycle = (
          await invoke('engineeringLifecycle:start', thread.projectId, thread.id)
        ).state
      }
      prdWorkflow = await invoke('prd:chooseEntry', thread.projectId, thread.id, choice)
    } catch (error) {
      sendError =
        error instanceof Error ? error.message : 'The PRD entry choice could not be saved.'
    } finally {
      lifecycleChoiceBusy = false
    }
  }

  async function retryEngineeringLifecycle(): Promise<void> {
    const current = engineeringLifecycle
    if (current?.humanGate !== 'terminal_failure' || !current.resumeToken) return
    try {
      engineeringLifecycle = await invoke(
        'engineeringLifecycle:retry',
        thread.projectId,
        thread.id,
        current.resumeToken
      )
      settings = settingsForEngineeringState(engineeringLifecycle)
      await deliver(
        `Retry the persisted ${engineeringLifecycle.activeStage ?? 'Engineering'} stage from its durable state.`,
        []
      )
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'The Engineering stage could not retry.'
    }
  }

  async function selectRemoteLofi(prototypeId: string): Promise<void> {
    const draft = gateBrainstorm
    if (!draft) return
    lifecycleChoiceBusy = true
    try {
      gateBrainstorm = await invoke(
        'agent:reviewBrainstorm',
        draft.projectId,
        draft.threadId,
        draft.id,
        draft.version,
        `Generate one direct HiFi prototype H1 based on selected LoFi prototype ${prototypeId}. Preserve all existing prototypes and aligned Brainstorm content.`
      )
      await refreshEngineeringLifecycle()
    } catch (error) {
      sendError =
        error instanceof Error ? error.message : 'The HiFi prototype could not be generated.'
    } finally {
      lifecycleChoiceBusy = false
    }
  }

  async function finalizeRemoteBrainstorm(): Promise<void> {
    const draft = gateBrainstorm
    if (!draft) return
    lifecycleChoiceBusy = true
    try {
      await invoke(
        'agent:finalizeBrainstorm',
        draft.projectId,
        draft.threadId,
        draft.id,
        draft.version,
        continueWithoutHifi ? 'Continue without HiFi.' : ''
      )
      await refreshEngineeringLifecycle()
      if (engineeringLifecycle?.activeStage === 'prd') {
        await invoke(
          'agent:generatePrd',
          thread.projectId,
          thread.id,
          settings,
          'Continue Run all by generating the PRD from the finalized Brainstorm and project context.',
          [],
          messageId()
        )
        await refreshEngineeringLifecycle()
      }
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'The Brainstorm could not be finalized.'
    } finally {
      lifecycleChoiceBusy = false
    }
  }

  async function continueRemoteLifecycleGate(): Promise<void> {
    const lifecycle = engineeringLifecycle
    if (!lifecycle?.humanGate || !lifecycle.resumeToken) return
    lifecycleChoiceBusy = true
    try {
      if (lifecycle.humanGate === 'prd_finalization') {
        const draft = await invoke('prd:getActive', thread.projectId, thread.id)
        if (!draft) throw new Error('The PRD draft is unavailable.')
        engineeringLifecycle = (
          await invoke(
            'engineeringLifecycle:resume',
            thread.projectId,
            thread.id,
            lifecycle.resumeToken,
            'continue'
          )
        ).state
        await invoke('prd:finalize', draft.projectId, draft.threadId, draft.id, draft.version)
        engineeringLifecycle = await invoke(
          'engineeringLifecycle:complete',
          thread.projectId,
          thread.id,
          'prd'
        )
        if (engineeringLifecycle.activeStage === 'spec') {
          await invoke('agent:ensureInitialSpec', thread.projectId, thread.id)
        }
      } else if (lifecycle.humanGate === 'spec_approval') {
        let draft = await invoke('spec:getActive', thread.projectId, thread.id)
        if (!draft) throw new Error('The Spec draft is unavailable.')
        engineeringLifecycle = (
          await invoke(
            'engineeringLifecycle:resume',
            thread.projectId,
            thread.id,
            lifecycle.resumeToken,
            'continue'
          )
        ).state
        if (draft.status === 'draft') {
          draft = await invoke(
            'spec:setReview',
            draft.projectId,
            draft.threadId,
            draft.id,
            draft.version
          )
        }
        if (draft.status === 'in_review') {
          await invoke('spec:approve', draft.projectId, draft.threadId, draft.id, draft.version)
        }
        engineeringLifecycle = await invoke(
          'engineeringLifecycle:complete',
          thread.projectId,
          thread.id,
          'spec'
        )
        if (engineeringLifecycle.activeStage === 'assignment') {
          await invoke('agent:generateAssignmentDraft', thread.projectId, thread.id, settings)
        }
      } else if (lifecycle.humanGate === 'assignment_approval') {
        engineeringLifecycle = (
          await invoke(
            'engineeringLifecycle:resume',
            thread.projectId,
            thread.id,
            lifecycle.resumeToken,
            'continue'
          )
        ).state
        await invoke('agent:startAssignment', thread.projectId, thread.id)
        if (engineeringLifecycle.autopilot) {
          engineeringLifecycle = await invoke(
            'engineeringLifecycle:complete',
            thread.projectId,
            thread.id,
            'assignment'
          )
        }
      }
      await refreshEngineeringLifecycle()
    } catch (error) {
      sendError =
        error instanceof Error ? error.message : 'The Engineering gate could not continue.'
    } finally {
      lifecycleChoiceBusy = false
    }
  }

  // Auto-scroll to the newest message, and honour history jumps.
  $effect(() => {
    const el = scrollEl
    if (!el) return
    // Track the message list so the effect re-runs when new parts stream in.
    const messageCount = messages.length
    const jump = jumpTarget
    if (jump && jump.nonce !== lastJumpNonce) {
      lastJumpNonce = jump.nonce
      for (const [id, element] of messageElements) {
        if (id === jump.id) {
          el.scrollTop = element.offsetTop - 12
          break
        }
      }
      return
    }
    if (userScrolledAway) return
    el.scrollTop = el.scrollHeight
    void messageCount
  })

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

  function turnEndIndex(startIndex: number): number {
    let endIndex = startIndex
    while (endIndex + 1 < messages.length && messages[endIndex + 1]?.role === 'assistant') {
      endIndex += 1
    }
    return endIndex
  }

  function turnFinalText(startIndex: number): Extract<AgentPart, { type: 'text' }> | undefined {
    let final: Extract<AgentPart, { type: 'text' }> | undefined
    const endIndex = turnEndIndex(startIndex)
    for (let index = startIndex; index <= endIndex; index += 1) {
      for (const part of messages[index]?.parts ?? []) {
        if (part.type === 'text') final = part
      }
    }
    return final
  }

  /** One ordered trace per user turn, matching the desktop grouping boundary. */
  function turnTraceParts(startIndex: number, includeCurrentFinal = false): AgentPart[] {
    const final = turnFinalText(startIndex)
    const parts: AgentPart[] = []
    const endIndex = turnEndIndex(startIndex)
    for (let index = startIndex; index <= endIndex; index += 1) {
      for (const part of messages[index]?.parts ?? []) {
        if (part.type === 'question') continue
        if (
          part.type === 'text' &&
          part.id === final?.id &&
          (!includeCurrentFinal || part.phase === 'final_answer')
        )
          continue
        if (isTodoToolPart(part)) continue
        parts.push(part)
      }
    }
    return parts
  }

  function turnFiles(startIndex: number): Extract<AgentPart, { type: 'file' }>[] {
    const files: Extract<AgentPart, { type: 'file' }>[] = []
    const endIndex = turnEndIndex(startIndex)
    for (let index = startIndex; index <= endIndex; index += 1) {
      files.push(...fileParts(messages[index]))
    }
    return files
  }

  function turnStartTime(startIndex: number): number | undefined {
    const preceding = messages[startIndex - 1]
    return preceding?.role === 'user' ? preceding.createdAt : messages[startIndex]?.createdAt
  }

  function turnAttribution(startIndex: number): AgentMessage {
    const endIndex = turnEndIndex(startIndex)
    for (let index = endIndex; index >= startIndex; index -= 1) {
      const message = messages[index]
      if (message?.modelId || message?.providerId || message?.harnessId) return message
    }
    return messages[startIndex]
  }

  function modelLabel(message: AgentMessage): string | null {
    if (!message.modelId) return null
    const allModels = providers.flatMap((provider) => provider.models)
    const model =
      allModels.find(
        (model) =>
          model.id === message.modelId &&
          (!message.providerId || model.providerId === message.providerId)
      ) ?? allModels.find((model) => model.id === message.modelId)
    if (model) return model.name
    // Fast variants may be absent from harness catalogs — fall back to a derived label.
    return fastVariantForModelId(message.modelId)?.label ?? message.modelId
  }

  /** Thinking level used for the turn, mirroring desktop's messageThinkingLevel. */
  function turnThinkingLevel(message: AgentMessage): ThinkingLevel | null {
    if (!message.modelId) return null
    const allModels = providers.flatMap((provider) => provider.models)
    const model =
      allModels.find(
        (candidate) =>
          candidate.id === message.modelId &&
          (!message.providerId || candidate.providerId === message.providerId)
      ) ?? allModels.find((candidate) => candidate.id === message.modelId)
    const presets = model?.thinkingPresets ?? []
    // A model known not to reason never shows a thinking badge.
    if (model && presets.length === 0) return null
    if (message.thinkingLevel) return message.thinkingLevel
    if (presets.length === 0) return null
    return resolveDefaultThinkingLevel(presets, undefined, settings.thinkingLevel) ?? null
  }

  function providerName(message: AgentMessage): string | null {
    if (!message.providerId) return null
    return (
      providers.find((provider) => provider.id === message.providerId)?.name ?? message.providerId
    )
  }

  function harnessId(message: AgentMessage): string {
    return message.harnessId ?? settings.harnessId
  }

  function harnessName(message: AgentMessage): string {
    const id = harnessId(message)
    return getAgentIcon(id)?.name ?? id
  }

  function localIssue(message: string, retryable: boolean): AgentProviderIssue {
    return {
      kind: 'unknown',
      message,
      rawError: message,
      harnessId: settings.harnessId,
      retryable
    }
  }

  let visibleErrorStatus = $derived.by<Extract<AgentSessionStatus, { state: 'error' }> | null>(
    () => {
      if (runIssue) return { state: 'error', issue: runIssue }
      if (sendError) {
        return { state: 'error', issue: localIssue(sendError, failedDelivery !== null) }
      }
      if (loadError) return { state: 'error', issue: localIssue(loadError, true) }
      return null
    }
  )
  let errorProviderName = $derived(
    visibleErrorStatus
      ? (getAgentIcon(visibleErrorStatus.issue.harnessId)?.name ??
          visibleErrorStatus.issue.harnessId)
      : settings.harnessId
  )

  function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  }

  let copiedMessageId = $state<string | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined
  let forkingMessageId = $state<string | null>(null)
  let openingAttachmentId = $state<string | null>(null)
  let previewAttachment = $state<PromptAttachment | null>(null)
  let previewSrc = $state<string>()
  let previewText = $state<string>()

  function attachmentName(part: Extract<AgentPart, { type: 'file' }>): string {
    return part.filename ?? part.url.split(/[/\\]/u).pop() ?? 'file'
  }

  function closeAttachmentPreview(): void {
    if (previewSrc) URL.revokeObjectURL(previewSrc)
    previewAttachment = null
    previewSrc = undefined
    previewText = undefined
  }

  async function openAttachment(part: Extract<AgentPart, { type: 'file' }>): Promise<void> {
    if (openingAttachmentId) return
    openingAttachmentId = part.id
    try {
      const filename = attachmentName(part)
      const bytes = await window.api.readFile(fileUrlToPath(part.url))
      const kind = attachmentPreviewKind(part.mime, filename)
      closeAttachmentPreview()
      previewAttachment = { mime: part.mime, url: part.url, filename }
      if (kind === 'markdown' || kind === 'text' || kind === 'csv') {
        previewText = new TextDecoder().decode(bytes)
      } else {
        previewSrc = URL.createObjectURL(
          new Blob([bytes], { type: part.mime || 'application/octet-stream' })
        )
      }
    } catch (error) {
      failedDelivery = null
      sendError = error instanceof Error ? error.message : 'The attachment could not be opened.'
    } finally {
      openingAttachmentId = null
    }
  }

  async function copyTurn(
    message: AgentMessage,
    final: Extract<AgentPart, { type: 'text' }>
  ): Promise<void> {
    try {
      await copyText(final.text)
      copiedMessageId = message.id
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copiedMessageId = null), 1_500)
    } catch {
      failedDelivery = null
      sendError = 'The response could not be copied to the clipboard.'
    }
  }

  async function forkFromMessage(message: AgentMessage): Promise<void> {
    if (forkingMessageId) return
    forkingMessageId = message.id
    try {
      const forked = await invoke(
        'thread:fork',
        thread.projectId,
        thread.id,
        `${thread.title} (fork)`,
        undefined,
        message.id
      )
      await mobileState.openThread(forked)
    } catch (error) {
      failedDelivery = null
      sendError = error instanceof Error ? error.message : 'The thread could not be forked.'
    } finally {
      forkingMessageId = null
    }
  }

  onDestroy(() => {
    clearTimeout(copyResetTimer)
    if (previewSrc) URL.revokeObjectURL(previewSrc)
  })

  // ─── Sending, queued "start after" dependencies, and abort ──────────────
  let queuedMessage = $state<{
    text: string
    attachments: PromptAttachment[]
    startAfterThreads: StartAfterSelection[]
    promptContext?: string
    promptReferences?: PromptReference[]
  } | null>(null)

  async function deliver(
    text: string,
    attachments: PromptAttachment[],
    promptContext?: string,
    promptReferences?: PromptReference[]
  ): Promise<void> {
    sendError = ''
    const userMessageId = messageId()
    userScrolledAway = false
    agentRuns.setBusy(thread.projectId, thread.id, true, userMessageId)
    if (chatMode) {
      chatSettings.commit(settings)
    } else {
      threadSettings.commit(settings)
    }
    try {
      if (
        !chatMode &&
        engineeringLifecycle !== null &&
        engineeringLifecycle?.selection !== 'none' &&
        engineeringLifecycle?.activeStage === undefined &&
        engineeringLifecycle?.humanGate === undefined
      ) {
        engineeringLifecycle = (
          await invoke('engineeringLifecycle:start', thread.projectId, thread.id)
        ).state
      }
      if (engineeringLifecycle?.activeStage === 'prd' && prdWorkflow?.stage !== 'drafting') {
        prdWorkflow = await invoke('prd:ensureWorkflow', thread.projectId, thread.id)
        if (prdWorkflow?.stage === 'choice_pending' || prdWorkflow?.stage === 'brainstorming') {
          failedDelivery = null
          agentRuns.setIdle(thread.projectId, thread.id)
          return
        }
      }
      if (engineeringLifecycle?.activeStage === 'prd' && prdWorkflow?.stage === 'drafting') {
        await invoke(
          'agent:generatePrd',
          thread.projectId,
          thread.id,
          settings,
          text,
          attachments,
          userMessageId
        )
        failedDelivery = null
        engineeringLifecycle = await invoke('engineeringLifecycle:get', thread.projectId, thread.id)
        prdWorkflow = await invoke('prd:getWorkflow', thread.projectId, thread.id)
        agentRuns.setIdle(thread.projectId, thread.id)
        return
      }
      if (engineeringLifecycle?.activeStage === 'assignment') {
        await invoke('agent:generateAssignmentDraft', thread.projectId, thread.id, settings)
        failedDelivery = null
        engineeringLifecycle = await invoke('engineeringLifecycle:get', thread.projectId, thread.id)
        agentRuns.setIdle(thread.projectId, thread.id)
        return
      }
      const sessionId = await invoke('agent:ensureSession', thread.projectId, thread.id)
      threadMessages.setSessionId(thread.projectId, thread.id, sessionId)
      await threadMessages.send(
        thread.projectId,
        thread.id,
        settings,
        text,
        attachments,
        engineeringLifecycle?.activeStage === 'achievement' ? 'implement' : undefined,
        userMessageId,
        undefined,
        promptContext,
        promptReferences
      )
      failedDelivery = null
      if (!chatMode) {
        engineeringLifecycle = await invoke('engineeringLifecycle:get', thread.projectId, thread.id)
        prdWorkflow = await invoke('prd:getWorkflow', thread.projectId, thread.id)
      }
    } catch (error) {
      agentRuns.setIdle(thread.projectId, thread.id)
      failedDelivery = { text, attachments }
      sendError = error instanceof Error ? error.message : 'The message could not be sent.'
    }
  }

  async function retryVisibleError(): Promise<void> {
    if (errorRetrying) return
    errorRetrying = true
    try {
      if (loadError && !runIssue && !sendError) {
        await threadMessages.load(thread.projectId, thread.id)
        return
      }
      if (sendError && failedDelivery) {
        const failed = failedDelivery
        await deliver(failed.text, failed.attachments)
        return
      }
      await deliver('Continue', [])
    } finally {
      errorRetrying = false
    }
  }

  async function dismissVisibleError(): Promise<void> {
    if (runIssue) {
      try {
        await invoke(
          'agent:dismissSessionError',
          thread.projectId,
          thread.id,
          thread.sessionId ?? ''
        )
        threadMessages.setRunIssue(thread.projectId, thread.id, null)
      } catch {
        // Keep the actionable card visible when the desktop cannot dismiss it.
      }
      return
    }
    if (sendError) {
      sendError = ''
      failedDelivery = null
      return
    }
    threadMessages.clearLoadError(thread.projectId, thread.id)
  }

  /** Once every dependency thread this message waits on goes idle, deliver it. */
  $effect(() => {
    const pending = queuedMessage
    if (!pending || pending.startAfterThreads.length === 0) return
    const stillBusy = pending.startAfterThreads.some((dep) =>
      agentRuns.hasSettled(thread.projectId, dep.id)
        ? agentRuns.isBusy(thread.projectId, dep.id)
        : false
    )
    if (stillBusy) return
    const pendingDelivery = pending
    queuedMessage = null
    void deliver(
      pendingDelivery.text,
      pendingDelivery.attachments,
      pendingDelivery.promptContext,
      pendingDelivery.promptReferences
    )
  })

  /** Toolbox presentation mirrors the staged selection so switches flip
   *  immediately, while every side effect stays deferred until the send. */
  const pendingLifecycleDisplay = $derived.by((): EngineeringLifecycleState | null => {
    const pending = pendingLifecycleSelection
    const base = engineeringLifecycle
    if (!pending) return base
    const autopilot = pending.autopilot === true
    const selectedStages = autopilot ? [] : normalizeLifecycleStages(pending.stages)
    return {
      projectId: base?.projectId ?? thread.projectId,
      threadId: base?.threadId ?? thread.id,
      selection: representativeLifecycleSelection(selectedStages, autopilot),
      selectedStages,
      autopilot,
      completedStages: base?.completedStages ?? [],
      ...(base?.activeStage ? { activeStage: base.activeStage } : {}),
      ...(base?.humanGate ? { humanGate: base.humanGate } : {}),
      ...(base?.failure ? { failure: base.failure } : {}),
      ...(base?.startedAt ? { startedAt: base.startedAt } : {}),
      updatedAt: base?.updatedAt ?? Date.now()
    }
  })

  function handleSend(
    text: string,
    attachments: PromptAttachment[],
    direct?: boolean,
    _projectReferences?: unknown,
    _taskReferences?: unknown,
    startAfterThreads?: StartAfterSelection[]
  ): void {
    const msg = text.trim()
    if (!msg && attachments.length === 0) return
    composerRestore = null
    const promptContext = selectionReferenceContext()
    const promptReferences = selectionReferences.length > 0 ? [...selectionReferences] : undefined
    clearSelectionReferences()
    const dependencies = (startAfterThreads ?? []).filter((dep) => dep.id !== thread.id)
    // Commit any staged Toolbox choice before routing the send: the user is
    // actually sending now, so the choice applies (or asks for confirmation)
    // because it will steer this message — never at toggle time.
    void (async () => {
      const staged = pendingLifecycleSelection
      if (staged) {
        if (
          engineeringLifecycle &&
          (engineeringLifecycle.activeStage !== undefined ||
            engineeringLifecycle.humanGate !== undefined)
        ) {
          // Keep the staged choice — confirmLifecycleReplacement reads it.
          guardedSend = {
            text: msg,
            attachments,
            promptContext: promptContext ?? undefined,
            promptReferences: promptReferences ?? undefined
          }
          composerRestore = { text: msg, attachments }
          composerRestoreKey += 1
          lifecycleGuardOpen = true
          return
        }
        pendingLifecycleSelection = null
        await applyLifecycleSelection(staged)
      }
      if (dependencies.length > 0 || (busy && !direct)) {
        queuedMessage = {
          text: msg,
          attachments,
          startAfterThreads: dependencies,
          promptContext,
          promptReferences
        }
        return
      }
      await deliver(msg, attachments, promptContext, promptReferences)
    })()
  }

  async function abortRun(): Promise<void> {
    if (!busy) return
    try {
      await invoke('agent:abort', thread.projectId, thread.id)
      agentRuns.setIdle(thread.projectId, thread.id)
    } catch (error) {
      failedDelivery = null
      sendError = error instanceof Error ? error.message : 'The request could not be stopped.'
    }
  }

  // ─── Subagent drill-in sheet ──────────────────────────────────────────
  let openSubagentTab = $state<SubagentContextTab | null>(null)

  function openSubagent(part: Extract<AgentPart, { type: 'subagent' }>): void {
    openSubagentTab = {
      id: part.id,
      kind: 'subagent',
      title: part.activity.description || part.activity.agent || 'Subagent',
      projectId: thread.projectId,
      threadId: thread.id,
      sourcePartId: part.id,
      activity: part.activity
    }
  }

  // ─── Response selection → references & temporary chats ────────────────
  // Mirrors desktop's ThreadView: selecting text inside an assistant response
  // offers "Add to chat" (reference the excerpt in the next prompt) and the
  // temporary read-only chats ("Explain" / "Quick chat").
  interface MobileResponseSelection {
    text: string
    messageId: string
    x: number
    y: number
  }

  let responseSelection = $state<MobileResponseSelection | null>(null)
  let selectionReferences = $state<PromptReference[]>([])

  function messageElementFor(node: Node | null): HTMLElement | null {
    let current = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
    while (current) {
      if (current.dataset.messageId) return current
      current = current.parentElement
    }
    return null
  }

  function captureResponseSelection(): void {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      responseSelection = null
      return
    }
    const anchorResponse = messageElementFor(selection.anchorNode)
    const focusResponse = messageElementFor(selection.focusNode)
    const anchorId = anchorResponse?.dataset.messageId
    if (!anchorResponse || anchorResponse !== focusResponse || !anchorId) {
      responseSelection = null
      return
    }
    const message = messages.find((candidate) => candidate.id === anchorId)
    if (!message || message.role !== 'assistant') {
      responseSelection = null
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      responseSelection = null
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const estimatedWidth = 320
    const estimatedHeight = 48
    const x = Math.max(
      12,
      Math.min(
        rect.left + rect.width / 2 - estimatedWidth / 2,
        window.innerWidth - estimatedWidth - 12
      )
    )
    const y =
      rect.top - estimatedHeight >= 12
        ? rect.top - estimatedHeight
        : Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - estimatedHeight - 8))
    responseSelection = { text, messageId: anchorId, x, y }
  }

  function closeResponseSelection(): void {
    responseSelection = null
    document.getSelection()?.removeAllRanges()
  }

  function addSelectionReference(): void {
    const selection = responseSelection
    if (!selection) return
    selectionReferences = [
      ...selectionReferences,
      {
        id: crypto.randomUUID(),
        label: `Selection ${selectionReferences.length + 1}`,
        text: selection.text
      }
    ]
    closeResponseSelection()
  }

  function removeSelectionReference(id: string): void {
    selectionReferences = selectionReferences.filter((reference) => reference.id !== id)
  }

  function clearSelectionReferences(): void {
    selectionReferences = []
  }

  function selectionReferenceContext(): string | undefined {
    if (selectionReferences.length === 0) return undefined
    return [
      'The user attached these excerpts from your earlier response as references:',
      ...selectionReferences.map(
        (reference) => `[${reference.label}]\n<selection>\n${reference.text}\n</selection>`
      )
    ].join('\n\n')
  }

  /** Full-transcript context for a temporary chat, matching desktop. */
  function temporaryConversationContext(): string {
    return messages
      .map((message) => {
        const text = textFor(message).trim()
        return text ? `${message.role.toUpperCase()}: ${text}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(-80_000)
  }

  function openTemporarySelectionChat(mode: 'elaborate' | 'quick'): void {
    const selection = responseSelection
    if (!selection) return
    const tab = contextSidebarState.openTemporaryChat(
      thread.projectId,
      thread.id,
      mode,
      selection.text,
      temporaryConversationContext(),
      settings,
      true,
      mode === 'elaborate' ? EXPLAIN_SELECTION_PROMPT : undefined
    )
    mobileState.openTemporaryChatTab(tab.id)
    closeResponseSelection()
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div
    {@attach captureScrollElement}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
    onscroll={onScroll}
  >
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {#if !loaded && loading}
        <div class="flex items-center gap-2 px-2 text-sm text-muted">
          <Loader2 size={15} class="animate-spin" />
          Loading conversation…
        </div>
      {:else if messages.length === 0}
        <div class="flex flex-col items-center gap-2 px-2 py-12 text-center">
          <p class="text-sm text-muted">No messages yet</p>
          <p class="max-w-64 text-[13px] leading-relaxed text-dimmed">
            Send a message to get started with this {chatMode ? 'chat' : 'thread'}.
          </p>
        </div>
      {:else}
        {#each messages as message, index (message.id)}
          {@const text = textFor(message)}
          {@const files = fileParts(message)}
          {#if message.role === 'user'}
            <div
              {@attach registerMessageElement}
              class="group flex flex-col gap-1.5"
              data-message-id={message.id}
            >
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-2xl bg-surface px-3.5 py-2.5">
                  {#if files.length > 0}
                    <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {#each files as part (part.id)}
                        <button
                          type="button"
                          class="flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg bg-elevated px-2 text-[11px] text-muted transition-colors active:bg-overlay active:text-foreground disabled:cursor-wait disabled:opacity-60"
                          title={`Open ${attachmentName(part)}`}
                          aria-label={`Open attachment ${attachmentName(part)}`}
                          disabled={openingAttachmentId !== null}
                          onclick={() => void openAttachment(part)}
                        >
                          {#if openingAttachmentId === part.id}
                            <Loader2 size={11} class="shrink-0 animate-spin" />
                          {:else}
                            <FileText size={11} class="shrink-0" />
                          {/if}
                          <span class="max-w-40 truncate">{attachmentName(part)}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if text}
                    <div class="text-sm text-foreground">
                      <MarkdownView {text} />
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {:else if index === 0 || messages[index - 1]?.role === 'user'}
            {@const endIndex = turnEndIndex(index)}
            {@const endMessage = messages[endIndex]}
            {@const final = turnFinalText(index)}
            {@const turnBusy = busy && endIndex === messages.length - 1}
            {@const trace = turnTraceParts(index, turnBusy)}
            {@const assistantFiles = turnFiles(index)}
            {@const attribution = turnAttribution(index)}
            {@const isLatestAssistantTurn = messages
              .slice(endIndex + 1)
              .every((candidate) => candidate.role === 'user')}
            {@const turnDone = endMessage.completedAt !== undefined || !turnBusy}
            {@const model = modelLabel(attribution)}
            {@const thinking = turnThinkingLevel(attribution)}
            <div
              {@attach registerMessageElement}
              class="group flex flex-col gap-1.5"
              data-message-id={message.id}
            >
              <div class="flex flex-col gap-1.5">
                {#if trace.length > 0}
                  <WorkingTrace
                    parts={trace}
                    open={turnBusy}
                    busy={turnBusy}
                    latest={isLatestAssistantTurn}
                    done={turnDone}
                    startTime={turnStartTime(index)}
                    modelLabel={modelLabel(attribution)}
                    thinkingLevel={attribution.thinkingLevel ?? settings.thinkingLevel}
                    providerName={providerName(attribution)}
                    harnessId={harnessId(attribution)}
                    harnessName={harnessName(attribution)}
                    projectId={thread.projectId}
                    threadId={thread.id}
                    onOpenSubagent={openSubagent}
                  />
                {/if}
                {#if final && !turnBusy}
                  {@const isReadingRemote =
                    'messageId' in speechController.playback &&
                    speechController.playback.messageId === endMessage.id &&
                    (speechController.playback.state === 'preparing' ||
                      speechController.playback.state === 'playing' ||
                      speechController.playback.state === 'paused')}
                  {#if isReadingRemote && speechController.activeSegments && speechController.activeSegments.length > 0 && speechController.readingOverlayActive}
                    {@const segs = speechController.activeSegments}
                    {@const activeIdx = speechController.visibleSegmentIndex}
                    <div class="flex flex-col gap-1.5 text-sm text-foreground">
                      {#each segs as seg, i (seg.id)}
                        <div
                          class={i === activeIdx
                            ? 'rounded-md border border-dashed border-info/40 bg-info/5 px-2.5 py-1.5 transition-colors'
                            : 'px-2.5 py-1 opacity-80'}
                          data-speech-line={i === activeIdx ? 'active' : undefined}
                        >
                          <span class="leading-relaxed">{seg.text}</span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <div
                      class={isReadingRemote && speechController.playback.state === 'preparing'
                        ? 'rounded-lg border border-dashed border-info/40 bg-info/5 p-3 text-sm text-foreground transition-colors'
                        : 'text-sm text-foreground'}
                    >
                      <MarkdownView text={final.text} />
                    </div>
                  {/if}
                {/if}
                {#if assistantFiles.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each assistantFiles as part (part.id)}
                      <button
                        type="button"
                        class="flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-lg bg-elevated px-2 text-[11px] text-muted transition-colors active:bg-overlay active:text-foreground disabled:cursor-wait disabled:opacity-60"
                        title={`Open ${attachmentName(part)}`}
                        aria-label={`Open attachment ${attachmentName(part)}`}
                        disabled={openingAttachmentId !== null}
                        onclick={() => void openAttachment(part)}
                      >
                        {#if openingAttachmentId === part.id}
                          <Loader2 size={11} class="shrink-0 animate-spin" />
                        {:else}
                          <FileText size={11} class="shrink-0" />
                        {/if}
                        <span class="max-w-40 truncate">{attachmentName(part)}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
                {#if turnBusy && trace.length === 0}
                  <div class="flex items-center gap-2 text-xs text-dimmed">
                    <Loader2 size={13} class="animate-spin" />
                    Working…
                  </div>
                {/if}
                {#if turnDone && !turnBusy && final}
                  <div class="mt-1 flex min-h-8 items-center gap-1 text-dimmed">
                    {#if final}
                      <button
                        type="button"
                        class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors active:bg-elevated active:text-foreground"
                        aria-label="Copy agent response"
                        title="Copy"
                        onclick={() => void copyTurn(endMessage, final)}
                      >
                        {#if copiedMessageId === endMessage.id}
                          <Check size={14} class="text-success" />
                        {:else}
                          <Copy size={14} />
                        {/if}
                      </button>
                    {/if}
                    <SpeechPlaybackButton
                      messageId={endMessage.id}
                      markdown={final.text}
                      scope={{ kind: 'project', projectId: thread.projectId, threadId: thread.id }}
                    />
                    <button
                      type="button"
                      class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors active:bg-elevated active:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Fork thread from this response"
                      title="Fork from here"
                      disabled={forkingMessageId !== null}
                      onclick={() => void forkFromMessage(endMessage)}
                    >
                      {#if forkingMessageId === endMessage.id}
                        <Loader2 size={14} class="animate-spin" />
                      {:else}
                        <GitFork size={14} />
                      {/if}
                    </button>
                    <span class="ml-1 flex min-w-0 items-center gap-1 truncate text-[10px]">
                      <span class="truncate">
                        {harnessName(attribution)}{#if providerName(attribution)}
                          · {providerName(attribution)}{/if}{#if model}
                          · {model}{/if}
                      </span>
                      {#if thinking}
                        <span
                          class="flex shrink-0 items-center gap-0.5 rounded-md bg-elevated px-1.5 py-0.5 text-[9px] capitalize text-muted"
                          title={`Thinking level: ${thinking}`}
                          aria-label={`Thinking level: ${thinking}`}
                        >
                          <Brain size={9} />
                          {thinking}
                        </span>
                      {/if}
                      {#if endMessage.completedAt && turnStartTime(index)}
                        <span class="shrink-0 tabular-nums">
                          · {formatDuration(endMessage.completedAt - (turnStartTime(index) ?? 0))}
                        </span>
                      {/if}
                    </span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      {/if}

      {#if busy && messages[messages.length - 1]?.role === 'user'}
        <div class="flex items-center gap-2 text-xs text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Working…
        </div>
      {/if}

      {#if queuedMessage}
        <p class="rounded-xl border border-border bg-elevated px-3 py-2 text-[12px] text-dimmed">
          Queued — will send once {queuedMessage.startAfterThreads.length === 1
            ? 'the selected thread finishes'
            : 'the selected threads finish'}.
        </p>
      {/if}
    </div>
  </div>

  <div
    class="relative shrink-0 border-t border-border bg-surface px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2"
  >
    {#if userScrolledAway}
      <button
        type="button"
        class="absolute -top-12 left-1/2 z-40 flex h-10 w-10 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-muted shadow-md transition-colors active:bg-elevated active:text-foreground"
        title="Scroll to latest message"
        aria-label="Scroll to latest message"
        onclick={scrollToLatest}
      >
        <ChevronDown size={19} />
      </button>
    {/if}
    {#if visibleErrorStatus}
      <div class="mb-2">
        <AgentProviderStatusCard
          status={visibleErrorStatus}
          providerName={errorProviderName}
          retrying={errorRetrying}
          retryLabel={loadError && !runIssue && !sendError ? 'Retry loading' : 'Retry'}
          onRetry={visibleErrorStatus.issue.retryable ? retryVisibleError : undefined}
          onDismiss={dismissVisibleError}
        />
      </div>
    {/if}
    {#if selectionReferences.length > 0}
      <div class="flex flex-wrap gap-1.5 px-1 pb-1.5">
        {#each selectionReferences as reference (reference.id)}
          <span
            class="flex max-w-full items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted"
            title={reference.text}
          >
            <MessageSquareDashed size={11} class="shrink-0" />
            <span class="max-w-40 truncate">{reference.label}</span>
            <button
              type="button"
              class="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors active:text-danger"
              title="Remove {reference.label}"
              aria-label="Remove {reference.label}"
              onclick={() => removeSelectionReference(reference.id)}
            >
              <X size={11} />
            </button>
          </span>
        {/each}
      </div>
    {/if}
    {#if !chatMode && hasSelectedStage(engineeringLifecycle, 'prd') && prdWorkflow?.stage === 'choice_pending'}
      <div class="px-1 pb-2">
        <EngineeringEntryCard
          target="prd"
          busy={lifecycleChoiceBusy}
          onBrainstormFirst={() => choosePrdEntry('brainstorm_first')}
          onJumpIn={() => choosePrdEntry('start_prd')}
        />
      </div>
    {/if}
    {#if !chatMode && engineeringLifecycle?.humanGate && engineeringLifecycle.humanGate !== 'terminal_failure'}
      <section class="mx-1 mb-2 rounded-2xl border bg-surface p-4 shadow-sm">
        <h2 class="text-sm font-semibold text-foreground">Engineering review</h2>
        {#if engineeringLifecycle.humanGate === 'prototype_selection' && !continueWithoutHifi}
          <p class="mt-1 text-xs leading-5 text-muted">
            Choose a LoFi direction for H1, or continue to Brainstorm sign-off without HiFi.
          </p>
          <div class="mt-3 grid gap-2">
            {#each gateBrainstorm?.content.prototypes?.filter((prototype) => prototype.fidelity === 'lofi') ?? [] as prototype (prototype.id)}
              <button
                type="button"
                class="rounded-xl bg-thread-spec px-3 py-2.5 text-left text-xs font-medium text-foreground disabled:opacity-50"
                disabled={lifecycleChoiceBusy}
                onclick={() => void selectRemoteLofi(prototype.id)}
              >
                Build HiFi from {prototype.id} · {prototype.title}
              </button>
            {/each}
            <button
              type="button"
              class="rounded-xl border px-3 py-2.5 text-left text-xs font-medium text-foreground disabled:opacity-50"
              disabled={lifecycleChoiceBusy}
              onclick={() => (continueWithoutHifi = true)}
            >
              Continue without HiFi
            </button>
          </div>
        {:else if engineeringLifecycle.humanGate === 'brainstorm_finalization' || continueWithoutHifi}
          <p class="mt-1 text-xs leading-5 text-muted">
            Finalize the reviewed Brainstorm to continue the persisted lifecycle.
          </p>
          <button
            type="button"
            class="mt-3 w-full rounded-xl bg-thread-spec px-3 py-2.5 text-xs font-medium text-foreground disabled:opacity-50"
            disabled={lifecycleChoiceBusy || !gateBrainstorm}
            onclick={() => void finalizeRemoteBrainstorm()}
          >
            Finalize Brainstorm
          </button>
        {:else}
          <p class="mt-1 text-xs leading-5 text-muted">
            {engineeringLifecycle.humanGate === 'prd_finalization'
              ? 'Finalize the reviewed PRD.'
              : engineeringLifecycle.humanGate === 'spec_approval'
                ? 'Approve the reviewed Spec without starting implementation early.'
                : 'Approve the Assignment and start its workers.'}
          </p>
          <button
            type="button"
            class="mt-3 w-full rounded-xl bg-thread-spec px-3 py-2.5 text-xs font-medium text-foreground disabled:opacity-50"
            disabled={lifecycleChoiceBusy}
            onclick={() => void continueRemoteLifecycleGate()}
          >
            {engineeringLifecycle.humanGate === 'prd_finalization'
              ? 'Finalize PRD'
              : engineeringLifecycle.humanGate === 'spec_approval'
                ? 'Approve Spec'
                : 'Approve Assignment'}
          </button>
        {/if}
      </section>
    {/if}
    {#key composerRestoreKey}
      <ChatComposer
        onSend={handleSend}
        working={busy}
        onStop={abortRun}
        placeholder={busy
          ? `${chatMode ? 'Chat' : 'Agent'} is working — type to queue`
          : 'Message…'}
        {settings}
        onSettingsChange={updateSettings}
        {providers}
        harnessId={settings.harnessId}
        projectId={thread.projectId}
        threadId={thread.id}
        attachmentStorage={{
          kind: chatMode ? 'chat' : 'project',
          projectId: thread.projectId,
          threadId: thread.id
        }}
        contextUsage={thread.contextUsage}
        hideUsageIndicator
        hidePermissionSelector={chatMode}
        showEngineeringMode={!chatMode}
        engineeringLifecycle={pendingLifecycleDisplay}
        onEngineeringLifecycleSelect={selectEngineeringLifecycle}
        onEngineeringLifecycleRetry={retryEngineeringLifecycle}
        showChatModes={false}
        initialStartAfterThreads={queuedMessage?.startAfterThreads}
        initialValue={composerRestore?.text ?? ''}
        initialAttachments={composerRestore?.attachments ?? []}
      />
    {/key}
  </div>
</div>

<EngineeringFlowCancelModal
  open={lifecycleGuardOpen}
  title="Replace Engineering work?"
  message="Generated documents and prototype artifacts will be preserved. Confirm before changing the active lifecycle run."
  oncancel={() => {
    lifecycleGuardOpen = false
    // The staged Toolbox choice stays staged (deliberate toggle); only the
    // parked send is discarded — its draft was restored into the composer.
    guardedSend = null
  }}
  onconfirm={confirmLifecycleReplacement}
/>

{#if openSubagentTab}
  {@const tab = openSubagentTab}
  <BottomSheet open title={tab.title} onClose={() => (openSubagentTab = null)} fixedHeight>
    {#await import('../threads/SubagentSessionView.svelte') then { default: SubagentSessionView }}
      <SubagentSessionView {tab} onOpenSubagent={openSubagent} />
    {/await}
  </BottomSheet>
{/if}

{#if responseSelection}
  <ResponseSelectionPopover
    text={responseSelection.text}
    x={responseSelection.x}
    y={responseSelection.y}
    onAdd={addSelectionReference}
    onElaborate={() => openTemporarySelectionChat('elaborate')}
    onQuickChat={() => openTemporarySelectionChat('quick')}
    onClose={closeResponseSelection}
  />
{/if}

{#if previewAttachment}
  <AttachmentPreview
    attachment={previewAttachment}
    src={previewSrc}
    text={previewText}
    onClose={closeAttachmentPreview}
  />
{/if}
