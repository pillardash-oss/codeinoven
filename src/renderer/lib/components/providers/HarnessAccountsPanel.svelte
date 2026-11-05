<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioLogIn from '@pdslng/cio-icon/CioLogIn.svelte'
  import CioPerson from '@pdslng/cio-icon/CioPerson.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUnplug from '@pdslng/cio-icon/CioUnplug.svelte'
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { invoke } from '$lib/ipc.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import type {
    HarnessAccount,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderConnectionInfo
  } from '$shared/types'
  import { quotaPercent } from '$lib/format/usage'
  import Modal from '../ui/Modal.svelte'
  import ProviderSignInPanel from './ProviderSignInPanel.svelte'
  import HarnessAccountList from './accounts/HarnessAccountList.svelte'
  import HarnessAccountDetail from './accounts/HarnessAccountDetail.svelte'
  import {
    groupAccountsByHarness,
    type AccountGroup
  } from './accounts/harness-account-presentation'

  interface Props {
    providers: ProviderConnectionInfo[]
  }

  let { providers }: Props = $props()

  let accounts = $state.raw<HarnessAccount[]>([])
  let loading = $state(true)
  let refreshing = $state(false)
  let refreshCompleted = $state(0)
  let refreshTotal = $state(0)
  let error = $state('')
  let search = $state('')
  let selectedHarnesses = new SvelteSet<string>()
  let hiddenOnly = $state(false)
  let selectedId = $state('')
  let showingDetail = $state(false)
  let hidingAccountId = $state('')
  let defaultingAccountId = $state('')

  let editTarget = $state<HarnessAccount | null>(null)
  let editLabel = $state('')
  let saving = $state(false)
  let disconnectTarget = $state<HarnessAccount | null>(null)
  let disconnecting = $state(false)

  /**
   * Credential state of the account the edit modal is showing.
   *
   * Replacing a credential never changes the account row, so the label the user
   * already chose survives: the modal reads the account's own auth status to
   * learn how it is authenticated, then either writes a new API key into that
   * account's credential home or re-runs the harness's own sign-in against it.
   */
  let editStatus = $state<ProviderAccountAuthStatus | null>(null)
  let editStatusLoading = $state(false)
  let editError = $state('')
  let editNotice = $state('')
  let newApiKey = $state('')
  let replacingKey = $state(false)
  /** Account whose credential is being re-authenticated through the sign-in panel. */
  let signInTarget = $state<HarnessAccount | null>(null)

  /**
   * A custom base-URL provider is not an authenticated account, so the account
   * registry never lists it. Its usage route is still account-level quota, so
   * it earns a usage-only row here, keyed by the provider id   the same
   * identity the battery hover and `refreshAccountUsage` use, which keeps two
   * custom providers in one harness from sharing one cache slot.
   */
  const customProviderRows = $derived.by(() =>
    baseUrlProviderStore.providers
      .filter((provider) => provider.enabled && Boolean(provider.usagePath))
      .map((provider): HarnessAccount => ({
        id: provider.id,
        harnessId: provider.harnessId,
        providerId: provider.id,
        providerName: provider.name,
        label: provider.name,
        containerKind: 'legacy-default',
        createdAt: 0,
        updatedAt: 0
      }))
  )

  /** Every row the page shows: authenticated accounts plus custom providers. */
  const rows = $derived<HarnessAccount[]>([...accounts, ...customProviderRows])

  function harnessFor(harnessId: string): ProviderConnectionInfo | undefined {
    return providers.find((provider) => provider.id === harnessId)
  }

  function harnessName(harnessId: string): string {
    return harnessFor(harnessId)?.name ?? harnessId
  }

  function providerLabel(account: HarnessAccount): string {
    return account.providerName || account.providerId
  }

  const filterHarnesses = $derived.by(() => {
    const seen: Record<string, true> = {}
    const harnesses: Array<{ id: string; name: string; count: number }> = []
    for (const account of rows) {
      if (seen[account.harnessId]) {
        const entry = harnesses.find((candidate) => candidate.id === account.harnessId)
        if (entry) entry.count += 1
        continue
      }
      seen[account.harnessId] = true
      harnesses.push({
        id: account.harnessId,
        name: harnessName(account.harnessId),
        count: 1
      })
    }
    return harnesses.toSorted((left, right) => left.name.localeCompare(right.name))
  })

  const hiddenCount = $derived(rows.filter((account) => account.hidden === true).length)
  const harnessFilterActive = $derived(selectedHarnesses.size > 0)

  /** Accounts sharing the same harness+provider; a default only matters when
   *  there is more than one to choose from. */
  const siblingCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>()
    for (const account of rows) {
      const key = `${account.harnessId}\u0000${account.providerId}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  })

  function hasSiblingAccounts(account: HarnessAccount): boolean {
    return (siblingCounts.get(`${account.harnessId}\u0000${account.providerId}`) ?? 0) > 1
  }

  const filteredRows = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase('en-US')
    return rows.filter((account) => {
      if (harnessFilterActive && !selectedHarnesses.has(account.harnessId)) return false
      if (hiddenOnly && account.hidden !== true) return false
      if (!query) return true
      return [
        account.label,
        account.providerId,
        account.providerName,
        harnessName(account.harnessId)
      ]
        .join('\u0000')
        .toLocaleLowerCase('en-US')
        .includes(query)
    })
  })

  const groups = $derived<AccountGroup[]>(
    groupAccountsByHarness(filteredRows, (harnessId) => harnessName(harnessId))
  )

  /**
   * The account the detail pane reads. It follows the selection when that row is
   * still visible and falls back to the first visible account otherwise, so a
   * filter change or a disconnect can never leave the pane pointing at nothing.
   */
  const selectedAccount = $derived(
    filteredRows.find((account) => account.id === selectedId) ?? filteredRows[0]
  )

  /** Accounts with at least one window at or above 90% used. */
  const nearLimitCount = $derived(
    rows.filter((account) =>
      (harnessAccountUsageCache.snapshotFor(account.id)?.usage?.rateLimits ?? []).some(
        (window) => (quotaPercent(window) ?? 0) >= 90
      )
    ).length
  )

  /** Accounts whose harness sign-in expired, so their quota cannot be read. */
  const needSignInCount = $derived(
    rows.filter(
      (account) =>
        harnessAccountUsageCache.snapshotFor(account.id)?.reauthenticationRequired === true
    ).length
  )

  const usageHydrating = $derived(harnessAccountUsageCache.hydrating)
  const usageProbed = $derived(
    Math.max(0, harnessAccountUsageCache.probingTotal - harnessAccountUsageCache.probingRemaining)
  )
  const usageTotal = $derived(harnessAccountUsageCache.probingTotal)
  const progressLabel = $derived.by(() => {
    if (refreshing && usageHydrating) {
      return `${refreshCompleted}/${refreshTotal} · usage ${usageProbed}/${usageTotal}`
    }
    if (refreshing) return `${refreshCompleted}/${refreshTotal}`
    if (usageHydrating) return `usage ${usageProbed}/${usageTotal}`
    return ''
  })

  function selectAccount(account: HarnessAccount): void {
    selectedId = account.id
    showingDetail = true
  }

  function toggleHarnessFilter(harnessId: string): void {
    if (selectedHarnesses.has(harnessId)) selectedHarnesses.delete(harnessId)
    else selectedHarnesses.add(harnessId)
    hiddenOnly = false
  }

  function clearHarnessFilter(): void {
    selectedHarnesses.clear()
    hiddenOnly = false
  }

  function toggleHiddenFilter(): void {
    hiddenOnly = !hiddenOnly
    selectedHarnesses.clear()
  }

  function sortAccounts(nextAccounts: HarnessAccount[]): HarnessAccount[] {
    // Newest created accounts appear first by default.
    return nextAccounts.toSorted((left, right) => right.createdAt - left.createdAt)
  }

  function accountGroups(seed: HarnessAccount[]): SvelteMap<string, HarnessAccount[]> {
    const grouped = new SvelteMap<string, HarnessAccount[]>()
    for (const account of seed) {
      grouped.set(account.harnessId, [...(grouped.get(account.harnessId) ?? []), account])
    }
    return grouped
  }

  function applyAccountGroups(grouped: ReadonlyMap<string, HarnessAccount[]>): void {
    accounts = sortAccounts([...grouped.values()].flat())
  }

  /** Drop one row in place, leaving the rest and the scroll position untouched. */
  function dropAccount(accountId: string): void {
    accounts = accounts.filter((account) => account.id !== accountId)
    harnessAccountUsageCache.prune(rows.map((account) => account.id))
  }

  /** Swap one row's payload in place, preserving its position. */
  function replaceAccount(updated: HarnessAccount): void {
    accounts = accounts.map((account) => (account.id === updated.id ? updated : account))
  }

  async function loadStoredAccounts(): Promise<void> {
    loading = true
    error = ''
    try {
      accounts = sortAccounts(await invoke('providerAccounts:list'))
      harnessAccountUsageCache.prune(rows.map((account) => account.id))
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Accounts could not be loaded.'
    } finally {
      loading = false
    }
  }

  async function refreshAccounts(): Promise<void> {
    if (refreshing) return
    refreshing = true
    error = ''
    refreshCompleted = 0
    const grouped = accountGroups(accounts)
    const storedHarnesses = new Set(grouped.keys())
    const harnesses = providers
      .map((provider, index) => ({ provider, index }))
      .toSorted((left, right) => {
        const leftPriority = storedHarnesses.has(left.provider.id)
          ? 0
          : left.provider.status === 'available'
            ? 1
            : 2
        const rightPriority = storedHarnesses.has(right.provider.id)
          ? 0
          : right.provider.status === 'available'
            ? 1
            : 2
        return leftPriority - rightPriority || left.index - right.index
      })
      .map(({ provider }) => provider)
    refreshTotal = harnesses.length
    const refreshErrors: Array<{ harnessName: string; message: string }> = []
    try {
      // Main-process auth probes are serialized. Updating one harness at a time
      // keeps work bounded and makes each completed result visible immediately.
      for (const provider of harnesses) {
        try {
          grouped.set(provider.id, await invoke('providerAccounts:list', provider.id, true))
          harnessAccountCache.invalidate(provider.id)
          applyAccountGroups(grouped)
        } catch (refreshError) {
          refreshErrors.push({
            harnessName: provider.name,
            message:
              refreshError instanceof Error ? refreshError.message : 'The account check failed.'
          })
        } finally {
          refreshCompleted += 1
        }
      }
      if (refreshErrors.length > 0) {
        const names = refreshErrors.map((failure) => failure.harnessName)
        const harnessNames =
          names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
        const firstFailure = refreshErrors[0]
        error = `${harnessNames} could not be checked.${firstFailure ? ` ${firstFailure.harnessName}: ${firstFailure.message}` : ''}`
      }
    } finally {
      refreshing = false
    }
  }

  /** Refresh accounts and their quota together: the account list updates as
   *  probes finish, and usage hydrates in its own bounded batches so the page
   *  never blocks on either. */
  async function refreshAll(): Promise<void> {
    harnessAccountUsageCache.schedule(rows, { force: true })
    await refreshAccounts()
    harnessAccountUsageCache.schedule(rows)
  }

  async function initializeAccounts(): Promise<void> {
    await loadStoredAccounts()
    harnessAccountUsageCache.schedule(rows)
    await refreshAccounts()
    harnessAccountUsageCache.schedule(rows)
  }

  /** Custom-provider rows can appear after this panel mounts, once the provider
   *  store hydrates, so probe them as they show up. */
  let scheduledCustomRowIds = ''
  $effect(() => {
    const ids = customProviderRows.map((row) => row.id).join('\u0000')
    if (ids === scheduledCustomRowIds) return
    scheduledCustomRowIds = ids
    if (ids) harnessAccountUsageCache.schedule(customProviderRows)
  })

  /** The auth entry describing the account being edited, when the harness reports one. */
  const editAuthEntry = $derived.by((): ProviderAccountAuthEntry | undefined => {
    if (!editTarget || !editStatus) return undefined
    return (
      editStatus.accounts.find((entry) => entry.providerId === editTarget?.providerId) ??
      editStatus.accounts.find((entry) => entry.active !== false)
    )
  })

  /** OAuth accounts are re-authenticated; API-key accounts get a replaced key. */
  const editIsOauth = $derived(editAuthEntry?.method?.toLowerCase() === 'oauth')

  const editCapabilities = $derived(editStatus?.capabilities ?? null)

  /** A pasted key can only replace a key-backed account the harness can store keys for. */
  const canReplaceApiKey = $derived(
    !!editTarget?.providerId && editCapabilities?.apiKeyEntry === true && !editIsOauth
  )

  /**
   * Whether this account can be signed in again from here.
   *
   * An OAuth account has no key to paste, so re-running the harness's own
   * sign-in is the only way to refresh it. The same action is offered for an
   * API-key account on a harness that also supports sign-in, so a stale key can
   * be swapped for a fresh sign-in without disconnecting the account.
   */
  const canSignInAgain = $derived(
    editCapabilities !== null && (editCapabilities.inAppLogin || editCapabilities.loginHandoff)
  )

  /** Human label for the credential method an account's auth entry reports. */
  function credentialMethodLabel(method: string | undefined): string {
    if (!method) return 'stored credentials'
    const normalized = method.toLowerCase()
    if (normalized === 'oauth') return 'an OAuth sign-in'
    if (normalized === 'api-key' || normalized === 'api_key') return 'an API key'
    return method
  }

  function openEdit(account: HarnessAccount): void {
    editTarget = account
    editLabel = account.label
    editStatus = null
    editError = ''
    editNotice = ''
    newApiKey = ''
    void loadEditStatus(account)
  }

  function closeEdit(): void {
    editTarget = null
    editStatus = null
    editError = ''
    editNotice = ''
    newApiKey = ''
  }

  /** Read how the account is authenticated against its own credential home. */
  async function loadEditStatus(account: HarnessAccount): Promise<void> {
    editStatusLoading = true
    editError = ''
    try {
      editStatus = await invoke(
        'providerAccounts:getAuthStatus',
        account.harnessId,
        undefined,
        account.id
      )
    } catch (statusError) {
      editStatus = null
      editError =
        statusError instanceof Error ? statusError.message : 'The account status could not be read.'
    } finally {
      editStatusLoading = false
    }
  }

  /** Write a new key into the account's own credential home, keeping its label. */
  async function replaceApiKey(): Promise<void> {
    if (!editTarget || replacingKey) return
    const account = editTarget
    const key = newApiKey.trim()
    if (!key) {
      editError = 'Enter the new API key.'
      return
    }
    replacingKey = true
    editError = ''
    editNotice = ''
    try {
      await invoke(
        'providerAccounts:setApiKey',
        account.harnessId,
        account.providerId,
        key,
        account.id
      )
      newApiKey = ''
      harnessAccountCache.invalidate(account.harnessId)
      await loadEditStatus(account)
      editNotice = `The API key for ${account.label} was replaced.`
      harnessAccountUsageCache.schedule([account], { force: true })
    } catch (replaceError) {
      editError =
        replaceError instanceof Error ? replaceError.message : 'The API key was not replaced.'
    } finally {
      replacingKey = false
    }
  }

  /** Hand the account to the shared sign-in panel, which re-runs the harness's own flow. */
  function startSignIn(account: HarnessAccount): void {
    closeEdit()
    signInTarget = account
  }

  async function completeSignIn(account: HarnessAccount): Promise<void> {
    signInTarget = null
    harnessAccountCache.invalidate(account.harnessId)
    await loadStoredAccounts()
    harnessAccountUsageCache.schedule(rows, { force: true })
  }

  async function saveLabel(): Promise<void> {
    if (!editTarget || saving) return
    const label = editLabel.trim()
    if (!label || label === editTarget.label) {
      closeEdit()
      return
    }
    saving = true
    editError = ''
    try {
      const updated = await invoke('providerAccounts:rename', editTarget.id, label)
      harnessAccountCache.invalidate(updated.harnessId)
      replaceAccount(updated)
      closeEdit()
    } catch (saveError) {
      editError =
        saveError instanceof Error ? saveError.message : 'The account label was not saved.'
    } finally {
      saving = false
    }
  }

  /** Mark an account as its harness's default for the provider. */
  async function setDefault(account: HarnessAccount): Promise<void> {
    if (defaultingAccountId) return
    defaultingAccountId = account.id
    error = ''
    try {
      const updated = await harnessAccountCache.setDefault(account)
      accounts = sortAccounts([
        ...accounts.filter((candidate) => candidate.harnessId !== account.harnessId),
        ...updated
      ])
      await harnessAccountCache.activate(account)
    } catch (setDefaultError) {
      error =
        setDefaultError instanceof Error
          ? setDefaultError.message
          : 'The default account was not saved.'
    } finally {
      defaultingAccountId = ''
    }
  }

  /** Hide an account from the pickers that offer one, or show it again. Nothing
   *  about the credential moves, so this never touches the sign-in state. */
  async function toggleHidden(account: HarnessAccount): Promise<void> {
    if (hidingAccountId) return
    hidingAccountId = account.id
    error = ''
    try {
      replaceAccount(await harnessAccountCache.setHidden(account, !account.hidden))
    } catch (hideError) {
      error = hideError instanceof Error ? hideError.message : 'The account was not hidden.'
    } finally {
      hidingAccountId = ''
    }
  }

  async function disconnectAccount(): Promise<void> {
    if (!disconnectTarget || disconnecting) return
    disconnecting = true
    error = ''
    const account = disconnectTarget
    try {
      await invoke(
        'providerAccounts:logout',
        account.harnessId,
        account.providerId || undefined,
        account.id
      )
      await invoke('providerAccounts:remove', account.id)
      harnessAccountCache.invalidate(account.harnessId)
      dropAccount(account.id)
      disconnectTarget = null
      showingDetail = false
    } catch (disconnectError) {
      error =
        disconnectError instanceof Error
          ? disconnectError.message
          : 'The account was not disconnected.'
    } finally {
      disconnecting = false
    }
  }

  onMount(() => void initializeAccounts())
</script>

<div class="space-y-3">
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-52 flex-1">
        <CioSearch
          size={14}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <input
          bind:value={search}
          type="text"
          placeholder="Search accounts…"
          aria-label="Search accounts"
          class="h-8 w-full border bg-surface pl-8 pr-3 text-xs text-foreground placeholder:text-dimmed focus:border-primary/50 focus:outline-none"
        />
      </div>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 border bg-surface px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Refresh accounts and usage"
        disabled={loading || refreshing}
        onclick={() => void refreshAll()}
      >
        <CioRefresh size={12} class={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
        Refresh
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <div
        class="flex flex-wrap items-center gap-0.5 border bg-elevated p-0.5"
        role="group"
        aria-label="Filter accounts"
      >
        <button
          type="button"
          class="flex h-7 items-center gap-1 px-2.5 text-[0.6875rem] font-medium transition-colors {!harnessFilterActive &&
          !hiddenOnly
            ? 'bg-surface text-foreground'
            : 'text-muted hover:text-foreground'}"
          aria-pressed={!harnessFilterActive && !hiddenOnly}
          title="Show every account"
          onclick={clearHarnessFilter}
        >
          All <span class="tabular-nums text-dimmed">{rows.length}</span>
        </button>
        {#each filterHarnesses as harness (harness.id)}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 px-2.5 text-[0.6875rem] font-medium transition-colors {selectedHarnesses.has(
              harness.id
            )
              ? 'bg-surface text-foreground'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={selectedHarnesses.has(harness.id)}
            title={`Show only ${harness.name} accounts`}
            onclick={() => toggleHarnessFilter(harness.id)}
          >
            <span class="flex shrink-0" aria-hidden="true">
              <AgentIcon agentId={harness.id} label={harness.name} size={11} />
            </span>
            <span class="truncate">{harness.name}</span>
            <span class="tabular-nums text-dimmed">{harness.count}</span>
          </button>
        {/each}
        {#if hiddenCount > 0}
          <button
            type="button"
            class="flex h-7 items-center gap-1 px-2.5 text-[0.6875rem] font-medium transition-colors {hiddenOnly
              ? 'bg-surface text-foreground'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={hiddenOnly}
            title="Show only accounts hidden from account pickers"
            onclick={toggleHiddenFilter}
          >
            Hidden <span class="tabular-nums text-dimmed">{hiddenCount}</span>
          </button>
        {/if}
      </div>

      <p
        class="ml-auto flex flex-wrap items-center gap-x-2 text-[0.6875rem] tabular-nums text-dimmed"
      >
        <span>{rows.length} accounts</span>
        {#if nearLimitCount > 0}
          <span class="text-warning">{nearLimitCount} near limit</span>
        {/if}
        {#if needSignInCount > 0}
          <span class="text-danger">{needSignInCount} need sign-in</span>
        {/if}
        {#if progressLabel}
          <span>{progressLabel}</span>
        {/if}
      </p>
    </div>
  </div>

  {#if error}
    <p class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}

  {#if loading}
    <div class="flex h-32 items-center justify-center">
      <CioSpinner size={18} class="animate-spin text-dimmed" />
    </div>
  {:else if refreshing && accounts.length === 0}
    <div class="flex h-32 flex-col items-center justify-center gap-2 text-center">
      <CioSpinner size={18} class="animate-spin text-dimmed" />
      <p class="text-xs text-muted">Checking connected providers…</p>
      <p class="text-xs tabular-nums text-dimmed">{refreshCompleted} of {refreshTotal} checked</p>
    </div>
  {:else if rows.length === 0}
    <div class="border border-dashed p-8 text-center">
      <CioPerson size={20} class="mx-auto mb-2 text-dimmed" />
      <p class="text-xs text-muted">No accounts have been created yet.</p>
    </div>
  {:else if filteredRows.length === 0}
    <div class="border border-dashed p-8 text-center">
      <p class="text-xs text-dimmed">
        {hiddenOnly
          ? 'Every account is currently visible in account pickers.'
          : harnessFilterActive
            ? 'No accounts belong to the selected harnesses.'
            : 'No accounts match your search.'}
      </p>
      {#if hiddenOnly || harnessFilterActive}
        <button
          type="button"
          class="mt-2 text-xs font-medium text-primary hover:underline"
          onclick={clearHarnessFilter}
        >
          Show all accounts
        </button>
      {/if}
    </div>
  {:else}
    <div class="grid gap-3 lg:grid-cols-[21rem_minmax(0,1fr)] lg:items-start">
      <div class="border bg-surface {showingDetail ? 'hidden lg:block' : ''}">
        <HarnessAccountList
          {groups}
          selectedId={selectedAccount?.id ?? ''}
          onselect={selectAccount}
        />
      </div>
      <div
        class="border bg-surface {showingDetail ? '' : 'hidden lg:block'} lg:sticky lg:top-0"
        aria-live="polite"
      >
        {#if selectedAccount}
          <HarnessAccountDetail
            account={selectedAccount}
            harnessName={harnessName(selectedAccount.harnessId)}
            canMakeDefault={!selectedAccount.isDefault && hasSiblingAccounts(selectedAccount)}
            hiddenBusy={hidingAccountId === selectedAccount.id}
            defaultBusy={defaultingAccountId === selectedAccount.id}
            onBack={() => (showingDetail = false)}
            onEdit={() => openEdit(selectedAccount)}
            onDisconnect={() => (disconnectTarget = selectedAccount)}
            onToggleHidden={() => void toggleHidden(selectedAccount)}
            onSignIn={() => startSignIn(selectedAccount)}
            onMakeDefault={() => void setDefault(selectedAccount)}
          />
        {:else}
          <p class="p-8 text-center text-xs text-dimmed">
            Select an account to see its quota and credentials.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<Modal open={editTarget !== null} title="Edit account" onClose={closeEdit}>
  {#snippet footer()}
    <button
      type="button"
      class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      onclick={closeEdit}
    >
      Cancel
    </button>
    <button
      type="button"
      class="h-9 bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={saving || editLabel.trim() === ''}
      onclick={() => void saveLabel()}
    >
      {saving ? 'Saving…' : 'Save label'}
    </button>
  {/snippet}

  {#if editTarget}
    {@const account = editTarget}
    <div class="space-y-4">
      <label class="block space-y-1.5">
        <span class="text-xs font-medium">Label</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={editLabel}
          maxlength="80"
          autocomplete="off"
          autofocus
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') void saveLabel()
          }}
        />
      </label>

      <div class="space-y-3 border-t pt-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium">Credentials</span>
          {#if editStatusLoading}
            <CioSpinner size={13} class="animate-spin text-dimmed" aria-hidden="true" />
          {/if}
        </div>

        <p class="text-[0.6875rem] text-muted">
          {account.label} is connected to {providerLabel(account)} with {credentialMethodLabel(
            editAuthEntry?.method
          )}. Replacing it keeps this account and its label.
        </p>

        {#if editError}
          <p
            class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            role="alert"
          >
            {editError}
          </p>
        {/if}
        {#if editNotice}
          <p
            class="flex items-start gap-1.5 border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
            role="status"
          >
            <CioCheckCircle size={13} class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{editNotice}</span>
          </p>
        {/if}

        {#if canReplaceApiKey}
          <div class="space-y-1.5">
            <label
              class="block text-[0.6875rem] font-medium text-foreground"
              for="account-replacement-key"
            >
              New API key
            </label>
            <input
              id="account-replacement-key"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste the replacement key"
              class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
              bind:value={newApiKey}
              onkeydown={(event: KeyboardEvent) => {
                if (event.key === 'Enter') void replaceApiKey()
              }}
            />
            <button
              type="button"
              class="flex h-9 items-center gap-1.5 bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={replacingKey || newApiKey.trim() === ''}
              title={`Replace the API key for ${account.label}`}
              onclick={() => void replaceApiKey()}
            >
              {#if replacingKey}
                <CioSpinner size={13} class="animate-spin" aria-hidden="true" />
                Replacing…
              {:else}
                <CioKey size={13} aria-hidden="true" />
                Replace API key
              {/if}
            </button>
          </div>
        {/if}

        {#if canReplaceApiKey && canSignInAgain}
          <p class="text-center text-[0.625rem] text-dimmed">or</p>
        {/if}

        {#if canSignInAgain}
          <button
            type="button"
            class="flex h-9 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
            title={`Sign in to ${providerLabel(account)} again for ${account.label}`}
            onclick={() => startSignIn(account)}
          >
            <CioLogIn size={13} aria-hidden="true" />
            Sign in again
          </button>
        {/if}

        {#if !editStatusLoading && !canReplaceApiKey && !canSignInAgain}
          <p class="text-[0.6875rem] text-dimmed">
            {providerLabel(account)} does not let CodeInOven replace this account's credentials from here.
            Disconnect and connect again to change them.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</Modal>

<Modal
  open={disconnectTarget !== null}
  title="Disconnect account"
  onClose={() => (disconnectTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      onclick={() => (disconnectTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      disabled={disconnecting}
      onclick={() => void disconnectAccount()}
    >
      {#if disconnecting}<CioSpinner size={13} class="animate-spin" />{:else}<CioUnplug
          size={13}
        />{/if}
      Disconnect
    </button>
  {/snippet}

  <div class="flex gap-2 text-sm text-muted">
    <p>
      Disconnect <strong class="text-foreground">{disconnectTarget?.label}</strong>? This logs the
      account out{#if disconnectTarget?.containerKind === 'managed'}
        and permanently deletes its isolated credential container{/if}.
    </p>
  </div>
</Modal>

{#if signInTarget}
  {@const signInAccount = signInTarget}
  <ProviderSignInPanel
    harnessId={signInAccount.harnessId}
    harnessName={harnessName(signInAccount.harnessId)}
    providerId={signInAccount.providerId || undefined}
    providerName={signInAccount.label}
    accountId={signInAccount.id}
    onClose={() => (signInTarget = null)}
    onComplete={() => void completeSignIn(signInAccount)}
  />
{/if}
