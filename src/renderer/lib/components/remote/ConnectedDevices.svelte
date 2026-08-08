<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { Ban, KeyRound, Pencil, ShieldOff, Smartphone, Unplug, X } from '@lucide/svelte'
  import type { RemoteDeviceInfo } from '$shared/ipc-contract'

  interface Props {
    devices: RemoteDeviceInfo[]
    busy: boolean
    onRename: (deviceId: string, name: string) => void
    onDisconnect: (deviceId: string) => void
    onRevoke: (deviceId: string) => void
  }

  let { devices, busy, onRename, onDisconnect, onRevoke }: Props = $props()

  let editingId = $state<string | null>(null)
  let editingName = $state('')
  let pendingDisconnect = $state<string | null>(null)
  let pendingRevoke = $state<string | null>(null)

  function beginEdit(device: RemoteDeviceInfo): void {
    editingId = device.id
    editingName = device.name
  }

  function commitEdit(): void {
    const id = editingId
    const name = editingName.trim()
    editingId = null
    if (id && name.length > 0 && name !== devices.find((d) => d.id === id)?.name) {
      onRename(id, name)
    }
  }

  function cancelEdit(): void {
    editingId = null
  }

  function confirmDisconnect(): void {
    const deviceId = pendingDisconnect
    pendingDisconnect = null
    if (deviceId) onDisconnect(deviceId)
  }

  function confirmRevoke(): void {
    const deviceId = pendingRevoke
    pendingRevoke = null
    if (deviceId) onRevoke(deviceId)
  }

  function deviceTransportLabel(transport: RemoteDeviceInfo['transport']): string {
    return transport === 'relay' ? 'Cloud relay' : 'Local network'
  }

  function formatRelative(at: number | null): string {
    if (at === null) return 'never'
    const elapsed = Math.max(0, Date.now() - at)
    const minutes = Math.floor(elapsed / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) return 'no expiry'
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) return 'expired'
    const days = Math.ceil(remaining / 86_400_000)
    if (days >= 2) return `expires in ${days}d`
    const hours = Math.max(1, Math.ceil(remaining / 3_600_000))
    return `expires in ${hours}h`
  }

  function scopeSummary(scopes: string[]): string {
    if (scopes.length === 0) return 'no scopes'
    const readable = scopes.map((scope) => scope.replace(/\./g, ' '))
    const joined = readable.join(', ')
    return joined.length > 60 ? `${joined.slice(0, 57)}…` : joined
  }

  function fingerprintShort(fingerprint: string | null): string {
    return fingerprint ? fingerprint.slice(0, 12) : ''
  }
</script>

<section class="rounded-xl border bg-surface p-4" aria-label="Connected devices">
  <div class="flex items-center gap-2">
    <Smartphone size={15} class="text-primary" />
    <h2 class="text-sm font-semibold text-foreground">Connected devices</h2>
    {#if devices.length > 0}
      <span class="rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info"
        >{devices.length}</span
      >
    {/if}
  </div>

  {#if devices.length === 0}
    <p class="mt-3 text-xs leading-relaxed text-dimmed">
      No phones connected yet. Scan the pairing code with your phone to connect.
    </p>
  {:else}
    <ul class="mt-3 divide-y divide-border/60">
      {#each devices as device (device.id)}
        <li class="flex items-center gap-3 py-2.5">
          <Smartphone
            size={16}
            class="shrink-0 {device.revokedAt !== null ? 'text-danger' : 'text-muted'}"
          />
          <div class="min-w-0 flex-1">
            {#if editingId === device.id}
              <div class="flex items-center gap-1.5">
                <input
                  type="text"
                  class="h-7 min-w-0 flex-1 rounded-md border bg-elevated px-2 text-xs text-foreground"
                  placeholder="Device name"
                  maxlength="100"
                  bind:value={editingName}
                  onkeydown={(event: KeyboardEvent) => {
                    if (event.key === 'Enter') commitEdit()
                    if (event.key === 'Escape') cancelEdit()
                  }}
                  onblur={commitEdit}
                  aria-label="Rename device"
                />
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
                  aria-label="Cancel renaming the device"
                  title="Cancel renaming the device"
                  onclick={cancelEdit}
                >
                  <X size={14} />
                </button>
              </div>
            {:else}
              <p class="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                {device.name}
                {#if device.connected}
                  <span
                    class="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success"
                    >Live</span
                  >
                {/if}
                {#if device.revokedAt !== null}
                  <span
                    class="shrink-0 rounded-full bg-danger/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-danger"
                    >Revoked</span
                  >
                {/if}
              </p>
              <p class="mt-0.5 text-[11px] text-dimmed">
                {deviceTransportLabel(device.transport)}
                {#if device.lastUsedAt}
                  · last used {formatRelative(device.lastUsedAt)}
                {/if}
                {#if device.expiresAt}
                  · {formatExpiry(device.expiresAt)}
                {/if}
              </p>
              {#if device.scopes.length > 0}
                <p
                  class="mt-0.5 flex items-center gap-1 text-[10px] text-muted"
                  title={device.scopes.join(', ')}
                >
                  <KeyRound size={9} class="shrink-0" />
                  <span class="truncate">{scopeSummary(device.scopes)}</span>
                </p>
              {/if}
              {#if device.fingerprint}
                <p class="mt-0.5 font-mono text-[9px] text-dimmed">
                  {fingerprintShort(device.fingerprint)}…
                </p>
              {/if}
            {/if}
          </div>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || editingId !== null || device.revokedAt !== null}
            aria-label={`Rename ${device.name}`}
            title="Rename device"
            onclick={() => beginEdit(device)}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || editingId !== null || !device.connected}
            aria-label={`Disconnect ${device.name}`}
            title="Disconnect device"
            onclick={() => (pendingDisconnect = device.id)}
          >
            <Unplug size={14} />
          </button>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-danger disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || editingId !== null || device.revokedAt !== null}
            aria-label={`Revoke ${device.name}`}
            title="Revoke device access"
            onclick={() => (pendingRevoke = device.id)}
          >
            <Ban size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<AlertDialog.Root open={pendingDisconnect !== null} onOpenChange={() => (pendingDisconnect = null)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Disconnect device?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        {devices.find((device) => device.id === pendingDisconnect)?.name ?? 'This device'} will be disconnected
        from this desktop. It can reconnect at any time by scanning the pairing code again.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={confirmDisconnect}
        >
          Disconnect
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<AlertDialog.Root open={pendingRevoke !== null} onOpenChange={() => (pendingRevoke = null)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ShieldOff size={15} class="text-danger" />
        Revoke device access?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Revoking {devices.find((device) => device.id === pendingRevoke)?.name ?? 'this device'} closes
        its live session immediately and permanently blocks its saved credentials. The phone cannot reconnect
        unless you pair it again with a fresh code. This action cannot be undone.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={confirmRevoke}
        >
          Revoke
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
