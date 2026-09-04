<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import CloudProviderIcon from '../cloud/icons/CloudProviderIcon.svelte'
  import {
    CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS,
    CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES,
    type CloudDeploymentProviderAccount,
    type CloudDeploymentProviderKind
  } from '$shared/types'

  interface Props {
    /** Account being edited, or null for create mode. Mounted conditionally. */
    account: CloudDeploymentProviderAccount | null
    onClose: () => void
    /** Invoked after a successful save so the caller can refresh its view. */
    onSaved?: () => void
  }

  const PROVIDER_DISPLAY_NAMES: Readonly<Record<CloudDeploymentProviderKind, string>> = {
    coolify: 'Coolify',
    netlify: 'Netlify',
    railway: 'Railway',
    vercel: 'Vercel',
    dokploy: 'Dokploy',
    custom: 'Custom'
  }

  let { account, onClose, onSaved }: Props = $props()

  /** Seed the form from the edited account, or start blank for create mode.
   * The component is mounted per-edit, so the initial prop value is authoritative. */
  function initialDraft(): {
    kind: CloudDeploymentProviderKind
    label: string
    baseUrl: string
    enabled: boolean
  } {
    return {
      kind: account?.providerKind ?? 'coolify',
      label: account?.label ?? '',
      baseUrl: account?.baseUrl ?? '',
      enabled: account?.enabled ?? true
    }
  }

  let draft = $state(initialDraft())
  let token = $state('')
  let saving = $state(false)
  let error = $state('')

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (draft.label.trim() === '') {
      error = 'Enter a name for this account.'
      return
    }
    if (draft.kind === 'coolify' && draft.baseUrl.trim() === '') {
      error = 'Enter the Coolify base URL.'
      return
    }
    if (!account && token.trim() === '') {
      error = 'Enter an API token.'
      return
    }
    saving = true
    error = ''
    try {
      if (account) {
        await cloudAccountsState.updateAccount(account.id, {
          ...(draft.label.trim() !== account.label ? { label: draft.label.trim() } : {}),
          ...(draft.baseUrl.trim() === ''
            ? { baseUrl: '' }
            : draft.baseUrl.trim() !== (account.baseUrl ?? '')
              ? { baseUrl: draft.baseUrl.trim() }
              : {}),
          enabled: draft.enabled
        })
        if (token.trim() !== '') {
          await cloudAccountsState.rotateSecret(account.id, token.trim())
        }
        toast.success('Provider account updated.')
      } else {
        await cloudAccountsState.createAccount(
          draft.kind,
          draft.label.trim(),
          token.trim(),
          draft.baseUrl.trim() === '' ? undefined : draft.baseUrl.trim()
        )
        toast.success('Provider account created.')
      }
      onSaved?.()
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'The account could not be saved.'
    } finally {
      saving = false
    }
  }
</script>

<Modal open size="md" title={account ? 'Edit provider account' : 'Add provider account'} {onClose}>
  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-3">
      <Switch bind:checked={draft.enabled} label="Enabled" class="font-medium" />
      <div class="flex items-center gap-2">
        <button
          class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          type="button"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          form="cloud-account-form"
          disabled={saving}
        >
          {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
          Save account
        </button>
      </div>
    </div>
  {/snippet}

  <form id="cloud-account-form" class="space-y-4" onsubmit={save}>
    {#if account === null}
      <label class="block space-y-1 text-xs font-medium">
        <span>Provider</span>
        <select
          class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
          bind:value={draft.kind}
        >
          {#each CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES as providerKind (providerKind)}
            <option
              value={providerKind}
              disabled={CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(providerKind)}
            >
              {PROVIDER_DISPLAY_NAMES[
                providerKind
              ]}{CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(providerKind)
                ? ' (not yet available)'
                : ''}
            </option>
          {/each}
        </select>
      </label>
    {:else}
      <div class="flex items-center gap-2 text-xs text-dimmed">
        <CloudProviderIcon
          providerKind={account.providerKind}
          size={16}
          class="shrink-0"
          title={PROVIDER_DISPLAY_NAMES[account.providerKind]}
        />
        {PROVIDER_DISPLAY_NAMES[account.providerKind]}
      </div>
    {/if}

    <label class="block space-y-1 text-xs font-medium">
      <span>Account name</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
        placeholder="e.g. Coolify — Personal or Coolify — Company"
        autocomplete="off"
        spellcheck="false"
        required
        bind:value={draft.label}
      />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Base URL</span>
      <input
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
        placeholder="https://coolify.internal"
        autocomplete="off"
        spellcheck="false"
        bind:value={draft.baseUrl}
      />
    </label>

    <label class="block space-y-1 text-xs font-medium" for="cloud-account-token">
      <span>API token</span>
      <input
        id="cloud-account-token"
        class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
        type="password"
        placeholder={account && account.configured
          ? 'Stored securely — enter a new token to replace'
          : 'Provider API token'}
        autocomplete="off"
        spellcheck="false"
        bind:value={token}
      />
    </label>
    {#if account && account.configured}
      <p class="text-[0.6875rem] text-dimmed">
        A token is stored securely. Leave the field blank to keep it.
      </p>
    {/if}

    {#if error !== ''}
      <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
  </form>
</Modal>
