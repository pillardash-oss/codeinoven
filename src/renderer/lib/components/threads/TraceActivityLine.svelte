<script lang="ts">
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import { traceActivityLine, traceActivitySummary } from '$lib/trace-activity'
  import type { AgentPart } from '$shared/types'
  import SmoothMarkdown from '../markdown/SmoothMarkdown.svelte'

  interface Props {
    /** The live turn's parts: the work happening now. */
    parts: AgentPart[]
    onCiteFile?: (path: string, line?: number) => void
  }

  let { parts, onCiteFile }: Props = $props()

  const activity = $derived(traceActivityLine(parts))
  const summary = $derived(traceActivitySummary(activity.actions))
</script>

{#if activity.prose || summary}
  <div
    class="flex min-w-0 items-start gap-2 text-[0.75rem] leading-relaxed text-dimmed"
    title={activity.prose ? 'What the agent just said' : 'What the agent is doing now'}
  >
    <span class="shrink-0 self-start">
      <ThinkingOrb size={20} label="Agent working" />
    </span>
    {#if activity.prose}
      <!-- The step's own words, streaming as they arrive, so the reader never
           has to open the trace to see what the agent reported. The turn's
           closing message replaces this the moment the assistant row lands. -->
      <div class="max-h-16 min-w-0 flex-1 overflow-hidden">
        <SmoothMarkdown text={activity.prose} streaming {onCiteFile} />
      </div>
    {:else}
      <span class="line-clamp-2 min-w-0 flex-1">{summary}</span>
    {/if}
  </div>
{/if}
