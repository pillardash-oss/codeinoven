<script lang="ts">
  import { onMount } from 'svelte'
  import { getAgentIcon } from './registry'
  import { publicAssetUrl } from '$lib/static-assets'
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'
  import { harnessMarkForCommand, vendorIconSlugFor, APP_VENDOR_SLUG } from './agent-vendor'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

  interface Props {
    agentId?: string
    label?: string
    size?: number
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
   * The shipped mark for the harness this agent's own command starts.
   */
  let commandMark = $derived(
    acpAgent && customImage === undefined && !entry
      ? harnessMarkForCommand(acpAgent.command)
      : undefined
  )
  /**
   * An ACP agent with no artwork of its own wears a vendor mark: the mark of the
   * vendor its command belongs to (`cursor-agent` is Cursor), else the app's own
   * branded icon asset, which carries its own surface and so reads the same on
   * light and dark.
   */
  let vendorMarkSlug = $derived(
    acpAgent !== undefined && customImage === undefined && !entry && commandMark === undefined
      ? vendorIconSlugFor(acpAgent.command, acpAgent.name)
      : undefined
  )
  let usesAppIcon = $derived(vendorMarkSlug === APP_VENDOR_SLUG)
  let accessibleLabel = $derived(label ?? entry?.name ?? agentId ?? 'Agent')
  const placeholderIconUrl = publicAssetUrl('assets/agents/_placeholder.svg')

  // The model picker draws this icon before Harnesses was ever opened, so the
  // agent records are read here too; the store answers a second call for free.
  onMount(() => {
    void acpAgentsStore.load()
  })
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
  {:else if commandMark}
    <img class="h-full w-full object-contain" src={commandMark.iconUrl} alt={accessibleLabel} />
  {:else if vendorMarkSlug && !usesAppIcon}
    <VendorIcon id={vendorMarkSlug} name={acpAgent?.name ?? accessibleLabel} {size} />
  {:else if usesAppIcon}
    <img class="h-full w-full object-contain" src={vendorIconUrl} alt={accessibleLabel} />
  {:else if entry}
    <img class="h-full w-full object-contain" src={entry.iconUrl} alt={accessibleLabel} />
  {:else}
    <img class="h-full w-full object-contain" src={placeholderIconUrl} alt={accessibleLabel} />
  {/if}
</span>
