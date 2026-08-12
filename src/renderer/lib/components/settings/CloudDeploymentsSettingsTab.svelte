<script lang="ts">
  import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Trash2 } from '@lucide/svelte'
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
  import CloudProviderIcon from '../cloud/icons/CloudProviderIcon.svelte'
  import Modal from '../ui/Modal.svelte'
  import CloudDeploymentAccountEditor from './CloudDeploymentAccountEditor.svelte'
  import {
    type CloudDeploymentProviderAccount,
    type CloudDeploymentProviderKind
  } from '$shared/types'

  const PROVIDER_DISPLAY_NAMES: Readonly<Record<CloudDeploymentProviderKind, string>> = {
    coolify: 'Coolify',
    netlify: 'Netlify',
    railway: 'Railway',
    vercel: 'Vercel',
    dokploy: 'Dokploy',
    custom: 'Custom'
  }

  let editorOpen = $state(false)
  let editingAccount = $state<CloudDeploymentProviderAccount | null>(null)
  let deleteTarget = $state<CloudDeploymentProviderAccount | null>(null)
  let deleteError = $state('')

  function openCreate(): void {
    editingAccount = null
    deleteError = ''
    editorOpen = true
  }

  function openEdit(account: CloudDeploymentProviderAccount): void {
    editingAccount = account
    deleteError = ''
    editorOpen = true
  }

  function closeEditor(): void {
    editorOpen = false
    editingAccount = null
  }

  async function removeAccount(): Promise<void> {
    if (!deleteTarget) return
    deleteError = ''
    try {
      await cloudAccountsState.removeAccount(deleteTarget.id)
      deleteTarget = null
    } catch (removeError) {
      deleteError =
        removeError instanceof Error ? removeError.message : 'Failed to delete provider account.'
    }
  }

  $effect(() => {
    void cloudAccountsState.load()
  })
</script>

<div class="mx-auto max-w-2xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Cloud Deployments</h1>
      <p class="mt-0.5 text-sm text-muted">
        Manage the provider accounts you can reuse across your projects. API tokens stay in secure
        storage and are never shown here.
      </p>
    </div>
    <button
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
      title="Refresh cloud deployment accounts"
      disabled={cloudAccountsState.loading}
      onclick={() => void cloudAccountsState.load()}
    >
      <RefreshCw size={13} class={cloudAccountsState.loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </div>

  {#if cloudAccountsState.error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {cloudAccountsState.error}
    </p>
  {/if}

  <div>
    <div class="mb-2 flex items-center justify-between">
      <div>
        <h3 class="text-sm font-semibold">Provider accounts</h3>
        <p class="text-[11px] text-dimmed">Create once, reuse across any project.</p>
      </div>
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
        title="Add cloud deployment provider account"
        onclick={openCreate}
      >
        <Plus size={13} /> Add account
      </button>
    </div>

    {#if cloudAccountsState.loading && cloudAccountsState.accounts.length === 0}
      <div class="rounded-xl border border-dashed p-6 text-center">
        <Loader2 size={17} class="mx-auto animate-spin text-dimmed" />
      </div>
    {:else if cloudAccountsState.accounts.length === 0}
      <div class="rounded-xl border border-dashed p-5 text-center">
        <CloudProviderIcon providerKind="coolify" size={17} class="mx-auto mb-1.5 text-dimmed" />
        <p class="text-xs text-muted">No cloud deployment provider accounts yet.</p>
        <button class="mt-2 text-xs font-medium text-primary hover:underline" onclick={openCreate}>
          Add the first account
        </button>
      </div>
    {:else}
      <div class="overflow-hidden rounded-xl border bg-surface">
        {#each cloudAccountsState.accounts as account (account.id)}
          <div
            class="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.6fr)_auto] items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <CloudProviderIcon
                  providerKind={account.providerKind}
                  size={14}
                  class="shrink-0 text-dimmed"
                  title={PROVIDER_DISPLAY_NAMES[account.providerKind]}
                />
                <p class="truncate text-xs font-semibold">{account.label}</p>
                <span
                  class="rounded-full px-1.5 py-0.5 text-[10px] font-medium {account.enabled
                    ? 'bg-success/10 text-success'
                    : 'bg-raised text-dimmed'}"
                >
                  {account.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p class="mt-0.5 truncate text-[10px] text-dimmed">
                {PROVIDER_DISPLAY_NAMES[account.providerKind]}
              </p>
            </div>
            <p class="truncate font-mono text-[10px] text-dimmed" title={account.baseUrl}>
              {account.baseUrl ?? 'No base URL'}
            </p>
            <div class="flex items-center gap-1">
              <button
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-overlay hover:text-foreground"
                aria-label="Edit {account.label}"
                title="Edit {account.label}"
                onclick={() => openEdit(account)}
              >
                <Pencil size={13} />
              </button>
              <button
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                aria-label="Delete {account.label}"
                title="Delete {account.label}"
                onclick={() => (deleteTarget = account)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if editorOpen}
  <CloudDeploymentAccountEditor
    account={editingAccount}
    onClose={closeEditor}
    onSaved={closeEditor}
  />
{/if}

<Modal
  open={deleteTarget !== null}
  title="Delete provider account"
  onClose={() => (deleteTarget = null)}
>
  {#snippet footer()}
    <button
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      type="button"
      onclick={() => (deleteTarget = null)}
    >
      Cancel
    </button>
    <button
      class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      type="button"
      disabled={cloudAccountsState.saving}
      onclick={() => void removeAccount()}
    >
      {#if cloudAccountsState.saving}<Loader2 size={13} class="animate-spin" />{:else}<Trash2
          size={13}
        />{/if}
      Delete account
    </button>
  {/snippet}

  {#if deleteError}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{deleteError}</p>
  {/if}
  <div class="flex gap-2 text-sm text-muted">
    <AlertTriangle size={16} class="mt-0.5 shrink-0 text-warning" />
    <p>
      Delete <strong class="text-foreground">{deleteTarget?.label}</strong>? Its API token will be
      removed from secure storage and it will be detached from any project that uses it.
    </p>
  </div>
</Modal>
