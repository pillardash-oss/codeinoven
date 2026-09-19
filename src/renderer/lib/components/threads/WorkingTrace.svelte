<script lang="ts">
  import { Bot } from '@lucide/svelte'
  import { onDestroy, tick } from 'svelte'
  import ActionSheet from '../ui/ActionSheet.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import type { AgentPart, ThinkingLevel } from '$shared/types'
  import { isImageMime } from '$lib/mime'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import { latestWorkingTraceParts } from '$lib/working-trace-parts'
  import {
    newestTraceStartId,
    olderTraceStartId,
    traceWindowAnchorExpired,
    traceWindowStartIndex
  } from '$lib/working-trace-window'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import {
    subagentIsRunning,
    subagentStatusLabel,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import WorkingTraceRow from './WorkingTraceRow.svelte'
  import WorkingTraceStatus from './WorkingTraceStatus.svelte'
  import WorkingTraceSummary from './WorkingTraceSummary.svelte'
  import { subagentBadgeLabel, subagentBadgeTitle } from './working-trace-subagents'
  import { workingTraceStartTime } from './working-trace-start'

  interface Props {
    parts: AgentPart[]
    open?: boolean
    busy?: boolean
    latest?: boolean
    /** True once this trace's turn produced a completed assistant message   the
     *  only condition under which the trace may fold itself. */
    done?: boolean
    /** True when this trace was rehydrated from persisted state because no live
     *  session activity is confirming the run. Renders a saved-activity note
     *  instead of a live "Agent working…" spinner. */
    rehydrated?: boolean
    /** True when this run belongs to another CodeInOven instance, which is where
     *  its live output and stop control are. */
    foreignRun?: boolean
    initialOpen?: boolean
    initialUserOpened?: boolean
    /** When the agent started working on this trace; used to show a live duration. */
    startTime?: number
    /** Attribution for the model currently working on this trace. */
    modelLabel?: string | null
    /** True while this trace is on screen. A hidden trace   the workspace keeps
     *  a thread mounted behind Settings/Scope and other views   re-bounds its
     *  mounted window, so coming back never mounts whatever streamed while the
     *  reader was away. */
    active?: boolean
    /** True when the durable stream holds entries older than the oldest this
     *  trace holds, so paging past the window needs another read. */
    olderPartsAvailable?: boolean
    /** Pull the next older durable page into this trace's parts. */
    onLoadOlderParts?: () => void | Promise<void>
    /** Thinking level used for this trace's turn, when the model reasons. */
    thinkingLevel?: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
    accountLabel?: string | null
    isFast?: boolean
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
    onToggle?: (open: boolean, userOpened: boolean) => void
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    onCiteFile?: (path: string, line?: number) => void
  }

  let {
    parts,
    open = false,
    busy = false,
    latest = false,
    done = false,
    rehydrated = false,
    foreignRun = false,
    initialOpen = false,
    initialUserOpened = false,
    startTime,
    active = true,
    olderPartsAvailable = false,
    onLoadOlderParts,
    modelLabel = null,
    thinkingLevel = null,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel,
    isFast = false,
    projectId,
    threadId,
    checkpointId = null,
    checkpointPaths = [],
    onToggle,
    onOpenSubagent,
    onCiteFile
  }: Props = $props()

  // Intentional initial-value capture   props are only used to seed local state.
  // svelte-ignore state_referenced_locally
  let isOpen = $state(open || initialOpen)
  // svelte-ignore state_referenced_locally
  let userOpened = $state(initialUserOpened)
  // svelte-ignore state_referenced_locally
  let wasLatest = $state(latest)
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let imageUrls = new FileBlobUrlManager()
  const visibleParts = $derived(latestWorkingTraceParts(parts))
  const TRACE_SCROLL_THRESHOLD = 32
  let traceScrollEl = $state<HTMLDivElement>()
  let traceAtBottom = $state(true)
  /** How close to the trace scroller's top counts as "paging older entries". */
  const TRACE_TOP_THRESHOLD = 32
  /** Pinned start of the mounted window. `null` means "the newest page"   the
   *  state a trace opens in, the state it re-bounds to whenever it is not being
   *  watched, and the state the reader's own paging moves back from. A pinned
   *  entry never moves on its own: entries that stream in append at the tail,
   *  so nothing the reader is looking at is ever evicted while they are on the
   *  thread. The header count reports the entries this trace holds   its newest
   *  page plus everything appended since, growing as the reader pages older
   *  entries in   never a number the mounted window happens to disagree with. */
  let windowStartId = $state<string | null>(null)
  const windowStartIndex = $derived(traceWindowStartIndex(visibleParts, windowStartId))
  const pagedParts = $derived(visibleParts.slice(windowStartIndex))
  /** True while an older durable page is in flight, so one gesture cannot queue
   *  the same page twice. */
  let loadingOlderParts = $state(false)

  /** Pin the window while the trace is genuinely being watched. A collapsed or
   *  hidden trace keeps the plain newest-page window: nothing mounts while it
   *  is away, and re-showing it must not mount whatever streamed meanwhile. A
   *  pinned entry that left the list (turn boundary, fold reset, replaced cache
   *  page) re-pins to the page being shown so nothing below the reader is
   *  evicted. */
  $effect(() => {
    if (!isOpen || !active) return
    if (windowStartId !== null && !traceWindowAnchorExpired(visibleParts, windowStartId)) {
      return
    }
    windowStartId = newestTraceStartId(visibleParts)
  })

  /** Leaving the trace   another thread, another top-level view   re-bounds it
   *  to the newest page off the reader's critical path, so returning mounts a
   *  bounded window instead of the whole turn. The turn keeps streaming into the
   *  log while away; the trace simply never keeps it mounted for nobody. The
   *  same rule applies while the trace is collapsed: nothing is mounted, so
   *  re-showing it opens on the newest page. */
  $effect(() => {
    if (active && isOpen) return
    windowStartId = null
    loadingOlderParts = false
  })

  /** Move the pinned window start one page older, keeping the reader's viewport
   *  stable across the mount (same compensation the conversation list uses). */
  function moveWindowOlderPage(): void {
    const el = traceScrollEl
    const nextId = olderTraceStartId(visibleParts, windowStartIndex)
    if (nextId === null) return
    const previousHeight = el?.scrollHeight ?? 0
    const previousTop = el?.scrollTop ?? 0
    windowStartId = nextId
    void tick().then(() => {
      if (!el) return
      const grown = el.scrollHeight - previousHeight
      if (grown > 0) el.scrollTop = previousTop + grown
    })
  }

  /** Page in older entries. Entries already loaded come from the message cache
   *  at no IPC cost; once the window reaches the oldest entry the trace holds,
   *  the durable stream is asked for the next older page   a live turn's work
   *  lives there long before the mirror records it. */
  function expandTracePage(): void {
    if (windowStartIndex > 0) {
      moveWindowOlderPage()
      return
    }
    if (!olderPartsAvailable || loadingOlderParts) return
    loadingOlderParts = true
    void Promise.resolve(onLoadOlderParts?.())
      .catch(() => {})
      .finally(() => {
        loadingOlderParts = false
        void tick().then(() => moveWindowOlderPage())
      })
  }

  /** Page older entries in once the reader reaches the top of a scrollable
   *  trace. A trace whose content fits needs no paging, and a reader parked at
   *  the bottom must never pull pages in behind a live stream. */
  function maybePageOlderEntries(element: HTMLDivElement): void {
    if (element.scrollHeight - element.clientHeight <= TRACE_SCROLL_THRESHOLD) return
    if (element.scrollTop > TRACE_TOP_THRESHOLD) return
    expandTracePage()
  }

  // When no explicit start is available, fall back to the earliest working
  // part timestamp so the timer keeps counting even at message boundaries.
  const effectiveStartTime = $derived(workingTraceStartTime(visibleParts, startTime))

  /** True only while a live session is streaming this trace. A restored trace
   *  (busy with the saved-activity note) is historical: its durations are
   *  frozen snapshots, never live wall-clock counts. */
  const liveActivity = $derived(busy && !rehydrated)

  // Live count of how long the agent has been working. Ticks every second
  // while the trace is genuinely live; a restored trace pins one snapshot so
  // the timer never keeps counting after the run it belonged to is over.
  const agentClock = new ElapsedTimer()
  $effect(() => {
    if (!busy || !effectiveStartTime) {
      agentClock.stop()
      return
    }
    if (liveActivity) agentClock.start()
    else {
      agentClock.stop()
      agentClock.snapshot()
    }
    return () => agentClock.stop()
  })

  const elapsed = $derived(busy && effectiveStartTime ? agentClock.seconds(effectiveStartTime) : 0)
  // Convert file:// image URLs to blob: Object URLs so attached images render
  // reliably in the Electron renderer.
  $effect(() => {
    if (!isOpen) return
    for (const part of visibleParts) {
      if (part.type === 'file' && isImageMime(part.mime) && part.url.startsWith('file://')) {
        void imageUrls.load(part.url, part.mime)
      }
    }
  })

  onDestroy(() => imageUrls.destroy())

  function notify(): void {
    onToggle?.(isOpen, userOpened)
  }

  $effect(() => {
    if (busy && visibleParts.length > 0) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      if (!isOpen) {
        isOpen = true
        notify()
      }
    } else if (done && !busy && wasLatest && !latest && isOpen && !userOpened) {
      // Turn finished and a newer turn superseded it   fold immediately.
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      isOpen = false
      notify()
    } else if (done && !busy && !latest && isOpen && !userOpened) {
      // Older completed turns fold after a short grace. The latest turn stays
      // open so a refreshed thread never hides its only context by default.
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      closeTimer = setTimeout(() => {
        isOpen = false
        closeTimer = null
        notify()
      }, 2000)
    }
    // A turn still in progress (done === false) never folds itself: a transient
    // busy=false from a harness activity blip must never hide the live trace.
    wasLatest = latest
  })

  function onTraceScroll(): void {
    const element = traceScrollEl
    if (!element) return
    traceAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= TRACE_SCROLL_THRESHOLD
    maybePageOlderEntries(element)
  }

  // New live parts follow the trace only while the user remains at its bottom.
  // A user scroll-up is preserved. Scroll chaining is left enabled: reaching the
  // top of a finished trace's inner scroller hands the gesture to the outer
  // conversation so it can lazy-load older messages (compaction boundaries do
  // not stop it). The tail-follow effect below keeps live output pinned while
  // the trace is busy, which is where containment actually mattered.
  $effect(() => {
    void visibleParts.length
    void isOpen
    void busy
    if (!isOpen || !traceScrollEl || !traceAtBottom) return
    void tick().then(() => {
      if (!traceScrollEl || !traceAtBottom) return
      traceScrollEl.scrollTop = traceScrollEl.scrollHeight
    })
  })

  $effect(() => {
    return () => {
      if (closeTimer) clearTimeout(closeTimer)
    }
  })

  function onSummaryClick(event: MouseEvent): void {
    event.preventDefault()
    isOpen = !isOpen
    userOpened = isOpen
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    notify()
  }

  let lastReasoningId = $derived.by((): string | null => {
    for (let i = visibleParts.length - 1; i >= 0; i--) {
      if (visibleParts[i].type === 'reasoning') return visibleParts[i].id
    }
    return null
  })
  const subagentParts = $derived(
    visibleParts.filter((part): part is SubagentPart => part.type === 'subagent')
  )
  const subagentCount = $derived(subagentParts.length)
  const runningSubagents = $derived(
    subagentParts.filter((part) => subagentIsRunning(part.activity))
  )
  const activeSubagentCount = $derived(runningSubagents.length)
  /** What the single running worker was asked to do, so the header badge can
   *  name the task instead of only counting heads. */
  const soleActiveTask = $derived(
    runningSubagents.length === 1 ? subagentTaskLabel(runningSubagents[0].activity) : null
  )
  const subagentBadgeTitleText = $derived(
    subagentBadgeTitle(soleActiveTask, subagentCount, activeSubagentCount)
  )
  const subagentBadgeLabelText = $derived(
    subagentBadgeLabel(soleActiveTask, activeSubagentCount, subagentCount)
  )
  const hasCompaction = $derived(
    visibleParts.some((part) => part.type === 'compaction' || part.type === 'compaction-summary')
  )

  // One clock for the whole dropdown list: it ticks only while a worker is
  // actually live, so a finished or restored list shows frozen durations.
  const listClock = new ElapsedTimer()
  $effect(() => {
    if (activeSubagentCount > 0 && liveActivity) listClock.start()
    else {
      listClock.stop()
      if (activeSubagentCount > 0) listClock.snapshot()
    }
    return () => listClock.stop()
  })

  function subagentElapsed(part: SubagentPart): number {
    return listClock.seconds(part.activity.time?.start, part.activity.time?.end)
  }

  // Touch devices get a bottom-sheet list instead of the hover-oriented
  // dropdown, whose small hit targets and portal positioning are unreliable
  // under a phone keyboard/viewport.
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  let subagentSheetOpen = $state(false)

  function subagentSheetItems(): MenuItem[] {
    return subagentParts.map((part) => ({
      label: `${subagentTaskLabel(part.activity)} - ${subagentStatusLabel(part.activity.status)}`,
      icon: Bot,
      onClick: () => onOpenSubagent?.(part)
    }))
  }
