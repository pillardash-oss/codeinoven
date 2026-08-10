<script lang="ts">
  import { onMount } from 'svelte'
  import { Globe2 } from '@lucide/svelte'
  import ConnectedDevices from '$lib/components/remote/ConnectedDevices.svelte'
  import StepUpApproval from '$lib/components/remote/StepUpApproval.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { RemoteModeStatus, RemotePendingStepUpApproval } from '$shared/ipc-contract'

  let remoteStatus = $state<RemoteModeStatus | null>(null)
  let pendingApprovals = $state<RemotePendingStepUpApproval[]>([])
  let loading = $state(true)
  let busy = $state(false)

  async function handleRenameDevice(deviceId: string, name: string): Promise<void> {
    try {
      remoteStatus = await invoke('remote:renameDevice', deviceId, name)
    } catch {
      // The status event will resync the list if the rename failed server-side.
    }
  }

  async function handleDisconnectDevice(deviceId: string): Promise<void> {
    await invoke('remote:disconnectDevice', deviceId)
  }

  async function handleRevokeDevice(deviceId: string): Promise<void> {
    try {
      remoteStatus = await invoke('remote:revokeDevice', deviceId, 'operator')
    } catch {
      // The status event will resync the list if the revocation failed.
    }
  }

  async function handleApproveStepUp(approvalId: string): Promise<void> {
    await invoke('remote:approveStepUp', approvalId)
  }

  async function handleRejectStepUp(approvalId: string): Promise<void> {
    await invoke('remote:rejectStepUp', approvalId)
  }

  async function beginCloudEnrollment(): Promise<void> {
    if (busy) return
    busy = true
    try {
      remoteStatus = await invoke('remote:beginCloudEnrollment')
    } finally {
      busy = false
    }
  }

  async function resetCloudEnrollment(): Promise<void> {
    if (busy) return
    busy = true
    try {
      remoteStatus = await invoke('remote:resetCloudEnrollment')
    } finally {
      busy = false
    }
  }

  async function syncRemoteStatus(): Promise<void> {
    try {
      remoteStatus = await invoke('remote:getStatus')
    } catch {
      remoteStatus = null
    } finally {
      loading = false
    }
  }

  onMount(() => {
    // The gateway provides the LAN route for the same account-backed session.
    // It is transport infrastructure, not a separate setup or pairing flow.
    void invoke('remote:ensureGateway')
      .then((status) => {
        remoteStatus = status
        loading = false
      })
      .catch(() => void syncRemoteStatus())
    const unsubStatus = subscribe('remote:status', (status) => {
      remoteStatus = status
      loading = false
    })
    const unsubStepUp = subscribe('remote:stepUpPending', (approvals) => {
      pendingApprovals = approvals
    })
    return () => {
      unsubStatus()
      unsubStepUp()
    }
  })
</script>

<main class="w-full space-y-6">
  <StepUpApproval
    approvals={pendingApprovals}
    {busy}
    onApprove={(approvalId) => void handleApproveStepUp(approvalId)}
    onReject={(approvalId) => void handleRejectStepUp(approvalId)}
  />

  <section class="rounded-xl border bg-surface p-4" aria-label="Remote access">
    <div class="flex items-center gap-1.5">
      <Globe2 size={14} class="text-muted" />
      <h2 class="text-sm font-semibold text-foreground">Remote access</h2>
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      Connect through one account-backed workspace. The app uses LAN automatically when both devices
      are on the same network and falls back to the cloud relay everywhere else.
    </p>

    {#if loading}
      <p class="mt-3 text-xs text-muted" aria-live="polite">Loading remote access…</p>
    {:else if !remoteStatus}
      <p class="mt-3 text-xs text-danger" aria-live="polite">
        Remote access status could not be loaded.
      </p>
    {:else if !remoteStatus.cloud.configured}
      <p class="mt-3 text-xs leading-relaxed text-muted">
        Set <span class="font-mono text-foreground">REMOTE_API_ORIGIN</span> to your hosted mobile origin
        to enroll this desktop.
      </p>
    {:else if remoteStatus.cloud.state === 'enrollment-pending'}
      <p class="mt-3 text-xs text-muted">Enter this one-time code in the mobile PWA:</p>
      <p
        class="mt-2 select-all rounded-lg bg-raised px-3 py-2 text-center font-mono text-sm font-semibold tracking-wider text-foreground"
      >
        {remoteStatus.cloud.enrollmentCode}
      </p>
      <p class="mt-2 text-[11px] text-dimmed">
        The code expires automatically. It never contains the desktop control secret.
      </p>
    {:else}
      <div class="mt-3 flex items-center justify-between gap-3 text-xs">
        <span class="text-muted">Connection</span>
        <span class="font-medium text-foreground">
          {remoteStatus.cloud.state === 'online'
            ? 'Ready'
            : remoteStatus.cloud.state === 'connecting'
              ? 'Connecting…'
              : remoteStatus.cloud.desktopId
                ? 'Offline'
                : 'Not enrolled'}
        </span>
      </div>
      {#if remoteStatus.cloud.lastError}
        <p class="mt-2 text-[11px] text-danger">{remoteStatus.cloud.lastError}</p>
      {/if}
    {/if}

    {#if remoteStatus}
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="h-9 cursor-pointer rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
          disabled={busy || !remoteStatus.cloud.configured}
          onclick={() => void beginCloudEnrollment()}
        >
          {remoteStatus.cloud.desktopId ? 'Create new code' : 'Enroll desktop'}
        </button>
        {#if remoteStatus.cloud.desktopId}
          <button
            type="button"
            class="h-9 cursor-pointer rounded-lg border px-3 text-xs font-medium text-muted transition hover:bg-elevated hover:text-foreground disabled:opacity-50"
            disabled={busy}
            onclick={() => void resetCloudEnrollment()}
          >
            Remove enrollment
          </button>
        {/if}
      </div>
    {/if}
  </section>

  <ConnectedDevices
    devices={remoteStatus?.devices ?? []}
    {busy}
    onRename={(deviceId, name) => void handleRenameDevice(deviceId, name)}
    onDisconnect={(deviceId) => void handleDisconnectDevice(deviceId)}
    onRevoke={(deviceId) => void handleRevokeDevice(deviceId)}
  />
</main>
