<script lang="ts">
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { tick } from 'svelte'
  import { Portal } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ThreadHoverPopover from '$lib/components/shared/ThreadHoverPopover.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    calculateThreadHoverPopoverPosition,
    resolveThreadHoverPopoverSize,
    threadHoverPopoverStyle,
    THREAD_HOVER_POPOVER_SURFACE_CLASS
  } from '$lib/components/shared/thread-hover-popover-layout'
  import RecordingIndicator from '$lib/components/speech/RecordingIndicator.svelte'
  import SpeakingIndicator from '$lib/components/speech/SpeakingIndicator.svelte'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
  import { threadBranchRowLabel } from '$lib/threads/thread-branch-label'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { type Thread, type ThreadSearchResult } from '$shared/types'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import { GitBranch } from '@lucide/svelte'

  interface Props {
    result: ThreadSearchResult
    selected?: boolean
    onOpen: (thread: Thread) => void
  }

  let { result, selected = false, onOpen }: Props = $props()

  let thread = $derived(result.thread)
  /** Oven the thread runs on, or null when it runs on this computer. */
  let oven = $derived(
    thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID
      ? ovens.identity(thread.settings.ovenId)
      : null
  )

  /** Git branch the thread's checkout is on, when main resolved one. */
  let branch = $derived(thread.branch?.trim() || null)

  $effect(() => {
    if (thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID) void ovens.ensure()
  })
  let isRecording = $derived(speechController.isRecordingThread(thread.id))
  let isSpeaking = $derived(!isRecording && speechController.isSpeakingThread(thread.id))

  /** The one live-working rule, so a parked thread shows the attention dot
   *  instead of a spinner and the row matches the sidebar's own ThreadRow. */
  let isWorking = $derived(isThreadLiveWorking(thread))
  let isRetryPaused = $derived(thread.status === 'working-paused')

  let hasQueuedMessage = $derived(
    rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0
  )
  let queuedBadge = $derived(statusBadgeForThread(thread, isWorking, hasQueuedMessage))

  let badgeProps = $derived.by(() => {
    if (queuedBadge.variant === 'icon') return queuedBadge
    if (isRetryPaused) {
      return { tone: 'working-paused' as const, variant: 'spinner' as const }
    }
    if (isWorking) {
      return { stage: 'working' as const, variant: 'spinner' as const }
    }
    if (thread.status === 'awaiting_approval') {
      return { kind: 'attention' as const, animated: true }
    }
    if (thread.status === 'spec') {
      return { stage: 'spec' as const }
    }
    if (thread.status === 'failed') {
      return { kind: 'error' as const }
    }
    if (!thread.read) return { stage: 'unread' as const }
    if (thread.status === 'created') return { stage: 'todo' as const }
    return null
  })

  type ThreadState =
    | 'unread'
    | 'read'
    | 'todo'
    | 'completed'
    | 'working'
    | 'working-paused'
    | 'spec'
    | 'approval'
    | 'error'

  let stageLabel = $derived.by((): string => {
    switch (thread.status) {
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Working'
      case 'working-paused':
        return 'Waiting to retry'
      default:
        return ''
    }
  })

  let threadState = $derived.by((): ThreadState => {
    if (thread.status === 'failed') return 'error'
    if (thread.status === 'working-paused') return 'working-paused'
    if (thread.status === 'awaiting_approval') return 'approval'
    if (thread.status === 'spec') return 'spec'
    if (isWorking) return 'working'
    if (!thread.read) return 'unread'
    if (thread.status === 'created') return 'todo'
    return 'read'
  })

  // ─── Hover popover (parity with ThreadRow) ────────────────────────────────

  let showPopover = $state(false)
  let rowEl = $state<HTMLButtonElement>()
  let popoverEl = $state<HTMLDivElement>()
  let popoverPos = $state({ x: 0, y: 0 })
  let popoverTimer: ReturnType<typeof setTimeout> | undefined

  async function revealPopover(): Promise<void> {
    if (!rowEl) return

    const size = resolveThreadHoverPopoverSize()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      size.width,
      size.height
    )
    showPopover = true
    await tick()

    if (!rowEl || !popoverEl) return
    const popoverRect = popoverEl.getBoundingClientRect()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      popoverRect.width,
      popoverRect.height
    )
  }

  function onRowEnter(): void {
    clearTimeout(popoverTimer)
    popoverTimer = setTimeout(() => {
      void revealPopover()
    }, 550)
  }

  function onRowLeave(): void {
    clearTimeout(popoverTimer)
    showPopover = false
  }

  const captureRowElement: Attachment<HTMLButtonElement> = (element) => {
    rowEl = element
    return () => {
      if (rowEl === element) rowEl = undefined
    }
  }

  const capturePopoverElement: Attachment<HTMLDivElement> = (element) => {
    popoverEl = element
    return () => {
      if (popoverEl === element) popoverEl = undefined
    }
  }
