<script lang="ts">
  import CioArchive from '@codeinoven/icons/CioArchive.svelte'
  import CioTools from '@codeinoven/icons/CioTools.svelte'
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import { formatDurationMs } from '$lib/format/duration'
  import type { SubagentPart } from '$lib/working-trace-parts'
  import type { ThinkingLevel } from '$shared/types'
  import type { OvenAppearance } from '$shared/ovens'
  import WorkingTraceMetadata from './WorkingTraceMetadata.svelte'
  import WorkingTraceSubagentBadge from './WorkingTraceSubagentBadge.svelte'

  interface Props {
    /** True while the trace's entries are mounted. */
    open: boolean
    /** True only while a live session is streaming this trace, so the header
     *  keeps the thinking orb for as long as work is actually happening, folded
     *  or not. A finished or restored trace shows the cog. */
    live: boolean
    /** Number of thinking and tool steps this trace holds. */
    count: number
    /** Total wall-clock seconds the trace occupied, or null when unknown. */
    durationSeconds: number | null
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
    /** Attribution for the model working on this trace, shown at the far right. */
    modelLabel: string | null
    isFast: boolean
    thinkingLevel: ThinkingLevel | null
    providerName?: string | null
    providerId?: string | null
    harnessId?: string | null
    harnessName?: string | null
    accountLabel?: string | null
    ovenLabel?: string | null
    ovenIsLocal?: boolean
    ovenAppearance?: OvenAppearance
    onOpen: (part: SubagentPart) => void
    onOpenSheet: () => void
    onToggle: (event: MouseEvent) => void
  }

  let {
    open,
    live,
    count,
    durationSeconds,
    hasCompaction,
    subagentCount,
    activeSubagentCount,
    subagentParts,
    coarsePointer,
    title,
    label,
    elapsedFor,
    modelLabel,
    isFast,
    thinkingLevel,
    providerName,
    providerId,
    harnessId,
    harnessName,
    accountLabel,
    ovenLabel,
    ovenIsLocal = false,
    ovenAppearance,
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
       it spans only what is on screen, from the title to the last badge, and the
       trailing metadata repeats that on the right so the two read as a pair. The
       target is an overlay so the sub-agent dropdown stays a real sibling
       instead of a button nested inside a button. -->
  <button
    type="button"
    class="absolute inset-0 cursor-pointer"
    aria-expanded={open}
    aria-label={open ? 'Hide the work behind this answer' : 'Show the work behind this answer'}
    title={open ? 'Hide the work behind this answer' : 'Show the work behind this answer'}
    onclick={onToggle}
  ></button>
  <div
    class="pointer-events-none relative inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-1 transition-colors group-hover/trace:border-border-strong group-hover/trace:text-foreground"
  >
    <!-- The icon keeps the left gutter shared with every step below, so the orb
         and the cog sit on the same edge as the thinking and tool marks. -->
    <span class="flex h-5 shrink-0 items-center">
      {#if live}
        <ThinkingOrb size={20} label="Weaving" />
      {:else}
        <CioTools size={12} />
      {/if}
    </span>
    Working Trace
    <span class="tabular-nums text-dimmed transition-colors group-hover/trace:text-foreground"
      >{stepLabel}{durationLabel ? ` · ${durationLabel}` : ''}</span
    >
    {#if hasCompaction || subagentCount > 0}
      <!-- Only the sub-agent dropdown takes the click; the plain badges let it
           fall through to the line's own toggle. -->
      <span class="relative z-10 flex items-center gap-1.5">
        {#if hasCompaction}
          <span
            class="flex items-center gap-1 bg-dimmed/10 px-1.5 py-0.5 text-[0.5625rem]"
            title="This trace includes compacted context. Forking from here restores the compaction summary."
            aria-label="Compacted context. Forking from here restores the compaction summary."
          >
            <CioArchive size={10} />
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
  {#if modelLabel}
    <div
      class="pointer-events-none relative ml-auto inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-1 transition-colors group-hover/trace:border-border-strong"
    >
      <WorkingTraceMetadata
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
      />
    </div>
  {/if}
</div>
