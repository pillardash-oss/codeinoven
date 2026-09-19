<script lang="ts">
  import { CheckCircle2, KeyRound, Loader2, RefreshCw, Search, Unplug, X } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type {
    HarnessAccount,
    OfferedProvider,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderAccountLoginHandoff,
    ProviderConnectionInfo
  } from '$shared/types'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import type { AddProviderModalOAuthController } from './add-provider-modal-oauth.svelte'
  import { shellCommand, stateLabel, type ConnectStep } from './add-provider-modal-helpers'

  interface Props {
    harness: ProviderConnectionInfo
    step: ConnectStep
    authStatus: ProviderAccountAuthStatus | null
    checkingAuth: boolean
    actionError: string
    actionWarning: string
    notice: string
    authenticatedProvider: { id: string; name: string } | null
    accountLabel: string
    loginHandoff: ProviderAccountLoginHandoff | null
    terminalId: string
    search: string
    offered: OfferedProvider[]
    offeredLoading: boolean
    offeredError: string
    filteredOffered: OfferedProvider[]
    selectedProvider: OfferedProvider | null
    apiKey: string
    apiKeyEntry: boolean
    pickerLogin: boolean
    oauth: AddProviderModalOAuthController
    accountForConnected: (connected: ProviderAccountAuthEntry) => HarnessAccount | undefined
    onCheckAuth: () => void
    onSaveAuthenticatedAccount: () => void
    onBackToList: () => void
    onConnectWithKey: () => void
    onLoginExit: (exitCode: number) => void
    onRequestDisconnect: (account: HarnessAccount | null) => void
  }

  let {
    harness,
    step,
    authStatus,
    checkingAuth,
    actionError,
    actionWarning,
    notice,
    authenticatedProvider,
    accountLabel = $bindable(),
    loginHandoff,
    terminalId,
    search = $bindable(),
    offered,
    offeredLoading,
    offeredError,
    filteredOffered,
    selectedProvider = $bindable(),
    apiKey = $bindable(),
    apiKeyEntry,
    pickerLogin,
    oauth,
    accountForConnected,
    onCheckAuth,
    onSaveAuthenticatedAccount,
    onBackToList,
    onConnectWithKey,
    onLoginExit,
    onRequestDisconnect
  }: Props = $props()

  const selectedProviderIsOauth = $derived(selectedProvider?.oauth === true)
</script>

