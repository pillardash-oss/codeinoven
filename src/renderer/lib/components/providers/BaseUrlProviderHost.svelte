<script lang="ts">
  import { providerStore } from '$lib/stores/providers.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import BaseUrlProviderEditor from './BaseUrlProviderEditor.svelte'

  /**
   * Renders the custom base-URL provider editor above every view.
   *
   * The editor is a dockable panel, so it cannot live inside the settings page:
   * a docked chip owned by that subtree would disappear the moment the user
   * navigated away from Settings, and "minimize and keep configuring the app"
   * is the whole reason the panel docks. Mounting it here instead means the
   * provider list, the model picker and the Add-provider hand-off all open the
   * same single panel, on the same remembered placement, from anywhere.
   *
   * The request keys the panel, so an edit started from the list behind a
   * docked panel remounts the draft from the newly chosen provider rather than
   * silently keeping the previous one.
   */
  let request = $derived(baseUrlProviderFlow.request)
</script>

{#if request}
  {#key request}
    <BaseUrlProviderEditor
      provider={request.provider}
      harnesses={providerStore.baseUrlHarnesses}
      defaultHarnessId={request.defaultHarnessId}
      onClose={() => {
        request.onClosed?.()
        baseUrlProviderFlow.close()
      }}
      onSaved={(provider) => {
        request.onSaved?.(provider)
        baseUrlProviderFlow.close()
      }}
      onBack={request.onBack}
    />
  {/key}
{/if}
