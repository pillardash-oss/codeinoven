<script lang="ts">
  import { getAgentIcon } from './registry'
  import { publicAssetUrl } from '$lib/static-assets'

  interface Props {
    agentId?: string
    label?: string
    size?: 14 | 16 | 20 | 22 | 24
    class?: string
  }

  let { agentId, label, size = 20, class: className = '' }: Props = $props()
  let entry = $derived(getAgentIcon(agentId))
  let accessibleLabel = $derived(label ?? entry?.name ?? agentId ?? 'Agent')
  const placeholderIconUrl = publicAssetUrl('assets/agents/_placeholder.svg')
</script>

<span
  class={`inline-flex shrink-0 items-center justify-center rounded-md text-muted ${className}`}
  style:width={`${size}px`}
  style:height={`${size}px`}
  title={accessibleLabel}
>
  {#if entry}
    <img class="h-full w-full object-contain" src={entry.iconUrl} alt={accessibleLabel} />
  {:else}
    <img class="h-full w-full object-contain" src={placeholderIconUrl} alt={accessibleLabel} />
  {/if}
</span>
