<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { OfferedProvider } from '$shared/types'
  import type { AddTab, ConnectStep } from './add-provider-modal-helpers'

  interface Props {
    tab: AddTab
    step: ConnectStep
    canSignIn: boolean
    pickerLogin: boolean
    apiKeyEntry: boolean
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
    {:else if canSignIn}
      {#if apiKeyEntry}
        <button
          class="flex h-9 items-center justify-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          title={step === 'picking' && selectedProvider
            ? `Store the API key for ${selectedProvider.name}`
            : 'Select a provider first'}
          disabled={storingKey ||
            oauthLoginId !== null ||
            (step === 'picking' && !selectedProvider)}
          onclick={() => (step === 'idle' ? onOpenPicker() : onConnectWithKey())}
        >
          {#if storingKey}
            <CioSpinner size={13} class="animate-spin" />
          {:else if step === 'idle'}
            <CioSearch size={13} /> Search providers
          {:else}
            <CioKey size={13} /> Connect provider
          {/if}
        </button>
      {:else}
        <button
          class="flex h-9 items-center justify-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={!pickerLogin && step === 'picking' && !selectedProvider}
          onclick={() =>
            pickerLogin
              ? onStartConnect(null)
              : step === 'idle'
                ? onOpenPicker()
                : selectedProvider
                  ? onStartConnect(selectedProvider)
                  : null}
        >
          {#if !pickerLogin && step === 'picking' && selectedProvider}
            <CioPlug size={13} /> Connect with {selectedProvider.name}
          {:else if !pickerLogin && step === 'picking'}
            <CioSearch size={13} /> Search providers
          {:else}
            <CioKey size={13} /> Connect provider
          {/if}
        </button>
      {/if}
    {:else}
      <button
        class="flex h-9 items-center gap-1.5 bg-elevated px-4 text-xs font-medium text-dimmed"
        type="button"
        disabled
        title="This harness does not expose a login flow CodeInOven can run"
      >
        <CioKey size={13} /> Connect provider
      </button>
    {/if}
  </div>
</div>
