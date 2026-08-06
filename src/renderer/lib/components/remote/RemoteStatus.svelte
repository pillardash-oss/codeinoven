<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { routeTone, type RemoteRoute } from '$lib/remote/routes'
  import {
    sessionStatusLabel,
    type KeepAlivePhase,
    type SessionSnapshot
  } from '$lib/remote/session-state'
  import { RefreshCw } from '@lucide/svelte'

  interface Props {
    snapshot: SessionSnapshot
    busy: boolean
    onReconnect: () => void
  }

  let { snapshot, busy, onReconnect }: Props = $props()

  const TONE_COLORS: Record<ReturnType<typeof routeTone>, string> = {
    success: 'var(--color-thread-done)',
    warning: 'var(--color-warning)',
    info: 'var(--color-info)',
    muted: 'var(--color-dimmed)',
    danger: 'var(--color-danger)'
  }

  const ROUTE_LABELS: Record<RemoteRoute['kind'], string> = {
    LAN_PROBE: 'Searching local network',
    LAN_CONNECTED: 'Connected over LAN',
    RELAY_PROBING: 'Connecting via relay',
    RELAY_CONNECTED: 'Connected via relay',
    DISCONNECTED: 'Disconnected'
  }

  const KEEP_ALIVE_LABELS: Record<KeepAlivePhase, string> = {
    IDLE: 'Remote mode off',
    KEEP_ALIVE_ARMED: 'Remote mode on — waiting for a session',
    KEEP_ALIVE_ACTIVE: 'Remote mode on — still accepting sessions',
    REMOTE_SESSION_LIVE: 'Remote session active on desktop'
  }
</script>

<section class="rounded-xl border bg-surface p-4" aria-label="Remote connection status">
  <div class="flex items-center gap-2.5">
    <StatusBadge
      color={TONE_COLORS[routeTone(snapshot.route)]}
      title={ROUTE_LABELS[snapshot.route.kind]}
      size="md"
    />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-foreground">{sessionStatusLabel(snapshot)}</p>
      <p class="text-[11px] text-dimmed">
        {snapshot.peerReachable ? 'Desktop peer reachable' : 'Desktop peer not reachable'}
      </p>
    </div>
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      disabled={busy}
      aria-label="Reconnect to the desktop"
      title="Reconnect to the desktop"
      onclick={onReconnect}
    >
      <RefreshCw size={14} class={busy ? 'animate-spin' : ''} />
      <span>Reconnect</span>
    </button>
  </div>

  <div class="mt-3 border-t pt-3">
    <p class="text-[11px] text-dimmed" title={KEEP_ALIVE_LABELS[snapshot.keepAlive]}>
      <span class="font-semibold text-muted">Keep-alive:</span>
      {KEEP_ALIVE_LABELS[snapshot.keepAlive]}
    </p>
  </div>
</section>
