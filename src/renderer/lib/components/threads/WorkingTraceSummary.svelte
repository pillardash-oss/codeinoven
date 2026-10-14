<script lang="ts">
  import { Archive, CodeXml, Cog } from '@lucide/svelte'
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import { formatDurationMs } from '$lib/format/duration'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import WorkingTraceSubagentBadge from './WorkingTraceSubagentBadge.svelte'

  interface Props {
    /** True while the trace's entries are mounted. */
    open: boolean
    /** True while the turn is streaming, so the header shows a spinner. */
    busy: boolean
    /** Number of thinking and tool steps this trace holds. */
    count: number
    /** Total wall-clock seconds the trace occupied, or null when unknown. */
    durationSeconds: number | null
    hasCompaction: boolean
    /** True when this trace ran code-mode scripts (any harness). */
    hasCodeMode: boolean
    subagentCount: number
    activeSubagentCount: number
    subagentParts: SubagentPart[]
    /** Touch devices get the bottom sheet instead of the hover dropdown. */
    coarsePointer: boolean
    /** Sub-agent badge wording, owned by the parent's derivations. */
    title: string
    label: string
    elapsedFor: (part: SubagentPart) => number
    onOpen: (part: SubagentPart) => void
    onOpenSheet: () => void
    onToggle: (event: MouseEvent) => void
  }

  let {
    open,
    busy,
    count,
    durationSeconds,
    hasCompaction,
    hasCodeMode,
    subagentCount,
    activeSubagentCount,
    subagentParts,
    coarsePointer,
    title,
    label,
    elapsedFor,
    onOpen,
    onOpenSheet,
    onToggle
  }: Props = $props()

  const stepLabel = $derived(`${count} ${count === 1 ? 'step' : 'steps'}`)
  const durationLabel = $derived(
    durationSeconds === null ? null : formatDurationMs(durationSeconds * 1000)
  )
</script>

<div
  class="group/trace relative flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-left text-[0.75rem] font-medium text-muted"
>
  <!-- The whole line is one click target, but the rule belongs to the content:
       it spans only what is on screen, from the title to the last badge. The
       target is an overlay so the sub-agent dropdown stays a real sibling
       instead of a button nested inside a button. -->
  <button
    type="button"
    class="absolute inset-0 cursor-pointer rounded-sm"
    aria-expanded={open}
    aria-label={open ? 'Hide the work behind this answer' : 'Show the work behind this answer'}
    title={open ? 'Hide the work behind this answer' : 'Show the work behind this answer'}
    onclick={onToggle}
  ></button>
  <div
    class="pointer-events-none relative inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-1 transition-colors group-hover/trace:border-border-strong group-hover/trace:text-foreground"
  >
    <!-- Icons share one left gutter with every step below, so the orb and the
       cog sit on the same edge as the thinking and tool marks. -->
    <span class="flex h-5 w-5 shrink-0 items-center">
      {#if open && busy}
        <ThinkingOrb size={20} label="Working" />
      {:else}
        <Cog size={12} />
      {/if}
    </span>
    Working Trace
    <span class="tabular-nums text-dimmed transition-colors group-hover/trace:text-foreground"
      >{stepLabel}{durationLabel ? ` · ${durationLabel}` : ''}</span
    >
    {#if hasCompaction || subagentCount > 0 || hasCodeMode}
      <!-- Only the sub-agent dropdown takes the click; the plain badges let it
           fall through to the line's own toggle. -->
      <span class="relative z-10 flex items-center gap-1.5">
        {#if hasCodeMode}
          <span
            class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[0.5625rem] text-info"
            title="This activity includes code-mode scripts that call tools in one run."
            aria-label="This activity includes code-mode scripts."
          >
            <CodeXml size={10} />
            Code
          </span>
        {/if}
        {#if hasCompaction}
          <span
            class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[0.5625rem] text-info"
            title="This trace includes compacted context. Forking from here restores the compaction summary."
            aria-label="Compacted context. Forking from here restores the compaction summary."
          >
            <Archive size={10} />
            Compacted
          </span>
        {/if}
        {#if subagentCount > 0}
          <span class="pointer-events-auto">
            <WorkingTraceSubagentBadge
              {coarsePointer}
              {title}
              {label}
              {subagentCount}
              {activeSubagentCount}
              parts={subagentParts}
              {elapsedFor}
              {onOpen}
              {onOpenSheet}
            />
          </span>
        {/if}
      </span>
    {/if}
  </div>
</div>
