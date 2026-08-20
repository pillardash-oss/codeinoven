<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'
  import { Check, ChevronDown, Copy, FileText, GitFork, Loader2, RefreshCw } from '@lucide/svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import {
    threadSettings,
    chatSettings,
    chatEffectiveSettings
  } from '$lib/stores/thread-settings.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { messageId } from '$shared/id'
  import { isTodoToolPart } from '$lib/agent-todos'
  import { copyText } from '$lib/copy-text'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { mobileState } from '$lib/remote/mobile-state.svelte'
  import ChatComposer from '../chats/ChatComposer.svelte'
  import WorkingTrace from '../threads/WorkingTrace.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import BottomSheet from '../ui/BottomSheet.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    AgentMessage,
    AgentPart,
    PromptAttachment,
    Thread,
    ThreadSettings
  } from '$shared/types'

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
  let runError = $derived(threadMessages.runError(thread.projectId, thread.id))
  let busy = $derived(agentRuns.isBusy(thread.projectId, thread.id))

  let sendError = $state('')
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

  // Provider/model catalog — hydrate this project's catalog if it hasn't
  // been fetched yet (desktop's App.svelte seeds every project at startup;
  // mobile only ever opens one project's threads at a time).
  let providers = $derived(providerCatalog.cached(thread.projectId) ?? [])
  onMount(() => {
    if (!providerCatalog.cached(thread.projectId)) {
      void providerCatalog.refresh(thread.projectId)
    }
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

  function turnError(startIndex: number): string {
    const endIndex = turnEndIndex(startIndex)
    for (let index = endIndex; index >= startIndex; index -= 1) {
      const error = messages[index]?.error
      if (error) return error
    }
    return ''
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
    return (
      providers.flatMap((provider) => provider.models).find((model) => model.id === message.modelId)
        ?.name ?? message.modelId
    )
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
      sendError = error instanceof Error ? error.message : 'The thread could not be forked.'
    } finally {
      forkingMessageId = null
    }
  }

  onDestroy(() => clearTimeout(copyResetTimer))

  // ─── Sending, queued "start after" dependencies, and abort ──────────────
  let queuedMessage = $state<{
    text: string
    attachments: PromptAttachment[]
    startAfterThreads: StartAfterSelection[]
  } | null>(null)

  async function deliver(text: string, attachments: PromptAttachment[]): Promise<void> {
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
      const sessionId = await invoke('agent:ensureSession', thread.projectId, thread.id)
      threadMessages.setSessionId(thread.projectId, thread.id, sessionId)
      await threadMessages.send(
        thread.projectId,
        thread.id,
        settings,
        text,
        attachments,
        undefined,
        userMessageId
      )
    } catch (error) {
      agentRuns.setIdle(thread.projectId, thread.id)
      sendError = error instanceof Error ? error.message : 'The message could not be sent.'
    }
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
    queuedMessage = null
    void deliver(pending.text, pending.attachments)
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
    const dependencies = (startAfterThreads ?? []).filter((dep) => dep.id !== thread.id)
    if (dependencies.length > 0 || (busy && !direct)) {
      queuedMessage = { text: msg, attachments, startAfterThreads: dependencies }
      return
    }
    void deliver(msg, attachments)
  }

  async function abortRun(): Promise<void> {
    if (!busy) return
    try {
      await invoke('agent:abort', thread.projectId, thread.id)
      agentRuns.setIdle(thread.projectId, thread.id)
    } catch (error) {
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
          <div
            {@attach registerMessageElement}
            class="group flex flex-col gap-1.5"
            data-message-id={message.id}
          >
            {#if message.role === 'user'}
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-2xl bg-surface px-3.5 py-2.5">
                  {#if files.length > 0}
                    <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {#each files as part (part.id)}
                        <span
                          class="flex max-w-full items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted"
                          title={part.filename ?? part.url}
                        >
                          <FileText size={11} class="shrink-0" />
                          <span class="max-w-40 truncate"
                            >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                          >
                        </span>
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
            {:else if index === 0 || messages[index - 1]?.role === 'user'}
              {@const endIndex = turnEndIndex(index)}
              {@const endMessage = messages[endIndex]}
              {@const final = turnFinalText(index)}
              {@const turnBusy = busy && endIndex === messages.length - 1}
              {@const trace = turnTraceParts(index, turnBusy)}
              {@const assistantFiles = turnFiles(index)}
              {@const error = turnError(index)}
              {@const attribution = turnAttribution(index)}
              {@const isLatestAssistantTurn = messages
                .slice(endIndex + 1)
                .every((candidate) => candidate.role === 'user')}
              {@const turnDone = endMessage.completedAt !== undefined || !turnBusy}
              <div class="flex flex-col gap-1.5">
                {#if error}
                  <p
                    class="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
                  >
                    {error}
                  </p>
                {/if}
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
                  <div class="text-sm text-foreground">
                    <MarkdownView text={final.text} />
                  </div>
                {/if}
                {#if assistantFiles.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each assistantFiles as part (part.id)}
                      <span
                        class="flex max-w-full items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted"
                        title={part.filename ?? part.url}
                      >
                        <FileText size={11} class="shrink-0" />
                        <span class="max-w-40 truncate"
                          >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                        >
                      </span>
                    {/each}
                  </div>
                {/if}
                {#if turnBusy && trace.length === 0}
                  <div class="flex items-center gap-2 text-xs text-dimmed">
                    <Loader2 size={13} class="animate-spin" />
                    Working…
                  </div>
                {/if}
                {#if turnDone && !turnBusy && (final || error)}
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
                    <span class="ml-1 min-w-0 truncate text-[10px]">
                      {harnessName(attribution)}{#if modelLabel(attribution)}
                        · {modelLabel(attribution)}{/if}
                      {#if endMessage.completedAt && turnStartTime(index)}
                        · {formatDuration(endMessage.completedAt - (turnStartTime(index) ?? 0))}
                      {/if}
                    </span>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}

      {#if busy && messages[messages.length - 1]?.role === 'user'}
        <div class="flex items-center gap-2 text-xs text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Working…
        </div>
      {/if}

      {#if loadError}
        <div
          class="flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
        >
          <span>{loadError}</span>
          <button
            type="button"
            class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-danger transition-colors hover:bg-danger/10"
            title="Retry loading the conversation"
            aria-label="Retry loading the conversation"
            onclick={() => void threadMessages.load(thread.projectId, thread.id)}
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      {/if}

      {#if sendError}
        <p
          class="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
        >
          {sendError}
        </p>
      {/if}

      {#if runError && !sendError && !messages.some((message) => message.error === runError)}
        <p
          class="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {runError}
        </p>
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
    <ChatComposer
      onSend={handleSend}
      working={busy}
      onStop={abortRun}
      placeholder={busy ? `${chatMode ? 'Chat' : 'Agent'} is working — type to queue` : 'Message…'}
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
      showEngineeringMode={false}
      showChatModes={false}
      initialStartAfterThreads={queuedMessage?.startAfterThreads}
    />
  </div>
</div>

{#if openSubagentTab}
  {@const tab = openSubagentTab}
  <BottomSheet
    open
    title={tab.title}
    onClose={() => (openSubagentTab = null)}
    maxHeight="max-h-[88dvh]"
    fixedHeight
  >
    {#await import('../threads/SubagentSessionView.svelte') then { default: SubagentSessionView }}
      <SubagentSessionView {tab} onOpenSubagent={openSubagent} />
    {/await}
  </BottomSheet>
{/if}
