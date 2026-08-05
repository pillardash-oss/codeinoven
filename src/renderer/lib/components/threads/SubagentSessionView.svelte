<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { AlertCircle, CheckCircle2, Clock, Loader2 } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type { AgentEvent, AgentMessage, AgentPart, AgentSessionStatus } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import WorkingTrace from './WorkingTrace.svelte'

  interface Props {
    tab: SubagentContextTab
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let { tab, onOpenSubagent }: Props = $props()

  let messages: AgentMessage[] = $state([])
  let loading = $state(false)
  let loadError = $state('')
  let liveStatus: AgentSessionStatus | null = $state(null)
  let liveError = $state('')
  let scrollElement: HTMLDivElement | null = $state(null)
  let userScrolledAway = $state(false)

  const SCROLL_AT_BOTTOM_THRESHOLD = 60

  function isAtBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  }

  function onScroll(): void {
    if (!scrollElement) return
    userScrolledAway = !isAtBottom(scrollElement)
  }

  const sessionId = $derived(tab.activity.childSessionId)
  const effectiveStatus = $derived.by(() => {
    if (liveStatus?.state === 'working') return 'running'
    if (liveStatus?.state === 'waiting') return 'waiting'
    if (liveStatus?.state === 'error') return 'error'
    if (liveStatus?.state === 'idle') return 'completed'
    return tab.activity.status
  })
  const busy = $derived(effectiveStatus === 'running')
  const visibleMessages = $derived.by(() => {
    const prompt = tab.activity.prompt?.trim()
    if (!prompt) return messages
    let skippedPrompt = false
    return messages.filter((message) => {
      if (skippedPrompt || message.role !== 'user') return true
      const text = textParts(message)
        .map((part) => part.text.trim())
        .join('\n')
      if (text !== prompt) return true
      skippedPrompt = true
      return false
    })
  })

  onMount(() => {
    void loadMessages()
    const unsubscribe = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (!event || !sessionId || !('sessionId' in event) || event.sessionId !== sessionId) {
        return
      }
      handleEvent(event)
    })
    return unsubscribe
  })

  $effect(() => {
    void messages.length
    void tick().then(() => {
      if (!scrollElement || userScrolledAway) return
      scrollElement.scrollTop = scrollElement.scrollHeight
    })
  })

  async function loadMessages(): Promise<void> {
    if (!sessionId) return
    loading = true
    loadError = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      messages = await Promise.race([
        invoke('agent:loadSessionMessages', tab.projectId, tab.threadId, sessionId),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The provider took too long to load this session.')),
            15_000
          )
        })
      ])
    } catch (error) {
      loadError =
        error instanceof Error ? error.message : 'The sub-agent session could not be loaded.'
    } finally {
      if (timeout) clearTimeout(timeout)
      loading = false
    }
  }

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message.part.updated':
        upsertPart(event.part)
        break
      case 'message.part.delta':
        applyDelta(event.messageId, event.partId, event.field, event.delta)
        break
      case 'message.completed':
        markCompleted(event.messageId, event.error)
        if (event.error) liveError = event.issue?.message ?? event.error
        void loadMessages()
        break
      case 'session.status':
        liveStatus = event.status
        if (event.status.state === 'error') liveError = event.status.issue.message
        break
      case 'session.idle':
        liveStatus = { state: 'idle' }
        void loadMessages()
        break
      case 'session.error':
        liveStatus = event.issue ? { state: 'error', issue: event.issue } : liveStatus
        liveError = event.issue?.message ?? event.error ?? 'The sub-agent session failed.'
        void loadMessages()
        break
    }
  }

  function upsertPart(part: AgentPart): void {
    const messageIndex = messages.findIndex((message) => message.id === part.messageID)
    if (messageIndex < 0) {
      messages = [
        ...messages,
        {
          id: part.messageID,
          role: 'assistant',
          parts: [part],
          createdAt: Date.now()
        }
      ]
      return
    }
    const message = messages[messageIndex]
    const partIndex = message.parts.findIndex((candidate) => candidate.id === part.id)
    const parts =
      partIndex < 0
        ? [...message.parts, part]
        : message.parts.map((candidate, index) => (index === partIndex ? part : candidate))
    messages = messages.map((candidate, index) =>
      index === messageIndex ? { ...message, parts } : candidate
    )
  }

  function applyDelta(messageId: string, partId: string, field: string, delta: string): void {
    if (field !== 'text') return
    messages = messages.map((message) => {
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

  function markCompleted(messageId: string, error?: string): void {
    messages = messages.map((message) =>
      message.id === messageId ? { ...message, completedAt: Date.now(), error } : message
    )
  }

  function textParts(message: AgentMessage): Extract<AgentPart, { type: 'text' }>[] {
    return message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text'
    )
  }

  function workingParts(message: AgentMessage): AgentPart[] {
    return message.parts.filter((part) => part.type !== 'text' && part.type !== 'question')
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    })
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="shrink-0 border-b border-border px-4 py-3">
    <div class="flex items-start gap-2.5">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h2 class="truncate text-xs font-semibold text-foreground">
            {tab.activity.agent || 'Sub-agent'}
          </h2>
          <span
            class="flex shrink-0 items-center gap-1 text-[10px] {effectiveStatus === 'error'
              ? 'text-danger'
              : effectiveStatus === 'completed'
                ? 'text-success'
                : 'text-info'}"
          >
            {#if effectiveStatus === 'running'}
              <Loader2 size={10} class="animate-spin" />
              Working
            {:else if effectiveStatus === 'waiting'}
              <Clock size={10} />
              Paused
            {:else if effectiveStatus === 'completed'}
              <CheckCircle2 size={10} />
              Completed
            {:else if effectiveStatus === 'error'}
              <AlertCircle size={10} />
              Failed
            {:else}
              <Clock size={10} />
              Starting
            {/if}
          </span>
        </div>
        <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-dimmed">
          {#if tab.activity.modelId}
            <span>
              {tab.activity.providerId
                ? `${tab.activity.providerId}/${tab.activity.modelId}`
                : tab.activity.modelId}
            </span>
          {/if}
          {#if tab.activity.providerTaskId && tab.activity.providerTaskId !== sessionId}
            <span title={tab.activity.providerTaskId}>
              task {tab.activity.providerTaskId}
            </span>
          {/if}
        </div>
      </div>
    </div>
  </header>

  <div
    bind:this={scrollElement}
    class="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    onscroll={onScroll}
  >
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-5">
      {#if tab.activity.prompt}
        <div class="ml-auto max-w-[90%]">
          <p
            class="mb-1 text-right text-[9px] font-semibold uppercase tracking-[0.12em] text-dimmed"
          >
            Delegated by parent
          </p>
          <div class="rounded-xl rounded-br-sm bg-elevated px-3 py-2.5 text-xs text-foreground">
            <MarkdownView text={tab.activity.prompt} />
          </div>
        </div>
      {/if}

      {#if liveStatus?.state === 'waiting'}
        <div class="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
          <p class="text-xs font-medium text-foreground">Sub-agent paused by provider</p>
          <p class="mt-1 text-[11px] leading-relaxed text-muted">
            {liveStatus.issue.message}
          </p>
          {#if liveStatus.issue.retryAt}
            <p class="mt-1.5 text-[10px] text-warning">
              Retry scheduled for {new Date(liveStatus.issue.retryAt).toLocaleString()}
            </p>
          {/if}
        </div>
      {/if}

      {#if messages.length === 0 && tab.activity.output}
        <div>
          <p class="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-dimmed">
            Captured result
          </p>
          <div class="text-xs text-foreground">
            <MarkdownView text={tab.activity.output} />
          </div>
        </div>
      {/if}

      {#if !sessionId}
        <div class="rounded-lg border border-border bg-elevated px-3 py-2.5 text-[11px] text-muted">
          The provider has not exposed this child session yet. Its assignment and status will
          continue updating here.
        </div>
      {:else if loading && messages.length === 0}
        <div
          class="flex items-center {tab.activity.output
            ? 'gap-1.5 text-[10px] text-dimmed'
            : 'justify-center gap-2 py-8 text-xs text-muted'}"
        >
          <Loader2 size={13} class="animate-spin text-info" />
          {tab.activity.output ? 'Loading full activity history…' : 'Loading sub-agent session…'}
        </div>
      {:else if loadError}
        <div class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5">
          <p class="text-xs font-medium text-danger">
            {tab.activity.output
              ? 'Full activity history is unavailable'
              : 'Could not load the sub-agent session'}
          </p>
          <p class="mt-1 text-[11px] text-muted">{loadError}</p>
          <button
            type="button"
            class="mt-2 text-[10px] font-medium text-info hover:underline"
            onclick={() => void loadMessages()}
          >
            Try again
          </button>
        </div>
      {/if}

      {#each visibleMessages as message (message.id)}
        {#if message.role === 'user'}
          <div class="ml-auto max-w-[90%]">
            <div class="rounded-xl rounded-br-sm bg-elevated px-3 py-2.5 text-xs text-foreground">
              {#each textParts(message) as part (part.id)}
                <MarkdownView text={part.text} />
              {/each}
            </div>
            <p class="mt-1 text-right text-[9px] text-dimmed">{formatTime(message.createdAt)}</p>
          </div>
        {:else}
          {@const traceParts = workingParts(message)}
          {@const responseParts = textParts(message)}
          <div class="flex flex-col gap-2.5">
            {#if traceParts.length > 0}
              <WorkingTrace
                parts={traceParts}
                open={busy}
                {busy}
                latest={busy}
                startTime={tab.activity.time?.start}
                {onOpenSubagent}
              />
            {/if}
            {#each responseParts as part (part.id)}
              <div class="text-xs text-foreground">
                <MarkdownView text={part.text} />
              </div>
            {/each}
            {#if message.error}
              <div
                class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger"
              >
                {message.error}
              </div>
            {/if}
            {#if message.completedAt}
              <p class="text-[9px] text-dimmed">{formatTime(message.completedAt)}</p>
            {/if}
          </div>
        {/if}
      {/each}

      {#if tab.activity.error && !loadError}
        <div
          class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[11px] text-danger"
        >
          {tab.activity.error}
        </div>
      {/if}

      {#if liveError && liveError !== tab.activity.error}
        <div
          class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[11px] text-danger"
        >
          {liveError}
        </div>
      {/if}

      {#if busy}
        <div class="flex items-center gap-2 text-[10px] text-info">
          <Loader2 size={11} class="animate-spin" />
          Sub-agent working…
        </div>
      {/if}
    </div>
  </div>
</div>
