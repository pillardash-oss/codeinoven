<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
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
    /**
     * When this trace's turn closed, when the caller knows it.
     *
     * A folded trace mounts no entries, so it has no span of its own to measure:
     * a settled turn reports its duration from its own close instead of from
     * whatever window happens to be on screen.
     */
    endTime?: number
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
    /** Rewrites a chain's output before it is drawn. A conversation whose text
     *  carries app machinery (an assistant authoring turn) hands its own
     *  filter here, so a step's text reads like the turn's answer does. */
    formatOutput?: (text: string) => string
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
    endTime,
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
    onCiteFile,
    formatOutput
  }: Props = $props()

  // Intentional initial-value capture   props are only used to seed local state.
  // Only a trace that is live right now may mount open, and only when the reader
  // has not folded it. Everything else   a settled turn, and a turn whose
  // completion was never recorded because the run was cut short (an app quit or
  // restart mid-turn leaves `done` false for a turn that is no longer working)
  //   mounts folded instead of staying expanded forever.
  // svelte-ignore state_referenced_locally
  let isOpen = $state(
    initialUserOpened || (busy && !done && !initiallyFolded && (open || initialOpen))
  )
  // svelte-ignore state_referenced_locally
  let userOpened = $state(initialUserOpened)
  // svelte-ignore state_referenced_locally
  let userFolded = $state(initiallyFolded)
  /** True once this mount has carried live work. A trace that was live and is
   *  not any more has settled, whether or not the turn reported its completion.
   *  Plain, not reactive: only the run-state effect below reads it. */
  let sawLiveWork = false
  let imageUrls = new FileBlobUrlManager()
  const visibleParts = $derived(latestWorkingTraceParts(parts))
  /** The trace's root. It exists only to find the transcript scroller the trace
   *  lives in, because the trace no longer owns a scroller of its own. */
  let traceRootEl = $state<HTMLDivElement>()
  /** The trace body. Its oldest mounted child is the sentinel that older pages
   *  load above once the reader reaches the top of the mounted work. */
  let traceBodyEl = $state<HTMLDivElement>()
  /** The transcript scroller that now drives the trace's own scrolling. */
  const scrollRoot = $derived(traceRootEl?.closest('.conversation-scroll') ?? null)
  /** The sticky header's measured height, published as a custom property so a
   *  chain's fold header pins directly beneath it instead of under it. */
  let traceHeaderHeight = $state(0)
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
  /** True while an older page is in flight, so one arrival loads exactly one
   *  page. Plain, not reactive: only the scroll handler reads it and nothing
   *  renders from it. */
  let loadingOlderParts = false
  /** Latched while the oldest mounted step sits in the top zone, so standing
   *  there does not load a page per scroll event. */
  let atTraceTop = false
  /** How close to the header the oldest mounted step counts as the top. */
  const TRACE_TOP_REACH = 48

  /** Pull the next older page and hold the reader's place across the prepend.
   *  The added rows land above what is on screen, so the transcript scroller is
   *  moved down by exactly the height they added. The transcript turns native
   *  scroll anchoring off, so this is the only correction applied. */
  async function pullOlderPage(): Promise<void> {
    const root = scrollRoot
    if (!root || loadingOlderParts || !olderPartsAvailable || !onLoadOlderParts) return
    loadingOlderParts = true
    const previousHeight = root.scrollHeight
    try {
      await onLoadOlderParts()
    } catch {
      // A failed page read leaves the reader where they are; the next gesture
      // tries again.
    } finally {
      loadingOlderParts = false
    }
    await tick()
    const scroller = scrollRoot
    if (!scroller) return
    scroller.scrollTop += scroller.scrollHeight - previousHeight
  }

  /** True while the oldest mounted step sits just under the trace header, where
   *  the reader has reached the top of the loaded work. The body's current first
   *  child is the sentinel: once a page lands above it the sentinel is pushed
   *  out of the zone, which is what stops one arrival loading page after page. */
  function traceTopReached(): boolean {
    const root = scrollRoot
    const body = traceBodyEl
    if (!root || !body) return false
    const oldest = body.firstElementChild
    if (!oldest) return false
    const offset = oldest.getBoundingClientRect().top - root.getBoundingClientRect().top
    return offset >= traceHeaderHeight - 4 && offset <= traceHeaderHeight + TRACE_TOP_REACH
  }

  /** Fold the trace so its header keeps the screen position it already had.
   *  While the body is mounted and the reader is inside it the header is pinned
   *  to the top of the transcript, so collapsing the body without touching the
   *  scroller would throw the header off the top and drop the reader wherever
   *  that scroll offset now lands. Moving the scroller to the header's own
   *  content offset leaves the header exactly where the eye last saw it and
   *  slides the work below up to meet it. A reader parked below the trace on the
   *  answer, or already above the header, keeps their place. */
  function foldToHeader(): void {
    const root = scrollRoot
    const trace = traceRootEl
    if (!root || !trace) return
    const rootRect = root.getBoundingClientRect()
    const headerOffset = trace.getBoundingClientRect().top - rootRect.top + root.scrollTop
    const body = traceBodyEl
    if (body) {
      const bodyBottom = body.getBoundingClientRect().bottom - rootRect.top + root.scrollTop
      if (root.scrollTop > bodyBottom) return
    }
    if (root.scrollTop <= headerOffset) return
    root.scrollTop = headerOffset
  }

  // The transcript scroller drives this trace now. Reaching the top of the
  // mounted work on a scroll-up loads one older page; following the live tail
  // and keeping the reader's place across content growth stay the transcript's
  // job, so nothing scrolls this trace by hand any more.
  $effect(() => {
    const root = scrollRoot
    if (!root || !isOpen || !active || !olderPartsAvailable || !onLoadOlderParts) return
    let previousTop = root.scrollTop
    const onScroll = (): void => {
      const top = root.scrollTop
      const scrolledUp = top < previousTop
      previousTop = top
      if (!scrolledUp) return
      if (!isOpen) return
      if (!traceTopReached()) {
        atTraceTop = false
        return
      }
      if (atTraceTop) return
      atTraceTop = true
      void pullOlderPage()
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  })

  // A trace whose work fits the transcript leaves older steps behind no scroll
  // at all, so fill the visible height one page at a time until the transcript
  // scrolls or the turn's older entries run out. Bounded by the viewport, never
  // the turn, so a long turn still opens on a fraction of its steps.
  $effect(() => {
    void visibleParts.length
    void isOpen
    void olderPartsAvailable
    if (!isOpen || !active || !olderPartsAvailable || !onLoadOlderParts) return
    const root = scrollRoot
    const body = traceBodyEl
    if (!root || !body) return
    if (root.scrollHeight - root.clientHeight > 1) return
    // A trace scrolled out of view above the reader is not filled: nobody is
    // reading it, and it would pull pages for a turn that is not on screen.
    if (body.getBoundingClientRect().top >= root.getBoundingClientRect().bottom) return
    void pullOlderPage()
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
    const spanEnd = traceSpan?.end ?? endTime
    if (spanEnd !== undefined && effectiveStartTime) {
      return Math.max(0, (spanEnd - effectiveStartTime) / 1000)
    }
    if (spanEnd !== undefined && traceSpan) return (spanEnd - traceSpan.start) / 1000
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
    if (busy) {
      sawLiveWork = true
      if (visibleParts.length > 0 && !isOpen && !userFolded) {
        isOpen = true
        notify()
      }
      return
    }
    // The moment the run settles, its answer is already outside the trace, so
    // the log folds itself by default and the reader opens it for the detail.
    // Settled is decided by the run stopping, not only by the turn reporting its
    // completion: an interrupted turn, and a run the app quit in the middle of,
    // leave `done` false for work that has stopped, and that is exactly the
    // expanded trace a settled thread must not keep showing. A trace the user
    // opened is left exactly as they left it.
    if ((done || sawLiveWork) && isOpen && !userOpened) {
      foldToHeader()
      isOpen = false
      notify()
    }
  })

  function onSummaryClick(event: MouseEvent): void {
    event.preventDefault()
    if (isOpen) foldToHeader()
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
      icon: CioSubagent,
      onClick: () => onOpenSubagent?.(part)
    }))
  }
</script>

<div class="min-w-0" bind:this={traceRootEl} style="--cio-trace-header-h: {traceHeaderHeight}px">
  <!-- The header pins to the transcript's top while the reader scrolls through
       this trace's work, so folding it is always one click away without a
       scroll back. The body is the transcript's now: one scroller, not two. -->
  <div class="sticky top-0 z-20 bg-app" bind:clientHeight={traceHeaderHeight}>
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
  </div>
  {#if isOpen}
    <div
      bind:this={traceBodyEl}
      transition:slide={foldSlide()}
      class="flex min-w-0 flex-col gap-2 pb-2"
    >
      {#each chains as chain, index (chain.id)}
        <WorkingTraceChain
          {chain}
          {formatOutput}
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
