<script lang="ts">
  import { onMount } from 'svelte'
  import {
    CheckCircle2,
    KeyRound,
    Loader2,
    Pencil,
    Plug,
    RefreshCw,
    Search,
    Server,
    Unplug,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import type {
    BaseUrlProvider,
    OfferedProvider,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderAccountLoginHandoff,
    ProviderConnectionInfo
  } from '$shared/types'

  type AddTab = 'connect' | 'custom'
  type ConnectStep = 'idle' | 'picking' | 'running'

  interface Props {
    harness: ProviderConnectionInfo
    onClose: () => void
    /** Hand the user off to the custom base-URL editor, pre-scoped to this harness. */
    onAddCustom: (harnessId: string) => void
    /** Hand the user off to the custom base-URL editor to edit an existing provider. */
    onEditCustom: (provider: BaseUrlProvider) => void
    /** Tab shown on open — e.g. 'custom' when returning here via the editor's Back button. */
    initialTab?: AddTab
  }

  let { harness, onClose, onAddCustom, onEditCustom, initialTab = 'connect' }: Props = $props()

  /** The component is mounted per-open, so the initial prop value is authoritative. */
  function startingTab(): AddTab {
    return initialTab
  }

  let tab = $state<AddTab>(startingTab())
  let step = $state<ConnectStep>('idle')
  let authStatus = $state<ProviderAccountAuthStatus | null>(null)
  let checkingAuth = $state(false)
  let offered = $state<OfferedProvider[]>([])
  let offeredLoading = $state(false)
  let offeredError = $state('')
  let search = $state('')
  let selectedProvider = $state<OfferedProvider | null>(null)
  let loginHandoff = $state<ProviderAccountLoginHandoff | null>(null)
  let terminalId = $state('')
  let disconnectTarget = $state<ProviderAccountAuthEntry | null>(null)
  let disconnecting = $state(false)
  let hiddenIds = $state<string[]>([])
  let togglingHide = $state(false)
  let notice = $state('')
  let actionWarning = $state('')
  let actionError = $state('')

  let customProviders = $derived(
    baseUrlProviderStore.providers.filter((provider) => provider.harnessId === harness.id)
  )
  let customCount = $derived(customProviders.length)

  let canSignIn = $derived(
    authStatus !== null &&
      authStatus.capabilities !== null &&
      authStatus.capabilities.loginHandoff !== false &&
      !(harness.id === 'antigravity' && authStatus.state === 'authenticated')
  )

  /** Antigravity has one keyring-backed Google account and no explicit login
   * command. Its bare `agy` launch is only a login handoff while signed out. */
  let antigravityConnected = $derived(
    harness.id === 'antigravity' && authStatus?.state === 'authenticated'
  )

  /**
   * Harness presents its own interactive provider picker inside the login
   * terminal (`opencode auth login`), so the bare login command is launched and
   * the user chooses the provider there instead of from an incomplete list.
   */
  let pickerLogin = $derived(authStatus?.capabilities?.pickerLogin === true)

  /**
   * Harness credentials are file-backed here (Pi): pick any catalog provider
   * and paste an API key — the whole flow stays in-app, no terminal handoff.
   */
  let apiKeyEntry = $derived(authStatus?.capabilities?.apiKeyEntry === true)
  let apiKey = $state('')
  let storingKey = $state(false)

  /** In-app sign-in state (Pi: OAuth flows and the provider's own key flows). */
  let oauthLoginId = $state<string | null>(null)
  let oauthStatus = $state('')
  let oauthDeviceCode = $state<{ userCode: string; verificationUri: string } | null>(null)
  let oauthPrompt = $state<{
    promptId: string
    type: 'text' | 'secret' | 'select' | 'manual_code'
    message: string
    placeholder?: string
    options?: Array<{ id: string; label: string }>
  } | null>(null)
  let oauthPromptAnswer = $state('')
  let oauthStarting = $state(false)
  /** The catalog flags providers that support a fully in-app browser sign-in. */
  let selectedProviderIsOauth = $derived(selectedProvider?.oauth === true)

  function resetOAuthState(): void {
    oauthLoginId = null
    oauthStatus = ''
    oauthDeviceCode = null
    oauthPrompt = null
    oauthPromptAnswer = ''
    oauthStarting = false
  }

  function handleOAuthPayload(payload: unknown): void {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      (payload as Record<string, unknown>)['loginId'] !== oauthLoginId
    ) {
      return
    }
    const data = payload as Record<string, unknown>
    if (data['kind'] === 'event') {
      const event = data['event'] as Record<string, unknown> | undefined
      if (!event) return
      if (event['type'] === 'auth_url') {
        oauthStatus = 'A browser window opened — finish signing in there.'
        void openInBrowser(String(event['url']))
      } else if (event['type'] === 'device_code') {
        oauthDeviceCode = {
          userCode: String(event['userCode']),
          verificationUri: String(event['verificationUri'])
        }
        oauthStatus = ''
      } else if (event['type'] === 'progress' || event['type'] === 'info') {
        oauthStatus = String(event['message'])
      }
    } else if (data['kind'] === 'prompt') {
      const prompt = data['prompt'] as Record<string, unknown> | undefined
      if (!prompt) return
      oauthPrompt = {
        promptId: String(data['promptId']),
        type:
          prompt['type'] === 'secret' ||
          prompt['type'] === 'select' ||
          prompt['type'] === 'manual_code'
            ? prompt['type']
            : 'text',
        message: String(prompt['message'] ?? 'Continue sign-in'),
        ...(typeof prompt['placeholder'] === 'string'
          ? { placeholder: prompt['placeholder'] }
          : {}),
        ...(Array.isArray(prompt['options'])
          ? {
              options: (prompt['options'] as Array<Record<string, unknown>>).map((option) => ({
                id: String(option['id']),
                label: String(option['label'])
              }))
            }
          : {})
      }
      oauthPromptAnswer = ''
    } else if (data['kind'] === 'complete') {
      const providerId = String(data['providerId'] ?? '')
      resetOAuthState()
      selectedProvider = null
      apiKey = ''
      notice = `${providerId} connected. Its models will appear in the picker.`
      void checkAuth()
      void loadOffered()
      providerCatalog.invalidateAll()
    } else if (data['kind'] === 'failed') {
      actionError = String(data['error'] ?? 'The sign-in failed.')
      resetOAuthState()
    }
  }

  /** Launch the provider's own in-app sign-in flow (OAuth or guided key entry). */
  async function startProviderSignIn(): Promise<void> {
    if (!selectedProvider || oauthStarting) return
    actionError = ''
    actionWarning = ''
    notice = ''
    oauthStarting = true
    oauthStatus = 'Starting sign-in…'
    try {
      oauthLoginId = await invoke(
        'providerAccounts:beginOAuthLogin',
        harness.id,
        selectedProvider.id
      )
    } catch (startError) {
      actionError =
        startError instanceof Error ? startError.message : 'The sign-in could not be started.'
      resetOAuthState()
    }
  }

  async function submitOAuthPrompt(): Promise<void> {
    if (!oauthLoginId || !oauthPrompt) return
    const answer = oauthPromptAnswer.trim()
    if (!answer) return
    oauthPrompt = null
    oauthPromptAnswer = ''
    oauthStatus = 'Continuing sign-in…'
    try {
      await invoke('providerAccounts:respondOAuthPrompt', oauthLoginId, answer)
    } catch (answerError) {
      actionError =
        answerError instanceof Error ? answerError.message : 'The answer could not be sent.'
    }
  }

  /** Answer a select prompt by choosing one of its options directly. */
  async function answerSelectPrompt(optionId: string): Promise<void> {
    if (!oauthLoginId || !oauthPrompt) return
    oauthPrompt = null
    oauthStatus = 'Continuing sign-in…'
    try {
      await invoke('providerAccounts:respondOAuthPrompt', oauthLoginId, optionId)
    } catch (answerError) {
      actionError =
        answerError instanceof Error ? answerError.message : 'The answer could not be sent.'
    }
  }

  async function cancelOAuthSignIn(): Promise<void> {
    if (!oauthLoginId) return
    const loginId = oauthLoginId
    resetOAuthState()
    try {
      await invoke('providerAccounts:cancelOAuthLogin', loginId)
    } catch {
      // The session may have already ended.
    }
  }

  let canAddCustom = $derived(harness.supportsCustomProviders && harness.integration === 'ready')

  /** Only OpenCode exposes a config-file mechanism (disabled_providers) to hide providers. */
  let supportsHide = $derived(harness.id === 'opencode')

  let filteredOffered = $derived(
    offered.filter(
      (provider) =>
        !hiddenIds.includes(provider.id) &&
        (search.trim() === '' ||
          provider.name.toLowerCase().includes(search.toLowerCase()) ||
          provider.id.toLowerCase().includes(search.toLowerCase()))
    )
  )

  async function checkAuth(): Promise<void> {
    checkingAuth = true
    try {
      authStatus = await invoke('providerAccounts:getAuthStatus', harness.id)
    } catch (authError) {
      authStatus = {
        capabilities: null,
        state: 'error',
        accounts: [],
        detail: authError instanceof Error ? authError.message : 'Authentication check failed.'
      }
    } finally {
      checkingAuth = false
    }
  }

  async function loadOffered(): Promise<void> {
    offeredLoading = true
    offeredError = ''
    try {
      offered = await invoke('providerAccounts:listOffered', harness.id)
    } catch (offerError) {
      offeredError =
        offerError instanceof Error ? offerError.message : 'Providers could not be loaded.'
      offered = []
    } finally {
      offeredLoading = false
    }
  }

  async function loadHidden(): Promise<void> {
    if (!supportsHide) return
    try {
      hiddenIds = await invoke('providerAccounts:getHidden', harness.id)
    } catch {
      hiddenIds = []
    }
  }

  function openPicker(): void {
    actionError = ''
    actionWarning = ''
    notice = ''
    step = 'picking'
    if (offered.length === 0) void loadOffered()
  }

  function backToList(): void {
    selectedProvider = null
    search = ''
    apiKey = ''
    step = 'idle'
    if (oauthLoginId !== null) void cancelOAuthSignIn()
  }

  /** Store the pasted key in the harness's own auth file and refresh state. */
  async function connectWithKey(): Promise<void> {
    if (!selectedProvider || storingKey) return
    actionError = ''
    actionWarning = ''
    notice = ''
    const key = apiKey.trim()
    if (!key) {
      actionWarning = `Enter an API key for ${selectedProvider.name}.`
      return
    }
    storingKey = true
    try {
      await invoke('providerAccounts:setApiKey', harness.id, selectedProvider.id, key)
      notice = `${selectedProvider.name} connected. Its models will appear in the picker.`
      selectedProvider = null
      apiKey = ''
      await checkAuth()
      await loadOffered()
      providerCatalog.invalidateAll()
    } catch (storeError) {
      actionError =
        storeError instanceof Error ? storeError.message : 'The API key could not be stored.'
    } finally {
      storingKey = false
    }
  }

  /**
   * Launch the harness's own login command in the embedded terminal. When no
   * provider is given, the harness shows its interactive provider picker.
   */
  async function startConnect(provider: OfferedProvider | null): Promise<void> {
    actionError = ''
    actionWarning = ''
    notice = ''
    try {
      loginHandoff = await invoke('providerAccounts:beginLogin', harness.id, {
        ...(provider ? { providerId: provider.id } : {})
      })
      selectedProvider = provider
      terminalId = `provider-login-${crypto.randomUUID()}`
      step = 'running'
    } catch (loginError) {
      actionError =
        loginError instanceof Error
          ? loginError.message
          : 'The login command could not be prepared.'
    }
  }

  function cancelConnection(): void {
    loginHandoff = null
    selectedProvider = null
    apiKey = ''
    step = pickerLogin && !apiKeyEntry ? 'idle' : 'picking'
  }

  async function handleLoginExit(exitCode: number): Promise<void> {
    const providerName = selectedProvider?.name ?? 'Provider'
    loginHandoff = null
    selectedProvider = null
    apiKey = ''
    step = pickerLogin && !apiKeyEntry ? 'idle' : 'picking'
    if (exitCode === 0) {
      notice = pickerLogin
        ? 'Sign-in complete. Newly connected providers appear above and their models show up in the model picker.'
        : `${providerName} connected. Its models will appear in the picker.`
    } else {
      actionWarning = `${providerName} sign-in exited with code ${exitCode}.`
    }
    await checkAuth()
    await loadOffered()
    // A new connection means new models — drop the stale model-picker cache so
    // the next open refresh reflects the newly connected provider.
    providerCatalog.invalidateAll()
  }

  async function confirmDisconnect(): Promise<void> {
    if (!disconnectTarget) return
    disconnecting = true
    actionError = ''
    actionWarning = ''
    try {
      const targetId = disconnectTarget.id
      await invoke('providerAccounts:logout', harness.id, targetId)
      disconnectTarget = null
      notice = `Disconnected ${targetId}.`
      await checkAuth()
      await loadOffered()
      providerCatalog.invalidateAll()
    } catch (logoutError) {
      actionError =
        logoutError instanceof Error
          ? logoutError.message
          : 'The provider could not be disconnected.'
    } finally {
      disconnecting = false
    }
  }

  async function toggleHidden(providerId: string, hidden: boolean): Promise<void> {
    if (!supportsHide) return
    togglingHide = true
    actionError = ''
    actionWarning = ''
    try {
      hiddenIds = await invoke('providerAccounts:setHidden', harness.id, providerId, hidden)
    } catch (hideError) {
      actionError =
        hideError instanceof Error ? hideError.message : 'The provider could not be hidden.'
    } finally {
      togglingHide = false
    }
  }

  function shellCommand(handoff: ProviderAccountLoginHandoff): string {
    return [handoff.command, ...handoff.args]
      .map((part) =>
        /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`
      )
      .join(' ')
  }

  function stateLabel(): string {
    if (authStatus === null) return 'Not checked'
    switch (authStatus.state) {
      case 'authenticated':
        return `${authStatus.accounts.length} authenticated provider${
          authStatus.accounts.length === 1 ? '' : 's'
        }`
      case 'unauthenticated':
        return 'No providers connected'
      case 'unknown':
        return 'Status unknown'
      case 'error':
        return authStatus.detail ?? 'Error'
      case 'unsupported':
        return 'Sign-in not supported by this harness'
    }
  }

  onMount(() => {
    void baseUrlProviderStore.load()
    void checkAuth()
    void loadHidden()
    void loadOffered()
    const unsubscribeOAuth = subscribe('providerAccounts:oauthEvent', (payload) =>
      handleOAuthPayload(payload)
    )
    return unsubscribeOAuth
  })
</script>

<Modal open size="lg" title={`Add provider — ${harness.name}`} {onClose}>
  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-4">
      {#if tab === 'custom'}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          Add any OpenAI-compatible endpoint by base URL — Ollama, LM Studio, llama.cpp, or a hosted
          gateway. Models appear in the picker after the next agent turn.
        </p>
      {:else if antigravityConnected}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          Antigravity is already connected through the Google account in your system keyring.
        </p>
      {:else if apiKeyEntry && canSignIn}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          Pick any provider from {harness.name}’s catalog and paste its API key — stored in
          {harness.name}’s own credential file.
        </p>
      {:else if pickerLogin}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          Runs {harness.name}’s own interactive provider picker in a built-in terminal — choose any
          provider there and follow the flow it shows (API key or OAuth).
        </p>
      {:else if canSignIn}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          Runs {harness.name}’s own sign-in flow in a built-in terminal rooted at your home
          directory — a browser window opens so you can authenticate.
        </p>
      {:else}
        <p class="min-w-0 flex-1 text-[11px] text-dimmed">
          {harness.name} does not expose a login flow CodeInOven can run. Use the Custom base URL tab
          to add an OpenAI-compatible provider instead.
        </p>
      {/if}
      <div class="flex shrink-0 items-center gap-2">
        {#if tab === 'custom'}
          <button
            class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover"
            type="button"
            onclick={() => onAddCustom(harness.id)}
          >
            <Server size={13} /> Open custom provider form
          </button>
        {:else if step === 'running'}
          <button
            class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
            type="button"
            onclick={cancelConnection}
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
              onclick={() => (step === 'idle' ? openPicker() : void connectWithKey())}
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
                  ? void startConnect(null)
                  : step === 'idle'
                    ? openPicker()
                    : selectedProvider
                      ? void startConnect(selectedProvider)
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
  {/snippet}

  <div class="mb-4 flex gap-1 rounded-lg bg-elevated p-1">
    <button
      class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors {tab ===
      'connect'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      type="button"
      onclick={() => (tab = 'connect')}
    >
      <Plug size={13} /> Connect provider
    </button>
    {#if canAddCustom}
      <button
        class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors {tab ===
        'custom'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        type="button"
        onclick={() => (tab = 'custom')}
      >
        <Server size={13} /> Custom base URL
      </button>
    {/if}
  </div>

  {#if tab === 'connect'}
    <div class="space-y-4">
      {#if step === 'idle'}
        <div
          class="flex items-center justify-between gap-3 rounded-xl border bg-surface px-3 py-2.5"
        >
          <div class="flex min-w-0 items-center gap-2">
            {#if authStatus?.state === 'authenticated'}
              <CheckCircle2 size={15} class="shrink-0 text-success" />
            {:else}
              <KeyRound size={15} class="shrink-0 text-dimmed" />
            {/if}
            <p class="truncate text-xs font-medium">{stateLabel()}</p>
          </div>
          <button
            class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[11px] font-medium hover:bg-overlay disabled:opacity-50"
            title="Re-check {harness.name} sign-in status"
            disabled={checkingAuth}
            onclick={() => void checkAuth()}
          >
            <RefreshCw size={11} class={checkingAuth ? 'animate-spin' : ''} />
            Check
          </button>
        </div>
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

      {#if step === 'idle' && authStatus?.accounts.length}
        <div class="space-y-1.5">
          <p class="text-[11px] font-medium text-dimmed">Connected providers</p>
          {#each authStatus.accounts as account (account.id)}
            <div
              class="flex items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2"
            >
              <div class="flex min-w-0 items-center gap-2">
                <CheckCircle2 size={13} class="shrink-0 text-success" />
                <span class="truncate text-xs">{account.label}</span>
                {#if account.method}
                  <span
                    class="rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-dimmed"
                    >{account.method}</span
                  >
                {/if}
                {#if hiddenIds.includes(account.id)}
                  <span
                    class="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium text-dimmed"
                    title="Hidden from the {harness.name} model picker via its config"
                  >
                    Hidden
                  </span>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                {#if supportsHide}
                  <Switch
                    checked={hiddenIds.includes(account.id)}
                    disabled={togglingHide}
                    label="Hide"
                    title="Hide {account.label} from the {harness.name} model picker via its config"
                    onchange={() => void toggleHidden(account.id, !hiddenIds.includes(account.id))}
                  />
                {/if}
                <button
                  class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[11px] font-medium text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                  title="Disconnect {account.label}"
                  disabled={disconnecting}
                  onclick={() => (disconnectTarget = account)}
                >
                  <Unplug size={11} /> Disconnect
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if step === 'running' && loginHandoff}
        <div class="space-y-2">
          <div class="h-60 overflow-hidden rounded-xl border bg-app">
            <ProviderLoginTerminal
              {terminalId}
              command={loginHandoff.command}
              args={loginHandoff.args}
              onExit={(exitCode) => void handleLoginExit(exitCode)}
            />
          </div>
          <p class="font-mono text-[10px] text-dimmed">
            $ {shellCommand(loginHandoff)}
          </p>
        </div>
      {:else if step === 'picking'}
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] font-medium text-dimmed">Providers {harness.name} offers</p>
            <button
              class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[11px] font-medium hover:bg-overlay"
              type="button"
              onclick={backToList}
            >
              <X size={11} /> Back
            </button>
          </div>
          <div class="relative">
            <Search
              size={13}
              class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
            />
            <input
              class="h-9 w-full rounded-lg border bg-elevated pl-8 pr-3 text-sm outline-none focus:border-primary"
              placeholder="Search providers"
              autocomplete="off"
              spellcheck="false"
              bind:value={search}
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
                    if (oauthLoginId !== null) void cancelOAuthSignIn()
                    selectedProvider = provider
                  }}
                >
                  <span class="min-w-0">
                    <span class="block truncate text-xs font-medium">{provider.name}</span>
                    <span
                      class="block truncate font-mono text-[10px] {selectedProvider?.id ===
                      provider.id
                        ? 'text-on-primary/70'
                        : 'text-dimmed'}"
                    >
                      {provider.id}
                    </span>
                  </span>
                  {#if provider.authenticated}
                    <span
                      class="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
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
              class="block text-[11px] font-medium text-foreground"
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
                  void connectWithKey()
                }
              }}
            />
            <p class="text-[10px] text-dimmed">
              Stored by CodeInOven in {harness.name}’s own credential file — never sent anywhere
              else.
            </p>
          {/snippet}

          {#if apiKeyEntry && selectedProvider}
            <div class="space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
              {#if oauthLoginId !== null}
                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <Loader2 size={13} class="animate-spin text-primary" />
                    <p class="min-w-0 flex-1 truncate text-[11px] text-muted">
                      {oauthStatus || 'Waiting for the provider…'}
                    </p>
                    <button
                      class="shrink-0 rounded-lg border bg-elevated px-2 py-1 text-[10px] font-medium text-muted hover:bg-overlay"
                      type="button"
                      title="Cancel the sign-in"
                      onclick={() => void cancelOAuthSignIn()}
                    >
                      Cancel
                    </button>
                  </div>
                  {#if oauthDeviceCode}
                    <div class="rounded-lg border bg-surface p-2.5 text-center">
                      <p class="text-[10px] text-dimmed">
                        Enter this code at
                        <button
                          class="font-medium text-primary underline underline-offset-2"
                          type="button"
                          title="Open {oauthDeviceCode.verificationUri}"
                          onclick={() => void openInBrowser(oauthDeviceCode?.verificationUri ?? '')}
                        >
                          {oauthDeviceCode.verificationUri}
                        </button>
                      </p>
                      <p
                        class="mt-1 font-mono text-base font-semibold tracking-widest text-foreground"
                      >
                        {oauthDeviceCode.userCode}
                      </p>
                    </div>
                  {/if}
                  {#if oauthPrompt}
                    <div class="space-y-1.5">
                      {#if oauthPrompt.type === 'select' && oauthPrompt.options}
                        <p class="text-[11px] font-medium text-foreground">{oauthPrompt.message}</p>
                        <div class="space-y-1">
                          {#each oauthPrompt.options as option (option.id)}
                            <button
                              class="w-full rounded-lg border bg-elevated px-3 py-2 text-left text-xs text-foreground hover:bg-overlay"
                              type="button"
                              title="Choose {option.label}"
                              onclick={() => void answerSelectPrompt(option.id)}
                            >
                              {option.label}
                            </button>
                          {/each}
                        </div>
                      {:else}
                        <label
                          class="block text-[11px] font-medium text-foreground"
                          for="oauth-prompt-input"
                        >
                          {oauthPrompt.message}
                        </label>
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                          id="oauth-prompt-input"
                          type={oauthPrompt.type === 'secret' ? 'password' : 'text'}
                          autocomplete="off"
                          spellcheck="false"
                          class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                          placeholder={oauthPrompt.placeholder ??
                            (oauthPrompt.type === 'secret' ? 'Enter the value' : 'Paste the code')}
                          bind:value={oauthPromptAnswer}
                          autofocus
                          onkeydown={(event: KeyboardEvent) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void submitOAuthPrompt()
                            }
                          }}
                        />
                        <button
                          class="flex h-8 w-full items-center justify-center rounded-lg bg-primary text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                          type="button"
                          title="Continue the sign-in"
                          disabled={oauthPromptAnswer.trim() === ''}
                          onclick={() => void submitOAuthPrompt()}
                        >
                          Continue
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {:else if selectedProviderIsOauth}
                <p class="text-[11px] font-medium text-foreground">
                  Sign in to {selectedProvider.name}
                </p>
                <p class="text-[10px] text-dimmed">
                  A browser window opens, you approve access, and this app finishes the rest — no
                  key pasting needed.
                </p>
                <button
                  class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                  type="button"
                  title="Sign in to {selectedProvider.name} in your browser"
                  onclick={() => void startProviderSignIn()}
                >
                  <KeyRound size={13} /> Sign in with browser
                </button>
                <p class="text-center text-[10px] text-dimmed">— or paste an API key —</p>
                {@render apiKeyField(selectedProvider.name)}
              {:else}
                <p class="text-[11px] font-medium text-foreground">
                  Connect to {selectedProvider.name}
                </p>
                <p class="text-[10px] text-dimmed">
                  {harness.name}'s own sign-in flow runs right here — answer its prompts and the
                  credential is stored in {harness.name}'s credential file.
                </p>
                <button
                  class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                  type="button"
                  title="Connect to {selectedProvider.name}"
                  onclick={() => void startProviderSignIn()}
                >
                  <KeyRound size={13} /> Connect
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <div class="rounded-xl border border-dashed px-3 py-2.5">
          {#if apiKeyEntry}
            <p class="text-[11px] text-muted">
              Click <strong class="font-medium text-foreground">Search providers</strong> below to
              browse {harness.name}’s full provider catalog, then sign in or paste an API key to
              connect.
            </p>
          {:else if pickerLogin}
            <p class="text-[11px] text-muted">
              Click <strong class="font-medium text-foreground">Connect provider</strong> below to
              open {harness.name}’s own provider picker in the built-in terminal — choose the
              provider you want there.
            </p>
          {:else}
            <p class="text-[11px] text-muted">
              Click <strong class="font-medium text-foreground">Connect provider</strong> below to pick
              a provider and sign in from here — no copying commands.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="space-y-4">
      <div class="flex items-center justify-between rounded-xl border bg-surface px-3 py-2.5">
        <p class="text-xs">
          <strong class="font-medium">Custom providers for {harness.name}</strong>
          <span class="ml-1.5 text-dimmed">
            {customCount} provider{customCount === 1 ? '' : 's'}
          </span>
        </p>
      </div>

      {#if customProviders.length > 0}
        <div class="space-y-1.5">
          <p class="text-[11px] font-medium text-dimmed">Custom providers</p>
          {#each customProviders as provider (provider.id)}
            <div
              class="flex items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2"
            >
              <div class="flex min-w-0 items-center gap-2">
                <Server size={13} class="shrink-0 text-dimmed" />
                <span class="truncate text-xs">{provider.name}</span>
                <span
                  class="truncate rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-dimmed"
                  title={provider.baseURL}
                >
                  {provider.baseURL}
                </span>
                {#if !provider.enabled}
                  <span
                    class="shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium text-dimmed"
                  >
                    Disabled
                  </span>
                {/if}
              </div>
              <button
                class="flex h-7 shrink-0 items-center gap-1 rounded-lg border bg-elevated px-2 text-[11px] font-medium hover:bg-overlay"
                title="Edit {provider.name}"
                type="button"
                onclick={() => onEditCustom(provider)}
              >
                <Pencil size={11} /> Edit
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="rounded-xl border border-dashed p-4 text-center">
          <p class="text-xs text-muted">
            No custom providers for {harness.name} yet. Click
            <strong class="font-medium text-foreground">Open custom provider form</strong> below to add
            one.
          </p>
        </div>
      {/if}
    </div>
  {/if}
</Modal>

<Modal
  open={disconnectTarget !== null}
  title="Disconnect provider"
  onClose={() => (disconnectTarget = null)}
>
  {#snippet footer()}
    <button
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      type="button"
      onclick={() => (disconnectTarget = null)}
    >
      Cancel
    </button>
    <button
      class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      type="button"
      disabled={disconnecting}
      onclick={() => void confirmDisconnect()}
    >
      {#if disconnecting}<Loader2 size={13} class="animate-spin" />{:else}<Unplug size={13} />{/if}
      Disconnect provider
    </button>
  {/snippet}

  <div class="flex gap-2 text-sm text-muted">
    <Unplug size={16} class="mt-0.5 shrink-0 text-warning" />
    <p>
      Disconnect <strong class="text-foreground">{disconnectTarget?.label}</strong>? This runs
      {harness.name}’s own logout command and removes the stored credential.
    </p>
  </div>
</Modal>
