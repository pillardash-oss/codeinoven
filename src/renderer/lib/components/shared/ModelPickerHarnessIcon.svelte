<script lang="ts">
  import { SquareTerminal } from '@lucide/svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'

  interface Props {
    harnessId: string
  }

  let { harnessId }: Props = $props()
</script>

{#if getAgentIcon(harnessId)}
  <img src={getAgentIcon(harnessId)?.iconUrl} alt="" class="h-3 w-3 shrink-0 object-contain" />
{:else}
  <SquareTerminal size={12} class="shrink-0" />
{/if}
