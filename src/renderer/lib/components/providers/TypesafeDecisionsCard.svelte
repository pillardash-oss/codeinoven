<script lang="ts">
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import {
    CircleCheck,
    ExternalLink,
    KeyRound,
    Loader2,
    RefreshCw,
    TriangleAlert
  } from '@lucide/svelte'
  import type { TypesafeCheckResult, TypesafeStatus } from '$shared/types'
  import { APP_NAME } from '$shared/brand'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'

  /** Where a user creates, rotates, and tops up a TypeSafe key. */
  const TYPESAFE_CONSOLE_URL = 'https://console.typesafe.ai/'

  let status = $state<TypesafeStatus | null>(null)
  let loading = $state(true)
  let loadError = $state('')
  /** Draft key, cleared the moment it is stored: the value never comes back. */
  let keyDraft = $state('')
  let saving = $state(false)
  let saveError = $state('')
  let checking = $state(false)
  let checkResult = $state<TypesafeCheckResult | null>(null)
  let confirmingRemove = $state(false)
  let removing = $state(false)

  let availabilityLabel = $derived.by(() => {
    switch (status?.availability) {
      case 'ready':
        return 'Ready'
      case 'rejected':
        return 'Key rejected'
      case 'rate-limited':
        return 'Rate limited'
      case 'unavailable':
        return 'Unreachable'
      case 'unverified':
        return 'Not verified'
      default:
        return 'No key'
    }
  })

  let availabilityTone = $derived.by<StatusTone>(() => {
    switch (status?.availability) {
      case 'ready':
        return 'success'
      case 'rejected':
      case 'unavailable':
        return 'danger'
      case 'rate-limited':
        return 'warning'
      case 'unverified':
        return 'info'
      default:
        return 'neutral'
    }
  })

  /**
   * Where the key in use came from.
   *
   * The app reads a key from any of four places, so the card names the one that
   * answered instead of implying the field below is the only source.
   */
  let sourceLabel = $derived.by(() => {
    if (!status?.keySource) return null
    if (status.keySource === 'device') return 'the key stored on this device'
    if (status.keySource === 'environment') return 'TYPESAFE_API_KEY from your environment'
    if (status.keySource === 'utility') {
      return `the credential on ${status.keySourceDetail ?? 'an installed utility'}`
    }
    return 'a secret you saved in a thread'
  })

  let lastFailure = $derived(status?.lastFailure)

  function errorMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message ? cause.message : fallback
  }

  async function load(): Promise<void> {
    loading = true
    loadError = ''
    try {
      status = await invoke('typesafe:getStatus')
    } catch (cause) {
      loadError = errorMessage(cause, 'TypeSafe settings could not be loaded.')
    } finally {
      loading = false
    }
  }

  async function saveKey(): Promise<void> {
    const value = keyDraft.trim()
    if (!value || saving) return
    saving = true
    saveError = ''
    try {
      status = await invoke('typesafe:setKey', value)
      keyDraft = ''
      checkResult = null
      toast.success('TypeSafe key saved')
    } catch (cause) {
      saveError = errorMessage(cause, 'The TypeSafe key could not be saved.')
    } finally {
      saving = false
    }
  }

  async function removeKey(): Promise<void> {
    removing = true
    try {
      status = await invoke('typesafe:clearKey')
      checkResult = null
      toast.success('TypeSafe key removed')
    } catch (cause) {
      toast.error(errorMessage(cause, 'The TypeSafe key could not be removed.'))
    } finally {
      removing = false
      confirmingRemove = false
    }
  }

  /**
   * One real typed question, so the reported state is what TypeSafe actually
   * said rather than what the presence of a key suggests.
   */
  async function check(): Promise<void> {
    if (checking) return
    checking = true
    checkResult = null
    try {
      checkResult = await invoke('typesafe:check')
    } catch (cause) {
      checkResult = {
        ok: false,
        status: 'unavailable',
        detail: errorMessage(cause, 'The check could not be completed.')
      }
    } finally {
      checking = false
    }
  }

  onMount(() => {
    const unsubscribe = subscribe('typesafe:status', (next) => {
      status = next
    })
    void load()
    return unsubscribe
  })
</script>

