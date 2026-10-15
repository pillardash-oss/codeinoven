<script lang="ts">
  import { onDestroy } from 'svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import type { McpOAuthConnectionState, UtilityDefinition } from '$shared/types'
  import type { StatusTone } from '$lib/components/ui/status-tone'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { McpOAuthController } from './utility-editor-modal-mcp-oauth.svelte'

  interface Props {
    /** The saved server being edited; `null` while it is still an unsaved draft. */
    utility: UtilityDefinition | null
    /** Fires when turning authorization on or off rewrites the saved server. */
    onChanged?: (utility: UtilityDefinition) => void
  }

  let { utility, onChanged }: Props = $props()

  const oauth = new McpOAuthController({
    utility: () => utility,
    onChanged: (updated) => onChanged?.(updated)
  })

  // The editor can switch which server it is showing without unmounting this
  // section, so a change of id is what triggers a fresh status read. A plain
  // variable keeps the effect from re-running on the status it assigns.
  let loadedId: string | null = null
  $effect(() => {
    const id = utility?.id ?? null
    if (!id || id === loadedId) return
    loadedId = id
    void oauth.load(id)
  })

  onDestroy(() => oauth.dispose())

  let tone = $derived.by((): StatusTone => {
    switch (oauth.status?.state) {
      case 'connected':
        return 'success'
      case 'authorizing':
        return 'info'
      case 'expired':
        return 'warning'
      case 'error':
        return 'danger'
      default:
        return 'neutral'
    }
  })

  let stateLabel = $derived.by(() => {
    switch (oauth.status?.state) {
      case 'connected':
        return 'Authorized'
      case 'authorizing':
        return 'Authorizing'
      case 'expired':
        return 'Expired'
      case 'error':
        return 'Failed'
      default:
        return 'Not authorized'
    }
  })

  let stateSentence = $derived.by((): string => {
    const status = oauth.status
    if (!status) return ''
    switch (status.state) {
      case 'connected':
        return status.accountLabel ? `Authorized as ${status.accountLabel}.` : 'Authorized.'
      case 'authorizing':
        return 'Waiting for the browser to finish signing in.'
      case 'expired':
        return 'The stored grant expired and cannot renew itself.'
      case 'error':
        return status.error ?? 'The last authorization failed.'
      default:
        return 'No grant is stored for this server.'
    }
  })

  /** The issuer host alone; the full URL stays in the tooltip. */
  let issuerHost = $derived.by((): string => {
    const issuer = oauth.status?.issuer
    if (!issuer) return ''
    try {
      return new URL(issuer).host
    } catch {
      return issuer
    }
  })

  let expiryLabel = $derived.by((): string => {
    const expiresAt = oauth.status?.expiresAt
    if (expiresAt === undefined) return ''
    const minutes = Math.round((expiresAt - Date.now()) / 60_000)
    if (minutes <= 0) return 'Access token expired'
    if (minutes < 60) return `Expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
    const hours = Math.round(minutes / 60)
    return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  })

  let authorizedLabel = $derived(
    oauth.status?.authorizedAt
      ? `Authorized ${formatDateTimeCompact(oauth.status.authorizedAt)}`
      : ''
  )

  let authorizing = $derived(oauth.busy && oauth.progress !== null)

  let canDisconnect = $derived.by((): boolean => {
    const state: McpOAuthConnectionState | undefined = oauth.status?.state
    if (!oauth.status) return false
    return oauth.status.enabled || state === 'connected' || state === 'expired' || state === 'error'
  })
</script>

{#if utility === null}
  <p class="text-xs text-muted">Save this MCP server before authorizing it.</p>
{:else if utility.kind === 'mcp' && utility.config.transport !== 'stdio'}
  <fieldset class="space-y-3 rounded-xl border p-3">
    <legend class="px-1 text-xs font-semibold">MCP authorization</legend>

    <div class="flex items-start justify-between gap-3">
      <p class="text-[0.6875rem] text-muted">
        OAuth is for servers that refuse anonymous or API-key access.
      </p>
      <Switch
        checked={oauth.status?.enabled ?? false}
        disabled={oauth.loading || oauth.busy || oauth.status === null}
        title="Send the stored OAuth grant with this server's requests"
        aria-label="Use OAuth authorization for this server"
        onchange={(enabled) => void oauth.setEnabled(enabled)}
      />
    </div>

    {#if oauth.loading}
      <p class="text-[0.6875rem] text-dimmed">Reading authorization status…</p>
    {:else if oauth.status}
      <div class="space-y-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <StatusPill {tone} dot>{stateLabel}</StatusPill>
          {#if issuerHost}
            <span class="truncate text-[0.6875rem] text-muted" title={oauth.status.issuer}>
              {issuerHost}
            </span>
          {/if}
          {#if expiryLabel}
            <span class="text-[0.6875rem] text-muted">{expiryLabel}</span>
          {/if}
          {#if authorizedLabel}
            <span class="text-[0.6875rem] text-dimmed">{authorizedLabel}</span>
          {/if}
        </div>
        <p class="text-[0.6875rem] text-muted">{stateSentence}</p>
        {#if oauth.status.scope}
          <p class="truncate text-[0.6875rem] text-dimmed" title={oauth.status.scope}>
            Scopes: {oauth.status.scope}
          </p>
        {/if}
      </div>

      {#if oauth.progress}
        <p class="text-[0.6875rem] text-muted" aria-live="polite">{oauth.progress}</p>
      {/if}

      {#if oauth.error}
        <p class="text-[0.6875rem] text-danger" role="alert">{oauth.error}</p>
      {/if}

      {#if !oauth.status.secureStorageAvailable}
        <p class="text-[0.6875rem] text-warning">
          A grant cannot be stored on this device: secure credential storage is unavailable.
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        {#if authorizing}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
            disabled={!oauth.busy}
            onclick={() => void oauth.cancel()}
          >
            Cancel
          </button>
        {:else if oauth.status.secureStorageAvailable}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
            disabled={oauth.busy}
            onclick={() => void oauth.authorize()}
          >
            Authorize in browser
          </button>
        {/if}
        {#if canDisconnect}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg border border-danger/40 px-3 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={oauth.busy}
            onclick={() => (oauth.confirmDisconnect = true)}
          >
            Disconnect
          </button>
        {/if}
      </div>

      <details class="rounded-lg border bg-surface">
        <summary
          class="cursor-pointer px-3 py-2 text-[0.6875rem] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Advanced
        </summary>
        <div class="space-y-3 border-t p-3">
          <p class="text-[0.6875rem] text-dimmed">
            Only for a server that issues no client dynamically, such as a Slack-style server.
          </p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1 text-xs font-medium">
              <span>Client ID</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                autocomplete="off"
                bind:value={oauth.clientId}
              />
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Client secret</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                type="password"
                autocomplete="off"
                placeholder="Stored only when provided"
                bind:value={oauth.clientSecret}
              />
            </label>
          </div>
          <label class="block space-y-1 text-xs font-medium">
            <span>Scopes</span>
            <input
              class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
              placeholder="Space-separated; defaults to the server's own list"
              bind:value={oauth.scope}
            />
          </label>
        </div>
      </details>
    {/if}
  </fieldset>

  <ConfirmDialog
    open={oauth.confirmDisconnect}
    title="Disconnect MCP authorization"
    confirmLabel="Disconnect"
    busy={oauth.busy}
    onCancel={() => (oauth.confirmDisconnect = false)}
    onConfirm={() => oauth.disconnect()}
  >
    <p>
      Remove the stored grant and client for
      <strong class="text-foreground">{utility.name}</strong>? Authorizing again will ask the server
      for a new grant.
    </p>
  </ConfirmDialog>
{/if}
