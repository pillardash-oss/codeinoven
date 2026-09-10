<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2, Pencil, RefreshCw, Search, Unplug, UserRound } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import type { HarnessAccount, ProviderConnectionInfo } from '$shared/types'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    providers: ProviderConnectionInfo[]
  }

  let { providers }: Props = $props()

  let accounts = $state.raw<HarnessAccount[]>([])
  let loading = $state(false)
  let error = $state('')
  let search = $state('')
  let editTarget = $state<HarnessAccount | null>(null)
  let editLabel = $state('')
  let saving = $state(false)
  let disconnectTarget = $state<HarnessAccount | null>(null)
  let disconnecting = $state(false)

  let filteredAccounts = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase('en-US')
    if (!query) return accounts
    return accounts.filter((account) => {
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

  async function loadAccounts(): Promise<void> {
    loading = true
    error = ''
    try {
      const loaded: HarnessAccount[] = []
      const loadErrors: string[] = []
      const harnesses = providers
      for (let offset = 0; offset < harnesses.length; offset += 3) {
        const batch = await Promise.allSettled(
          harnesses
            .slice(offset, offset + 3)
            .map((provider) => invoke('providerAccounts:list', provider.id, true))
        )
        for (const result of batch) {
          if (result.status === 'fulfilled') {
            loaded.push(...result.value)
          } else {
            loadErrors.push(
              result.reason instanceof Error ? result.reason.message : 'An account source failed.'
            )
          }
        }
      }
      accounts = loaded.sort((left, right) => left.createdAt - right.createdAt)
      if (loadErrors.length > 0) {
        error =
          loaded.length > 0
            ? 'Some account sources could not be refreshed. Showing the accounts that are available.'
            : loadErrors[0]
      }
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Accounts could not be loaded.'
    } finally {
      loading = false
    }
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
      await loadAccounts()
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
      await loadAccounts()
    } catch (disconnectError) {
      error =
        disconnectError instanceof Error
          ? disconnectError.message
          : 'The account was not disconnected.'
    } finally {
      disconnecting = false
    }
  }

  onMount(() => void loadAccounts())
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
      disabled={loading}
      onclick={() => void loadAccounts()}
    >
      <RefreshCw size={12} class={loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </div>

  {#if error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  {#if loading && accounts.length === 0}
    <div class="flex h-32 items-center justify-center">
      <Loader2 size={18} class="animate-spin text-dimmed" />
    </div>
  {:else if accounts.length === 0}
    <div class="rounded-xl border border-dashed p-8 text-center">
      <UserRound size={20} class="mx-auto mb-2 text-dimmed" />
      <p class="text-xs text-muted">No accounts have been created yet.</p>
    </div>
  {:else if filteredAccounts.length === 0}
    <div class="rounded-xl border border-dashed p-8 text-center text-xs text-dimmed">
      No accounts match your search.
    </div>
  {:else}
    <div class="overflow-x-auto rounded-xl border bg-surface">
      <div
        class="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1.3fr)_auto] gap-3 border-b bg-elevated px-4 py-2 text-[0.625rem] font-medium uppercase tracking-wide text-dimmed"
      >
        <span>Harness</span>
        <span>Provider</span>
        <span>Label</span>
        <span class="sr-only">Actions</span>
      </div>
      {#each filteredAccounts as account (account.id)}
        {@const harness = harnessFor(account.harnessId)}
        <div
          class="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1.3fr)_auto] items-center gap-3 border-b px-4 py-3 last:border-b-0"
        >
          <div class="flex min-w-0 items-center gap-2">
            <AgentIcon
              agentId={account.harnessId}
              label={harness?.name ?? account.harnessId}
              size={20}
            />
            <span class="truncate text-xs font-medium">{harness?.name ?? account.harnessId}</span>
          </div>
          <span class="truncate font-mono text-xs text-muted" title={providerLabel(account)}>
            {providerLabel(account)}
          </span>
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-xs">{account.label}</span>
          </div>
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
        </div>
      {/each}
    </div>
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
