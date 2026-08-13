<script lang="ts">
  import { onMount } from 'svelte'
  import {
    CheckCircle2,
    KeyRound,
    Loader2,
    Plug,
    RefreshCw,
    Search,
    Server,
    Unplug,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import type {
    OfferedProvider,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderAccountLoginHandoff,
    ProviderConnectionInfo
  } from '$shared/types'

  interface Props {
    harness: ProviderConnectionInfo
    onClose: () => void
    /** Hand the user off to the custom base-URL editor, pre-scoped to this harness. */
    onAddCustom: (harnessId: string) => void
  }

  let { harness, onClose, onAddCustom }: Props = $props()

  type AddTab = 'connect' | 'custom'
  type ConnectStep = 'idle' | 'picking' | 'running'

  let tab = $state<AddTab>('connect')
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
  let actionError = $state('')

  let customCount = $derived(
    baseUrlProviderStore.providers.filter((provider) => provider.harnessId === harness.id).length
  )

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
    notice = ''
    step = 'picking'
    if (offered.length === 0) void loadOffered()
  }

  function backToList(): void {
    selectedProvider = null
    search = ''
    step = 'idle'
  }

  /**
   * Launch the harness's own login command in the embedded terminal. When no
   * provider is given, the harness shows its interactive provider picker.
   */
  async function startConnect(provider: OfferedProvider | null): Promise<void> {
    actionError = ''
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
    step = pickerLogin ? 'idle' : 'picking'
  }

  async function handleLoginExit(exitCode: number): Promise<void> {
    const providerName = selectedProvider?.name ?? 'Provider'
    loginHandoff = null
    selectedProvider = null
    step = pickerLogin ? 'idle' : 'picking'
    notice =
      exitCode === 0
        ? pickerLogin
          ? 'Sign-in complete. Newly connected providers appear above and their models show up in the model picker.'
          : `${providerName} connected. Its models will appear in the picker.`
        : `${providerName} sign-in exited with code ${exitCode}.`
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
              <Search size={13} /> Select a provider
            {:else}
              <KeyRound size={13} /> Connect provider
            {/if}
          </button>
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
      <div class="flex items-center justify-between gap-3 rounded-xl border bg-surface px-3 py-2.5">
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

      {#if actionError}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {actionError}
        </p>
      {/if}
      {#if notice}
        <p class="rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
          {notice}
        </p>
      {/if}

      {#if authStatus?.accounts.length}
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
                  onclick={() => (selectedProvider = provider)}
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
        </div>
      {:else}
        <div class="rounded-xl border border-dashed px-3 py-2.5">
          {#if pickerLogin}
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
