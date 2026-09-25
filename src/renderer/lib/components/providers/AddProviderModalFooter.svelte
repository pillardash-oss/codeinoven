<script lang="ts">
  import { CheckCircle2, KeyRound, Loader2, Plug, Search, Server, X } from '@lucide/svelte'
  import type { OfferedProvider, ProviderConnectionInfo } from '$shared/types'
  import type { AddTab, ConnectStep } from './add-provider-modal-helpers'

  interface Props {
    tab: AddTab
    step: ConnectStep
    harness: ProviderConnectionInfo
    canSignIn: boolean
    pickerLogin: boolean
    apiKeyEntry: boolean
    antigravityConnected: boolean
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
    harness,
    canSignIn,
    pickerLogin,
    apiKeyEntry,
    antigravityConnected,
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

<div class="flex w-full items-center justify-between gap-4">
  {#if tab === 'custom'}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      Add any OpenAI-compatible endpoint by base URL Ollama, LM Studio, llama.cpp, or a hosted
      gateway. Models are ready in the picker as soon as you save.
    </p>
  {:else if antigravityConnected}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      Antigravity is already connected through the Google account in your system keyring.
    </p>
  {:else if apiKeyEntry && canSignIn}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      Pick any provider from {harness.name}’s catalog and paste its API key stored in
      {harness.name}’s own credential file.
    </p>
  {:else if pickerLogin}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      Runs {harness.name}’s own interactive provider picker in a built-in terminal choose any
      provider there and follow the flow it shows (API key or OAuth).
    </p>
  {:else if canSignIn}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      Runs {harness.name}’s own sign-in flow in a built-in terminal rooted at your home directory a
      browser window opens so you can authenticate.
    </p>
  {:else}
    <p class="min-w-0 flex-1 text-[0.6875rem] text-dimmed">
      {harness.name} does not expose a login flow CodeInOven can run. Use the Custom base URL tab to add
      an OpenAI-compatible provider instead.
    </p>
  {/if}
  <div class="flex shrink-0 items-center gap-2">
    {#if tab === 'custom'}
      <button
        class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover"
        type="button"
        onclick={onOpenCustom}
      >
        <Server size={13} /> Open custom provider form
      </button>
    {:else if step === 'labeling'}
      <button
        class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="button"
        disabled={finalizingAccount}
        onclick={onSaveAccount}
      >
        {#if finalizingAccount}<Loader2 size={13} class="animate-spin" />{/if}
        Save account
      </button>
    {:else if step === 'running'}
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={onCancelConnection}
      >
        <X size={13} /> Cancel connection
      </button>
    {:else if antigravityConnected}
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-elevated px-4 text-xs font-medium text-muted"
        type="button"
        disabled
      >
        <CheckCircle2 size={13} /> Already connected
      </button>
    {:else if canSignIn}
      {#if apiKeyEntry}
        <button
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
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
            <Loader2 size={13} class="animate-spin" />
          {:else if step === 'idle'}
            <Search size={13} /> Search providers
          {:else}
            <KeyRound size={13} /> Connect provider
          {/if}
        </button>
      {:else}
        <button
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
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
            <Plug size={13} /> Connect with {selectedProvider.name}
          {:else if !pickerLogin && step === 'picking'}
            <Search size={13} /> Search providers
          {:else}
            <KeyRound size={13} /> Connect provider
          {/if}
        </button>
      {/if}
    {:else}
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-elevated px-4 text-xs font-medium text-dimmed"
        type="button"
        disabled
        title="This harness does not expose a login flow CodeInOven can run"
      >
        <KeyRound size={13} /> Connect provider
      </button>
    {/if}
  </div>
</div>
