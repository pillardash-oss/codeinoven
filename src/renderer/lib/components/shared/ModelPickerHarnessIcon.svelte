<script lang="ts">
  import CioTerminal from 'cio-icon/CioTerminal.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'

  interface Props {
    harnessId: string
    size?: number
  }

  let { harnessId, size = 12 }: Props = $props()
</script>

{#if getAgentIcon(harnessId)}
  <img
    src={getAgentIcon(harnessId)?.iconUrl}
    alt=""
    class="shrink-0 object-contain"
    style:width={`${size}px`}
    style:height={`${size}px`}
  />
{:else}
  <CioTerminal {size} class="shrink-0" />
{/if}
