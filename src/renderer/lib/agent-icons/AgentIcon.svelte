<script lang="ts">
  import { getAgentIcon } from './registry'
  import { publicAssetUrl } from '$lib/static-assets'
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'

  interface Props {
    agentId?: string
    label?: string
    size?: 14 | 16 | 20 | 22 | 24
    class?: string
  }

  let { agentId, label, size = 20, class: className = '' }: Props = $props()
  let entry = $derived(getAgentIcon(agentId))
  /**
   * An ACP agent is the user's own record, so its artwork is whatever they
   * uploaded, with a separate image for the dark theme when they gave one.
   */
  let customImage = $derived(
    agentId?.startsWith('acp-')
      ? (() => {
          const agent = acpAgentsStore.get(agentId)
          return schemeState.isDark ? (agent?.iconDark ?? agent?.icon) : agent?.icon
        })()
      : undefined
  )
  let accessibleLabel = $derived(label ?? entry?.name ?? agentId ?? 'Agent')
  const placeholderIconUrl = publicAssetUrl('assets/agents/_placeholder.svg')
</script>

<span
  class={`inline-flex shrink-0 items-center justify-center text-muted ${className}`}
  style:width={`${size}px`}
  style:height={`${size}px`}
  title={accessibleLabel}
>
  {#if customImage}
    <img class="h-full w-full object-contain" src={customImage} alt={accessibleLabel} />
  {:else if entry}
    <img class="h-full w-full object-contain" src={entry.iconUrl} alt={accessibleLabel} />
  {:else}
    <img class="h-full w-full object-contain" src={placeholderIconUrl} alt={accessibleLabel} />
  {/if}
</span>
