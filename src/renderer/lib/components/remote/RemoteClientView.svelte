<script lang="ts">
  import { ArrowLeft, Globe2, RefreshCw, ShieldCheck } from '@lucide/svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import RemoteStatus from '$lib/components/remote/RemoteStatus.svelte'
  import PeerConnect from '$lib/components/remote/PeerConnect.svelte'
  import PairingQr from '$lib/components/remote/PairingQr.svelte'
  import ConnectedDevices from '$lib/components/remote/ConnectedDevices.svelte'
  import StepUpApproval from '$lib/components/remote/StepUpApproval.svelte'
  import { remoteSession, type RemoteConnectionTarget } from '$lib/remote/session-store.svelte'
  import { buildRemoteConfig, loadRemoteConfig, type RemoteConfig } from '$lib/remote/config'
  import {
    recentRemoteLogs,
    setRemoteLogger,
    createRingBufferLogger,
    type RemoteLogEntry
  } from '$lib/remote/logger'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { RemoteModeStatus, RemotePendingStepUpApproval } from '$shared/ipc-contract'

  interface Props {
    onBack?: () => void
    /** True when rendered as the installable PWA on a phone (no Electron bridge). */
    pwa?: boolean
    /** True when embedded in the Settings page — no header bar, no app chrome. */
    embedded?: boolean
  }

  let { onBack = () => undefined, pwa = false, embedded = false }: Props = $props()

  let desktop = $derived(!pwa && typeof window !== 'undefined' && 'api' in window)

  function resolveConfig(): { config: RemoteConfig; error: string | null } {
    try {
      return { config: loadRemoteConfig(), error: null }
    } catch (error) {
      return {
        config: buildRemoteConfig({}),
        error: error instanceof Error ? error.message : 'Remote configuration is invalid'
      }
    }
  }

  const resolvedConfig = resolveConfig()
  let config = $state(resolvedConfig.config)
  let configError = $state(resolvedConfig.error)

  let remoteStatus = $state<RemoteModeStatus | null>(null)
  let pendingApprovals = $state<RemotePendingStepUpApproval[]>([])
  let secret = $state(remoteSession.secretValue)
  let busy = $state(false)
  let diagnostics = $state<readonly RemoteLogEntry[]>([])
  let diagnosticsOpen = $state(false)

  let keepAliveOn = $derived(
    remoteStatus?.remoteMode ?? remoteSession.snapshot.keepAlive !== 'IDLE'
  )
  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )

  function refreshDiagnostics(): void {
    diagnostics = recentRemoteLogs()
  }

  async function handleConnect(value?: string): Promise<void> {
    const effective = value ?? secret
    if (busy || effective.trim().length === 0) return
    busy = true
    try {
      let target: RemoteConnectionTarget | undefined
      if (pwa && typeof window !== 'undefined') {
        target = {
          host: window.location.hostname || 'localhost',
          port: Number(window.location.port) || config.lan.port,
          scheme: 'wss'
        }
      } else {
        target = { host: '127.0.0.1', port: config.lan.localPort, scheme: 'ws' }
      }
      await remoteSession.connect(effective.trim(), target, { deviceCredentials: pwa })
    } finally {
      busy = false
    }
  }

  function handleDisconnect(): void {
    remoteSession.disconnect()
  }

  async function handleKeepAliveToggle(enabled: boolean): Promise<void> {
    if (desktop) {
      remoteStatus = await invoke('remote:toggle', enabled)
      remoteSession.setKeepAlive(remoteStatus.phase)
    } else {
      remoteSession.setKeepAlive(enabled ? 'KEEP_ALIVE_ARMED' : 'IDLE')
    }
  }

  async function handleRenameDevice(deviceId: string, name: string): Promise<void> {
    if (!desktop) return
    try {
      remoteStatus = await invoke('remote:renameDevice', deviceId, name)
    } catch {
      // The status event will resync the list if the rename failed server-side.
    }
  }

  async function handleDisconnectDevice(deviceId: string): Promise<void> {
    if (!desktop) return
    await invoke('remote:disconnectDevice', deviceId)
  }

  async function handleRevokeDevice(deviceId: string): Promise<void> {
    if (!desktop) return
    try {
      remoteStatus = await invoke('remote:revokeDevice', deviceId, 'operator')
    } catch {
      // The status event will resync the list if the revocation failed.
    }
  }

  async function handleApproveStepUp(approvalId: string): Promise<void> {
    if (!desktop) return
    await invoke('remote:approveStepUp', approvalId)
  }

  async function handleRejectStepUp(approvalId: string): Promise<void> {
    if (!desktop) return
    await invoke('remote:rejectStepUp', approvalId)
  }

  function gatewayHost(): string | null {
    const url = remoteStatus?.gateway?.url
    if (!url) return null
    try {
      return new URL(url).host
    } catch {
      return null
    }
  }

  async function beginCloudEnrollment(): Promise<void> {
    if (!desktop || busy) return
    busy = true
    try {
      remoteStatus = await invoke('remote:beginCloudEnrollment')
    } finally {
      busy = false
    }
  }

  async function resetCloudEnrollment(): Promise<void> {
    if (!desktop || busy) return
    busy = true
    try {
      remoteStatus = await invoke('remote:resetCloudEnrollment')
    } finally {
      busy = false
    }
  }

  async function syncRemoteStatus(): Promise<void> {
    if (!desktop) return
    try {
      remoteStatus = await invoke('remote:getStatus')
      remoteSession.setKeepAlive(remoteStatus.phase)
    } catch {
      remoteStatus = null
    }
  }

  $effect(() => {
    if (!desktop) return
    setRemoteLogger(createRingBufferLogger())
    // Start the LAN gateway (if not already listening) so the QR pairing code
    // is immediately scannable — no manual "remote mode" toggle required.
    void invoke('remote:ensureGateway')
      .then((status) => {
        remoteStatus = status
        remoteSession.setKeepAlive(status.phase)
      })
      .catch(() => void syncRemoteStatus())
    refreshDiagnostics()
    const unsubscribe = subscribe('remote:status', (status) => {
      remoteStatus = status
      remoteSession.setKeepAlive(status.phase)
    })
    const unsubscribeStepUp = subscribe('remote:stepUpPending', (approvals) => {
      pendingApprovals = approvals
    })
    return () => {
      unsubscribe()
      unsubscribeStepUp()
    }
  })

  // The phone client reads `#pair=<secret>` from the QR code and connects
  // automatically — the human never types anything. If the first attempt fails
  // (e.g. the desktop was mid-restart), retry in the background so returning to
  // the page eventually connects without a manual tap.
  let pwaPair = $state('')
  let pwaRetryTimer: number | null = null
  $effect(() => {
    if (!pwa || typeof window === 'undefined') return
    const queryParams = new URLSearchParams(window.location.search)
    const fragmentParams = new URLSearchParams(window.location.hash.slice(1))
    const pair = fragmentParams.get('pair') ?? queryParams.get('pair')
    if (pair && pair.length > 0 && pwaPair.length === 0) {
      pwaPair = pair
      secret = pair
    }
  })

  $effect(() => {
    if (!pwa || pwaPair.length === 0 || connected || busy) return
    // Retry the auto-connect until it lands, so a desktop restart mid-session
    // heals on its own once the gateway is back up.
    pwaRetryTimer = window.setTimeout(() => {
      void handleConnect(pwaPair)
    }, 1500)
    return () => {
      if (pwaRetryTimer !== null) window.clearTimeout(pwaRetryTimer)
    }
  })

  $effect(() => {
    if (!pwa || pwaPair.length === 0) return
    void handleConnect(pwaPair)
  })
