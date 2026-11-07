<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { OfferedProvider } from '$shared/types'
  import type { ConnectStep } from './add-provider-modal-helpers'

  /**
   * The connect action that starts a provider sign-in, in one place.
   *
   * It renders twice: inside the modal footer, where it sits once the harness has
   * at least one provider, and inside the empty state, where a harness with none
   * offers the same action as the screen's own call to action instead of leaving
   * it alone at the bottom. `prominent` is the only difference between the two
   * (sizing, and claiming the modal's primary-action slot).
   */
  interface Props {
    step: ConnectStep
    apiKeyEntry: boolean
    pickerLogin: boolean
    storingKey: boolean
    oauthLoginId: string | null
    selectedProvider: OfferedProvider | null
    /** Rendered as the screen's own call to action rather than the footer's. */
    prominent?: boolean
    onOpenPicker: () => void
    onStartConnect: (provider: OfferedProvider | null) => void
    onConnectWithKey: () => void
  }

  let {
    step,
    apiKeyEntry,
    pickerLogin,
    storingKey,
    oauthLoginId,
    selectedProvider,
    prominent = false,
    onOpenPicker,
    onStartConnect,
    onConnectWithKey
  }: Props = $props()

  const size = $derived(
    prominent
      ? 'min-h-12 justify-center gap-2 px-6 py-3 text-sm'
      : 'h-9 justify-center gap-1.5 px-4 text-xs'
  )
  const iconSize = $derived(prominent ? 20 : 13)

  const selecting = $derived(step === 'picking')
</script>

{#if apiKeyEntry}
  <button
    class="flex items-center bg-primary font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50 {size}"
    type="button"
    title={selecting && selectedProvider
      ? `Store the API key for ${selectedProvider.name}`
      : 'Select a provider first'}
    disabled={storingKey || oauthLoginId !== null || (selecting && !selectedProvider)}
    data-modal-primary={prominent ? '' : undefined}
    onclick={() => (step === 'idle' ? onOpenPicker() : onConnectWithKey())}
  >
    {#if storingKey}
      <CioSpinner size={iconSize} class="animate-spin" />
    {:else if step === 'idle'}
      <CioSearch size={iconSize} /> Search providers
    {:else}
      <CioKey size={iconSize} /> Connect provider
    {/if}
  </button>
{:else}
  <button
    class="flex items-center bg-primary font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50 {size}"
    type="button"
    disabled={!pickerLogin && selecting && !selectedProvider}
    data-modal-primary={prominent ? '' : undefined}
    onclick={() =>
      pickerLogin
        ? onStartConnect(null)
        : step === 'idle'
          ? onOpenPicker()
          : selectedProvider
            ? onStartConnect(selectedProvider)
            : null}
  >
    {#if !pickerLogin && selecting && selectedProvider}
      <CioPlug size={iconSize} /> Connect with {selectedProvider.name}
    {:else if !pickerLogin && selecting}
      <CioSearch size={iconSize} /> Search providers
    {:else}
      <CioKey size={iconSize} /> Connect provider
    {/if}
  </button>
{/if}