<div class="space-y-4" id="settings-block-harnesses-typesafe">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h2 class="text-sm font-semibold text-foreground">TypeSafe decisions</h2>
      <p class="mt-0.5 text-xs text-muted">
        The API key {APP_NAME} uses for TypeSafe judgments.
      </p>
    </div>
    <StatusPill tone={availabilityTone} dot title={availabilityLabel}>
      {availabilityLabel}
    </StatusPill>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading TypeSafe settings…
    </div>
  {:else}
    {#if loadError}
      <p
        class="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger"
        role="alert"
      >
        {loadError}
      </p>
    {/if}

    <div class="space-y-3 rounded-xl border bg-surface p-4">
      {#if sourceLabel}
        <p class="flex items-center gap-1.5 text-xs text-muted">
          <CircleCheck size={14} class="shrink-0 text-success" />
          <span>CodeInOven is using {sourceLabel}.</span>
        </p>
      {/if}

      {#if lastFailure}
        <div class="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <TriangleAlert size={14} class="mt-0.5 shrink-0" />
          <span>
            {lastFailure.detail}
            {#if lastFailure.requestId}
              <span class="text-dimmed">Request {lastFailure.requestId}</span>
            {/if}
          </span>
        </div>
      {/if}

      <div class="flex flex-wrap items-end gap-2">
        <label class="min-w-64 flex-1 space-y-1 text-xs font-medium">
          <span class="flex items-center gap-1.5">
            <KeyRound size={14} class="shrink-0" /> API key
          </span>
          <input
            class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
            type="password"
            autocomplete="off"
            placeholder={status?.hasKey
              ? 'Stored securely, enter a new key to replace'
              : 'Paste a key from the TypeSafe console'}
            disabled={!status?.secureStorageAvailable || saving}
            bind:value={keyDraft}
          />
        </label>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          title="Store this key on this device"
          disabled={!keyDraft.trim() || saving || !status?.secureStorageAvailable}
          onclick={() => void saveKey()}
        >
          {#if saving}
            <Loader2 size={14} class="animate-spin" />
          {/if}
          Save key
        </button>
      </div>

      {#if !status?.secureStorageAvailable}
        <p class="text-xs text-warning" role="alert">
          Secure credential storage is unavailable on this device, so a key cannot be stored here.
        </p>
      {/if}

      {#if saveError}
        <p class="text-xs text-danger" role="alert">{saveError}</p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          title="Test the key with a live TypeSafe request"
          disabled={checking || !status?.hasKey}
          onclick={() => void check()}
        >
          {#if checking}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <RefreshCw size={14} />
          {/if}
          Check connection
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Open the TypeSafe console to manage keys and credits"
          data-external-url={TYPESAFE_CONSOLE_URL}
          onclick={() => void openInBrowser(TYPESAFE_CONSOLE_URL)}
        >
          <ExternalLink size={14} /> TypeSafe console
        </button>
        {#if status?.keySource === 'device'}
          <button
            type="button"
            class="flex h-9 items-center gap-2 rounded-lg border border-danger/30 px-3 text-xs font-medium text-danger hover:bg-danger/10"
            title="Remove the key stored on this device"
            onclick={() => (confirmingRemove = true)}
          >
            Remove key
          </button>
        {/if}
      </div>

      {#if checkResult?.ok}
        <p class="flex items-center gap-1.5 text-xs text-success">
          <CircleCheck size={14} class="shrink-0" />
          <span>{checkResult.model} answered in {checkResult.latencyMs} ms.</span>
        </p>
      {:else if checkResult}
        <p class="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <TriangleAlert size={14} class="mt-0.5 shrink-0" />
          <span>
            {checkResult.detail}
            {#if checkResult.requestId}
              <span class="text-dimmed">Request {checkResult.requestId}</span>
            {/if}
          </span>
        </p>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={confirmingRemove}
  title="Remove the stored TypeSafe key?"
  confirmLabel="Remove key"
  busy={removing}
  onCancel={() => (confirmingRemove = false)}
  onConfirm={() => void removeKey()}
>
  {APP_NAME} stops using the key stored on this device. A key from your environment or an installed utility
  is still used.
</ConfirmDialog>
