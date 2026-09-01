<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { Portal } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ThreadHoverPopover from '$lib/components/shared/ThreadHoverPopover.svelte'
  import RecordingIndicator from '$lib/components/speech/RecordingIndicator.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { statusBadgeForThread } from '$lib/thread-status-badge'
  import { isThreadWorking, type Thread, type ThreadSearchResult } from '$shared/types'

  interface Props {
    result: ThreadSearchResult
    selected?: boolean
    onOpen: (thread: Thread) => void
    onPreview?: (thread: Thread) => void
    onPreviewEnd?: (thread: Thread) => void
  }

  let {
    result,
    selected = false,
    onOpen,
    onPreview = () => {},
    onPreviewEnd = () => {}
  }: Props = $props()

  let thread = $derived(result.thread)
  let isRecording = $derived(speechController.isRecordingThread(thread.id))
  let isSpeaking = $derived(!isRecording && speechController.isSpeakingThread(thread.id))

  /** Live-settled run state wins over the persisted status, matching ThreadRow. */
  let isWorking = $derived(
    agentRuns.hasSettled(thread.projectId, thread.id)
      ? agentRuns.isBusy(thread.projectId, thread.id)
      : Boolean(thread.sessionId) && isThreadWorking(thread)
  )
  let isRetryPaused = $derived(thread.status === 'working-paused')

  let badgeProps = $derived.by(() => {
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

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'Now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return `${weeks}w`
    return `${Math.floor(days / 30)}mo`
  }

  // ─── Hover popover (parity with ThreadRow) ────────────────────────────────

  let showPopover = $state(false)
  let rowEl = $state<HTMLButtonElement>()
  let popoverEl = $state<HTMLDivElement>()
  let popoverPos = $state({ x: 0, y: 0 })
  let popoverTimer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined

  const POPOVER_WIDTH = 256
  const POPOVER_ESTIMATED_HEIGHT = 290
  const POPOVER_GAP = 8
  const VIEWPORT_MARGIN = 8

  function calculatePopoverPosition(
    anchor: DOMRect,
    width: number,
    height: number
  ): { x: number; y: number } {
    const availableRight = window.innerWidth - anchor.right - VIEWPORT_MARGIN
    const availableLeft = anchor.left - VIEWPORT_MARGIN
    const placeRight = availableRight >= width || availableRight >= availableLeft
    const preferredX = placeRight ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - width
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)

    return {
      x: Math.max(VIEWPORT_MARGIN, Math.min(preferredX, maxX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, maxY))
    }
  }

  async function revealPopover(): Promise<void> {
    if (!rowEl) return

    popoverPos = calculatePopoverPosition(
      rowEl.getBoundingClientRect(),
      POPOVER_WIDTH,
      POPOVER_ESTIMATED_HEIGHT
    )
    showPopover = true
    await tick()

    if (!rowEl || !popoverEl) return
    const popoverRect = popoverEl.getBoundingClientRect()
    popoverPos = calculatePopoverPosition(
      rowEl.getBoundingClientRect(),
      popoverRect.width,
      popoverRect.height
    )
  }

  function onRowEnter(): void {
    clearTimeout(popoverTimer)
    clearTimeout(previewTimer)
    if (!selected) previewTimer = setTimeout(() => onPreview(thread), 200)
    popoverTimer = setTimeout(() => {
      void revealPopover()
    }, 550)
  }

  function onRowLeave(): void {
    clearTimeout(popoverTimer)
    clearTimeout(previewTimer)
    onPreviewEnd(thread)
    showPopover = false
  }

  onDestroy(() => {
    clearTimeout(previewTimer)
    clearTimeout(popoverTimer)
    onPreviewEnd(thread)
  })

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
          animated={badgeProps.animated}
          size="sm"
          title={statusBadgeForThread(thread, isWorking)?.label}
        />
      {:else}
        <span class="h-2 w-2 rounded-full border border-border-strong bg-transparent"></span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{thread.title}</span>
    {#if isRecording}
      <RecordingIndicator label="Listening" />
    {:else if isSpeaking}
      <RecordingIndicator label="Speaking" tone="speech" />
    {:else}
      <span class="shrink-0 whitespace-nowrap text-[10px] text-dimmed">
        {relativeTime(thread.lastActivity)}
      </span>
    {/if}
  </span>
  {#if result.kind === 'message' && result.snippet}
    <span class="line-clamp-2 pl-[22px] text-[11px] leading-snug text-dimmed">
      <span class="text-[10px] uppercase tracking-wide text-dimmed/80">
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
      class="fixed z-60 max-h-[calc(100vh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border bg-surface p-3 shadow-lg"
      style="left: {popoverPos.x}px; top: {popoverPos.y}px"
    >
      <ThreadHoverPopover {thread} {isWorking} {isRetryPaused} {stageLabel} {threadState} />
    </div>
  </Portal>
{/if}