<div class="space-y-4">
  {#if step === 'idle'}
    <div class="flex items-center justify-between gap-3 rounded-xl border bg-surface px-3 py-2.5">
      <div class="flex min-w-0 items-center gap-2">
        {#if authStatus?.state === 'authenticated'}
          <CheckCircle2 size={15} class="shrink-0 text-success" />
        {:else}
          <KeyRound size={15} class="shrink-0 text-dimmed" />
        {/if}
        <p class="truncate text-xs font-medium">{stateLabel(authStatus)}</p>
      </div>
      <button
        class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay disabled:opacity-50"
        title="Re-check {harness.name} sign-in status"
        disabled={checkingAuth}
        onclick={onCheckAuth}
      >
        <RefreshCw size={11} class={checkingAuth ? 'animate-spin' : ''} />
        Check
      </button>
    </div>
    {#if authStatus?.accounts.length}
      <div class="overflow-hidden rounded-xl border bg-surface">
        <div
          class="border-b bg-elevated px-3 py-2 text-[0.625rem] font-medium uppercase tracking-wide text-dimmed"
        >
          Connected providers
        </div>
        {#each authStatus.accounts.filter((account) => account.active !== false) as connected (connected.id)}
          <div class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
            <CheckCircle2 size={14} class="shrink-0 text-success" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium text-foreground">{connected.label}</p>
              <p class="truncate font-mono text-[0.625rem] text-dimmed">
                {connected.providerId}{#if connected.method}
                  · {connected.method}{/if}
              </p>
            </div>
            {#if accountForConnected(connected)}
              <button
                type="button"
                class="flex h-7 items-center gap-1 rounded-lg px-2 text-[0.6875rem] font-medium text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                title={`Disconnect ${connected.label}`}
                onclick={() => onRequestDisconnect(accountForConnected(connected) ?? null)}
              >
                <Unplug size={11} /> Disconnect
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if actionError}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {actionError}
    </p>
  {/if}

  {#if actionWarning}
    <p
      class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      role="alert"
    >
      {actionWarning}
    </p>
  {/if}
  {#if notice}
    <p class="rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
      {notice}
    </p>
  {/if}

  {#if step === 'labeling' && authenticatedProvider}
    <div class="space-y-3 rounded-xl border bg-surface p-4">
      <div class="flex items-start gap-2">
        <CheckCircle2 size={16} class="mt-0.5 shrink-0 text-success" />
        <div>
          <p class="text-sm font-medium text-foreground">
            Label your newly logged in {authenticatedProvider.name} account
          </p>
          <p class="mt-0.5 text-xs text-muted">
            Leave the label blank to use {authenticatedProvider.name}-N automatically.
          </p>
        </div>
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        placeholder={`${authenticatedProvider.name}-N`}
        maxlength="80"
        autocomplete="off"
        bind:value={accountLabel}
        autofocus
        onkeydown={(event: KeyboardEvent) => {
          if (event.key === 'Enter') onSaveAuthenticatedAccount()
        }}
      />
    </div>
  {:else if step === 'running' && loginHandoff}
    <div class="space-y-2">
      <div class="h-60 overflow-hidden rounded-xl border bg-app">
        <ProviderLoginTerminal
          {terminalId}
          command={loginHandoff.command}
          args={loginHandoff.args}
          environment={loginHandoff.environment}
          onExit={(exitCode) => onLoginExit(exitCode)}
        />
      </div>
      <p class="font-mono text-[0.625rem] text-dimmed">
        $ {shellCommand(loginHandoff)}
      </p>
    </div>
  {:else if step === 'picking'}
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[0.6875rem] font-medium text-dimmed">Providers {harness.name} offers</p>
        <button
          class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay"
          type="button"
          onclick={onBackToList}
        >
          <X size={11} /> Back
        </button>
      </div>
      <div class="relative">
        <Search
          size={13}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="h-9 w-full rounded-lg border bg-elevated pl-8 pr-3 text-sm outline-none focus:border-primary"
          placeholder="Search providers"
          autocomplete="off"
          spellcheck="false"
          bind:value={search}
          autofocus
        />
      </div>

      {#if offeredLoading && offered.length === 0}
        <div class="flex h-24 items-center justify-center">
          <Loader2 size={17} class="animate-spin text-dimmed" />
        </div>
      {:else if offeredError}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {offeredError}
        </p>
      {:else if filteredOffered.length === 0}
        <div class="rounded-xl border border-dashed p-4 text-center">
          <p class="text-xs text-muted">
            {offered.length === 0
              ? 'No connectable providers were found for this harness.'
              : 'No providers match your search.'}
          </p>
        </div>
      {:else}
        <div class="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-0.5">
          {#each filteredOffered as provider (provider.id)}
            <button
              type="button"
              class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors {selectedProvider?.id ===
              provider.id
                ? 'border-primary bg-primary text-on-primary'
                : 'bg-surface text-foreground hover:bg-overlay'}"
              aria-pressed={selectedProvider?.id === provider.id}
              onclick={() => {
                if (oauth.loginId !== null) void oauth.cancel()
                selectedProvider = provider
              }}
            >
              <span class="min-w-0">
                <span class="block truncate text-xs font-medium">{provider.name}</span>
                <span
                  class="block truncate font-mono text-[0.625rem] {selectedProvider?.id ===
                  provider.id
                    ? 'text-on-primary/70'
                    : 'text-dimmed'}"
                >
                  {provider.id}
                </span>
              </span>
              {#if provider.authenticated}
                <span
                  class="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-success"
                >
                  Connected
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#snippet apiKeyField(providerName: string)}
        <label
          class="block text-[0.6875rem] font-medium text-foreground"
          for="provider-api-key-input"
        >
          API key for {providerName}
        </label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="provider-api-key-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
          placeholder="Paste the API key"
          bind:value={apiKey}
          autofocus
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onConnectWithKey()
            }
          }}
        />
        <p class="text-[0.625rem] text-dimmed">
          Stored by CodeInOven in {harness.name}’s own credential file never sent anywhere else.
        </p>
      {/snippet}

      {#if apiKeyEntry && selectedProvider}
        <div class="space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
          {#if oauth.loginId !== null}
            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <Loader2 size={13} class="animate-spin text-primary" />
                <p class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">
                  {oauth.status || 'Waiting for the provider…'}
                </p>
                <button
                  class="shrink-0 rounded-lg border bg-elevated px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-overlay"
                  type="button"
                  title="Cancel the sign-in"
                  onclick={() => void oauth.cancel()}
                >
                  Cancel
                </button>
              </div>
              {#if oauth.deviceCode}
                <div class="rounded-lg border bg-surface p-2.5 text-center">
                  <p class="text-[0.625rem] text-dimmed">
                    Enter this code at
                    <button
                      class="font-medium text-primary underline underline-offset-2"
                      type="button"
                      title="Open {oauth.deviceCode.verificationUri}"
                      onclick={() => void openInBrowser(oauth.deviceCode?.verificationUri ?? '')}
                    >
                      {oauth.deviceCode.verificationUri}
                    </button>
                  </p>
                  <p class="mt-1 font-mono text-base font-semibold tracking-widest text-foreground">
                    {oauth.deviceCode.userCode}
                  </p>
                </div>
              {/if}
              {#if oauth.prompt}
                <div class="space-y-1.5">
                  {#if oauth.prompt.type === 'select' && oauth.prompt.options}
                    <p class="text-[0.6875rem] font-medium text-foreground">
                      {oauth.prompt.message}
                    </p>
                    <div class="space-y-1">
                      {#each oauth.prompt.options as option (option.id)}
                        <button
                          class="w-full rounded-lg border bg-elevated px-3 py-2 text-left text-xs text-foreground hover:bg-overlay"
                          type="button"
                          title="Choose {option.label}"
                          onclick={() => void oauth.answerSelect(option.id)}
                        >
                          {option.label}
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <label
                      class="block text-[0.6875rem] font-medium text-foreground"
                      for="oauth-prompt-input"
                    >
                      {oauth.prompt.message}
                    </label>
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      id="oauth-prompt-input"
                      type={oauth.prompt.type === 'secret' ? 'password' : 'text'}
                      autocomplete="off"
                      spellcheck="false"
                      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                      placeholder={oauth.prompt.placeholder ??
                        (oauth.prompt.type === 'secret' ? 'Enter the value' : 'Paste the code')}
                      bind:value={oauth.promptAnswer}
                      autofocus
                      onkeydown={(event: KeyboardEvent) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void oauth.submitPrompt()
                        }
                      }}
                    />
                    <button
                      class="flex h-8 w-full items-center justify-center rounded-lg bg-primary text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                      type="button"
                      title="Continue the sign-in"
                      disabled={oauth.promptAnswer.trim() === ''}
                      onclick={() => void oauth.submitPrompt()}
                    >
                      Continue
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {:else if selectedProviderIsOauth}
            <p class="text-[0.6875rem] font-medium text-foreground">
              Sign in to {selectedProvider.name}
            </p>
            <p class="text-[0.625rem] text-dimmed">
              A browser window opens, you approve access, and this app finishes the rest no key
              pasting needed.
            </p>
            <button
              class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              type="button"
              title="Sign in to {selectedProvider.name} in your browser"
              onclick={() => void oauth.start()}
            >
              <KeyRound size={13} /> Sign in with browser
            </button>
            <p class="text-center text-[0.625rem] text-dimmed">or paste an API key</p>
            {@render apiKeyField(selectedProvider.name)}
          {:else}
            <div class="text-[0.6875rem] font-medium text-foreground text-center">
              Connect to {selectedProvider.name}
              <button
                class="flex h-9 mx-auto mt-2 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                type="button"
                title="Connect to {selectedProvider.name}"
                onclick={() => void oauth.start()}
              >
                <KeyRound size={13} /> Connect
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="rounded-xl border border-dashed px-3 py-2.5">
      {#if apiKeyEntry}
        <p class="text-[0.6875rem] text-muted">
          Click <strong class="font-medium text-foreground">Search providers</strong> below to
          browse
          {harness.name}’s full provider catalog, then sign in or paste an API key to connect.
        </p>
      {:else if pickerLogin}
        <p class="text-[0.6875rem] text-muted">
          Click <strong class="font-medium text-foreground">Connect provider</strong> below to open
          {harness.name}’s own provider picker in the built-in terminal choose the provider you want
          there.
        </p>
      {:else}
        <p class="text-[0.6875rem] text-muted">
          Click <strong class="font-medium text-foreground">Connect provider</strong> below to pick a
          provider and sign in from here no copying commands.
        </p>
      {/if}
    </div>
  {/if}
</div>
