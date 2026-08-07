<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { Pencil, Smartphone, Unplug, X } from '@lucide/svelte'
  import type { RemoteDeviceInfo } from '$shared/ipc-contract'

  interface Props {
    devices: RemoteDeviceInfo[]
    busy: boolean
    onRename: (deviceId: string, name: string) => void
    onDisconnect: (deviceId: string) => void
  }

  let { devices, busy, onRename, onDisconnect }: Props = $props()

  let editingId = $state<string | null>(null)
  let editingName = $state('')
  let pendingDisconnect = $state<string | null>(null)

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

  function deviceTransportLabel(transport: RemoteDeviceInfo['transport']): string {
    return transport === 'relay' ? 'Cloud relay' : 'Local network'
  }

  function formatConnectedAt(connectedAt: number): string {
    const elapsed = Math.max(0, Date.now() - connectedAt)
    const minutes = Math.floor(elapsed / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m ago`
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
          <Smartphone size={16} class="shrink-0 text-muted" />
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
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
                  aria-label="Cancel renaming the device"
                  title="Cancel renaming the device"
                  onclick={cancelEdit}
                >
                  <X size={14} />
                </button>
              </div>
            {:else}
              <p class="truncate text-sm font-medium text-foreground">{device.name}</p>
              <p class="text-[11px] text-dimmed">
                {deviceTransportLabel(device.transport)} · {formatConnectedAt(device.connectedAt)}
              </p>
            {/if}
          </div>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || editingId !== null}
            aria-label={`Rename ${device.name}`}
            title="Rename device"
            onclick={() => beginEdit(device)}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-danger disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || editingId !== null}
            aria-label={`Disconnect ${device.name}`}
            title="Disconnect device"
            onclick={() => (pendingDisconnect = device.id)}
          >
            <Unplug size={14} />
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
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={confirmDisconnect}
        >
          Disconnect
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
