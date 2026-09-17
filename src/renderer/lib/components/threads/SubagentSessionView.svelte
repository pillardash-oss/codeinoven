<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type { AgentEvent, AgentMessage, AgentPart, AgentSessionStatus } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { subagentTaskDetail, subagentTaskLabel } from '$lib/subagent-presentation'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import SubagentSessionViewHeader from './SubagentSessionViewHeader.svelte'
  import SubagentSessionViewLoadState from './SubagentSessionViewLoadState.svelte'
  import SubagentSessionViewMessage from './SubagentSessionViewMessage.svelte'
  import SubagentSessionViewNotices from './SubagentSessionViewNotices.svelte'
  import {
    applyStreamedDelta,
    catalogModelLabel,
    catalogProviderName,
    filterVisibleMessages,
    isAtBottom,
    loadSessionTranscript,
    markMessageCompleted,
    mergeTranscript,
    shouldShowCapturedOutput,
    subagentEffectiveStatus,
    subagentFallbackIssue,
    subagentHeaderStatus,
    subagentProviderStatus,
    TRANSCRIPT_POLL_INTERVAL_MS,
    unknownProviderIssue,
    upsertStreamedPart,
    type SubagentRecoveryNotice
  } from './subagent-session-view-helpers'

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
  let recoveryNotice: SubagentRecoveryNotice | null = $state(null)
  let scrollElement: HTMLDivElement | null = $state(null)
  let userScrolledAway = $state(false)
  // Non-reactive run-state marker: when the worker settles after having been
  // busy, one fresh transcript load covers the gap between the last poll and
  // pi's final flush. Kept plain so tracking it never re-triggers effects.
  let workerWasBusy = false

  function onScroll(): void {
    if (!scrollElement) return
    userScrolledAway = !isAtBottom(scrollElement)
  }

  const sessionId = $derived(tab.activity.childSessionId)
  const fallbackIssue = $derived(subagentFallbackIssue(tab.activity))
  const visibleProviderStatus = $derived(subagentProviderStatus(liveStatus, fallbackIssue))
  const effectiveStatus = $derived(
    subagentEffectiveStatus(visibleProviderStatus, liveStatus, tab.activity)
  )
  const busy = $derived(effectiveStatus === 'running')
  const taskLabel = $derived(subagentTaskLabel(tab.activity))
  const taskDetail = $derived(subagentTaskDetail(tab.activity))
  const headerStatus = $derived(subagentHeaderStatus(effectiveStatus))
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
  let modelLabel = $derived(catalogModelLabel(tab.activity, providers))
  let providerName = $derived(catalogProviderName(tab.activity, providers))
  let providerLabel = $derived(providerName ?? tab.activity.providerId ?? 'Provider')
  const visibleMessages = $derived(filterVisibleMessages(messages, tab.activity.prompt))
  const finalOutput = $derived(tab.activity.output?.trim() ?? '')
  const showCapturedOutput = $derived(
    shouldShowCapturedOutput(finalOutput, busy, loading, loadError, messages)
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
    try {
      const loadedMessages = await loadSessionTranscript(() =>
        invoke('agent:loadSessionMessages', tab.projectId, tab.threadId, sessionId)
      )
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
          issue: unknownProviderIssue(lastAssistant.error, lastAssistant.harnessId ?? 'agent')
        }
      }
    } catch (error) {
      loadError =
        error instanceof Error ? error.message : 'The sub-agent session could not be loaded.'
    } finally {
      loading = false
    }
  }

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message.part.updated':
        messages = upsertStreamedPart(messages, event.part)
        break
      case 'message.part.delta':
        messages = applyStreamedDelta(
          messages,
          event.messageId,
          event.partId,
          event.field,
          event.delta
        )
        break
      case 'message.completed':
        messages = markMessageCompleted(messages, event.messageId, event.error)
        if (event.error) {
          const issue = event.issue ?? unknownProviderIssue(event.error)
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
            issue: unknownProviderIssue(message)
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
</script>

<div class="flex h-full min-h-0 flex-col">
  <SubagentSessionViewHeader
    {taskLabel}
    {taskDetail}
    {headerStatus}
    {showDuration}
    {elapsed}
    {busy}
    {modelLabel}
    {providerName}
    providerId={tab.activity.providerId}
    background={tab.activity.background}
    providerTaskId={tab.activity.providerTaskId}
    {sessionId}
  />

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

      <SubagentSessionViewNotices
        providerStatus={visibleProviderStatus}
        {providerLabel}
        {recoveryNotice}
        {actionError}
        onStop={stopChild}
        onRetry={retryChild}
        onDismissRecovery={() => (recoveryNotice = null)}
      />

      <SubagentSessionViewLoadState
        {loading}
        {busy}
        {liveStreamed}
        {loadError}
        messageCount={messages.length}
        onRetry={() => void loadMessages()}
      />

      {#each visibleMessages as message (message.id)}
        <SubagentSessionViewMessage
          {message}
          {busy}
          startTime={tab.activity.time?.start}
          {modelLabel}
          {providerName}
          {onOpenSubagent}
        />
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
