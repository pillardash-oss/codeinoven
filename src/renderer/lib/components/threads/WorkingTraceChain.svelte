<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationMs } from '$lib/format/duration'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { traceChainMarkers, traceChainSpan, type TraceChain } from '$lib/working-trace-parts'
  import type { AgentPart } from '$shared/types'
  import DeferredMarkdownView from '../markdown/DeferredMarkdownView.svelte'
  import WorkingTraceRow from './WorkingTraceRow.svelte'

  interface Props {
    chain: TraceChain
    /** True for the newest chain, the one still receiving work. */
    active: boolean
    /** False for a trace that holds a single chain, where the fold header would
     *  only repeat the trace's own header. */
    showHeader: boolean
    /** True while this trace's turn is still streaming. */
    busy: boolean
    /** True only while a live session is streaming, never for restored traces. */
    live: boolean
    /** The newest reasoning entry, which shows the active thinking state. */
    lastReasoningId: string | null
    imageUrls: FileBlobUrlManager
    onCiteFile?: (path: string, line?: number) => void
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    /** Rewrites this chain's output before it is drawn, so a conversation that
     *  carries app machinery in its text can strip it here too. */
    formatOutput?: (text: string) => string
  }

  let {
    chain,
    active,
    showHeader,
    busy,
    live,
    lastReasoningId,
    imageUrls,
    onCiteFile,
    projectId,
    threadId,
    checkpointId,
    checkpointPaths,
    onOpenSubagent,
    formatOutput
  }: Props = $props()

  /**
   * A settled chain folds the moment its output lands: the steps were the work,
   * the text is what the reader came for, and the text stays visible either way.
   * The newest chain that has not produced its output yet stays open so the work
   * is watchable while it happens. A reader who toggles a chain keeps that
   * choice for as long as the chain lives.
   */
  let userChoice = $state<boolean | null>(null)
  const open = $derived(userChoice ?? (active && chain.output === null))

  const span = $derived(traceChainSpan(chain))
  const durationStart = $derived(span?.start)
  /** Live counting only for the newest chain of a streaming trace; every other
   *  chain shows the frozen span its steps reported. */
  const durationEnd = $derived(live && active ? undefined : span?.end)

  const clock = new ElapsedTimer()
  $effect(() => {
    if (durationStart && durationEnd === undefined) clock.start()
    else {
      clock.stop()
      if (durationStart) clock.snapshot()
    }
    return () => clock.stop()
  })
  /** The chain's own duration in milliseconds. Millisecond precision keeps a
   *  fast chain readable as "<1s" instead of collapsing to "0s". */
  const durationMs = $derived(
    durationStart === undefined ? 0 : Math.max(0, (durationEnd ?? clock.now()) - durationStart)
  )
  const durationLabel = $derived(durationStart === undefined ? null : formatDurationMs(durationMs))

  const stepLabel = $derived(`${chain.steps.length} ${chain.steps.length === 1 ? 'step' : 'steps'}`)

  /**
   * What this chain of thought holds, so the reader can see where a compaction,
   * a delegated sub-agent, or code-mode work happened without opening the
   * steps. The trace header still carries the turn-wide totals; these mark the
   * exact step the action belongs to.
   */
  const markers = $derived(traceChainMarkers(chain))
</script>

<div class="min-w-0">
  {#snippet stepList()}
    <div transition:slide={foldSlide()} class="flex min-w-0 flex-col gap-1.5">
      {#each chain.steps as step (step.id)}
        <WorkingTraceRow
          part={step}
          {busy}
          {live}
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
    </div>
  {/snippet}
  {#if chain.steps.length > 0}
    {#if showHeader}
      <!-- Sticky within the transcript scroller, directly under the pinned
           trace header: a reader deep in a long chain keeps its fold control on
           screen instead of having to scroll back to the head. -->
      <button
        type="button"
        class="sticky z-10 flex w-full items-center gap-1.5 bg-app py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
        style="top: var(--cio-trace-header-h, 0px)"
        aria-expanded={open}
        title={open ? 'Hide the steps behind this output' : 'Show the steps behind this output'}
        onclick={() => (userChoice = !open)}
      >
        <CioForward size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
        <span class="font-medium">{stepLabel}</span>
        {#if durationLabel}
          <span class="tabular-nums">· {durationLabel}</span>
        {/if}
        {#if markers.compacted || markers.subagentCount > 0 || markers.codeMode}
          <span class="flex items-center gap-1.5">
            {#if markers.compacted}
              <span
                class="flex items-center gap-1 border border-border bg-dimmed/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide uppercase"
                title="This step compacted earlier context."
              >
                <CioArchive size={10} />
                Compacted
              </span>
            {/if}
            {#if markers.subagentCount > 0}
              <span
                class="flex items-center gap-1 border border-border bg-dimmed/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide tabular-nums uppercase"
                title={`This step delegated work to ${markers.subagentCount} sub-agent${
                  markers.subagentCount === 1 ? '' : 's'
                }.`}
              >
                <CioSubagent size={10} />
                {markers.subagentCount}
              </span>
            {/if}
            {#if markers.codeMode}
              <span
                class="flex items-center gap-1 border border-border bg-dimmed/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide uppercase"
                title="This step ran code-mode work."
              >
                <CioCode size={10} />
                Code
              </span>
            {/if}
          </span>
        {/if}
      </button>
      {#if open}
        {@render stepList()}
      {/if}
    {:else}
      {@render stepList()}
    {/if}
  {/if}
  {#if chain.output}
    {@const outputText = formatOutput ? formatOutput(chain.output.text) : chain.output.text}
    {#if outputText.trim() !== ''}
      <div class="min-w-0 text-[0.8125rem] text-foreground">
        <DeferredMarkdownView text={outputText} {onCiteFile} />
      </div>
    {/if}
  {/if}
</div>
