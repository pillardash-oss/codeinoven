<script lang="ts">
  import { providerConnectFlow } from '$lib/stores/provider-connect-flow.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import ProviderConnectFlow from './ProviderConnectFlow.svelte'

  /**
   * Renders the app-wide connect flow above every view, so a surface that has
   * nothing to work with (the first-run setup card, the empty model picker) can
   * hand the user straight to the harness's provider list without navigating
   * away from their conversation.
   */
  let request = $derived(providerConnectFlow.request)
  let harness = $derived(
    request === null
      ? null
      : (providerStore.providers.find((provider) => provider.id === request?.harnessId) ?? null)
  )
</script>

{#if request && harness}
  <ProviderConnectFlow
    {harness}
    initialSearch={request.search}
    onClose={() => providerConnectFlow.close()}
    onConnected={request.onConnected}
  />
{/if}
