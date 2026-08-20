<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Check,
    CheckCircle2,
    Copy,
    ExternalLink,
    Power as PowerIcon,
    RefreshCw
  } from '@lucide/svelte'
  import ConnectedDevices from '$lib/components/remote/ConnectedDevices.svelte'
  import EnrollmentQr from '$lib/components/remote/EnrollmentQr.svelte'
  import StepUpApproval from '$lib/components/remote/StepUpApproval.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { copyText } from '$lib/copy-text'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { RemoteModeStatus, RemotePendingStepUpApproval } from '$shared/ipc-contract'
  import type { AccountAuthProvider, AccountProfileState } from '$shared/types'

  let remoteStatus = $state<RemoteModeStatus | null>(null)
  let pendingApprovals = $state<RemotePendingStepUpApproval[]>([])
  let remoteLoading = $state(true)
  let accountLoading = $state(true)
  let busy = $state(false)
  let copied = $state<'code' | 'link' | null>(null)
  let accountState = $state<AccountProfileState>({ status: 'pending', profile: null })
  let activeProvider = $state<AccountAuthProvider | null>(null)
  let accountError = $state('')
  let enrollmentError = $state('')
  let powerError = $state('')
  let powerBusy = $state(false)
  let keepAwakeWhileRemoteConnected = $state(true)

  const initializing = $derived(remoteLoading || accountLoading)
  const accountProfile = $derived(accountState.profile)
  const pairedDevices = $derived(
    remoteStatus?.devices.filter((device) => device.revokedAt === null) ?? []
  )
  const pairingFinishing = $derived(
    remoteStatus?.cloud.desktopId !== null &&
      remoteStatus?.cloud.state === 'connecting' &&
      remoteStatus?.cloud.enrollmentCode !== null
  )
  const interactionsLocked = $derived(busy || pairingFinishing)
  const accountInitials = $derived.by(() => {
    const source = accountProfile?.displayName || accountProfile?.email || ''
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  })

  let mobileAppUrl = $derived.by(() => {
    const apiOrigin = remoteStatus?.cloud.apiOrigin
    if (!apiOrigin) return null
    try {
      return new URL('/', apiOrigin).toString()
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
    enrollmentError = ''
    try {
      remoteStatus = await invoke('remote:beginCloudEnrollment')
    } catch {
      enrollmentError =
        'A pairing code could not be created. Check the remote service and try again.'
    } finally {
      busy = false
    }
  }

  async function beginAccountSignIn(provider: AccountAuthProvider): Promise<void> {
    if (busy) return
    busy = true
    activeProvider = provider
    accountError = ''
    try {
      const signIn = await invoke('account:beginSignIn', provider)
      await invoke('shell:openExternal', signIn.url)
      accountState = { status: 'pending', profile: null }
    } catch {
      accountError = 'Sign-in could not be opened. Check the remote service and try again.'
    } finally {
      busy = false
      activeProvider = null
    }
  }

  async function initializeRemoteAccess(): Promise<void> {
    const [remoteResult, accountResult, configResult] = await Promise.allSettled([
      invoke('remote:ensureGateway'),
      invoke('account:getProfile'),
      invoke('config:get')
    ])

    remoteStatus = remoteResult.status === 'fulfilled' ? remoteResult.value : null
    accountState =
      accountResult.status === 'fulfilled'
        ? accountResult.value
        : { status: 'signed-out', profile: null }
    if (configResult.status === 'fulfilled') {
      keepAwakeWhileRemoteConnected = configResult.value.keepAwakeWhileRemoteConnected
    }
    remoteLoading = false
    accountLoading = false
  }

  async function toggleRemoteKeepAwake(): Promise<void> {
    if (powerBusy) return
    powerBusy = true
    powerError = ''
    const nextValue = !keepAwakeWhileRemoteConnected
    try {
      const config = await invoke('config:update', {
        keepAwakeWhileRemoteConnected: nextValue
      })
      keepAwakeWhileRemoteConnected = config.keepAwakeWhileRemoteConnected
    } catch {
      powerError = 'The power preference could not be saved.'
    } finally {
      powerBusy = false
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

  onMount(() => {
    const unsubStatus = subscribe('remote:status', (status) => {
      remoteStatus = status
      remoteLoading = false
    })
    const unsubAccount = subscribe('account:profileChanged', (state) => {
      accountState = state
      accountLoading = false
      accountError = state.status === 'error' ? state.message : ''
    })
    const unsubStepUp = subscribe('remote:stepUpPending', (approvals) => {
      pendingApprovals = approvals
    })
    // Restored account sessions do not emit a fresh profile-change event. Load
    // account and remote state together, but keep enrollment behind the explicit
    // “Create pairing code” action.
    void initializeRemoteAccess()
    return () => {
      unsubStatus()
      unsubAccount()
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

  <section class="rounded-xl border bg-surface p-4" aria-label="Phone pairing">
    {#if accountProfile}
      <div class="flex items-center gap-3">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-bold text-on-primary ring-1 ring-border"
        >
          {#if accountProfile.image}
            <img class="h-full w-full object-cover" src={accountProfile.image} alt="" />
          {:else}
            <span aria-hidden="true">{accountInitials}</span>
          {/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-foreground">
            {accountProfile.displayName || accountProfile.email}
          </p>
          <p class="truncate text-xs text-muted">{accountProfile.email}</p>
        </div>
        <span class="flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
          <CheckCircle2 size={13} /> Signed in
        </span>
      </div>
    {/if}

    {#if initializing}
      <div class="mt-4 flex items-center gap-2 text-xs text-muted" aria-live="polite">
        <RefreshCw size={14} class="shrink-0 animate-spin text-primary" />
        Restoring remote access…
      </div>
    {:else if !remoteStatus}
      <p class="mt-4 text-xs text-danger" aria-live="polite">
        Remote access status could not be loaded.
      </p>
    {:else if !remoteStatus.cloud.configured}
      <p class="mt-4 text-xs text-danger">Remote access is not configured.</p>
    {:else if accountState.status === 'signed-out' || accountState.status === 'error'}
      <div class="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          class="flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
          disabled={busy}
          onclick={() => void beginAccountSignIn('google')}
        >
          <VendorIcon name="Google" size={16} />
          {activeProvider === 'google' ? 'Opening Google…' : 'Continue with Google'}
        </button>
        <button
          type="button"
          class="flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold text-foreground transition hover:bg-elevated disabled:opacity-50"
          disabled={busy}
          onclick={() => void beginAccountSignIn('apple')}
        >
          <VendorIcon name="Apple" size={16} />
          {activeProvider === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
        </button>
      </div>
    {:else if accountState.status === 'pending'}
      <button
        type="button"
        class="mt-4 h-9 cursor-pointer rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
        disabled={busy}
        onclick={() => void beginCloudEnrollment()}
      >
        Finish sign-in
      </button>
    {:else if remoteStatus.cloud.enrollmentCode}
      <div class="mt-4 border-t pt-4">
        <h2 class="text-sm font-semibold text-foreground">Pair a phone</h2>

        {#if mobileAppUrl && enrollmentLink}
          <div class="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p class="text-xs font-semibold text-foreground">1. Open the mobile app</p>
              <p class="mt-1 text-[11px] text-muted">Scan and sign in on your phone.</p>
              <div class="mt-3"><EnrollmentQr value={mobileAppUrl} /></div>
              <div class="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                  title="Copy mobile website link"
                  aria-label="Copy mobile website link"
                  disabled={interactionsLocked}
                  onclick={() => void copyEnrollmentValue('link', mobileAppUrl)}
                >
                  {#if copied === 'link'}<Check size={13} />{:else}<Copy size={13} />{/if}
                  {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
                <button
                  type="button"
                  class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                  title="Open mobile website in browser"
                  aria-label="Open mobile website in browser"
                  disabled={interactionsLocked}
                  onclick={() => void openInBrowser(mobileAppUrl)}
                >
                  <ExternalLink size={13} /> Open
                </button>
              </div>
            </div>

            <div>
              <p class="text-xs font-semibold text-foreground">2. Pair this desktop</p>
              <p class="mt-1 text-[11px] text-muted">Scan to submit the one-time code.</p>
              <div class="relative mt-3 w-fit">
                <EnrollmentQr value={enrollmentLink} />
                {#if pairingFinishing}
                  <div
                    class="absolute inset-0 grid place-items-center rounded-xl bg-overlay/85 backdrop-blur-sm"
                    role="status"
                    aria-live="polite"
                    aria-label="Finishing secure connection"
                  >
                    <div class="flex max-w-36 flex-col items-center gap-2 px-3 text-center">
                      <RefreshCw size={22} class="animate-spin text-primary" />
                      <p class="text-xs font-semibold text-foreground">Finishing connection…</p>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}

        <div class="mt-4 flex items-center gap-2">
          <div class="min-w-0 flex-1 rounded-lg bg-raised px-3 py-2">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Code</p>
            <p
              class="mt-0.5 select-all font-mono text-sm font-semibold tracking-wider text-foreground"
            >
              {remoteStatus.cloud.enrollmentCode}
            </p>
          </div>
          <button
            type="button"
            class="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-medium text-muted transition hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title="Copy one-time enrollment code"
            aria-label="Copy one-time enrollment code"
            disabled={interactionsLocked}
            onclick={() =>
              void copyEnrollmentValue('code', remoteStatus?.cloud.enrollmentCode ?? '')}
          >
            {#if copied === 'code'}<Check size={13} />{:else}<Copy size={13} />{/if}
            {copied === 'code' ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            class="h-9 cursor-pointer rounded-lg border px-3 text-xs font-medium text-muted transition hover:bg-elevated hover:text-foreground disabled:opacity-50"
            disabled={interactionsLocked}
            onclick={() => void resetCloudEnrollment()}
          >
            Cancel
          </button>
        </div>
      </div>
    {:else}
      <button
        type="button"
        class="mt-4 h-9 cursor-pointer rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
        disabled={interactionsLocked}
        onclick={() => void beginCloudEnrollment()}
      >
        {busy
          ? 'Creating pairing code…'
          : pairedDevices.length > 0
            ? 'Pair another phone'
            : 'Pair a new device'}
      </button>
    {/if}

    {#if accountError || enrollmentError}
      <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {accountError || enrollmentError}
      </p>
    {/if}
  </section>

  <section class="rounded-xl border bg-surface p-4" aria-labelledby="remote-power-title">
    <div class="flex items-center gap-2">
      <PowerIcon size={15} class="text-muted" />
      <h2 id="remote-power-title" class="text-xs font-semibold uppercase tracking-wide text-muted">
        Power
      </h2>
    </div>
    <div class="mt-3 flex items-center justify-between gap-4">
      <div>
        <p class="text-sm font-medium text-foreground">Keep desktop awake while connected</p>
        <p class="mt-1 text-xs text-dimmed">
          Prevent sleep only while a phone has joined this desktop.
        </p>
      </div>
      <Switch
        checked={keepAwakeWhileRemoteConnected}
        onchange={() => void toggleRemoteKeepAwake()}
        aria-label="Toggle keeping the desktop awake while a phone is connected"
        disabled={powerBusy || pairingFinishing}
      />
    </div>
    {#if powerError}
      <p class="mt-3 text-xs text-danger" role="alert">{powerError}</p>
    {/if}
  </section>

  <ConnectedDevices
    devices={pairedDevices}
    busy={interactionsLocked}
    onRename={(deviceId, name) => void handleRenameDevice(deviceId, name)}
    onDisconnect={(deviceId) => void handleDisconnectDevice(deviceId)}
    onRevoke={(deviceId) => void handleRevokeDevice(deviceId)}
  />
</main>