</script>

<details class="rounded-xl border border-border bg-surface" open={isOpen}>
  <WorkingTraceSummary
    open={isOpen}
    {busy}
    count={visibleParts.length}
    {hasCompaction}
    {subagentCount}
    {activeSubagentCount}
    {subagentParts}
    {coarsePointer}
    title={subagentBadgeTitleText}
    label={subagentBadgeLabelText}
    elapsedFor={subagentElapsed}
    onOpen={(part) => onOpenSubagent?.(part)}
    onOpenSheet={() => (subagentSheetOpen = true)}
    onToggle={onSummaryClick}
  />
  {#if isOpen}
    <div
      bind:this={traceScrollEl}
      class="max-h-[min(55vh,36rem)] overflow-y-auto overscroll-contain px-3 pb-3 [&>*:first-child]:mt-2 [&>*+*]:mt-2"
      onscroll={onTraceScroll}
    >
      {#each pagedParts as part (part.id)}
        <WorkingTraceRow
          {part}
          {busy}
          live={liveActivity}
          {lastReasoningId}
          {imageUrls}
          {onCiteFile}
          {projectId}
          {threadId}
          {checkpointId}
          {checkpointPaths}
          {onOpenSubagent}
        />
      {/each}
      {#if busy}
        <WorkingTraceStatus
          {rehydrated}
          {foreignRun}
          startTime={effectiveStartTime}
          {elapsed}
          {modelLabel}
          {isFast}
          {thinkingLevel}
          {providerName}
          {providerId}
          {harnessId}
          {harnessName}
          {accountLabel}
        />
      {/if}
    </div>
  {/if}
</details>

{#if coarsePointer}
  <ActionSheet
    open={subagentSheetOpen}
    title="Sub-agents"
    items={subagentSheetItems()}
    onClose={() => (subagentSheetOpen = false)}
  />
{/if}
