<script lang="ts">
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import type { BaseUrlProvider, ProviderConnectionInfo } from '$shared/types'
  import AddProviderModal from './AddProviderModal.svelte'

  /**
   * One harness's provider management: the Add-provider modal and the custom
   * base-URL editor it hands off to. Extracted so the Harnesses settings page
   * and the app-wide connect flow (the first-run setup card, the empty model
   * picker) run the exact same flow instead of two copies of its wiring.
   *
   * The editor itself is not mounted here. It is a dockable panel owned by
   * `BaseUrlProviderHost` at the app root, so minimizing it leaves a chip that
   * survives navigation; this component only asks for it and stands down while
   * it is open.
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
  /** Set when the editor's Back button (or a dismissal) returned the user here,
   *  so the modal reopens on the tab they left instead of the connect list. */
  let returnedToCustomTab = $state(false)

  /**
   * Hand off to the app-wide editor.
   *
   * The hand-off is a replacement, not a stack: the editor is the surface the
   * user is working in, so this modal stands down. Back returns the user to the
   * tab they left, because that button exists precisely to undo the hand-off;
   * saving or dismissing the editor ends the whole flow, exactly as it did when
   * the editor was mounted here.
   */
  function openCustomEditor(provider: BaseUrlProvider | null): void {
    customEditorOpen = true
    baseUrlProviderFlow.open({
      provider,
      defaultHarnessId: provider?.harnessId ?? harness.id,
      onSaved: () => onClose(),
      onClosed: () => onClose(),
      onBack: returnToModal
    })
  }

  function returnToModal(): void {
    returnedToCustomTab = true
    customEditorOpen = false
  }
</script>

{#if !customEditorOpen}
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
