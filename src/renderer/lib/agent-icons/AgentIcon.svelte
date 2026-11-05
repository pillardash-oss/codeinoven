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
  let acpAgent = $derived(agentId?.startsWith('acp-') ? acpAgentsStore.get(agentId) : undefined)
  let customImage = $derived(
    acpAgent
      ? schemeState.isDark
        ? (acpAgent.iconDark ?? acpAgent.icon)
        : acpAgent.icon
      : undefined
  )
  /**
   * An ACP agent with no artwork of its own wears the app's vendor icon: the
   * branded icon asset, which carries its own surface and so reads the same on
   * light and dark. The harness keeps it until the user gives it its own icon.
   */
  let usesVendorIcon = $derived(acpAgent !== undefined && customImage === undefined && !entry)
  let accessibleLabel = $derived(label ?? entry?.name ?? agentId ?? 'Agent')
  const placeholderIconUrl = publicAssetUrl('assets/agents/_placeholder.svg')
  const vendorIconUrl = publicAssetUrl('icon.svg')
</script>

<span
  class={`inline-flex shrink-0 items-center justify-center text-muted ${className}`}
  style:width={`${size}px`}
  style:height={`${size}px`}
  title={accessibleLabel}
>
  {#if customImage}
    <img class="h-full w-full object-contain" src={customImage} alt={accessibleLabel} />
  {:else if usesVendorIcon}
    <img class="h-full w-full object-contain" src={vendorIconUrl} alt={accessibleLabel} />
  {:else if entry}
    <img class="h-full w-full object-contain" src={entry.iconUrl} alt={accessibleLabel} />
  {:else}
    <img class="h-full w-full object-contain" src={placeholderIconUrl} alt={accessibleLabel} />
  {/if}
</span>
