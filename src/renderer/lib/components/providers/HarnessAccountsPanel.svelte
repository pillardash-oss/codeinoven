<script lang="ts">
  import CioCheckCircle from '$lib/components/icons/cio/CioCheckCircle.svelte'
  import CioClose from '$lib/components/icons/cio/CioClose.svelte'
  import CioFilter from '$lib/components/icons/cio/CioFilter.svelte'
  import CioKey from '$lib/components/icons/cio/CioKey.svelte'
  import CioPencil from '$lib/components/icons/cio/CioPencil.svelte'
  import CioPerson from '$lib/components/icons/cio/CioPerson.svelte'
  import CioRefresh from '$lib/components/icons/cio/CioRefresh.svelte'
  import CioSearch from '$lib/components/icons/cio/CioSearch.svelte'
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import CioStar from '$lib/components/icons/cio/CioStar.svelte'
  import CioUnplug from '$lib/components/icons/cio/CioUnplug.svelte'
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { LogIn } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import type {
    HarnessAccount,
    ProviderAccountAuthEntry,
    ProviderAccountAuthStatus,
    ProviderConnectionInfo
  } from '$shared/types'
  import { bankedResetSummary, creditsLabel } from '$lib/format/usage'
  import { formatCompactAge, formatDateTimeWithWeekday } from '$shared/date-time-format'
  import DataTable, { type DataTableColumn } from '$lib/components/ui/DataTable.svelte'
  import HarnessAccountUsageCell from './HarnessAccountUsageCell.svelte'
  import ProviderSignInPanel from './ProviderSignInPanel.svelte'
  import Modal from '../ui/Modal.svelte'

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

  /** Every row the table shows: authenticated accounts plus custom providers. */
  const rows = $derived<HarnessAccount[]>([...accounts, ...customProviderRows])

  function isCustomProviderRow(account: HarnessAccount): boolean {
    return isCodeInOvenCustomProviderId(account.providerId)
  }

  type AccountSortKey = 'account'

  /** Quota telemetry column. Not sortable, so the cell snippet identifies it by
   *  reference instead of a sort key. */
  const usageColumn: DataTableColumn<HarnessAccount, AccountSortKey> = {
    key: null,
    header: 'Usage',
    width: 'w-[44rem]',
    cellClass: 'align-middle'
  }

  const accountColumns: DataTableColumn<HarnessAccount, AccountSortKey>[] = [
    {
      key: 'account',
      header: 'Account',
      width: 'w-56',
      cellClass: 'align-middle',
      sortValue: (account) =>
        [
          harnessFor(account.harnessId)?.name ?? account.harnessId,
          providerLabel(account),
          account.label
        ]
          .join('\u0000')
          .toLocaleLowerCase('en-US')
    },
    usageColumn,
    {
      key: null,
      header: 'Actions',
      width: 'w-64',
      cellClass: 'align-middle'
    }
  ]

  let filterHarnesses = $derived.by(() => {
    const seen: Record<string, true> = {}
    const harnesses: Array<{ id: string; name: string }> = []
    for (const account of rows) {
      if (seen[account.harnessId]) continue
      seen[account.harnessId] = true
      harnesses.push({
        id: account.harnessId,
        name: harnessFor(account.harnessId)?.name ?? account.harnessId
      })
    }
    return harnesses.toSorted((left, right) => left.name.localeCompare(right.name))
  })

  let selectedHarnesses = new SvelteSet<string>()
  let harnessFilterActive = $derived(selectedHarnesses.size > 0)

  /** Accounts sharing the same harness+provider; a default only matters when
   *  there is more than one to choose from. */
  let siblingCounts = $derived.by(() => {
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

  let filteredRows = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase('en-US')
    return rows.filter((account) => {
      if (harnessFilterActive && !selectedHarnesses.has(account.harnessId)) return false
      if (!query) return true
      const harnessName = harnessFor(account.harnessId)?.name ?? account.harnessId
      return [account.label, account.providerId, harnessName, account.harnessId].some((value) =>
        value.toLocaleLowerCase('en-US').includes(query)
      )
    })
  })

  function harnessFor(harnessId: string): ProviderConnectionInfo | undefined {
    return providers.find((provider) => provider.id === harnessId)
  }

  function providerLabel(account: HarnessAccount): string {
    return account.providerName || account.providerId
  }

  function toggleHarnessFilter(harnessId: string): void {
    if (selectedHarnesses.has(harnessId)) selectedHarnesses.delete(harnessId)
    else selectedHarnesses.add(harnessId)
  }

  function clearHarnessFilter(): void {
    selectedHarnesses.clear()
  }

  function sortAccounts(nextAccounts: HarnessAccount[]): HarnessAccount[] {
    // Newest created accounts appear first by default.
    return nextAccounts.toSorted((left, right) => right.createdAt - left.createdAt)
  }

  function accountGroups(seed: HarnessAccount[]): SvelteMap<string, HarnessAccount[]> {
    const groups = new SvelteMap<string, HarnessAccount[]>()
    for (const account of seed) {
      groups.set(account.harnessId, [...(groups.get(account.harnessId) ?? []), account])
    }
    return groups
  }

  function applyAccountGroups(groups: ReadonlyMap<string, HarnessAccount[]>): void {
    accounts = sortAccounts([...groups.values()].flat())
  }

  /** Usage hydration progress, shown beside the account refresh progress. */
  let usageHydrating = $derived(harnessAccountUsageCache.hydrating)
  let usageProbed = $derived(
    Math.max(0, harnessAccountUsageCache.probingTotal - harnessAccountUsageCache.probingRemaining)
  )
  let usageTotal = $derived(harnessAccountUsageCache.probingTotal)

  /** Drop one row in place. Reloading the whole list swaps the table for the
   *  loading state, which collapses the page height and throws the user's
   *  scroll position away; removing the single entry leaves the rest untouched. */
  function dropAccount(accountId: string): void {
    accounts = accounts.filter((account) => account.id !== accountId)
    harnessAccountUsageCache.prune(rows.map((account) => account.id))
  }

  /** Swap one row's payload in place, preserving its position and scroll offset. */
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
    const groups = accountGroups(accounts)
    const storedHarnesses = new Set(groups.keys())
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
          groups.set(provider.id, await invoke('providerAccounts:list', provider.id, true))
          harnessAccountCache.invalidate(provider.id)
          applyAccountGroups(groups)
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
   *  probes finish, and usage hydrates in its own bounded batches so the tab
   *  never blocks on either. */
  async function refreshAll(): Promise<void> {
    harnessAccountUsageCache.schedule(rows, { force: true })
    await refreshAccounts()
    // A forced account read can surface a newly created account; queue it now
    // so usage covers every row the table shows.
    harnessAccountUsageCache.schedule(rows)
  }

  async function initializeAccounts(): Promise<void> {
    await loadStoredAccounts()
    // Quota hydrates immediately in small batches: cached snapshots paint first
    // and each account's live values land as its probe completes.
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

<div class="space-y-4">
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
        class="h-8 w-full border bg-elevated pl-8 pr-3 text-xs text-foreground placeholder:text-dimmed focus:border-primary/50 focus:outline-none"
      />
    </div>
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 border px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Refresh accounts and usage"
      disabled={loading || refreshing}
      onclick={() => void refreshAll()}
    >
      <CioRefresh size={12} class={refreshing ? 'animate-spin' : ''} /> Refresh
    </button>
    <span class="min-w-28 text-right text-xs tabular-nums text-dimmed" aria-live="polite">
      {#if refreshing && usageHydrating}
        {refreshCompleted}/{refreshTotal} · usage {usageProbed}/{usageTotal}
      {:else if refreshing}
        {refreshCompleted}/{refreshTotal}
      {:else if usageHydrating}
        usage {usageProbed}/{usageTotal}
      {/if}
    </span>
  </div>

  {#if filterHarnesses.length > 1}
    <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by harness">
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 border px-2.5 text-[0.6875rem] font-medium transition-colors {!harnessFilterActive
          ? 'border-primary bg-primary text-on-primary'
          : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={!harnessFilterActive}
        title="Show accounts for all harnesses"
        onclick={clearHarnessFilter}
      >
        <CioFilter size={11} class="shrink-0" />
        All
      </button>
      {#each filterHarnesses as harness (harness.id)}
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 border px-2.5 text-[0.6875rem] font-medium transition-colors {selectedHarnesses.has(
            harness.id
          )
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={selectedHarnesses.has(harness.id)}
          title={`Filter accounts by ${harness.name}`}
          onclick={() => toggleHarnessFilter(harness.id)}
        >
          <AgentIcon agentId={harness.id} label={harness.name} size={14} />
          <span class="truncate">{harness.name}</span>
        </button>
      {/each}
      {#if harnessFilterActive}
        <button
          type="button"
          class="flex h-7 items-center gap-1 border bg-elevated px-2 text-[0.6875rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
          title="Clear harness filter"
          onclick={clearHarnessFilter}
        >
          <CioClose size={11} /> Clear
        </button>
      {/if}
    </div>
  {/if}

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
      <p class="text-xs tabular-nums text-dimmed">
        {refreshCompleted} of {refreshTotal} checked
      </p>
    </div>
  {:else if accounts.length === 0}
    <div class="border border-dashed p-8 text-center">
      <CioPerson size={20} class="mx-auto mb-2 text-dimmed" />
      <p class="text-xs text-muted">No accounts have been created yet.</p>
    </div>
  {:else if filteredRows.length === 0}
    <div class="border border-dashed p-8 text-center">
      <CioFilter size={18} class="mx-auto mb-2 text-dimmed" />
      <p class="text-xs text-dimmed">
        {harnessFilterActive
          ? 'No accounts match the selected harnesses.'
          : 'No accounts match your search.'}
      </p>
      {#if harnessFilterActive}
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
    <DataTable
      rows={filteredRows}
      columns={accountColumns}
      getRowId={(account) => account.id}
      label="Harness accounts"
      rowClass="transition-colors hover:bg-elevated/40"
      clearable
    >
      {#snippet cell(
        account: HarnessAccount,
        column: DataTableColumn<HarnessAccount, AccountSortKey>
      )}
        {@const harness = harnessFor(account.harnessId)}
        {@const usageSnapshot = harnessAccountUsageCache.snapshotFor(account.id)}
        {@const accountUsage = usageSnapshot?.usage}
        {@const hasReportedLimits =
          !!accountUsage &&
          (accountUsage.rateLimits.length > 0 ||
            bankedResetSummary(accountUsage.bankedResets) !== undefined ||
            creditsLabel(accountUsage) !== undefined)}
        {#if column.key === 'account'}
          <div class="flex min-w-0 items-center gap-2.5">
            <AgentIcon
              agentId={account.harnessId}
              label={harness?.name ?? account.harnessId}
              size={20}
            />
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-xs font-medium">{account.label}</span>
                {#if account.isDefault}
                  <span
                    class="shrink-0 border border-border bg-raised px-1 text-[0.625rem] font-medium text-muted"
                    title="Default account for this provider"
                  >
                    Default
                  </span>
                {/if}
                {#if isCustomProviderRow(account)}
                  <span
                    class="shrink-0 border border-border bg-raised px-1 text-[0.625rem] font-medium text-muted"
                    title="Custom base URL provider"
                  >
                    Custom
                  </span>
                {/if}
              </div>
              <p
                class="truncate text-[0.625rem] text-muted"
                title={`${harness?.name ?? account.harnessId} · ${providerLabel(account)}`}
              >
                {harness?.name ?? account.harnessId} · {providerLabel(account)}
              </p>
              {#if hasReportedLimits && usageSnapshot && usageSnapshot.fetchedAt > 0}
                {#if harnessAccountUsageCache.isProbing(account.id) && !usageSnapshot.error}
                  <p class="truncate text-[0.625rem] text-dimmed">Checking…</p>
                {:else}
                  <p
                    class="truncate text-[0.625rem] text-dimmed"
                    title={`Last checked ${formatDateTimeWithWeekday(usageSnapshot.fetchedAt)}${usageSnapshot.error ? ` · ${usageSnapshot.error}` : ''}`}
                  >
                    Updated {formatCompactAge(usageSnapshot.fetchedAt)}
                  </p>
                {/if}
              {/if}
            </div>
          </div>
        {:else if column === usageColumn}
          <HarnessAccountUsageCell {account} />
        {:else if isCustomProviderRow(account)}
          <span class="text-[0.6875rem] text-dimmed">Edit in Providers</span>
        {:else}
          <div class="flex items-center gap-1">
            {#if hasSiblingAccounts(account) && !account.isDefault}
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-1 text-[0.6875rem] text-dimmed transition-colors hover:bg-elevated hover:text-accent"
                title={`Set ${account.label} as the default account for ${providerLabel(account)}`}
                aria-label={`Set ${account.label} as the default account for ${providerLabel(account)}`}
                onclick={() => void setDefault(account)}
              >
                <CioStar size={12} aria-hidden="true" />
                Make default
              </button>
            {/if}
            <button
              type="button"
              class="inline-flex items-center gap-1 px-1.5 py-1 text-[0.6875rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title={`Edit label for ${account.label}`}
              aria-label={`Edit label for ${account.label}`}
              onclick={() => openEdit(account)}
            >
              <CioPencil size={12} aria-hidden="true" />
              Edit
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 px-1.5 py-1 text-[0.6875rem] text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
              title={`Disconnect ${account.label}`}
              aria-label={`Disconnect ${account.label}`}
              onclick={() => (disconnectTarget = account)}
            >
              <CioUnplug size={12} aria-hidden="true" />
              Disconnect
            </button>
          </div>
        {/if}
      {/snippet}
    </DataTable>
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
            <LogIn size={13} aria-hidden="true" />
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
    <CioUnplug size={16} class="mt-0.5 shrink-0 text-danger" />
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
    harnessName={harnessFor(signInAccount.harnessId)?.name ?? signInAccount.harnessId}
    providerId={signInAccount.providerId || undefined}
    providerName={signInAccount.label}
    accountId={signInAccount.id}
    onClose={() => (signInTarget = null)}
    onComplete={() => void completeSignIn(signInAccount)}
  />
{/if}
