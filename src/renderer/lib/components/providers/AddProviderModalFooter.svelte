<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { OfferedProvider } from '$shared/types'
  import type { AddTab, ConnectStep } from './add-provider-modal-helpers'
  import AddProviderConnectAction from './AddProviderConnectAction.svelte'

  interface Props {
    tab: AddTab
    step: ConnectStep
    canSignIn: boolean
    pickerLogin: boolean
    apiKeyEntry: boolean
    /**
     * Nothing is connected yet, so the connect action lives in the empty state
     * instead of here: the footer only carries it once a provider exists.
     */
    emptyState: boolean
    storingKey: boolean
    oauthLoginId: string | null
    selectedProvider: OfferedProvider | null
    finalizingAccount: boolean
    onOpenCustom: () => void
    onSaveAccount: () => void
    onCancelConnection: () => void
    onStartConnect: (provider: OfferedProvider | null) => void
    onOpenPicker: () => void
    onConnectWithKey: () => void
  }

  let {
    tab,
    step,
    canSignIn,
    pickerLogin,
    apiKeyEntry,
    emptyState,
    storingKey,
    oauthLoginId,
    selectedProvider,
    finalizingAccount,
    onOpenCustom,
    onSaveAccount,
    onCancelConnection,
    onStartConnect,
    onOpenPicker,
    onConnectWithKey
  }: Props = $props()
</script>

<div class="flex w-full justify-end">
  <div class="flex shrink-0 items-center gap-2">
    {#if tab === 'custom'}
      <button
        class="flex h-9 items-center justify-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover"
        type="button"
        onclick={onOpenCustom}
      >
        <CioServer size={13} /> Open custom provider form
      </button>
    {:else if step === 'labeling'}
      <button
        class="flex h-9 items-center justify-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="button"
        disabled={finalizingAccount}
        onclick={onSaveAccount}
      >
        {#if finalizingAccount}<CioSpinner size={13} class="animate-spin" />{/if}
        Save account
      </button>
    {:else if step === 'running'}
      <button
        class="flex h-9 items-center gap-1.5 border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={onCancelConnection}
      >
        <CioClose size={13} /> Cancel connection
      </button>
    {:else if !canSignIn}
      <button
        class="flex h-9 items-center gap-1.5 bg-elevated px-4 text-xs font-medium text-dimmed"
        type="button"
        disabled
        title="This harness does not expose a login flow CodeInOven can run"
      >
        <CioKey size={13} /> Connect provider
      </button>
    {:else if !emptyState}
      <AddProviderConnectAction
        {step}
        {apiKeyEntry}
        {pickerLogin}
        {storingKey}
        {oauthLoginId}
        {selectedProvider}
        {onOpenPicker}
        {onStartConnect}
        {onConnectWithKey}
      />
    {/if}
  </div>
</div>
