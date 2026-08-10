<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, ExternalLink, Globe2 } from '@lucide/svelte'
  import ConnectedDevices from '$lib/components/remote/ConnectedDevices.svelte'
  import EnrollmentQr from '$lib/components/remote/EnrollmentQr.svelte'
  import StepUpApproval from '$lib/components/remote/StepUpApproval.svelte'
  import { copyText } from '$lib/copy-text'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { RemoteModeStatus, RemotePendingStepUpApproval } from '$shared/ipc-contract'

  let remoteStatus = $state<RemoteModeStatus | null>(null)
  let pendingApprovals = $state<RemotePendingStepUpApproval[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let copied = $state<'code' | 'link' | null>(null)

  let mobileAppUrl = $derived.by(() => {
    const apiOrigin = remoteStatus?.cloud.apiOrigin
    if (!apiOrigin) return null
    try {
      return new URL('/remote.html', apiOrigin).toString()
    } catch {
      return null
    }
  })

  let enrollmentLink = $derived.by(() => {
    const code = remoteStatus?.cloud.enrollmentCode
    if (!mobileAppUrl || !code) return null
    const enrollmentHash = new URLSearchParams({ enroll: code }).toString()
    return `${mobileAppUrl}#${enrollmentHash}`
  })

  async function copyEnrollmentValue(kind: 'code' | 'link', value: string): Promise<void> {
    await copyText(value)
    copied = kind
    window.setTimeout(() => {
      if (copied === kind) copied = null
    }, 1_500)
  }

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
      <div class="mt-4">
        <div class="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p class="text-xs font-semibold text-foreground">
            First, create or sign in to your CodeInOven account.
          </p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Continue with Google or Apple. A new account is created automatically when one does not
            already exist.
          </p>
        </div>

        <h3 class="mt-4 text-sm font-semibold text-foreground">Continue on your phone</h3>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          The QR opens the mobile PWA and carries this one-time code. It does not contain your
          desktop control secret.
        </p>

        <div class="mt-4 flex flex-col gap-4 sm:flex-row">
          {#if enrollmentLink}
            <EnrollmentQr value={enrollmentLink} />
          {/if}

          <ol class="min-w-0 flex-1 space-y-3 text-xs text-muted">
            <li class="flex gap-2.5">
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-on-primary"
                >1</span
              >
              <span>Scan the QR code with your phone, or copy the mobile-app link below.</span>
            </li>
            <li class="flex gap-2.5">
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-on-primary"
                >2</span
              >
              <span>
                Choose <strong>Continue with Google</strong> or
                <strong>Continue with Apple</strong>.
              </span>
            </li>
            <li class="flex gap-2.5">
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-on-primary"
                >3</span
              >
              <span>The code will already be filled in. Tap <strong>Add</strong> to finish.</span>
            </li>
          </ol>
        </div>

        {#if mobileAppUrl && enrollmentLink}
          <div class="mt-4 rounded-lg bg-raised p-3">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Mobile app</p>
            <p class="mt-1 truncate text-xs text-foreground" title={mobileAppUrl}>{mobileAppUrl}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                title="Copy mobile app link"
                aria-label="Copy mobile app link"
                onclick={() => void copyEnrollmentValue('link', enrollmentLink)}
              >
                {#if copied === 'link'}<Check size={13} />{:else}<Copy size={13} />{/if}
                {copied === 'link' ? 'Copied link' : 'Copy link'}
              </button>
              <button
                type="button"
                class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                title="Open mobile app in browser"
                aria-label="Open mobile app in browser"
                onclick={() => void openInBrowser(enrollmentLink)}
              >
                <ExternalLink size={13} /> Open link
              </button>
            </div>
          </div>
        {/if}

        {#if remoteStatus.cloud.enrollmentCode}
          <div class="mt-3 flex items-center gap-2 rounded-lg bg-raised p-3">
            <div class="min-w-0 flex-1">
              <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">
                One-time code
              </p>
              <p
                class="mt-1 select-all font-mono text-sm font-semibold tracking-wider text-foreground"
              >
                {remoteStatus.cloud.enrollmentCode}
              </p>
            </div>
            <button
              type="button"
              class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
              title="Copy one-time enrollment code"
              aria-label="Copy one-time enrollment code"
              onclick={() =>
                void copyEnrollmentValue('code', remoteStatus?.cloud.enrollmentCode ?? '')}
            >
              {#if copied === 'code'}<Check size={13} />{:else}<Copy size={13} />{/if}
              {copied === 'code' ? 'Copied' : 'Copy code'}
            </button>
          </div>
        {/if}
      </div>
    {:else}
      {#if !remoteStatus.cloud.desktopId}
        <div class="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p class="text-xs font-semibold text-foreground">
            You need a CodeInOven account before enrolling this desktop.
          </p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Create it automatically by continuing with Google or Apple. GitHub sidebar access is
            connected separately.
          </p>
        </div>
      {/if}
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
