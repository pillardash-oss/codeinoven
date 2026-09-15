<script lang="ts">
  import { CornerDownRight, Layers3 } from '@lucide/svelte'
  import { subagentModeLabel, subagentModeTitle } from '$lib/subagent-presentation'

  interface Props {
    background: boolean
    /**
     * `icon` keeps the trace rows and cards to a single glyph (the parent
     * already reads "sub-agent" from the row itself); `chip` spells the mode
     * out for the detail header, where the question is "is this one blocking
     * me or not".
     */
    variant?: 'icon' | 'chip'
  }

  let { background, variant = 'icon' }: Props = $props()

  const title = $derived(subagentModeTitle(background))
</script>

{#if variant === 'chip'}
  <span
    class="flex shrink-0 items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] text-muted"
    {title}
    aria-label={title}
  >
    {#if background}
      <Layers3 size={9} />
    {:else}
      <CornerDownRight size={9} />
    {/if}
    {subagentModeLabel(background)}
  </span>
{:else if background}
  <span class="flex shrink-0 items-center" {title} aria-label={title}>
    <Layers3 size={9} class="text-dimmed" />
  </span>
{/if}
