<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { CheckCircle2, Loader2, X } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    AgentEvent,
    AgentMessage,
    AgentPart,
    AgentSessionStatus,
    AgentToolStatus
  } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import AgentProviderStatusCard from './AgentProviderStatusCard.svelte'
  import SubagentModeBadge from './SubagentModeBadge.svelte'
  import SubagentStatusIcon from './SubagentStatusIcon.svelte'
  import WorkingTrace from './WorkingTrace.svelte'
  import { mergeStreamedPart } from '$shared/agent-part-merge'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import {
    SUBAGENT_STATUS_TONE,
    subagentStatusLabel,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'

  interface Props {
    tab: SubagentContextTab
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let { tab, onOpenSubagent }: Props = $props()

  let messages: AgentMessage[] = $state([])
  let loading = $state(false)
  let loadError = $state('')
  // Set as soon as this child session streams an event of its own. A harness
  // that streams the child transcript (pi) needs no polling: the events build
  // the transcript live, the driver replays everything already produced when
  // the tab opens, and the view keeps the streamed transcript when the run
  // settles. A harness that reports nothing child-scoped keeps the poll.
  let liveStreamed = $state(false)
  let liveStatus: AgentSessionStatus | null = $state(null)
  let actionError = $state('')
  let retrying = $state(false)
  let stopping = $state(false)
  let recoveryNotice: { message: string; recoveredAt: number } | null = $state(null)
  let scrollElement: HTMLDivElement | null = $state(null)
  let userScrolledAway = $state(false)
  // Non-reactive run-state marker: when the worker settles after having been
  // busy, one fresh transcript load covers the gap between the last poll and
  // pi's final flush. Kept plain so tracking it never re-triggers effects.
  let workerWasBusy = false

  const SCROLL_AT_BOTTOM_THRESHOLD = 60
  const TRANSCRIPT_POLL_INTERVAL_MS = 3_000

  function isAtBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  }

  function onScroll(): void {
    if (!scrollElement) return
    userScrolledAway = !isAtBottom(scrollElement)
  }

  const sessionId = $derived(tab.activity.childSessionId)
  const fallbackIssue = $derived.by(() => {
    const message = tab.activity.error?.trim()
    if (!message) return null
    return {
      kind: 'unknown' as const,
      message,
      rawError: message,
      harnessId: 'agent',
      retryable: true
    }
  })
  const visibleProviderStatus = $derived.by(() => {
    if (liveStatus?.state === 'waiting' || liveStatus?.state === 'error') return liveStatus
    if (liveStatus) return null
    return fallbackIssue ? ({ state: 'error', issue: fallbackIssue } as const) : null
  })
  const effectiveStatus = $derived.by(() => {
    if (visibleProviderStatus?.state === 'error') return 'error'
    if (liveStatus?.state === 'working') return 'running'
    if (liveStatus?.state === 'waiting') return 'waiting'
    if (liveStatus?.state === 'error') return 'error'
    // A child session reports a plain `idle` once its run ends; a worker the
    // user stopped must not be described as completed.
    if (liveStatus?.state === 'idle') {
      return tab.activity.status === 'aborted' ? 'aborted' : 'completed'
    }
    return tab.activity.status
  })
  const busy = $derived(effectiveStatus === 'running')
  const taskLabel = $derived(subagentTaskLabel(tab.activity))
  const taskDetail = $derived(subagentTaskDetail(tab.activity))
  /** Lifecycle view for the header chip: 'waiting' is a paused provider
   *  connection, which the sub-agent status vocabulary has no state for. */
  const headerStatus = $derived.by((): { icon: AgentToolStatus; label: string; tone: string } => {
    if (effectiveStatus === 'waiting') {
      return { icon: 'pending', label: 'Paused', tone: SUBAGENT_STATUS_TONE.pending }
    }
    return {
      icon: effectiveStatus,
      label: subagentStatusLabel(effectiveStatus),
      tone: SUBAGENT_STATUS_TONE[effectiveStatus]
    }
  })
  // The header answers "how long has this been going" without scrolling, so it
  // owns the same live clock the trace rows use.
  const clock = new ElapsedTimer()
  $effect(() => {
    if (busy) clock.start()
    else {
      clock.stop()
      if (!tab.activity.time?.end) clock.snapshot()
    }
    return () => clock.stop()
  })
  const elapsed = $derived(clock.seconds(tab.activity.time?.start, tab.activity.time?.end))
  const showDuration = $derived(
    tab.activity.time?.start !== undefined &&
      (busy || tab.activity.time?.end !== undefined || elapsed > 0)
  )
  let providers = $derived(providerCatalog.cached(tab.projectId) ?? providerCatalog.allCached())
  let modelLabel = $derived.by((): string | null => {
    const modelId = tab.activity.modelId
    if (!modelId) return null
    const models = providers.flatMap((p) => p.models)
    const model =
      models.find(
        (m) =>
          m.id === modelId && (!tab.activity.providerId || m.providerId === tab.activity.providerId)
      ) ??
      // Harnesses that report `provider/model` (pi) still resolve to the
      // catalog's display name.
      models.find((m) => modelId.endsWith(`/${m.id}`))
    return model?.name ?? modelId
  })
  let providerName = $derived(
    providers.find((p) => p.id === tab.activity.providerId)?.name ?? undefined
  )
  let providerLabel = $derived(providerName ?? tab.activity.providerId ?? 'Provider')
  const visibleMessages = $derived.by(() => {
    const prompt = tab.activity.prompt?.trim()
    if (!prompt) return messages
    let skippedPrompt = false
    return messages.filter((message: AgentMessage) => {
      if (skippedPrompt || message.role !== 'user') return true
      const text = textParts(message)
        .map((part) => part.text.trim())
        .join('\n')
      if (text !== prompt) return true
      skippedPrompt = true
      return false
    })
  })
  const finalOutput = $derived(tab.activity.output?.trim() ?? '')
  // The captured output is a fallback for when the transcript itself is not
  // renderable   never a companion to it. While the sub-agent works,
  // activity.output is an accumulating preview that concatenates every
  // assistant message (capped, possibly cut mid-line), so substring checks
  // against the last assistant message fail and the raw wall of text would
  // duplicate the live working trace at the bottom of the view. Only surface
  // it when the loaded transcript carries no assistant text to cover it and
  // the session is no longer streaming.
  const transcriptHasAssistantText = $derived(
    [...messages]
      .reverse()
      .some(
        (message) =>
          message.role === 'assistant' && textParts(message).some((part) => part.text.trim())
      )
  )
  const showCapturedOutput = $derived(
    finalOutput.length > 0 &&
      !busy &&
      !loading &&
      (loadError !== '' || messages.length === 0 || !transcriptHasAssistantText)
  )

  onMount(() => {
    void initializeSession()
    const unsubscribe = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (!event || !sessionId || !('sessionId' in event) || event.sessionId !== sessionId) {
        return
      }
      liveStreamed = true
      handleEvent(event)
    })
    return unsubscribe
  })

  async function initializeSession(): Promise<void> {
    await loadMessages()
    await loadStatus()
  }

  async function loadStatus(): Promise<void> {
    if (!sessionId) return
    try {
      const status = await invoke(
        'agent:getChildSessionStatus',
        tab.projectId,
        tab.threadId,
        sessionId
      )
      if (status && (status.state !== 'idle' || liveStatus?.state !== 'error')) {
        liveStatus = status
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'Live sub-agent status is unavailable.'
    }
  }

  $effect(() => {
    void messages.length
    void tick().then(() => {
      if (!scrollElement || userScrolledAway) return
      // The scroll event lags the user's gesture by a frame, so re-check the
      // live position before snapping   a queued callback racing a scroll-up
      // would otherwise drag the view back to the bottom mid-gesture.
      if (!isAtBottom(scrollElement)) {
        userScrolledAway = true
        return
      }
      scrollElement.scrollTop = scrollElement.scrollHeight
    })
  })

  // pi flushes a sub-agent's native transcript only after its first assistant
  // message completes, so an early load legitimately returns nothing (the
  // engine reports an empty result while the worker is still starting). Poll
  // while the worker is busy instead of surfacing a load error, and reload
  // once more when the run settles so the final transcript is picked up even
  // if the last poll raced the terminal flush. A child that streams its own
  // events needs neither: the stream is the transcript, so polling stops the
  // moment the first child event arrives.
  $effect(() => {
    if (!sessionId) return
    if (busy && !liveStreamed) {
      workerWasBusy = true
      const poll = setInterval(() => {
        if (!loading) void loadMessages()
      }, TRANSCRIPT_POLL_INTERVAL_MS)
      return () => clearInterval(poll)
    }
    if (busy) {
      workerWasBusy = true
      return
    }
    if (workerWasBusy) {
      workerWasBusy = false
      // A streamed transcript already holds the worker's final messages; only
      // a polled (or not yet streamed) one needs the settle reconcile.
      if (!liveStreamed) void loadMessages()
    }
  })

  async function loadMessages(): Promise<void> {
    if (!sessionId) return
    loading = true
    loadError = ''
    const mergeWithStream = liveStreamed
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const loadedMessages = await Promise.race([
        invoke('agent:loadSessionMessages', tab.projectId, tab.threadId, sessionId),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The provider took too long to load this session.')),
            15_000
          )
        })
      ])
      // A load that raced the live stream must not roll the transcript back:
      // the streamed transcript is the newer, richer half of the same mapper
      // output, so merge by message id with the live copy winning.
      messages = mergeWithStream ? mergeTranscript(loadedMessages, messages) : loadedMessages
      const lastAssistant = [...loadedMessages]
        .reverse()
        .find((message) => message.role === 'assistant')
      if (!liveStatus && lastAssistant?.error) {
        liveStatus = {
          state: 'error',
          issue: {
            kind: 'unknown',
            message: lastAssistant.error,
            rawError: lastAssistant.error,
            harnessId: lastAssistant.harnessId ?? 'agent',
            retryable: true
          }
        }
      }
    } catch (error) {
      loadError =
        error instanceof Error ? error.message : 'The sub-agent session could not be loaded.'
    } finally {
      if (timeout) clearTimeout(timeout)
      loading = false
    }
  }

  /** Keep the live transcript as the newer half of a raced load. */
  function mergeTranscript(loaded: AgentMessage[], streamed: AgentMessage[]): AgentMessage[] {
    if (streamed.length === 0) return loaded
    const merged = loaded.map(
      (message) => streamed.find((candidate) => candidate.id === message.id) ?? message
    )
    for (const message of streamed) {
      if (!loaded.some((candidate) => candidate.id === message.id)) merged.push(message)
    }
    return merged.sort((left, right) => left.createdAt - right.createdAt)
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
        if (event.error) {
          const issue = event.issue ?? {
            kind: 'unknown' as const,
            message: event.error,
            rawError: event.error,
            harnessId: 'agent',
            retryable: true
          }
          liveStatus = { state: 'error', issue }
          recoveryNotice = null
        }
        void loadMessages()
        break
      case 'session.status': {
        const previousStatus = liveStatus
        if (event.status.state === 'working') {
          if (previousStatus?.state === 'waiting' || previousStatus?.state === 'error') {
            recoveryNotice = {
              message: `Connection restored after: ${previousStatus.issue.message}`,
              recoveredAt: Date.now()
            }
          }
          actionError = ''
        } else if (event.status.state === 'waiting' || event.status.state === 'error') {
          recoveryNotice = null
        }
        if (event.status.state !== 'idle' || previousStatus?.state !== 'error') {
          liveStatus = event.status
        }
        break
      }
      case 'session.idle':
        if (liveStatus?.state !== 'error') liveStatus = { state: 'idle' }
        void loadMessages()
        break
      case 'session.error':
        liveStatus = event.issue ? { state: 'error', issue: event.issue } : liveStatus
        if (!event.issue) {
          const message = event.error ?? 'The sub-agent session failed.'
          liveStatus = {
            state: 'error',
            issue: {
              kind: 'unknown',
              message,
              rawError: message,
              harnessId: 'agent',
              retryable: true
            }
          }
        }
        recoveryNotice = null
        void loadMessages()
        break
    }
  }

  function retryChild(): void {
    if (!sessionId || retrying) return
    retrying = true
    actionError = ''
    void invoke('agent:retryChildSession', tab.projectId, tab.threadId, sessionId)
      .then(() => {
        liveStatus = { state: 'working' }
        recoveryNotice = {
          message: 'A manual retry started in the existing sub-agent session.',
          recoveredAt: Date.now()
        }
      })
      .catch((error: unknown) => {
        actionError =
          error instanceof Error ? error.message : 'The sub-agent retry could not start.'
      })
      .finally(() => {
        retrying = false
      })
  }

  function stopChild(): void {
    if (!sessionId || stopping) return
    stopping = true
    actionError = ''
    void invoke('agent:abortChildSession', tab.projectId, tab.threadId, sessionId)
      .catch((error: unknown) => {
        actionError = error instanceof Error ? error.message : 'The sub-agent could not be stopped.'
      })
      .finally(() => {
        stopping = false
      })
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
        : message.parts.map((candidate, index) =>
            // A snapshot shorter than what already streamed must never wipe the
            // streamed text (see mergeStreamedPart).
            index === partIndex ? mergeStreamedPart(candidate, part) : candidate
          )
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
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 class="min-w-0 truncate text-xs font-semibold text-foreground">{taskLabel}</h2>
      <span
        class="flex shrink-0 items-center gap-1 text-[0.625rem] {headerStatus.tone}"
        aria-live="polite"
      >
        <SubagentStatusIcon status={headerStatus.icon} size={11} />
        {headerStatus.label}
      </span>
      {#if showDuration}
        <span
          class="ml-auto shrink-0 tabular-nums text-[0.625rem] text-muted"
          title={busy ? 'Elapsed time for this sub-agent' : 'Total time this sub-agent took'}
        >
          {formatDurationSeconds(elapsed)}
        </span>
      {/if}
    </div>
    <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.625rem] text-dimmed">
      {#if modelLabel}
        <span class="flex min-w-0 items-center gap-1">
          <VendorIcon name={providerName ?? modelLabel} id={tab.activity.providerId} size={11} />
          <span class="truncate">
            {providerName ? `${providerName} · ${modelLabel}` : modelLabel}
          </span>
        </span>
      {/if}
      <SubagentModeBadge background={tab.activity.background} variant="chip" />
      {#if tab.activity.providerTaskId && tab.activity.providerTaskId !== sessionId}
        <span class="truncate font-mono" title={tab.activity.providerTaskId}>
          task {tab.activity.providerTaskId}
        </span>
      {/if}
    </div>
    {#if taskDetail}
      <p class="mt-1 min-w-0 truncate text-[0.625rem] text-muted">{taskDetail}</p>
    {/if}
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
            class="mb-1 text-right text-[0.5625rem] font-semibold uppercase tracking-[0.12em] text-dimmed"
          >
            Delegated by parent
          </p>
          <div class="rounded-xl rounded-br-sm bg-elevated px-3 py-2.5 text-xs text-foreground">
            <MarkdownView text={tab.activity.prompt} />
          </div>
        </div>
      {/if}

      {#if visibleProviderStatus}
        <AgentProviderStatusCard
          status={visibleProviderStatus}
          providerName={providerLabel}
          onStop={stopChild}
          onRetry={retryChild}
        />
      {/if}

      {#if recoveryNotice}
        <div
          class="flex items-start gap-2.5 rounded-xl border border-success/25 bg-success/5 px-3 py-2.5"
          role="status"
          aria-live="polite"
        >
          <CheckCircle2 size={14} class="mt-0.5 shrink-0 text-success" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold text-foreground">Sub-agent connection recovered</p>
            <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
              {recoveryNotice.message}
            </p>
            <p class="mt-1 text-[0.625rem] text-dimmed">
              {formatTime(recoveryNotice.recoveredAt)}
            </p>
          </div>
          <button
            type="button"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Dismiss sub-agent recovery notice"
            title="Dismiss sub-agent recovery notice"
            onclick={() => (recoveryNotice = null)}
          >
            <X size={13} />
          </button>
        </div>
      {/if}

      {#if actionError}
        <div class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5" role="alert">
          <p class="text-xs font-medium text-danger">Sub-agent action failed</p>
          <p class="mt-1 text-[0.6875rem] text-muted">{actionError}</p>
        </div>
      {/if}

      {#if (loading || busy) && messages.length === 0 && !liveStreamed}
        <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
          <Loader2 size={13} class="animate-spin text-info" />
          Loading sub-agent session…
        </div>
      {:else if loadError && !busy && !liveStreamed}
        <div class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5">
          <p class="text-xs font-medium text-danger">Could not load the sub-agent session</p>
          <p class="mt-1 text-[0.6875rem] text-muted">{loadError}</p>
          <button
            type="button"
            class="mt-2 text-[0.625rem] font-medium text-info hover:underline"
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
            <p class="mt-1 text-right text-[0.5625rem] text-dimmed">
              {formatTime(message.createdAt)}
            </p>
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
                {modelLabel}
                {providerName}
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
                class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[0.6875rem] text-danger"
              >
                {message.error}
              </div>
            {/if}
            {#if message.completedAt}
              <p class="text-[0.5625rem] text-dimmed">{formatTime(message.completedAt)}</p>
            {/if}
          </div>
        {/if}
      {/each}

      {#if showCapturedOutput}
        <div class="text-xs text-foreground">
          <MarkdownView text={finalOutput} />
        </div>
      {:else if !sessionId && !loading && !loadError && !busy}
        {#if effectiveStatus === 'completed' || effectiveStatus === 'error'}
          <p class="text-[0.625rem] text-dimmed">
            No further output was recorded for this sub-agent.
          </p>
        {:else}
          <p class="text-[0.625rem] text-dimmed">
            Sub-agent output will appear here as it is produced.
          </p>
        {/if}
      {/if}
    </div>
  </div>
</div>
