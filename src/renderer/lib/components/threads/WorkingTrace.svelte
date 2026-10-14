<script lang="ts">
  import { Bot } from '@lucide/svelte'
  import { onDestroy, tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import ActionSheet from '../ui/ActionSheet.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import type { AgentPart, ThinkingLevel } from '$shared/types'
  import type { OvenAppearance } from '$shared/ovens'
  import { isImageMime } from '$lib/mime'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import {
    groupTraceIntoChains,
    latestWorkingTraceParts,
    tracePartsSpan
  } from '$lib/working-trace-parts'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import {
    subagentIsRunning,
    subagentStatusLabel,
    subagentTaskLabel
  } from '$lib/subagent-presentation'
  import WorkingTraceChain from './WorkingTraceChain.svelte'
  import WorkingTraceStatus from './WorkingTraceStatus.svelte'
  import WorkingTraceSummary from './WorkingTraceSummary.svelte'
  import { subagentBadgeLabel, subagentBadgeTitle } from './working-trace-subagents'
  import { workingTraceStartTime } from './working-trace-start'

  interface Props {
    parts: AgentPart[]
    open?: boolean
    busy?: boolean
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
    /** What the app is doing before the harness streams, e.g. preparing a remote
     *  checkout or cloning a repository. */
    note?: string | null
    initialOpen?: boolean
    initialUserOpened?: boolean
    /** True when the user explicitly folded this turn's trace. A folded trace
     *  stays folded   it is never force-opened by the busy state or a remount
     *  until a new turn begins. */
    initiallyFolded?: boolean
    /** When the agent started working on this trace; used to show a live duration. */
    startTime?: number
    /** Attribution for the model currently working on this trace. */
    modelLabel?: string | null
    /** True while this trace is on screen. A hidden trace   the workspace keeps
     *  a thread mounted behind Settings/Scope and other views   does not pull
     *  its older durable pages, so coming back mounts what the reader is
     *  looking at instead of streaming in a turn nobody is reading. */
    active?: boolean
    /** Total thinking and tool steps the whole turn holds, from the durable
     *  fold. The header shows this even when only the newest window of steps is
     *  mounted, so the count states the turn's real size instead of climbing as
     *  older pages load. Zero when the turn's total is not known. */
    totalSteps?: number
    /** True when the durable stream holds entries older than the oldest this
     *  trace holds, so the top of the trace can pull another page. */
    olderPartsAvailable?: boolean
    /** Pull the next older durable page into this trace's parts. Called once per
     *  gesture at the trace's top, and to fill a trace whose content fits. */
    onLoadOlderParts?: () => void | Promise<void>
    /** Thinking level used for this trace's turn, when the model reasons. */
    thinkingLevel?: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
    accountLabel?: string | null
    accountId?: string | null
    ovenLabel?: string | null
    ovenIsLocal?: boolean
    ovenAppearance?: OvenAppearance
    isFast?: boolean
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
    onToggle?: (open: boolean, userOpened: boolean, userFolded: boolean) => void
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    onCiteFile?: (path: string, line?: number) => void
  }

  let {
    parts,
    open = false,
    busy = false,
    done = false,
    rehydrated = false,
    foreignRun = false,
    note = null,
    initialOpen = false,
    initialUserOpened = false,
    initiallyFolded = false,
    startTime,
    active = true,
    totalSteps = 0,
    olderPartsAvailable = false,
    onLoadOlderParts,
    modelLabel = null,
    thinkingLevel = null,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel,
    ovenLabel,
    ovenIsLocal,
    ovenAppearance,
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
  // A settled turn opens folded (its answer lives outside the trace), and a
  // trace the user opened themselves stays open.
  // svelte-ignore state_referenced_locally
  let isOpen = $state(initialUserOpened || (!done && !initiallyFolded && (open || initialOpen)))
  // svelte-ignore state_referenced_locally
  let userOpened = $state(initialUserOpened)
  // svelte-ignore state_referenced_locally
  let userFolded = $state(initiallyFolded)
  let imageUrls = new FileBlobUrlManager()
  const visibleParts = $derived(latestWorkingTraceParts(parts))
  /** How close to the trace scroller's bottom counts as "there". */
  const TRACE_SCROLL_THRESHOLD = 32
  /** The trace's own scroller. A tall trace caps its height and scrolls inside
   *  the transcript. */
  let traceScrollEl = $state<HTMLDivElement>()
  /** True while the reader is parked at the trace's bottom, where live output
   *  keeps following. A scroll-up pins their place and stops the follow. */
  let traceAtBottom = $state(true)
  /** The turn's trace as chains of thought, grouped from the mounted steps.
   *  A chain that produced an output is keyed by that output, which is the
   *  boundary that defines it, so paging older steps in above never remounts a
   *  chain or replays its fold. */
  const chains = $derived(groupTraceIntoChains(visibleParts))
  /** Thinking and tool steps currently mounted. */
  const mountedStepCount = $derived(visibleParts.filter((part) => part.type !== 'text').length)
  /** The header count: the whole turn's step total when the durable fold reports
   *  it, so a trace showing only its newest window still states the real size
   *  and the figure never climbs as older pages load. */
  const stepCount = $derived(Math.max(mountedStepCount, totalSteps))
  /** The trace's whole wall-clock span, from its earliest entry to its latest. */
  const traceSpan = $derived(tracePartsSpan(visibleParts))
  /** True while an older page is in flight, so one gesture pulls exactly one
   *  page. Plain, not reactive: only the DOM handlers read it and nothing
   *  renders from it. */
  let loadingOlderParts = false
  /** True while the reader is parked at the trace's top, so reaching the top
   *  pulls one page and staying there does not pull a page per scroll event. */
  let atTraceTop = false
  /** How close to the trace's top counts as reaching for older steps. */
  const TRACE_TOP_REACH = 24

  /** Pull the next older page and hold the reader's place across the prepend:
   *  the added rows land above what is on screen, so the scroller is moved down
   *  by exactly the height they added. Scroll anchoring is off for this scroller
   *  (see the style block), so this is the only correction applied. */
  async function pullOlderPage(): Promise<void> {
    const element = traceScrollEl
    if (!element || loadingOlderParts || !olderPartsAvailable || !onLoadOlderParts) return
    loadingOlderParts = true
    const previousHeight = element.scrollHeight
    try {
      await onLoadOlderParts()
    } catch {
      // A failed page read leaves the reader where they are; the next gesture
      // tries again.
    } finally {
      loadingOlderParts = false
    }
    await tick()
    if (!traceScrollEl) return
    traceScrollEl.scrollTop += traceScrollEl.scrollHeight - previousHeight
  }

  /** Track the trace's own scroll: remember whether the reader is at the bottom,
   *  where live output keeps following, and pull an older page when they reach
   *  the top. */
  function onTraceScroll(): void {
    const element = traceScrollEl
    if (!element) return
    traceAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= TRACE_SCROLL_THRESHOLD
    if (element.scrollTop <= TRACE_TOP_REACH) {
      if (!atTraceTop) {
        atTraceTop = true
        void pullOlderPage()
      }
      return
    }
    atTraceTop = false
  }

  // A trace that fits its box hides the older steps behind no scrollbar, so fill
  // the visible height: pull one page at a time until the box scrolls or the
  // turn's older entries run out. Bounded by the box height, never the turn, so
  // a long turn still opens on a fraction of its steps.
  $effect(() => {
    void visibleParts.length
    void isOpen
    void olderPartsAvailable
    if (!isOpen || !active || !olderPartsAvailable || !onLoadOlderParts) return
    const element = traceScrollEl
    if (!element) return
    if (element.scrollHeight - element.clientHeight > 1) return
    void pullOlderPage()
  })

  // New live parts follow the trace only while the reader remains at its
  // bottom. A scroll-up is preserved, and a collapsed or hidden trace mounts
  // nothing to follow.
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
  /** The trace's total duration in seconds: the live clock while it works, the
   *  frozen span once it settles. Null when no entry reported a timestamp. */
  const totalDurationSeconds = $derived.by((): number | null => {
    if (busy && effectiveStartTime) return elapsed
    if (traceSpan && effectiveStartTime) {
      return Math.max(0, (traceSpan.end - effectiveStartTime) / 1000)
    }
    if (traceSpan) return (traceSpan.end - traceSpan.start) / 1000
    return null
  })
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
    onToggle?.(isOpen, userOpened, userFolded)
  }

  $effect(() => {
    // A live turn keeps its work on screen; a trace the user explicitly folded
    // stays folded while it works, so a harness busy blip never re-opens it.
    if (busy && visibleParts.length > 0) {
      if (!isOpen && !userFolded) {
        isOpen = true
        notify()
      }
      return
    }
    // The moment the turn settles, its answer is already outside the trace, so
    // the log folds itself by default and the reader opens it for the detail.
    // A trace the user opened is left exactly as they left it. A turn still in
    // progress (done === false) never folds.
    if (done && !busy && isOpen && !userOpened) {
      isOpen = false
      notify()
    }
  })

  function onSummaryClick(event: MouseEvent): void {
    event.preventDefault()
    isOpen = !isOpen
    userOpened = isOpen
    userFolded = !isOpen
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
  // on a touch device with a soft keyboard.
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

<div class="min-w-0">
  <WorkingTraceSummary
    open={isOpen}
    live={liveActivity}
    count={stepCount}
    durationSeconds={totalDurationSeconds}
    {hasCompaction}
    {subagentCount}
    {activeSubagentCount}
    {subagentParts}
    {coarsePointer}
    title={subagentBadgeTitleText}
    label={subagentBadgeLabelText}
    elapsedFor={subagentElapsed}
    {modelLabel}
    {isFast}
    {thinkingLevel}
    {providerName}
    {providerId}
    {harnessId}
    {harnessName}
    {accountLabel}
    {ovenLabel}
    {ovenIsLocal}
    {ovenAppearance}
    onOpen={(part) => onOpenSubagent?.(part)}
    onOpenSheet={() => (subagentSheetOpen = true)}
    onToggle={onSummaryClick}
  />
  {#if isOpen}
    <div
      bind:this={traceScrollEl}
      transition:slide={foldSlide()}
      class="trace-scroll flex max-h-[min(75vh,48rem)] min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-2"
      onscroll={onTraceScroll}
    >
      {#each chains as chain, index (chain.id)}
        <WorkingTraceChain
          {chain}
          active={liveActivity && index === chains.length - 1}
          showHeader={chains.length > 1 || chain.output !== null}
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
      {#if busy && (foreignRun || rehydrated || note)}
        <WorkingTraceStatus {rehydrated} {foreignRun} {note} />
      {/if}
    </div>
  {/if}
</div>

{#if coarsePointer}
  <ActionSheet
    open={subagentSheetOpen}
    title="Sub-agents"
    items={subagentSheetItems()}
    onClose={() => (subagentSheetOpen = false)}
  />
{/if}

<style>
  /* The trace owns its scroll position: it pages older steps in at the top as
     the reader scrolls and compensates by hand. Chromium's scroll anchoring is
     off so it never applies a second, competing correction when a page lands or
     a fold opens. */
  .trace-scroll {
    overflow-anchor: none;
  }
</style>
