<script lang="ts">
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
  import { toast } from 'svelte-sonner'
  import { CheckCircle2, Loader2, Plus, RotateCcw, Trash2 } from '@lucide/svelte'
  import CloudProviderIcon from '../cloud/icons/CloudProviderIcon.svelte'
  import CloudDeploymentConfigSheet from '../cloud/CloudDeploymentConfigSheet.svelte'
  import Modal from '../ui/Modal.svelte'
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

  let sheetOpen = $state(false)
  let rotatingAccount = $state<CloudDeploymentProviderAccount | null>(null)
  let rotateToken = $state('')
  let rotating = $state(false)
  let rotateError = $state('')
  let removingAccount = $state<CloudDeploymentProviderAccount | null>(null)
  let removing = $state(false)

  function openRotate(account: CloudDeploymentProviderAccount): void {
    rotatingAccount = account
    rotateToken = ''
    rotateError = ''
  }

  async function confirmRotate(): Promise<void> {
    const account = rotatingAccount
    if (!account) return
    if (rotateToken.trim() === '') {
      rotateError = 'Enter a token.'
      return
    }
    rotating = true
    rotateError = ''
    try {
      await cloudAccountsState.rotateSecret(account.id, rotateToken.trim())
      toast.success('Secret rotated.')
      rotatingAccount = null
    } catch (reason) {
      rotateError = reason instanceof Error ? reason.message : 'The secret could not be rotated.'
    } finally {
      rotating = false
    }
  }

  function openRemove(account: CloudDeploymentProviderAccount): void {
    removingAccount = account
  }

  async function confirmRemove(): Promise<void> {
    const account = removingAccount
    if (!account) return
    removing = true
    try {
      await cloudAccountsState.removeAccount(account.id)
      toast.success('Provider account removed.')
      removingAccount = null
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The account could not be removed.')
    } finally {
      removing = false
    }
  }

  $effect(() => {
    void cloudAccountsState.load()
  })
</script>

<div class="mx-auto max-w-2xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Cloud Deployments</h1>
      <p class="mt-0.5 text-sm text-muted">
        Manage the provider accounts you can reuse across your projects. Accounts are stored
        securely in your system keychain; tokens are update-only and never shown here.
      </p>
    </div>
    <button
      type="button"
      class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover"
      onclick={() => (sheetOpen = true)}
    >
      <Plus size={14} />
      New account
    </button>
  </div>

  {#if cloudAccountsState.accounts.length === 0}
    <div class="rounded-xl border bg-elevated px-4 py-10 text-center">
      <p class="text-sm text-muted">No provider accounts yet.</p>
      <p class="mt-1 text-xs text-dimmed">
        Create one to connect a deployment host (for example Coolify) and reuse it across your
        projects.
      </p>
    </div>
  {:else}
    <div class="space-y-2">
      {#each cloudAccountsState.accounts as account (account.id)}
        <div class="flex items-center gap-3 rounded-xl border bg-elevated px-4 py-3">
          <CloudProviderIcon
            providerKind={account.providerKind}
            size={18}
            class="shrink-0 text-dimmed"
            title={PROVIDER_DISPLAY_NAMES[account.providerKind]}
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{account.label}</span>
              <span class="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                {PROVIDER_DISPLAY_NAMES[account.providerKind]}
              </span>
              {#if account.configured}
                <CheckCircle2 size={12} class="shrink-0 text-success" />
              {/if}
            </div>
            <p class="truncate text-[11px] text-dimmed">
              {account.baseUrl ?? 'No base URL set'}
            </p>
          </div>
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-raised px-2.5 text-[11px] font-medium text-foreground hover:bg-overlay disabled:opacity-50"
            title="Rotate this account's secret"
            aria-label="Rotate this account's secret"
            onclick={() => openRotate(account)}
          >
            <RotateCcw size={12} />
            Rotate secret
          </button>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-raised text-danger hover:bg-overlay"
            title="Remove this provider account"
            aria-label="Remove this provider account"
            onclick={() => openRemove(account)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <CloudDeploymentConfigSheet
    open={sheetOpen}
    initialMode="provider"
    onClose={() => (sheetOpen = false)}
    onSaved={() => {
      sheetOpen = false
      void cloudAccountsState.load()
    }}
  />

  {#if rotatingAccount}
    <Modal open title="Rotate secret" onClose={() => (rotatingAccount = null)}>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          Enter a new API token for <span class="font-medium text-foreground"
            >{rotatingAccount.label}</span
          >. The current token is never shown or returned.
        </p>
        <label class="block space-y-1 text-xs font-medium">
          <span>New API token</span>
          <input
            class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
            type="password"
            placeholder="New provider API token"
            autocomplete="off"
            spellcheck="false"
            bind:value={rotateToken}
          />
        </label>
        {#if rotateError !== ''}
          <p class="text-xs text-error">{rotateError}</p>
        {/if}
      </div>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="flex h-9 items-center justify-center rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
            onclick={() => (rotatingAccount = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
            disabled={rotating}
            onclick={() => void confirmRotate()}
          >
            {#if rotating}
              <Loader2 size={13} class="animate-spin" />
            {/if}
            Rotate secret
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if removingAccount}
    <Modal open title="Remove provider account" onClose={() => (removingAccount = null)}>
      <p class="text-sm text-muted">
        Remove <span class="font-medium text-foreground">{removingAccount.label}</span>? This
        deletes its stored token and detaches it from any project that uses it.
      </p>
      {#snippet footer()}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="flex h-9 items-center justify-center rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
            onclick={() => (removingAccount = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-danger px-4 text-xs font-medium text-on-danger hover:bg-danger-hover disabled:opacity-50"
            disabled={removing}
            onclick={() => void confirmRemove()}
          >
            {#if removing}
              <Loader2 size={13} class="animate-spin" />
            {/if}
            Remove
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}
</div>
