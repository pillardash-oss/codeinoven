<script lang="ts">
  import { Bot } from '@lucide/svelte'
  import { onDestroy, tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import ActionSheet from '../ui/ActionSheet.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import { isCodeModeToolName } from '$shared/agent-interactions'
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
    /** True when the durable stream holds entries older than the oldest this
     *  trace holds, so the trace is still missing part of its turn. */
    olderPartsAvailable?: boolean
    /** Pull the next older durable page into this trace's parts. The trace
     *  calls it on open until `olderPartsAvailable` is false, so the whole
     *  structure exists before it is grouped. */
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
    olderPartsAvailable = false,
    onLoadOlderParts,
    modelLabel = null,
    thinkingLevel = null,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel,
    accountId,
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
  /** The turn's trace as chains of thought, grouped from the complete part list
   *  in one pass. Grouping everything at once is what keeps the structure
   *  stable: a trace that grouped only its newest page reorganized itself as
   *  older entries arrived   a flat run of steps turning into folded chains
   *  which broke the reader's place. */
  const chains = $derived(groupTraceIntoChains(visibleParts))
  /** How much thinking and tool work the whole trace holds, for the header count. */
  const stepCount = $derived(visibleParts.filter((part) => part.type !== 'text').length)
  /** The trace's whole wall-clock span, from its earliest entry to its latest. */
  const traceSpan = $derived(tracePartsSpan(visibleParts))
  /** True while the rest of this turn's durable stream is being pulled in. A
   *  plain flag, not reactive state: the effect below re-runs on the part list
   *  growing, so writing it back must not schedule the effect itself. */
  let loadingOlderParts = false

  /** Pull the rest of this turn's durable stream in as soon as the trace is
   *  open. The whole structure is grouped in one pass, so the header count and
   *  every chain header are complete the moment the trace appears instead of
   *  rebuilding themselves as the reader scrolls. One page per call, so a long
   *  turn never blocks a frame; the loader stops when the turn's oldest entry
   *  is mounted. */
  $effect(() => {
    // Re-run as each page lands, and while the trace is open on screen.
    void visibleParts.length
    if (!isOpen || !active || !olderPartsAvailable || !onLoadOlderParts) return
    if (loadingOlderParts) return
    loadingOlderParts = true
    void Promise.resolve(onLoadOlderParts())
      .catch(() => {})
      .finally(() => {
        loadingOlderParts = false
      })
  })

  /** Track the trace's own scroll: remember whether the reader is at the bottom,
   *  where live output keeps following. */
  function onTraceScroll(): void {
    const element = traceScrollEl
    if (!element) return
    traceAtBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= TRACE_SCROLL_THRESHOLD
  }

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

  // Code mode is per-part and harness-independent: the driver marks a script
  // call and every call it made, and the shared predicate covers harnesses
  // that report their script runner by name alone.
  const hasCodeMode = $derived(
    visibleParts.some(
      (part) => part.type === 'tool' && (part.codeMode === true || isCodeModeToolName(part.tool))
    )
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
    {busy}
    count={stepCount}
    durationSeconds={totalDurationSeconds}
    {hasCompaction}
    {hasCodeMode}
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
      {#if busy}
        <WorkingTraceStatus
          {rehydrated}
          {foreignRun}
          {note}
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
          {accountId}
          {ovenLabel}
          {ovenIsLocal}
          {ovenAppearance}
        />
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
  /* The trace mounts its whole structure up front, so its scroll position is
     its own. Chromium's scroll anchoring is left off so a fold or unfold inside
     never shifts the reader. */
  .trace-scroll {
    overflow-anchor: none;
  }
</style>
