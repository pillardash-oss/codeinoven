<script lang="ts">
  import { Archive, Cog, Loader2 } from '@lucide/svelte'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import WorkingTraceSubagentBadge from './WorkingTraceSubagentBadge.svelte'

  interface Props {
    /** True while the trace's entries are mounted. */
    open: boolean
    /** True while the turn is streaming, so the header shows a spinner. */
    busy: boolean
    /** Number of entries this trace holds. */
    count: number
    hasCompaction: boolean
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
    hasCompaction,
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
</script>

<summary
  class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
  onclick={onToggle}
>
  {#if open && busy}
    <Loader2 size={12} class="shrink-0 animate-spin text-info" />
  {:else}
    <Cog size={12} class="shrink-0" />
  {/if}
  Working Trace
  <span class="tabular-nums text-dimmed">({count})</span>
  {#if hasCompaction || subagentCount > 0}
    <span class="ml-auto flex items-center gap-1.5">
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
