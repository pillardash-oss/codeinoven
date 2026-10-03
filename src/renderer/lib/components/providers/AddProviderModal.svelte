<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2, Plug, Server, X } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { findFirstTextField, findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { APP_SLUG } from '$shared/brand'
  import type {
    BaseUrlProvider,
    OfferedProvider,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderAccountLoginHandoff,
    ProviderConnectionInfo,
    HarnessAccount
  } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import AddProviderModalConnectTab from './AddProviderModalConnectTab.svelte'
  import AddProviderModalCustomTab from './AddProviderModalCustomTab.svelte'
  import AddProviderModalFooter from './AddProviderModalFooter.svelte'
  import { AddProviderModalOAuthController } from './add-provider-modal-oauth.svelte'
  import {
    type AddTab,
    type ConnectStep,
    providerMatchesSearch
  } from './add-provider-modal-helpers'

  interface Props {
    harness: ProviderConnectionInfo
    onClose: () => void
    /** Hand the user off to the custom base-URL editor, pre-scoped to this harness. */
    onAddCustom: (harnessId: string) => void
    /** Hand the user off to the custom base-URL editor to edit an existing provider. */
    onEditCustom: (provider: BaseUrlProvider) => void
    /** Tab shown on open   e.g. 'custom' when returning here via the editor's Back button. */
    initialTab?: AddTab
    /** Provider-search text the connect list starts with. Pre-filled only when
     *  the harness actually offers a match, so a first-run user lands on the
     *  familiar connect screen with their own providers, not on an empty list. */
    initialSearch?: string
    /** Fired once a provider finished connecting and its account was saved. */
    onProviderConnected?: () => void
  }

  let {
    harness,
    onClose,
    onAddCustom,
    onEditCustom,
    initialTab = 'connect',
    initialSearch = '',
    onProviderConnected
  }: Props = $props()

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
  let hiddenIds = $state<string[]>([])
  let togglingHide = $state(false)
  let notice = $state('')
  let actionWarning = $state('')
  let actionError = $state('')
  let accountLabel = $state('')
  let pendingAccountId = $state<string | null>(null)
  let authenticatedProvider = $state<{ id: string; name: string } | null>(null)
  let finalizingAccount = $state(false)
  let knownAccounts = $state.raw<HarnessAccount[]>([])
  let disconnectTarget = $state<HarnessAccount | null>(null)
  let disconnecting = $state(false)
  let apiKey = $state('')
  let storingKey = $state(false)

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
   *  command. Its bare `agy` launch is only a login handoff while signed out. */
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
   * and paste an API key   the whole flow stays in-app, no terminal handoff.
   */
  let apiKeyEntry = $derived(authStatus?.capabilities?.apiKeyEntry === true)

  let canAddCustom = $derived(harness.supportsCustomProviders && harness.integration === 'ready')

  /** Only OpenCode exposes a config-file mechanism to hide providers:
   *  V1's `disabled_providers`, V2's `experimental.policies` provider.use deny. */
  let supportsHide = $derived(harness.id === 'opencode')

  let filteredOffered = $derived(
    offered.filter(
      (provider) => !hiddenIds.includes(provider.id) && providerMatchesSearch(provider, search)
    )
  )

  const oauth = new AddProviderModalOAuthController({
    harnessId: () => harness.id,
    selectedProvider: () => selectedProvider,
    clearApiKey: () => (apiKey = ''),
    clearMessages: () => {
      actionError = ''
      actionWarning = ''
      notice = ''
    },
    setActionError: (message) => (actionError = message),
    preparePendingAccount: (providerId) => preparePendingAccount(providerId),
    finishAuthentication: (providerId, providerName) =>
      finishAuthentication(providerId, providerName),
    discardPendingAccount: () => discardPendingAccount()
  })

  /**
   * Owns the panel's remembered placement, shared with the dock row below so a
   * docked sign-in reopens on the edge the user left it on.
   */
  const PANEL_STORAGE_KEY = `${APP_SLUG}.addProviderPanel.v1`

  /**
   * Whether a sign-in is running, and so whether the panel may be dismissed.
   *
   * Dismissing an in-flight sign-in would throw away the pending account and the
   * OAuth event subscription along with it, so the close affordance is withheld
   * while a login is live. Escape then minimizes instead of closing, which is the
   * same rule the harness run panel uses for a run in progress.
   */
  const signingIn = $derived(oauth.loginId !== null)

  /**
   * Docking follows the view, not only the `auth_url` event.
   *
   * The event is the earliest signal and still has to dock first, but it is not
   * the only route to the browser. A device-code link reveals the browser without
   * one, and a harness that prints its own authorization URL asks the user to go
   * and open it. Whenever the app actually switches to the browser mid sign-in
   * the panel has to get out of the way, or it sits over the one page the user
   * has to act on. A settled flow is exempt: `reset()` clears the login id, so a
   * panel that finished while the user browsed does not follow them out.
   *
   * The transition guard is what stops this fighting the user. Restoring the panel
   * from the dock chip does not change the view, so a panel restored to read the
   * device code stays restored until the app leaves the browser and comes back.
   */
  let previousView = rendererRecovery.activeView
  $effect(() => {
    const view = rendererRecovery.activeView
    const enteredBrowser = view !== previousView && view === 'browser'
    previousView = view
    if (!enteredBrowser || oauth.loginId === null) return
    // Only when the app browser is where the sign-in actually is. A user who
    // turned the link preference off has the page in their real browser, so the
    // app browser taking the view is nothing to clear the way for, and the panel
    // holds the flow's status instead.
    if (!oauth.authPageInAppBrowser) return
    oauth.docked = true
  })

  /** Label for the dock chip's restore control, naming what it brings back. */
  const dockRestoreLabel = $derived(
    signingIn
      ? `Show the sign-in for ${selectedProvider?.name ?? 'this provider'}`
      : `Show the add provider panel for ${harness.name}`
  )

  /**
   * The chip's heading. The panel is docked for two reasons and must not claim
   * a sign-in it is not running: a browser handover (`oauth.docked`) and the user
   * minimizing the panel by hand, which says nothing about any sign-in.
   */
  const dockTitle = $derived(
    signingIn
      ? `Signing in to ${selectedProvider?.name ?? 'this provider'}`
      : `Add provider for ${harness.name}`
  )

  /**
   * What the chip says while a sign-in is running.
   *
   * A device-code flow is what makes the chip carry its weight: docking hides the
   * panel body where the code is printed, and that code is the one thing left to
   * type into the page the browser just opened. So the chip repeats it, rather
   * than leaving the user to restore the panel to read a string they are already
   * expected to copy. The verification URL is not repeated: the browser is
   * already sitting on it.
   */
  const dockStatus = $derived(
    oauth.deviceCode
      ? `Enter ${oauth.deviceCode.userCode} to finish signing in.`
      : oauth.status || 'Finish signing in in the browser.'
  )

  /** What the dock chip's dismiss control does: it ends the attempt, like the panel's own close. */
  const dockDismissLabel = $derived(
    signingIn
      ? `Cancel the sign-in for ${selectedProvider?.name ?? 'this provider'}`
      : `Close the add provider panel for ${harness.name}`
  )

  /**
   * The app's modal focus rule: the first field the user would type into, else
   * the primary action. `ui/Modal.svelte` applies this on open for every modal,
   * so the panel claims it explicitly rather than letting the switch to
   * `DockableModal` quietly drop it.
   */
  function claimPanelInitialFocus(panel: HTMLElement): boolean {
    const field = findFirstTextField(panel)
    if (field) {
      field.focus()
      return true
    }
    const action = findPanelPrimaryAction(panel)
    if (!action) return false
    action.focus()
    return true
  }

  async function checkAuth(): Promise<void> {
    checkingAuth = true
    try {
      authStatus = await invoke('providerAccounts:getAuthStatus', harness.id)
      knownAccounts = await invoke('providerAccounts:list', harness.id)
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

  async function preparePendingAccount(providerId = ''): Promise<HarnessAccount> {
    if (pendingAccountId) {
      return {
        id: pendingAccountId,
        harnessId: harness.id,
        providerId,
        providerName: providerId,
        label: '',
        containerKind: 'managed',
        createdAt: 0,
        updatedAt: 0
      }
    }
    const pending = await invoke('providerAccounts:prepare', harness.id, providerId || undefined)
    pendingAccountId = pending.id
    return {
      ...pending,
      providerName: providerId,
      label: '',
      containerKind: 'managed',
      createdAt: 0,
      updatedAt: 0
    }
  }

  async function discardPendingAccount(): Promise<void> {
    const pendingId = pendingAccountId
    pendingAccountId = null
    authenticatedProvider = null
    accountLabel = ''
    if (!pendingId) return
    await invoke('providerAccounts:cancelPending', pendingId).catch(() => undefined)
  }

  async function finishAuthentication(providerId: string, providerName: string): Promise<void> {
    if (!pendingAccountId) return
    try {
      const pendingStatus = await invoke('providerAccounts:inspectPending', pendingAccountId)
      const authenticated = pendingStatus.accounts.find(
        (account) => account.active !== false && account.providerId === providerId
      )
      if (!authenticated) {
        actionError = `${providerName} did not report a completed sign-in.`
        await discardPendingAccount()
        return
      }
      authenticatedProvider = {
        id: authenticated.providerId,
        name: authenticated.label || providerName
      }
      accountLabel = ''
      selectedProvider = null
      step = 'labeling'
    } catch (inspectError) {
      actionError =
        inspectError instanceof Error
          ? inspectError.message
          : `${providerName} sign-in could not be verified.`
    }
  }

  async function saveAuthenticatedAccount(): Promise<void> {
    if (!pendingAccountId || !authenticatedProvider || finalizingAccount) return
    finalizingAccount = true
    actionError = ''
    try {
      const account = await invoke(
        'providerAccounts:finalizePending',
        pendingAccountId,
        authenticatedProvider.id,
        accountLabel.trim() || undefined
      )
      notice = `${account.label} connected.`
      pendingAccountId = null
      authenticatedProvider = null
      accountLabel = ''
      step = 'idle'
      harnessAccountCache.invalidate(harness.id)
      await checkAuth()
      await loadOffered()
      providerCatalog.invalidateAll()
      onProviderConnected?.()
    } catch (finalizeError) {
      actionError =
        finalizeError instanceof Error ? finalizeError.message : 'The account could not be saved.'
    } finally {
      finalizingAccount = false
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

  async function toggleHidden(providerId: string, hidden: boolean): Promise<void> {
    if (!supportsHide) return
    togglingHide = true
    actionError = ''
    actionWarning = ''
    try {
      hiddenIds = await invoke('providerAccounts:setHidden', harness.id, providerId, hidden)
      // The harness's own catalog now includes (or excludes) this provider, so
      // drop the cached one or the model picker keeps showing the old set.
      providerCatalog.invalidateAll()
    } catch (hideError) {
      actionError =
        hideError instanceof Error ? hideError.message : 'The provider could not be hidden.'
    } finally {
      togglingHide = false
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
    if (oauth.loginId !== null) void oauth.cancel()
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
      const account = await preparePendingAccount(selectedProvider.id)
      await invoke('providerAccounts:setApiKey', harness.id, selectedProvider.id, key, account.id)
      apiKey = ''
      await finishAuthentication(selectedProvider.id, selectedProvider.name)
    } catch (storeError) {
      actionError =
        storeError instanceof Error ? storeError.message : 'The API key could not be stored.'
      await discardPendingAccount()
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
      const providerId =
        provider?.id ??
        (harness.id === 'codex' ? 'openai' : harness.id === 'claude-code' ? 'anthropic' : '')
      const account = await preparePendingAccount(providerId)
      loginHandoff = await invoke('providerAccounts:beginLogin', harness.id, {
        ...(provider ? { providerId: provider.id } : {}),
        accountId: account.id
      })
      selectedProvider = provider
      terminalId = `provider-login-${crypto.randomUUID()}`
      step = 'running'
    } catch (loginError) {
      actionError =
        loginError instanceof Error
          ? loginError.message
          : 'The login command could not be prepared.'
      await discardPendingAccount()
    }
  }

  function cancelConnection(): void {
    loginHandoff = null
    selectedProvider = null
    apiKey = ''
    accountLabel = ''
    step = pickerLogin && !apiKeyEntry ? 'idle' : 'picking'
    void discardPendingAccount()
  }

  async function handleLoginExit(exitCode: number): Promise<void> {
    const attemptedProvider = selectedProvider
    const providerName = selectedProvider?.name ?? 'Provider'
    loginHandoff = null
    selectedProvider = null
    apiKey = ''
    step = pickerLogin && !apiKeyEntry ? 'idle' : 'picking'
    if (exitCode === 0) {
      if (!pendingAccountId) return
      try {
        const pendingStatus = await invoke('providerAccounts:inspectPending', pendingAccountId)
        const authenticated = attemptedProvider
          ? pendingStatus.accounts.find(
              (account) => account.providerId === attemptedProvider.id && account.active !== false
            )
          : pendingStatus.accounts.find((account) => account.active !== false)
        if (!authenticated) {
          actionWarning = `${providerName} exited without completing sign-in.`
          await discardPendingAccount()
        } else {
          await finishAuthentication(authenticated.providerId, authenticated.label)
        }
      } catch (inspectError) {
        actionError =
          inspectError instanceof Error
            ? inspectError.message
            : `${providerName} sign-in could not be verified.`
      }
    } else {
      actionWarning = `${providerName} sign-in exited with code ${exitCode}.`
      await discardPendingAccount()
    }
  }

  /** Resolve the registered account behind one connected-provider row. Every
   * row is a dedicated account: container rows carry their account id as a
   * suffix (`<entryId>.<accountId>`), legacy rows match exactly, and a harness
   * whose own store holds several credentials per provider (OpenCode) is
   * matched by the credential id the row mirrors (`sourceId`), so two
   * connections on one provider stay separately actionable. */
  function accountForConnected(connected: ProviderAccountAuthEntry): HarnessAccount | undefined {
    return (
      knownAccounts.find((account) => account.sourceId === connected.id) ??
      knownAccounts.find((account) => account.id === connected.id) ??
      knownAccounts.find((account) => connected.id.endsWith(`.${account.id}`)) ??
      knownAccounts.find((account) => account.providerId === connected.providerId)
    )
  }

  async function disconnectProvider(): Promise<void> {
    if (!disconnectTarget || disconnecting) return
    disconnecting = true
    actionError = ''
    const account = disconnectTarget
    try {
      await invoke('providerAccounts:logout', account.harnessId, account.providerId, account.id)
      await invoke('providerAccounts:remove', account.id)
      disconnectTarget = null
      harnessAccountCache.invalidate(harness.id)
      await checkAuth()
      await loadOffered()
      providerCatalog.invalidateAll()
    } catch (disconnectError) {
      actionError =
        disconnectError instanceof Error
          ? disconnectError.message
          : 'The provider could not be disconnected.'
    } finally {
      disconnecting = false
    }
  }

  async function closeModal(): Promise<void> {
    if (oauth.loginId) await oauth.cancel()
    else await discardPendingAccount()
    onClose()
  }

  onMount(() => {
    void baseUrlProviderStore.load()
    void loadHidden()
    // A caller that names a provider search wants it waiting in the search box
    // for the next time the provider list is opened   never applied on top of
    // the connect screen itself. Jumping straight to the filtered list hid the
    // sign-in status and the already-connected providers, which is exactly what
    // a user who has accounts needs to see first.
    void Promise.all([checkAuth(), loadOffered()]).then(() => {
      const query = initialSearch.trim()
      search = offered.some((provider) => providerMatchesSearch(provider, query)) ? query : ''
    })
    const unsubscribeOAuth = subscribe('providerAccounts:oauthEvent', (payload) =>
      oauth.handlePayload(payload)
    )
    return unsubscribeOAuth
  })
</script>

<!--
  This is a dockable panel, not a plain modal, because a browser sign-in has to
  keep running while the browser is the view. The panel's own state holds the
  OAuth controller and its event subscription, and `DockableModal` keeps the panel
  mounted when it is minimized, so the sign-in survives the handover: device
  codes, prompts and results still arrive while the user is off in the browser.

  `DockRow` publishes the chip's rectangle to `browserVisibility`, which is what
  makes the chip work at all over the browser: the browser's page is a native
  `WebContentsView` the compositor paints above every DOM node, so the row makes
  that view stand down wherever the chip actually sits.
-->
<DockableModal
  open
  title={`Add provider   ${harness.name}`}
  minimized={oauth.docked}
  closable={!signingIn}
  onMinimize={() => (oauth.docked = true)}
  onClose={() => void closeModal()}
  storageKey={PANEL_STORAGE_KEY}
  dragLabel="Drag to move the add provider panel"
  defaultHeight={620}
  claimInitialFocus={claimPanelInitialFocus}
>
  {#snippet dock()}
    <DockRow storageKey={PANEL_STORAGE_KEY} label="Move docked provider sign-in">
      <div
        class="flex items-center gap-1 rounded-xl border bg-surface p-1.5 shadow-xl"
        data-region="provider-sign-in-dock"
      >
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={dockRestoreLabel}
          aria-label={dockRestoreLabel}
          onclick={() => (oauth.docked = false)}
        >
          {#if signingIn}
            <Loader2 size={14} class="shrink-0 animate-spin text-info" aria-hidden="true" />
          {/if}
          <span class="flex min-w-0 flex-col">
            <span class="text-[0.6875rem] leading-tight font-medium text-foreground">
              {dockTitle}
            </span>
            {#if signingIn}
              <span
                class="max-w-56 truncate text-[0.625rem] leading-tight text-muted"
                aria-live="polite"
              >
                {dockStatus}
              </span>
            {/if}
          </span>
        </button>
        <span class="h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={dockDismissLabel}
          title={dockDismissLabel}
          onclick={() => void closeModal()}
        >
          <X size={14} />
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#snippet footer()}
    <AddProviderModalFooter
      {tab}
      {step}
      {harness}
      {canSignIn}
      {pickerLogin}
      {apiKeyEntry}
      {antigravityConnected}
      {storingKey}
      oauthLoginId={oauth.loginId}
      {selectedProvider}
      {finalizingAccount}
      onOpenCustom={() => onAddCustom(harness.id)}
      onSaveAccount={() => void saveAuthenticatedAccount()}
      onCancelConnection={cancelConnection}
      onStartConnect={(provider) => void startConnect(provider)}
      onOpenPicker={openPicker}
      onConnectWithKey={() => void connectWithKey()}
    />
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
    <AddProviderModalConnectTab
      {harness}
      {step}
      {authStatus}
      {checkingAuth}
      {actionError}
      {actionWarning}
      {notice}
      {authenticatedProvider}
      bind:accountLabel
      {loginHandoff}
      {terminalId}
      bind:search
      {offered}
      {offeredLoading}
      {offeredError}
      {filteredOffered}
      bind:selectedProvider
      bind:apiKey
      {apiKeyEntry}
      {pickerLogin}
      {hiddenIds}
      {supportsHide}
      {togglingHide}
      {oauth}
      {accountForConnected}
      onCheckAuth={() => void checkAuth()}
      onSaveAuthenticatedAccount={() => void saveAuthenticatedAccount()}
      onBackToList={backToList}
      onConnectWithKey={() => void connectWithKey()}
      onLoginExit={(exitCode) => void handleLoginExit(exitCode)}
      onRequestDisconnect={(account) => (disconnectTarget = account)}
      onToggleHidden={(providerId, hidden) => void toggleHidden(providerId, hidden)}
    />
  {:else}
    <AddProviderModalCustomTab {harness} {customProviders} {customCount} {onEditCustom} />
  {/if}
</DockableModal>

<ConfirmDialog
  open={disconnectTarget !== null}
  title="Disconnect provider"
  confirmLabel="Disconnect"
  busy={disconnecting}
  onCancel={() => (disconnectTarget = null)}
  onConfirm={disconnectProvider}
>
  <p>
    Disconnect <strong class="text-foreground">{disconnectTarget?.label}</strong> from {harness.name}?
    The provider credential will be removed from this account container.
  </p>
</ConfirmDialog>
