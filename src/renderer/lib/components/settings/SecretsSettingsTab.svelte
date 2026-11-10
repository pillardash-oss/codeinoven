<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { SecretsOverview, SecretInventoryEntry } from '$shared/secrets'
  import { invoke } from '$lib/ipc.svelte'
  import { onMount } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import SecretsList from './secrets-settings/SecretsList.svelte'
  import SecretRotateModal from './secrets-settings/SecretRotateModal.svelte'

  /**
   * The one place every stored secret is listed.
   *
   * The page reads the inventory from the main process and never a value: rows
   * describe what a secret belongs to, and the only writes here are replacing a
   * value and deleting one. Deleting also tells the owning surface to let go of
   * the reference, so nothing is left pointing at a value that no longer exists.
   */
  let overview = $state<SecretsOverview | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let error = $state('')
  let rotateTarget = $state<SecretInventoryEntry | null>(null)
  let deleteTarget = $state<SecretInventoryEntry | null>(null)

  const available = $derived(overview?.availability.available ?? true)
  const secrets = $derived(overview?.secrets ?? [])

  /** Why nothing can be stored, in the words the user needs to act on. */
  const unavailableReason = $derived.by((): string => {
    const availability = overview?.availability
    if (!availability || availability.available) return ''
    switch (availability.reason) {
      case 'plaintext-backend':
        return 'This Linux session has no keyring, so Electron falls back to a plaintext backend. Install a keyring (GNOME Keyring or KWallet) and restart to store secrets.'
      case 'unattended-launch':
        return 'This launch runs unattended and never asks the OS keyring for a key, so secrets are read-only here. Start the app normally to store one.'
      case 'probe-failed':
        return 'The OS keyring could not be reached, so secrets cannot be stored right now. Restart the app and approve the keyring prompt.'
      default:
        return 'Secure credential storage is unavailable on this device, so no secret can be stored.'
    }
  })

  function reportFailure(cause: unknown, fallback: string): void {
    error = cause instanceof Error ? cause.message : fallback
  }

  async function load(): Promise<void> {
    loading = true
    try {
      overview = await invoke('secrets:overview')
    } catch (cause) {
      reportFailure(cause, 'Could not read the stored secrets')
    } finally {
      loading = false
    }
  }

  async function rotate(value: string): Promise<void> {
    const target = rotateTarget
    if (!target) return
    busy = true
    error = ''
    try {
      overview = await invoke('secrets:rotate', { ref: target.ref, value })
      rotateTarget = null
    } catch (cause) {
      reportFailure(cause, 'Could not replace this secret')
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    const target = deleteTarget
    if (!target) return
    busy = true
    error = ''
    try {
      overview = await invoke('secrets:delete', { ref: target.ref })
      deleteTarget = null
    } catch (cause) {
      reportFailure(cause, 'Could not delete this secret')
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load()
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Secrets</h1>
    <p class="mt-0.5 text-sm text-muted">
      Every credential {APP_NAME} stores lives here, encrypted by the OS keyring. Values are never shown
      again after they are saved. Replace one to store a new value, or delete one to revoke it everywhere.
    </p>
  </div>

  {#if !available}
    <p class="mb-4 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {unavailableReason}
    </p>
  {/if}

  {#if error}
    <p class="mb-4 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  <div class="mb-4 flex items-center justify-between gap-3">
    <span class="text-xs tabular-nums text-dimmed">
      {secrets.length}
      {secrets.length === 1 ? 'secret' : 'secrets'} stored
    </span>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 border bg-surface px-4 py-3 text-xs text-muted">
      <CioSpinner size={14} class="animate-spin" /> Reading stored secrets...
    </div>
  {:else if secrets.length === 0}
    <div class="border bg-surface">
      <EmptyState
        icon={CioKey}
        title="Nothing stored yet"
        description="Credentials you add from Utilities, cloud deployments, Ovens, a capability sign-in or a thread secret appear here, so you can find and revoke them in one place."
      />
    </div>
  {:else}
    <SecretsList
      {secrets}
      {busy}
      onRotate={(entry) => {
        error = ''
        rotateTarget = entry
      }}
      onDelete={(entry) => {
        error = ''
        deleteTarget = entry
      }}
    />
  {/if}
</div>

{#if rotateTarget}
  <SecretRotateModal
    entry={rotateTarget}
    {busy}
    {error}
    onSubmit={rotate}
    onClose={() => {
      if (!busy) rotateTarget = null
    }}
  />
{/if}

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete this secret?"
  confirmLabel="Delete secret"
  note="The value is removed from the OS keyring and cannot be recovered."
  {busy}
  onCancel={() => {
    if (!busy) deleteTarget = null
  }}
  onConfirm={remove}
>
  <p>
    <span class="font-medium text-foreground">{deleteTarget?.title ?? 'This secret'}</span>
    is deleted, and whatever owns it asks for the value again before it works.
  </p>
</ConfirmDialog>
