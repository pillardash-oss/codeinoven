<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    ListFilter,
    Loader2,
    Pencil,
    RefreshCw,
    Search,
    Unplug,
    UserRound,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import type { HarnessAccount, ProviderConnectionInfo } from '$shared/types'
  import DataTable, { type DataTableColumn } from '$lib/components/ui/DataTable.svelte'
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

  type AccountSortKey = 'harness' | 'provider' | 'label'

  const accountColumns: DataTableColumn<HarnessAccount, AccountSortKey>[] = [
    {
      key: 'harness',
      header: 'Harness',
      sortValue: (account) =>
        (harnessFor(account.harnessId)?.name ?? account.harnessId).toLocaleLowerCase('en-US')
    },
    {
      key: 'provider',
      header: 'Provider',
      sortValue: (account) => providerLabel(account).toLocaleLowerCase('en-US')
    },
    {
      key: 'label',
      header: 'Label',
      sortValue: (account) => account.label.toLocaleLowerCase('en-US')
    },
    { key: null, header: 'Actions', headerClass: 'sr-only' }
  ]

  let filterHarnesses = $derived.by(() => {
    const seen: Record<string, true> = {}
    const harnesses: Array<{ id: string; name: string }> = []
    for (const account of accounts) {
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

  let filteredAccounts = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase('en-US')
    return accounts.filter((account) => {
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

  async function loadStoredAccounts(): Promise<void> {
    loading = true
    error = ''
    try {
      accounts = sortAccounts(await invoke('providerAccounts:list'))
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

  async function initializeAccounts(): Promise<void> {
    await loadStoredAccounts()
    await refreshAccounts()
  }

  function openEdit(account: HarnessAccount): void {
    editTarget = account
    editLabel = account.label
  }

  async function saveLabel(): Promise<void> {
    if (!editTarget || saving) return
    const label = editLabel.trim()
    if (!label || label === editTarget.label) {
      editTarget = null
      return
    }
    saving = true
    error = ''
    try {
      await invoke('providerAccounts:rename', editTarget.id, label)
      harnessAccountCache.invalidate(editTarget.harnessId)
      editTarget = null
      await loadStoredAccounts()
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'The account label was not saved.'
    } finally {
      saving = false
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
      disconnectTarget = null
      await loadStoredAccounts()
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
      <Search
        size={14}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
      />
      <input
        bind:value={search}
        type="text"
        placeholder="Search accounts…"
        aria-label="Search accounts"
        class="h-8 w-full rounded-lg border bg-elevated pl-8 pr-3 text-xs text-foreground placeholder:text-dimmed focus:border-primary/50 focus:outline-none"
      />
    </div>
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Refresh accounts"
      disabled={loading || refreshing}
      onclick={() => void refreshAccounts()}
    >
      <RefreshCw size={12} class={refreshing ? 'animate-spin' : ''} /> Refresh
    </button>
    <span class="w-10 text-right text-xs tabular-nums text-dimmed" aria-live="polite">
      {refreshing ? `${refreshCompleted}/${refreshTotal}` : ''}
    </span>
  </div>

  {#if filterHarnesses.length > 1}
    <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by harness">
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {!harnessFilterActive
          ? 'border-primary bg-primary text-on-primary'
          : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={!harnessFilterActive}
        title="Show accounts for all harnesses"
        onclick={clearHarnessFilter}
      >
        <ListFilter size={11} class="shrink-0" />
        All
      </button>
      {#each filterHarnesses as harness (harness.id)}
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {selectedHarnesses.has(
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
          class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[0.6875rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
          title="Clear harness filter"
          onclick={clearHarnessFilter}
        >
          <X size={11} /> Clear
        </button>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  {#if loading}
    <div class="flex h-32 items-center justify-center">
      <Loader2 size={18} class="animate-spin text-dimmed" />
    </div>
  {:else if refreshing && accounts.length === 0}
    <div class="flex h-32 flex-col items-center justify-center gap-2 text-center">
      <Loader2 size={18} class="animate-spin text-dimmed" />
      <p class="text-xs text-muted">Checking connected providers…</p>
      <p class="text-xs tabular-nums text-dimmed">
        {refreshCompleted} of {refreshTotal} checked
      </p>
    </div>
  {:else if accounts.length === 0}
    <div class="rounded-xl border border-dashed p-8 text-center">
      <UserRound size={20} class="mx-auto mb-2 text-dimmed" />
      <p class="text-xs text-muted">No accounts have been created yet.</p>
    </div>
  {:else if filteredAccounts.length === 0}
    <div class="rounded-xl border border-dashed p-8 text-center">
      <ListFilter size={18} class="mx-auto mb-2 text-dimmed" />
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
      rows={filteredAccounts}
      columns={accountColumns}
      getRowId={(account) => account.id}
      label="Harness accounts"
      clearable
    >
      {#snippet cell(
        account: HarnessAccount,
        column: DataTableColumn<HarnessAccount, AccountSortKey>
      )}
        {@const harness = harnessFor(account.harnessId)}
        {#if column.key === 'harness'}
          <div class="flex min-w-0 items-center gap-2">
            <AgentIcon
              agentId={account.harnessId}
              label={harness?.name ?? account.harnessId}
              size={20}
            />
            <span class="truncate text-xs font-medium">{harness?.name ?? account.harnessId}</span>
          </div>
        {:else if column.key === 'provider'}
          <span class="block truncate font-mono text-xs text-muted" title={providerLabel(account)}>
            {providerLabel(account)}
          </span>
        {:else if column.key === 'label'}
          <span class="block truncate text-xs">{account.label}</span>
        {:else}
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title={`Edit label for ${account.label}`}
              aria-label={`Edit label for ${account.label}`}
              onclick={() => openEdit(account)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
              title={`Disconnect ${account.label}`}
              aria-label={`Disconnect ${account.label}`}
              onclick={() => (disconnectTarget = account)}
            >
              <Unplug size={12} />
            </button>
          </div>
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</div>

<Modal open={editTarget !== null} title="Edit account label" onClose={() => (editTarget = null)}>
  {#snippet footer()}
    <button
      type="button"
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      onclick={() => (editTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="h-9 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={saving || editLabel.trim() === ''}
      onclick={() => void saveLabel()}
    >
      {saving ? 'Saving…' : 'Save label'}
    </button>
  {/snippet}

  <label class="block space-y-1.5">
    <span class="text-xs font-medium">Label</span>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:value={editLabel}
      maxlength="80"
      autocomplete="off"
      autofocus
      class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
      onkeydown={(event: KeyboardEvent) => {
        if (event.key === 'Enter') void saveLabel()
      }}
    />
  </label>
</Modal>

<Modal
  open={disconnectTarget !== null}
  title="Disconnect account"
  onClose={() => (disconnectTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      onclick={() => (disconnectTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      disabled={disconnecting}
      onclick={() => void disconnectAccount()}
    >
      {#if disconnecting}<Loader2 size={13} class="animate-spin" />{:else}<Unplug size={13} />{/if}
      Disconnect
    </button>
  {/snippet}

  <div class="flex gap-2 text-sm text-muted">
    <Unplug size={16} class="mt-0.5 shrink-0 text-danger" />
    <p>
      Disconnect <strong class="text-foreground">{disconnectTarget?.label}</strong>? This logs the
      account out{#if disconnectTarget?.containerKind === 'managed'}
        and permanently deletes its isolated credential container{/if}.
    </p>
  </div>
</Modal>
