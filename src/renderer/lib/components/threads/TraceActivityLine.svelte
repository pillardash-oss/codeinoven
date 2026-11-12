<script lang="ts">
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import {
    newestProseParagraph,
    traceActivityLine,
    traceActivitySummary
  } from '$lib/trace-activity'
  import type { AgentPart } from '$shared/types'
  import SmoothMarkdown from '../markdown/SmoothMarkdown.svelte'

  interface Props {
    /** The live turn's parts: the work happening now. */
    parts: AgentPart[]
    /**
     * True while the newest live trace is folded, which is the only state this
     * line belongs in.
     *
     * The line is the folded trace's summary of the work in progress: with the
     * trace open the reader is already looking at those steps, so the line would
     * only repeat them beside a body it no longer stands for.
     */
    folded?: boolean
    onCiteFile?: (path: string, line?: number) => void
    /**
     * Rewrites the newest words before they are drawn.
     *
     * A conversation whose text carries the app's own transport boundary reads
     * its prose through the same rule as its answer, so the line can never show
     * a marker the transcript strips. Prose this rule empties falls back to what
     * the agent is doing.
     */
    formatProse?: (text: string) => string
  }

  let { parts, folded = true, onCiteFile, formatProse }: Props = $props()

  const activity = $derived(traceActivityLine(parts))
  // The step's whole text is read through the conversation's own rule first, then
  // only its newest paragraph is drawn: the line reports the words the agent is
  // writing now, never the opening of a block it started minutes ago.
  const prose = $derived(
    newestProseParagraph(
      activity.prose && formatProse ? formatProse(activity.prose) : activity.prose
    )
  )
  const summary = $derived(traceActivitySummary(activity.actions))
</script>

{#if folded && (prose || summary)}
  <div
    transition:slide={foldSlide()}
    class="flex min-w-0 items-start gap-2 text-[0.75rem] leading-relaxed text-dimmed"
    title={prose ? 'What the agent just said' : 'What the agent is doing now'}
  >
    <span class="shrink-0 self-start">
      <ThinkingOrb size={20} label="Agent working" />
    </span>
    {#if prose}
      <!-- The step's own words, streaming as they arrive, so the reader never
           has to open the trace to see what the agent reported. The turn's
           closing message replaces this the moment the assistant row lands. -->
      <div class="max-h-16 min-w-0 flex-1 overflow-hidden">
        <SmoothMarkdown text={prose} streaming {onCiteFile} />
      </div>
    {:else}
      <span class="line-clamp-2 min-w-0 flex-1">{summary}</span>
    {/if}
  </div>
{/if}
