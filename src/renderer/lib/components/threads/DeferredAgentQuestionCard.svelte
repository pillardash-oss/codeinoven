<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type AgentQuestionCard from './AgentQuestionCard.svelte'
  import { loadCachedPanelModule } from '$lib/lazy-panel'

  /**
   * The card an agent's pending question is answered in, behind its own chunk.
   *
   * It is the transcript's heaviest card and the rarest: it exists only while a
   * question is waiting for an answer, which is an interaction the reader has
   * already been pulled into by the run. The card, its editors and its pickers
   * therefore load when that question appears, not with the first screen, and
   * the load is memoized so a second question is immediate.
   */
  let props: ComponentProps<typeof AgentQuestionCard> = $props()
</script>

{#await loadCachedPanelModule('module:lib/components/threads/AgentQuestionCard.svelte', () => import('./AgentQuestionCard.svelte')) then { default: AgentQuestionCard }}
  <AgentQuestionCard {...props} />
{/await}
