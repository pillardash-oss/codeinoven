<script lang="ts">
  import {
    Archive,
    Bot,
    Brain,
    CheckCircle2,
    Clock,
    Cog,
    FileText,
    Layers3,
    Loader2,
    RefreshCw,
    XCircle,
    Zap
  } from '@lucide/svelte'
  import { onDestroy, tick } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import ToolCard from './ToolCard.svelte'
  import SubagentCard from './SubagentCard.svelte'
  import ThinkingBlock from './ThinkingBlock.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import ActionSheet from '../ui/ActionSheet.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import type { AgentPart, AgentToolStatus, ThinkingLevel } from '$shared/types'
  import { isImageMime } from '$lib/mime'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { latestWorkingTraceParts } from '$lib/working-trace-parts'

  interface Props {
    parts: AgentPart[]
    open?: boolean
    busy?: boolean
    latest?: boolean
    /** True once this trace's turn produced a completed assistant message — the
     *  only condition under which the trace may fold itself. */
    done?: boolean
    /** True when this trace was rehydrated from persisted state because no live
     *  session activity is confirming the run. Renders a saved-activity note
     *  instead of a live "Agent working…" spinner. */
    rehydrated?: boolean
    initialOpen?: boolean
    initialUserOpened?: boolean
    /** When the agent started working on this trace; used to show a live duration. */
    startTime?: number
    /** Attribution for the model currently working on this trace. */
    modelLabel?: string | null
    /** Thinking level used for this trace's turn, when the model reasons. */
    thinkingLevel?: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
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
    initialOpen = false,
    initialUserOpened = false,
    startTime,
    modelLabel = null,
    thinkingLevel = null,
    providerName,
    providerId,
    harnessId,
    harnessName,
    isFast = false,
    projectId,
    threadId,
    checkpointId = null,
    checkpointPaths = [],
    onToggle,
    onOpenSubagent,
    onCiteFile
  }: Props = $props()

  // Intentional initial-value capture — props are only used to seed local state.
  // svelte-ignore state_referenced_locally
  let isOpen = $state(open || initialOpen)
  // svelte-ignore state_referenced_locally
  let userOpened = $state(initialUserOpened)
  // svelte-ignore state_referenced_locally
  let wasLatest = $state(latest)
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let imageUrls = new FileBlobUrlManager()
  let elapsed = $state(0)
  const visibleParts = $derived(latestWorkingTraceParts(parts))
  const TRACE_SCROLL_THRESHOLD = 32
  let traceScrollEl = $state<HTMLDivElement>()
  let traceAtBottom = $state(true)
  /** The trace renders its own pagination: the newest 15 entries first, and
   *  one older page (15 more) whenever the reader scrolls the trace's inner
   *  scroller until the ante-penultimate rendered item is in view. The header
   *  count always reflects the FULL entry count — the window limits what
   *  mounts, never what is reported. Entries come from the already-loaded
   *  message cache, so paging here costs no IPC. */
  const TRACE_PAGE_SIZE = 15
  let traceWindow = $state(TRACE_PAGE_SIZE)
  /** A live turn streams UNBOUNDED: every entry renders the instant it lands
   *  so wrong direction can be caught and steered early. The 15-entry page
   *  applies to finished traces (history), which load older pages lazily on
   *  inner scroll. When the turn folds on completion, pagination restarts. */
  const pagedParts = $derived(
    busy ? visibleParts : visibleParts.slice(Math.max(0, visibleParts.length - traceWindow))
  )

  $effect(() => {
    if (!busy) traceWindow = TRACE_PAGE_SIZE
  })

  /** Prepend one older page of trace entries, keeping the reader's viewport
   *  stable across the mount (same compensation the conversation list uses). */
  function expandTracePage(): void {
    if (traceWindow >= visibleParts.length) return
    const el = traceScrollEl
    const previousHeight = el?.scrollHeight ?? 0
    const previousTop = el?.scrollTop ?? 0
    traceWindow = Math.min(visibleParts.length, traceWindow + TRACE_PAGE_SIZE)
    void tick().then(() => {
      if (!el) return
      const grown = el.scrollHeight - previousHeight
      if (grown > 0) el.scrollTop = previousTop + grown
    })
  }

  /** Load the next older page once the ante-penultimate rendered entry
   *  (third from the top of the current window) enters the scroller's view. */
  function maybeExpandOlderEntries(element: HTMLDivElement): void {
    if (busy || traceWindow >= visibleParts.length) return
    const third = element.children[2] as HTMLElement | undefined
    if (!third) return
    const scrollerRect = element.getBoundingClientRect()
    const thirdRect = third.getBoundingClientRect()
    const visibleInScroller =
      thirdRect.bottom > scrollerRect.top && thirdRect.top < scrollerRect.bottom
    if (visibleInScroller) expandTracePage()
  }

  // When no explicit start is available, fall back to the earliest working
  // part timestamp so the timer keeps counting even at message boundaries.
  const effectiveStartTime = $derived.by((): number | undefined => {
    if (startTime && startTime > 0) return startTime
    for (const part of visibleParts) {
      const start =
        part.type === 'tool'
          ? part.state.time?.start
          : part.type === 'reasoning'
            ? part.time?.start
            : part.type === 'subagent'
              ? part.activity.time?.start
              : undefined
      if (start && start > 0) return start
    }
    return undefined
  })

  /** True only while a live session is streaming this trace. A restored trace
   *  (busy with the saved-activity note) is historical: its durations are
   *  frozen snapshots, never live wall-clock counts. */
  const liveActivity = $derived(busy && !rehydrated)

  // Live count of how long the agent has been working. Ticks every second
  // while the trace is genuinely live; a restored trace snapshots once so the
  // timer never keeps counting after the run it belonged to is over.
  $effect(() => {
    if (!busy || !effectiveStartTime) {
      elapsed = 0
      return
    }
    if (!liveActivity) {
      if (elapsed === 0) {
        elapsed = Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000))
      }
      return
    }
    elapsed = Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000))
    const interval = setInterval(() => {
      elapsed = Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  })

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }

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
      // Turn finished and a newer turn superseded it — fold immediately.
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
    maybeExpandOlderEntries(element)
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
  type SubagentPart = Extract<AgentPart, { type: 'subagent' }>
  const subagentParts = $derived(
    visibleParts.filter((part): part is SubagentPart => part.type === 'subagent')
  )
  const subagentCount = $derived(subagentParts.length)
  const activeSubagentCount = $derived(
    subagentParts.filter((part) => part.activity.status === 'running').length
  )
  const hasCompaction = $derived(
    visibleParts.some((part) => part.type === 'compaction' || part.type === 'compaction-summary')
  )

  // Live clock for the sub-agent dropdown list — ticks only while any sub-agent is running.
  let listNow = $state(0)
  $effect(() => {
    if (subagentParts.every((part) => part.activity.status !== 'running')) {
      listNow = 0
      return
    }
    listNow = Date.now()
    const interval = setInterval(() => {
      listNow = Date.now()
    }, 1000)
    return () => clearInterval(interval)
  })

  function subagentElapsed(part: SubagentPart): number {
    const start = part.activity.time?.start
    if (!start) return 0
    const end = part.activity.time?.end
    return Math.max(0, Math.floor(((end ?? (listNow || Date.now())) - start) / 1000))
  }

  function subagentStatusLabel(status: AgentToolStatus): string {
    if (status === 'running') return 'Working'
    if (status === 'completed') return 'Completed'
    if (status === 'error') return 'Failed'
    return 'Starting'
  }

  // Touch devices get a bottom-sheet list instead of the hover-oriented
  // dropdown, whose small hit targets and portal positioning are unreliable
  // under a phone keyboard/viewport.
  const coarsePointer =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  let subagentSheetOpen = $state(false)

  function subagentSheetItems(): MenuItem[] {
    return subagentParts.map((part) => ({
      label: `${part.activity.agent || 'Sub-agent'} — ${
        part.activity.description || subagentStatusLabel(part.activity.status)
      }`,
      icon: Bot,
      onClick: () => onOpenSubagent?.(part)
    }))
  }
