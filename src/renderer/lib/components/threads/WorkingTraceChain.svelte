<script lang="ts">
  import { ChevronRight } from '@lucide/svelte'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { traceChainSpan, type TraceChain } from '$lib/working-trace-parts'
  import type { AgentPart } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
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
    onOpenSubagent
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
  const indented = $derived(showHeader && chain.steps.length > 0)

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
  const elapsed = $derived(durationStart ? clock.seconds(durationStart, durationEnd) : 0)

  const stepLabel = $derived(`${chain.steps.length} ${chain.steps.length === 1 ? 'step' : 'steps'}`)
</script>

<div class="min-w-0">
  {#snippet stepList()}
    <div class="flex min-w-0 flex-col gap-0.5" class:pl-4={indented}>
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
      <button
        type="button"
        class="flex w-full items-center gap-1.5 py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
        aria-expanded={open}
        title={open ? 'Hide the steps behind this output' : 'Show the steps behind this output'}
        onclick={() => (userChoice = !open)}
      >
        <ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
        <span class="font-medium">{stepLabel}</span>
        {#if durationStart}
          <span class="tabular-nums">· {formatDurationSeconds(elapsed)}</span>
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
    <div class="min-w-0 text-[0.8125rem] text-foreground" class:pl-4={indented}>
      <MarkdownView text={chain.output.text} {onCiteFile} />
    </div>
  {/if}
</div>
