<script lang="ts">
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
  import { toast } from 'svelte-sonner'
  import { CheckCircle2, Loader2, Plus, RotateCcw, Trash2 } from '@lucide/svelte'
  import CloudProviderIcon from '../cloud/icons/CloudProviderIcon.svelte'
  import CloudDeploymentConfigSheet from '../cloud/CloudDeploymentConfigSheet.svelte'
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
  let rotatingId = $state<string | null>(null)

  async function rotateSecret(account: CloudDeploymentProviderAccount): Promise<void> {
    const token = window.prompt(`Enter the new API token for "${account.label}".`)
    if (token === null) return
    if (token.trim() === '') {
      toast.error('The token cannot be empty.')
      return
    }
    rotatingId = account.id
    try {
      await cloudAccountsState.rotateSecret(account.id, token.trim())
      toast.success('Secret rotated.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The secret could not be rotated.')
    } finally {
      rotatingId = null
    }
  }

  async function removeAccount(account: CloudDeploymentProviderAccount): Promise<void> {
    const ok = window.confirm(
      `Remove "${account.label}"? This deletes its stored token and detaches it from any project that uses it.`
    )
    if (!ok) return
    await cloudAccountsState.removeAccount(account.id)
    toast.success('Provider account removed.')
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
            disabled={rotatingId === account.id}
            title="Rotate this account's secret"
            aria-label="Rotate this account's secret"
            onclick={() => void rotateSecret(account)}
          >
            {#if rotatingId === account.id}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <RotateCcw size={12} />
            {/if}
            Rotate secret
          </button>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-raised text-danger hover:bg-overlay"
            title="Remove this provider account"
            aria-label="Remove this provider account"
            onclick={() => void removeAccount(account)}
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
</div>