</script>

<div class={embedded ? 'flex flex-col' : 'flex h-full flex-col overflow-y-auto bg-app'}>
  {#if !pwa && !embedded}
    <header class="flex h-12 shrink-0 items-center gap-2 border-b bg-surface px-4">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
        aria-label="Back to the app"
        title="Back to the app"
        onclick={onBack}
      >
        <ArrowLeft size={16} />
      </button>
      <h1 class="text-[13px] font-semibold tracking-tight text-foreground">Remote</h1>
      <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
        >Phone client</span
      >
    </header>
  {/if}

  <main class={embedded ? 'w-full space-y-6' : 'mx-auto w-full max-w-md flex-1 space-y-6 p-6'}>
    {#if !pwa && desktop}
      <StepUpApproval
        approvals={pendingApprovals}
        {busy}
        onApprove={(approvalId) => void handleApproveStepUp(approvalId)}
        onReject={(approvalId) => void handleRejectStepUp(approvalId)}
      />
    {/if}
    {#if configError}
      <section
        class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        aria-label="Remote configuration warning"
      >
        <p class="font-medium">Configuration incomplete</p>
        <p class="mt-1 text-xs leading-relaxed">{configError}</p>
      </section>
    {/if}

    {#if !pwa && remoteStatus?.gateway?.pairingUrl}
      <PairingQr
        pairingUrl={remoteStatus.gateway.pairingUrl}
        phoneUrl={remoteStatus.gateway.url}
        pairingExpiresAt={remoteStatus.gateway.pairingExpiresAt}
        networkInterface={gatewayHost()}
      />
    {/if}

    <RemoteStatus
      snapshot={remoteSession.snapshot}
      {busy}
      onReconnect={() => void handleConnect()}
    />

    {#if !pwa && desktop}
      <ConnectedDevices
        devices={remoteStatus?.devices ?? []}
        {busy}
        onRename={(deviceId, name) => void handleRenameDevice(deviceId, name)}
        onDisconnect={(deviceId) => void handleDisconnectDevice(deviceId)}
        onRevoke={(deviceId) => void handleRevokeDevice(deviceId)}
      />
    {/if}

    {#if !embedded}
      {#if !pwa || pwaPair.length === 0}
        <PeerConnect
          bind:secret
          {connected}
          {busy}
          onConnect={(value) => void handleConnect(value)}
          onDisconnect={handleDisconnect}
        />
      {/if}
    {/if}

    {#if !pwa}
      <section class="rounded-xl border bg-surface p-4" aria-label="Remote mode">
        <h2 class="text-sm font-semibold text-foreground">Remote mode</h2>
        <div class="mt-2">
          <Switch
            checked={keepAliveOn}
            onchange={(enabled) => void handleKeepAliveToggle(enabled)}
            label="Accept phone sessions while the app is open"
            title="Accept phone sessions while the app is open"
            aria-label="Enable remote mode"
          />
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-dimmed">
          While remote mode is on, phones can connect to this desktop and the device stays awake
          during a live session. Closing the app disconnects everything.
        </p>
        {#if remoteStatus?.gateway?.url}
          <p class="mt-2 text-[11px] text-muted">
            Phone client: <span class="font-medium text-foreground">{remoteStatus.gateway.url}</span
            >
          </p>
        {/if}
      </section>

      <section class="rounded-xl border bg-surface p-4" aria-label="Internet access">
        <div class="flex items-center gap-1.5">
          <Globe2 size={14} class="text-muted" />
          <h2 class="text-sm font-semibold text-foreground">Internet access</h2>
        </div>
        {#if !remoteStatus?.cloud.configured}
          <p class="mt-2 text-xs leading-relaxed text-muted">
            Set <span class="font-mono text-foreground">REMOTE_API_ORIGIN</span> to your hosted mobile
            origin to enroll this desktop.
          </p>
        {:else if remoteStatus.cloud.state === 'enrollment-pending'}
          <p class="mt-2 text-xs text-muted">Enter this one-time code in the mobile PWA:</p>
          <p
            class="mt-2 select-all rounded-lg bg-raised px-3 py-2 text-center font-mono text-sm font-semibold tracking-wider text-foreground"
          >
            {remoteStatus.cloud.enrollmentCode}
          </p>
          <p class="mt-2 text-[11px] text-dimmed">
            The code expires automatically. It never contains the desktop control secret.
          </p>
        {:else}
          <div class="mt-2 flex items-center justify-between gap-3 text-xs">
            <span class="text-muted">Cloud relay</span>
            <span class="font-medium text-foreground">
              {remoteStatus?.cloud.state === 'online'
                ? 'Online'
                : remoteStatus?.cloud.state === 'connecting'
                  ? 'Connecting…'
                  : remoteStatus?.cloud.desktopId
                    ? 'Offline'
                    : 'Not enrolled'}
            </span>
          </div>
          {#if remoteStatus?.cloud.lastError}
            <p class="mt-2 text-[11px] text-danger">{remoteStatus.cloud.lastError}</p>
          {/if}
        {/if}
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
            disabled={busy || !remoteStatus?.cloud.configured}
            onclick={() => void beginCloudEnrollment()}
          >
            {remoteStatus?.cloud.desktopId ? 'Create new code' : 'Enroll desktop'}
          </button>
          {#if remoteStatus?.cloud.desktopId}
            <button
              type="button"
              class="h-9 rounded-lg border px-3 text-xs font-medium text-muted transition hover:bg-elevated hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onclick={() => void resetCloudEnrollment()}
            >
              Remove enrollment
            </button>
          {/if}
        </div>
      </section>
    {/if}

    <section class="rounded-xl border bg-surface p-4" aria-label="Connection settings">
      <div class="flex items-center gap-1.5">
        <ShieldCheck size={14} class="text-muted" />
        <h2 class="text-sm font-semibold text-foreground">Connection settings</h2>
      </div>
      <dl class="mt-2 space-y-1.5 text-xs">
        <div class="flex items-center justify-between gap-3">
          <dt class="text-dimmed">LAN route</dt>
          <dd class="font-medium text-foreground">
            {config.lan.enabled ? 'Enabled' : 'Disabled'} · port {config.lan.port}
          </dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-dimmed">Relay fallback</dt>
          <dd class="max-w-56 truncate font-medium text-foreground" title={config.relay.url}>
            {config.relay.enabled ? config.relay.url : 'Disabled'}
          </dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-dimmed">Peer secret</dt>
          <dd class="font-medium text-foreground">
            {config.peer.authSecret ? 'Configured' : 'Entered in this client'}
          </dd>
        </div>
      </dl>

      <div class="mt-3 border-t pt-3">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-semibold text-muted">Recent diagnostics</h3>
          <button
            type="button"
            class="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
            aria-label={diagnosticsOpen ? 'Collapse diagnostics' : 'Expand diagnostics'}
            title="Refresh diagnostics"
            onclick={() => {
              refreshDiagnostics()
              diagnosticsOpen = !diagnosticsOpen
            }}
          >
            <RefreshCw size={12} />
            <span>{diagnosticsOpen ? 'Collapse' : 'Show'}</span>
          </button>
        </div>
        {#if diagnosticsOpen}
          <ul class="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {#each diagnostics as entry (entry.at + entry.message)}
              <li class="flex gap-2 text-[10px] leading-snug">
                <span class="shrink-0 uppercase text-dimmed">{entry.level}</span>
                <span class="break-all text-muted">{entry.message}</span>
              </li>
            {:else}
              <li class="text-[10px] text-dimmed">No remote diagnostics recorded yet.</li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </main>
</div>
