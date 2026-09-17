<script lang="ts">
  import { providerStore } from '$lib/stores/providers.svelte'
  import type { BaseUrlProvider, ProviderConnectionInfo } from '$shared/types'
  import AddProviderModal from './AddProviderModal.svelte'
  import BaseUrlProviderEditor from './BaseUrlProviderEditor.svelte'

  /**
   * One harness's provider management: the Add-provider modal and the custom
   * base-URL editor it hands off to. Extracted so the Harnesses settings page
   * and the app-wide connect flow (the first-run setup card, the empty model
   * picker) run the exact same flow instead of two copies of its wiring.
   */
  interface Props {
    harness: ProviderConnectionInfo
    /** Tab the Add-provider modal opens on. */
    initialTab?: 'connect' | 'custom'
    /** Provider search the connect list opens with. */
    initialSearch?: string
    onClose: () => void
    /** Fired once a provider finished connecting, so the caller can re-probe. */
    onConnected?: () => void
  }

  let {
    harness,
    initialTab = 'connect',
    initialSearch = '',
    onClose,
    onConnected
  }: Props = $props()

  /** True while the custom base-URL editor stands in for the Add-provider modal. */
  let customEditorOpen = $state(false)
  /** Custom provider being edited; null while creating a new one. */
  let customEditorProvider = $state<BaseUrlProvider | null>(null)
  /** Set when the editor's Back button returned the user to the modal, so it
   *  reopens on the tab they left instead of the connect list. */
  let returnedToCustomTab = $state(false)

  function openCustomEditor(provider: BaseUrlProvider | null): void {
    customEditorProvider = provider
    customEditorOpen = true
  }
</script>

{#if customEditorOpen}
  <BaseUrlProviderEditor
    provider={customEditorProvider}
    harnesses={providerStore.baseUrlHarnesses}
    defaultHarnessId={customEditorProvider?.harnessId ?? harness.id}
    {onClose}
    onSaved={onClose}
    onBack={() => {
      returnedToCustomTab = true
      customEditorOpen = false
      customEditorProvider = null
    }}
  />
{:else}
  <AddProviderModal
    {harness}
    initialTab={returnedToCustomTab ? 'custom' : initialTab}
    {initialSearch}
    {onClose}
    onAddCustom={() => openCustomEditor(null)}
    onEditCustom={(provider) => openCustomEditor(provider)}
    onProviderConnected={onConnected}
  />
{/if}
