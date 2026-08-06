<script lang="ts">
  import { ArrowLeft, ShieldCheck } from '@lucide/svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import RemoteStatus from '$lib/components/remote/RemoteStatus.svelte'
  import PeerConnect from '$lib/components/remote/PeerConnect.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { loadRemoteConfig, type RemoteConfig } from '$lib/remote/config'

  interface Props {
    onBack: () => void
  }

  let { onBack }: Props = $props()

  let config = $state<RemoteConfig | null>(null)
  let configError = $state<string | null>(null)
  try {
    config = loadRemoteConfig()
  } catch (error) {
    configError = error instanceof Error ? error.message : 'Remote configuration is invalid'
  }

  let secret = $state(remoteSession.secretValue)
  let busy = $state(false)

  let keepAliveOn = $derived(remoteSession.snapshot.keepAlive !== 'IDLE')
  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )

  async function handleConnect(value?: string): Promise<void> {
    const effective = value ?? secret
    if (busy || effective.trim().length === 0) return
    busy = true
    try {
      await remoteSession.connect(effective.trim())
    } finally {
      busy = false
    }
  }

  function handleDisconnect(): void {
    remoteSession.disconnect()
  }

  function handleKeepAliveToggle(enabled: boolean): void {
    remoteSession.setKeepAlive(enabled ? 'KEEP_ALIVE_ARMED' : 'IDLE')
  }
</script>

<div class="flex h-full flex-col overflow-y-auto bg-app">
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

  <main class="mx-auto w-full max-w-md flex-1 space-y-6 p-6">
    {#if configError}
      <section
        class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        aria-label="Remote configuration error"
      >
        {configError}
      </section>
    {:else if config}
      <RemoteStatus
        snapshot={remoteSession.snapshot}
        {busy}
        onReconnect={() => void handleConnect()}
      />

      <PeerConnect
        bind:secret
        {connected}
        {busy}
        onConnect={(value) => void handleConnect(value)}
        onDisconnect={handleDisconnect}
      />

      <section class="rounded-xl border bg-surface p-4" aria-label="Remote mode">
        <h2 class="text-sm font-semibold text-foreground">Remote mode</h2>
        <div class="mt-2">
          <Switch
            checked={keepAliveOn}
            onchange={handleKeepAliveToggle}
            label="Keep the desktop alive in the tray while I am away"
            title="Keep the desktop alive in the tray while I am away"
            aria-label="Keep remote mode on"
          />
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-dimmed">
          While remote mode is on the desktop stays alive, accepts incoming remote sessions, and
          refuses full quit while a session is live. Turn it off when you are back at your desk.
        </p>
      </section>

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
      </section>
    {/if}
  </main>
</div>
