<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { appQuitState } from '$lib/stores/app-quit.svelte'
  import type { SubagentContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    AgentEvent,
    AgentMessage,
    AgentPart,
    AgentSessionStatus,
    ThinkingLevel
  } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { agentDisplayName } from '$lib/agent-icons/agent-display-name'
  import { latestWorkingTraceParts, shouldMountWorkingTrace } from '$lib/working-trace-parts'
  import {
    subagentAgentType,
    subagentTaskDetail,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import DeferredMarkdownView from '../markdown/DeferredMarkdownView.svelte'
  import MessageTimestamp from '../shared/MessageTimestamp.svelte'
  import WorkingTrace from './WorkingTrace.svelte'
  import SubagentSessionViewHeader from './SubagentSessionViewHeader.svelte'
  import SubagentSessionViewLoadState from './SubagentSessionViewLoadState.svelte'
  import SubagentSessionViewNotices from './SubagentSessionViewNotices.svelte'
  import {
    appendForwardedSubagentText,
    applyStreamedDelta,
    catalogModelLabel,
    catalogProviderName,
    subagentProvider,
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
    subagentSessionRun,
    textParts,
    TRANSCRIPT_POLL_INTERVAL_MS,
    unknownProviderIssue,
    upsertStreamedPart,
    type SubagentRecoveryNotice
  } from './subagent-session-view-helpers'

  interface Props {
    tab: SubagentContextTab
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    /** Configuration of the thread that spawned this worker. A nested worker
     *  inherits its session's harness and reasoning effort, and a harness that
     *  reports neither per worker still renders truthful attribution here. */
    inherited?: {
      harnessId: string | null
      providerId?: string | null
      thinkingLevel: ThinkingLevel | null
    }
  }

  let { tab, onOpenSubagent, inherited }: Props = $props()

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
  /**
   * The live work of an app-owned run (the Assignment draft), forwarded by the
   * parent thread. Its session has no provider-native transcript to load, so the
   * forwarded trace is the transcript the panel shows.
   */
  const draftTrace = $derived(tab.draftTrace ?? [])
  /** A harness that names no child session (Claude Code forwards a sub-agent's
   *  messages into the parent stream instead) has no transcript to load: the
   *  panel renders the text it is handed, and builds the run itself. */
  const parentForwarded = $derived(!sessionId || tab.activity.assignmentDraft === true)
  /** The run this panel has watched arrive. Nothing accumulates for a worker
   *  nobody is looking at, so an unopened panel costs the main process one
   *  bounded record per message instead of an ever-growing transcript.
   *  The buffer is plain because the effect below both reads and writes it: a
   *  reactive buffer would make the append feed its own run. */
  let forwardedBuffer = ''
  let forwardedStream = $state('')
  const fallbackIssue = $derived(subagentFallbackIssue(tab.activity))
  const visibleProviderStatus = $derived(subagentProviderStatus(liveStatus, fallbackIssue))
  const effectiveStatus = $derived(
    subagentEffectiveStatus(visibleProviderStatus, liveStatus, tab.activity)
  )
  const busy = $derived(effectiveStatus === 'running')
  const taskLabel = $derived(subagentTaskLabel(tab.activity))
  const taskDetail = $derived(subagentTaskDetail(tab.activity))
  const agentType = $derived(subagentAgentType(tab.activity))
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
  // The worker's own provider, else the one it inherited from the parent
  // session, always resolved inside the harness that ran it.
  const provider = $derived(subagentProvider(tab.activity, providers, inherited))
  let providerName = $derived(catalogProviderName(tab.activity, providers, inherited))
  const providerId = $derived(provider?.id ?? tab.activity.providerId)
  let providerLabel = $derived(providerName ?? providerId ?? 'Provider')
  // The worker's own report wins; the thread's settings describe what it
  // inherited when the harness reports nothing per worker.
  const harnessId = $derived(tab.activity.harnessId ?? inherited?.harnessId ?? undefined)
  const harnessName = $derived(
    tab.activity.harnessId ? agentDisplayName(tab.activity.harnessId) : null
  )
  const thinkingLevel = $derived(tab.activity.thinkingLevel ?? inherited?.thinkingLevel ?? null)
  const visibleMessages = $derived(filterVisibleMessages(messages, tab.activity.prompt))
  /** Any user message the delegated-prompt filter left behind (a steer into the
   *  worker's session), rendered as its own bubble above the run. */
  const userMessages = $derived(visibleMessages.filter((message) => message.role === 'user'))
  /** The whole run as one trace plus the closing statement that leaves it. A
   *  busy run owns its newest text; a settled one hands it to the transcript. */
  const sessionRun = $derived(subagentSessionRun(visibleMessages, busy))
  const runParts = $derived(latestWorkingTraceParts(sessionRun.parts))
  const showWorkingTrace = $derived(shouldMountWorkingTrace(runParts.length, busy))
  const finalOutput = $derived(tab.activity.output?.trim() ?? '')
  // Each forwarded message replaces the one before it on the part, so the run
  // the panel shows is the sum of what it watched arrive.
  $effect(() => {
    if (!parentForwarded) return
    const chunk = finalOutput
    if (!chunk) return
    const next = appendForwardedSubagentText(forwardedBuffer, chunk)
    if (next === forwardedBuffer) return
    forwardedBuffer = next
    forwardedStream = next
  })
  const forwardedOutput = $derived(parentForwarded ? forwardedStream : finalOutput)
  const showCapturedOutput = $derived(
    shouldShowCapturedOutput(
      forwardedOutput,
      parentForwarded ? false : busy,
      loading,
      loadError,
      messages
    )
  )
  // Until the worker's first forwarded message lands there is nothing to show,
  // so the loader stands in for the wait it would otherwise never end.
  const showChildLoader = $derived(!parentForwarded || finalOutput.length === 0)

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
    if (!sessionId || parentForwarded) return
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
  // moment the first child event arrives. The quit signal stops it outright:
  // the transcript read goes through the database, which the main process
  // closes while the window is still open.
  $effect(() => {
    if (!sessionId || parentForwarded || appQuitState.quitting) return
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
    if (!sessionId || parentForwarded) return
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
    if (tab.activity.assignmentDraft) {
      // The draft retry continues the session the failed run preserved, so the
      // model keeps the context it already built. It answers immediately and the
      // settled run reports through the card and this panel's notices.
      void invoke('agent:retryAssignmentDraft', tab.projectId, tab.threadId)
        .then(() => {
          liveStatus = { state: 'working' }
          recoveryNotice = {
            message: 'A manual retry continued the existing draft session.',
            recoveredAt: Date.now()
          }
        })
        .catch((error: unknown) => {
          actionError = error instanceof Error ? error.message : 'The draft retry could not start.'
        })
        .finally(() => {
          retrying = false
        })
      return
    }
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
    {agentType}
    {headerStatus}
    {showDuration}
    {elapsed}
    {busy}
    {modelLabel}
    {providerName}
    {providerId}
    {harnessId}
    {harnessName}
    {thinkingLevel}
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
          <div class="bg-elevated px-3 py-2.5 text-xs text-foreground">
            <DeferredMarkdownView text={tab.activity.prompt} />
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
        busy={busy && showChildLoader}
        {liveStreamed}
        {loadError}
        messageCount={messages.length}
        onRetry={() => void loadMessages()}
      />

      {#each userMessages as message (message.id)}
        <div class="ml-auto max-w-[90%]">
          <div class="bg-elevated px-3 py-2.5 text-xs text-foreground">
            {#each textParts(message) as part (part.id)}
              <DeferredMarkdownView text={part.text} />
            {/each}
          </div>
          <p class="mt-1 text-right text-[0.5625rem] text-dimmed">
            <MessageTimestamp at={message.createdAt} />
          </p>
        </div>
      {/each}

      {#if draftTrace.length > 0 || showWorkingTrace}
        <WorkingTrace
          parts={draftTrace.length > 0 ? draftTrace : runParts}
          open={busy}
          {busy}
          done={!busy}
          startTime={tab.activity.time?.start}
          {modelLabel}
          {providerName}
          {providerId}
          {onOpenSubagent}
        />
      {/if}

      {#if sessionRun.closing}
        <div class="text-xs text-foreground">
          <DeferredMarkdownView text={sessionRun.closing.text} />
        </div>
      {/if}

      {#if showCapturedOutput}
        <div class="text-xs text-foreground">
          <DeferredMarkdownView text={forwardedOutput} />
        </div>
      {:else if !sessionId && !loading && !loadError}
        {#if effectiveStatus === 'completed' || effectiveStatus === 'error'}
          <p class="text-[0.625rem] text-dimmed">
            No further output was recorded for this sub-agent.
          </p>
        {:else if !busy}
          <p class="text-[0.625rem] text-dimmed">
            Sub-agent output will appear here as it is produced.
          </p>
        {/if}
      {/if}
    </div>
  </div>
</div>