</script>

<button
  {@attach captureRowElement}
  class="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors {selected
    ? 'bg-selected'
    : 'hover:bg-elevated'}"
  title={thread.title}
  onclick={() => {
    showPopover = false
    clearTimeout(popoverTimer)
    onOpen(thread)
  }}
  onmouseenter={onRowEnter}
  onmouseleave={onRowLeave}
>
  <span class="flex min-w-0 items-center gap-2">
    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {#if badgeProps}
        <StatusBadge
          stage={badgeProps.stage}
          tone={badgeProps.tone}
          kind={badgeProps.kind}
          variant={badgeProps.variant ?? 'dot'}
          icon={queuedBadge.icon}
          animated={badgeProps.animated}
          size="sm"
          title={queuedBadge.label}
        />
      {:else}
        <span class="h-2 w-2 rounded-full border border-border-strong bg-transparent"></span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">{thread.title}</span>
    {#if isRecording}
      <RecordingIndicator label="Listening" />
    {:else if isSpeaking}
      <SpeakingIndicator label="Playing audio" />
    {:else}
      <span class="shrink-0 whitespace-nowrap text-[0.625rem] text-dimmed">
        {formatCompactAge(thread.lastActivity)}
      </span>
    {/if}
  </span>
  {#if oven || branch}
    <span class="flex min-w-0 items-center gap-2 pl-[22px] text-[0.625rem] text-dimmed">
      {#if oven}
        <span class="flex min-w-0 items-center gap-1" title={`Oven: ${oven.name}`}>
          {#if oven.iconUrl}
            <img src={oven.iconUrl} alt="" class="h-2.5 w-2.5 shrink-0 object-contain" />
          {/if}
          <span class="max-w-[9rem] truncate">{oven.name}</span>
        </span>
      {/if}
      {#if branch}
        <span class="flex min-w-0 items-center gap-1" title={`Branch: ${branch}`}>
          <GitBranch size={10} class="shrink-0" aria-hidden="true" />
          <span class="font-mono">{threadBranchRowLabel(branch)}</span>
        </span>
      {/if}
    </span>
  {/if}
  {#if result.kind === 'message' && result.snippet}
    <span class="line-clamp-2 pl-[22px] text-[0.6875rem] leading-snug text-dimmed">
      <span class="text-[0.625rem] uppercase tracking-wide text-dimmed/80">
        {result.role === 'assistant' ? 'Agent' : 'You'}
      </span>
      <span aria-hidden="true"> · </span>
      {result.snippet}
    </span>
  {/if}
</button>

{#if showPopover}
  <Portal>
    <div
      {@attach capturePopoverElement}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(popoverPos.x, popoverPos.y)}
    >
      <ThreadHoverPopover {thread} {isWorking} {isRetryPaused} {stageLabel} {threadState} />
    </div>
  </Portal>
{/if}