</script>

<details class="rounded-xl border border-border bg-surface" open={isOpen}>
  <summary
    class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
    onclick={onSummaryClick}
  >
    {#if isOpen && busy}
      <Loader2 size={12} class="shrink-0 animate-spin text-info" />
    {:else}
      <Cog size={12} class="shrink-0" />
    {/if}
    Working Trace
    <span class="tabular-nums text-dimmed">({visibleParts.length})</span>
    {#if hasCompaction || subagentCount > 0}
      <span class="ml-auto flex items-center gap-1.5">
        {#if hasCompaction}
          <span
            class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[9px] text-info"
            title="This trace includes compacted context. Forking from here restores the compaction summary."
            aria-label="Compacted context. Forking from here restores the compaction summary."
          >
            <Archive size={10} />
            Compacted
          </span>
        {/if}
        {#if subagentCount > 0}
          {#if coarsePointer}
            <button
              type="button"
              class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-1 text-[9px] text-info transition-colors active:bg-info/20"
              aria-label={`${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'} spawned — open list`}
              title={`${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'} spawned — open list`}
              onclick={(e: MouseEvent) => {
                e.preventDefault()
                e.stopPropagation()
                subagentSheetOpen = true
              }}
            >
              <Bot size={10} />
              {#if activeSubagentCount > 0}
                {activeSubagentCount} active · {subagentCount} total
              {:else}
                {subagentCount} {subagentCount === 1 ? 'sub-agent' : 'sub-agents'}
              {/if}
            </button>
          {:else}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[9px] text-info transition-colors hover:bg-info/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                aria-label={`${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'} spawned — open list`}
                title={`${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'} spawned — open list`}
                onclick={(e: MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                <Bot size={10} />
                {#if activeSubagentCount > 0}
                  {activeSubagentCount} active · {subagentCount} total
                {:else}
                  {subagentCount} {subagentCount === 1 ? 'sub-agent' : 'sub-agents'}
                {/if}
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="end"
                  sideOffset={6}
                  collisionPadding={8}
                  class="z-50 w-80 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                >
                  <div class="flex items-center gap-1.5 px-2.5 py-1.5">
                    <Bot size={12} class="shrink-0 text-info" />
                    <span class="text-[11px] font-semibold text-foreground">
                      {subagentCount}
                      {subagentCount === 1 ? 'sub-agent' : 'sub-agents'}
                    </span>
                    {#if activeSubagentCount > 0}
                      <span class="text-[10px] text-dimmed">
                        · {activeSubagentCount} running
                      </span>
                    {/if}
                  </div>
                  <DropdownMenu.Separator class="mx-1 my-1 h-px bg-border" />
                  <div class="max-h-60 overflow-y-auto p-0.5">
                    {#each subagentParts as part (part.id)}
                      {@const status = part.activity.status}
                      <DropdownMenu.Item
                        class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => onOpenSubagent?.(part)}
                      >
                        {#if status === 'running'}
                          <Loader2 size={13} class="shrink-0 animate-spin text-info" />
                        {:else if status === 'completed'}
                          <CheckCircle2 size={13} class="shrink-0 text-success" />
                        {:else if status === 'error'}
                          <XCircle size={13} class="shrink-0 text-danger" />
                        {:else}
                          <Clock size={13} class="shrink-0 text-dimmed" />
                        {/if}
                        <span class="shrink-0 text-[11px] font-semibold text-foreground">
                          {part.activity.agent || 'Sub-agent'}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-[11px] text-muted">
                          {part.activity.description}
                        </span>
                        {#if part.activity.background}
                          <span
                            class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[9px] text-dimmed"
                          >
                            <Layers3 size={9} />
                            Background
                          </span>
                        {/if}
                        {#if part.activity.time?.start}
                          <span class="shrink-0 tabular-nums text-[10px] text-dimmed">
                            {formatDuration(subagentElapsed(part))}
                          </span>
                        {/if}
                        <span
                          class="shrink-0 text-[10px] {status === 'error'
                            ? 'text-danger'
                            : status === 'running'
                              ? 'text-info'
                              : 'text-dimmed'}"
                        >
                          {subagentStatusLabel(status)}
                        </span>
                      </DropdownMenu.Item>
                    {/each}
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        {/if}
      </span>
    {/if}
  </summary>
  {#if isOpen}
    <div
      bind:this={traceScrollEl}
      class="max-h-[min(55vh,36rem)] overflow-y-auto overscroll-contain px-3 pb-3 [&>*:first-child]:mt-2 [&>*+*]:mt-2"
      onscroll={onTraceScroll}
    >
      {#each pagedParts as part (part.id)}
        {#if part.type === 'reasoning'}
          <ThinkingBlock
            {part}
            active={busy && part.id === lastReasoningId}
            live={liveActivity}
            {onCiteFile}
          />
        {:else if part.type === 'tool'}
          <ToolCard
            {part}
            live={liveActivity}
            {projectId}
            {threadId}
            {checkpointId}
            {checkpointPaths}
          />
        {:else if part.type === 'subagent'}
          <SubagentCard {part} live={liveActivity} onOpen={onOpenSubagent} />
        {:else if part.type === 'text'}
          <div class="text-sm text-foreground">
            <MarkdownView text={part.text} {onCiteFile} />
          </div>
        {:else if part.type === 'compaction-summary'}
          <div class="rounded-lg border border-border bg-elevated px-3 py-2">
            <p class="mb-1 text-[11px] font-medium text-foreground">Compaction summary</p>
            <div class="text-sm text-muted">
              <MarkdownView text={part.text} {onCiteFile} />
            </div>
          </div>
        {:else if part.type === 'step-finish'}
          {#if part.reason}
            <span class="text-[10px] text-dimmed">Step complete · {part.reason}</span>
          {/if}
        {:else if part.type === 'compaction'}
          <details class="rounded-lg border border-border bg-elevated">
            <summary
              class="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-overlay"
            >
              {#if busy && !part.summary}
                <Loader2 size={12} class="shrink-0 animate-spin text-info" />
              {:else}
                <Archive size={12} class="shrink-0 text-info" />
              {/if}
              <div class="min-w-0">
                <p
                  class="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-foreground"
                >
                  {part.auto ? 'Automatic compaction' : 'Compact Work'}
                  {#if !part.summary && !busy}
                    <span
                      class="rounded-md bg-warning/10 px-1.5 py-0.5 text-[9px] font-normal text-warning"
                      title="The harness completed compaction without producing a summary."
                    >
                      harness returned nothing
                    </span>
                  {/if}
                </p>
                <p class="text-[10px] text-dimmed">
                  {part.summary
                    ? 'Earlier work summarized'
                    : part.overflow
                      ? 'Context limit reached · summarizing earlier work'
                      : 'Summarizing earlier work to free context'}
                </p>
              </div>
            </summary>
            {#if part.summary}
              <div class="border-t border-border px-3 py-2 text-sm text-muted">
                <MarkdownView text={part.summary} {onCiteFile} />
              </div>
            {/if}
          </details>
        {:else if part.type === 'file'}
          <div class="flex items-center gap-1.5 text-[10px] text-dimmed">
            {#if isImageMime(part.mime)}
              <img
                src={imageUrls.getUrl(part.url)}
                alt={part.filename ?? 'file'}
                class="h-6 w-6 shrink-0 rounded object-cover"
                onerror={(e: Event) =>
                  void imageUrls.bindImage(
                    part.url,
                    part.mime,
                    e.currentTarget as HTMLImageElement
                  )}
              />
            {:else}
              <FileText size={10} class="shrink-0" />
            {/if}
            {part.filename ?? part.url.split('/').pop() ?? 'file'}
          </div>
        {/if}
      {/each}
      {#if busy}
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          {#if rehydrated}
            <span class="flex min-w-0 shrink items-center gap-2">
              <RefreshCw size={11} class="shrink-0 text-info" />
              <span class="shrink-0 text-[10px] text-info/80">
                Showing last saved activity · live run not confirmed
              </span>
              {#if effectiveStartTime}
                <span class="shrink-0 tabular-nums text-[10px] text-info/80">
                  · {formatDuration(elapsed)}
                </span>
              {/if}
            </span>
          {:else}
            <span class="flex min-w-0 shrink items-center gap-2">
              <Loader2 size={11} class="shrink-0 animate-spin text-info" />
              <span class="shrink-0 text-[10px] text-info/80">Agent working…</span>
              {#if effectiveStartTime}
                <span class="shrink-0 tabular-nums text-[10px] text-info/80">
                  · {formatDuration(elapsed)}
                </span>
              {/if}
            </span>
          {/if}
          {#if modelLabel}
            <span
              class="flex min-w-0 items-center gap-1.5 text-[10px] text-dimmed max-sm:basis-full max-sm:pl-[18px] max-sm:text-[9px] sm:ml-auto"
            >
              {#if harnessId}
                <span class="flex shrink-0 items-center gap-1">
                  <AgentIcon agentId={harnessId} size={14} />
                  {#if harnessName}<span class="truncate">{harnessName}</span>{/if}
                </span>
                <span>·</span>
              {/if}
              <span class="flex shrink-0 items-center gap-1">
                <VendorIcon
                  name={providerName ?? modelLabel}
                  id={providerId ?? undefined}
                  size={11}
                />
                <span class="truncate">{modelLabel}</span>
              </span>
              {#if isFast}
                <Zap
                  size={10}
                  class="shrink-0 text-accent"
                  fill="currentColor"
                  aria-label="Fast inference"
                  title="Fast inference"
                />
              {/if}
              {#if thinkingLevel}
                <span
                  class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[9px] capitalize text-muted"
                  title={`Thinking level: ${thinkingLevel}`}
                  aria-label={`Thinking level: ${thinkingLevel}`}
                >
                  <Brain size={9} />
                  {thinkingLevel}
                </span>
              {/if}
            </span>
          {/if}
        </div>
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
