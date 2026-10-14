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

<summary
  class="flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1 text-left text-[0.75rem] font-medium text-muted transition-colors hover:text-foreground"
  onclick={onToggle}
>
  <span class="flex h-5 w-5 shrink-0 items-center justify-center">
    {#if open && busy}
      <ThinkingOrb size={20} label="Working" />
    {:else}
      <Cog size={12} />
    {/if}
  </span>
  Working Trace
  <span class="tabular-nums text-dimmed"
    >{stepLabel}{durationLabel ? ` · ${durationLabel}` : ''}</span
  >
  {#if hasCompaction || subagentCount > 0 || hasCodeMode}
    <span class="flex items-center gap-1.5">
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
      {/if}
    </span>
  {/if}
</summary>
