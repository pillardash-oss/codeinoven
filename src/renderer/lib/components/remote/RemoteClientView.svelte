<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, CheckCircle2, Copy, ExternalLink, Globe2, RefreshCw } from '@lucide/svelte'
  import ConnectedDevices from '$lib/components/remote/ConnectedDevices.svelte'
  import EnrollmentQr from '$lib/components/remote/EnrollmentQr.svelte'
  import StepUpApproval from '$lib/components/remote/StepUpApproval.svelte'
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

  const initializing = $derived(remoteLoading || accountLoading)
  const accountProfile = $derived(accountState.profile)
  const pairedDevices = $derived(
    remoteStatus?.devices.filter((device) => device.revokedAt === null) ?? []
  )
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
    const [remoteResult, accountResult] = await Promise.allSettled([
      invoke('remote:ensureGateway'),
      invoke('account:getProfile')
    ])

    remoteStatus = remoteResult.status === 'fulfilled' ? remoteResult.value : null
    accountState =
      accountResult.status === 'fulfilled'
        ? accountResult.value
        : { status: 'signed-out', profile: null }
    remoteLoading = false
    accountLoading = false
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

  <section class="rounded-xl border bg-surface p-4" aria-label="Remote access">
    <div class="flex items-center gap-1.5">
      <Globe2 size={14} class="text-muted" />
      <h2 class="text-sm font-semibold text-foreground">Remote access</h2>
    </div>
    <p class="mt-2 text-xs leading-relaxed text-muted">
      Connect through one account-backed workspace. The app uses LAN automatically when both devices
      are on the same network and falls back to the cloud relay everywhere else.
    </p>

    {#if accountProfile}
      <div class="mt-4 flex items-center gap-3 border-y py-3">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-bold text-on-primary ring-1 ring-border"
        >
          {#if accountProfile.image}
            <img class="h-full w-full object-cover" src={accountProfile.image} alt="" />
          {:else}
            <span aria-hidden="true">{accountInitials}</span>
          {/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-semibold text-foreground">
            {accountProfile.displayName || accountProfile.email}
          </p>
          <p class="truncate text-[11px] text-muted">{accountProfile.email}</p>
        </div>
        <span class="flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
          <CheckCircle2 size={13} /> Signed in
        </span>
      </div>
    {/if}

    {#if initializing}
      <div class="mt-4 flex items-start gap-2 rounded-lg bg-raised p-3" aria-live="polite">
        <RefreshCw size={14} class="mt-0.5 shrink-0 text-primary" />
        <div>
          <p class="text-xs font-semibold text-foreground">Restoring your account</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Checking your saved sign-in and remote access status…
          </p>
        </div>
      </div>
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
          <p class="text-xs font-semibold text-foreground">Your account is ready</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            Now add this desktop from your phone using the same Google or Apple account.
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
              <span> Sign in with the same Google or Apple account if your phone asks. </span>
            </li>
            <li class="flex gap-2.5">
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-on-primary"
                >3</span
              >
              <span>The signed-in account adds this desktop automatically.</span>
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
    {:else if !remoteStatus.cloud.desktopId && (accountState.status === 'signed-out' || accountState.status === 'error')}
      <div class="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p class="text-xs font-semibold text-foreground">Sign in before enrolling this desktop</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Continue with Google or Apple. If the account does not exist, it is created automatically.
          GitHub sidebar access remains separate.
        </p>
        {#if accountError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {accountError}
          </p>
        {/if}
        <div class="mt-3 flex flex-col gap-2 sm:flex-row">
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
      </div>
    {:else if !remoteStatus.cloud.desktopId && accountState.status === 'pending'}
      <div class="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div class="flex items-start gap-2">
          <RefreshCw size={14} class="mt-0.5 shrink-0 text-primary" />
          <div>
            <p class="text-xs font-semibold text-foreground">Finish signing in in your browser</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              CodeInOven will detect the secure callback and create your desktop connection code
              automatically.
            </p>
          </div>
        </div>
        <button
          type="button"
          class="mt-3 h-9 cursor-pointer rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
          disabled={busy}
          onclick={() => void beginCloudEnrollment()}
        >
          Check sign-in and enroll desktop
        </button>
      </div>
    {:else if accountState.status === 'signed-in'}
      {#if !remoteStatus.cloud.desktopId && remoteStatus.cloud.state === 'connecting'}
        <div
          class="mt-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3"
        >
          <RefreshCw size={14} class="mt-0.5 shrink-0 text-primary" />
          <div>
            <p class="text-xs font-semibold text-foreground">Creating your pairing code</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              Your account is connected. CodeInOven is preparing the QR code for your phone.
            </p>
          </div>
        </div>
      {:else if !remoteStatus.cloud.desktopId}
        <div class="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p class="text-xs font-semibold text-foreground">Pair your phone</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            You are signed in. Create a temporary QR code to add your phone to this desktop.
          </p>
        </div>
        {#if enrollmentError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {enrollmentError}
          </p>
        {/if}
      {:else}
        <div class="mt-4 border-y py-4">
          <h3 class="text-sm font-semibold text-foreground">Open the mobile app</h3>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            {pairedDevices.length > 0
              ? `${pairedDevices.length} ${pairedDevices.length === 1 ? 'phone is' : 'phones are'} paired. Scan to open the PWA and connect.`
              : 'No phone has completed pairing yet. Scan to open the PWA and finish connecting this desktop.'}
          </p>

          {#if mobileAppUrl}
            <div class="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
              <EnrollmentQr value={mobileAppUrl} />
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs text-foreground" title={mobileAppUrl}>{mobileAppUrl}</p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                    title="Copy mobile app link"
                    aria-label="Copy mobile app link"
                    onclick={() => void copyEnrollmentValue('link', mobileAppUrl)}
                  >
                    {#if copied === 'link'}<Check size={13} />{:else}<Copy size={13} />{/if}
                    {copied === 'link' ? 'Copied link' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium text-muted transition hover:bg-elevated hover:text-foreground"
                    title="Open mobile app in browser"
                    aria-label="Open mobile app in browser"
                    onclick={() => void openInBrowser(mobileAppUrl)}
                  >
                    <ExternalLink size={13} /> Open link
                  </button>
                </div>
              </div>
            </div>
          {/if}
        </div>
        {#if remoteStatus.cloud.lastError}
          <p class="mt-2 text-[11px] text-danger">{remoteStatus.cloud.lastError}</p>
        {/if}
      {/if}
    {:else}
      <p class="mt-3 text-xs text-muted">Account status is unavailable. Refresh and try again.</p>
    {/if}

    {#if accountError}
      <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {accountError}
      </p>
    {/if}

    {#if remoteStatus && (remoteStatus.cloud.desktopId || accountState.status === 'signed-in')}
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="h-9 cursor-pointer rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition hover:bg-primary-hover disabled:opacity-50"
          disabled={busy || !remoteStatus.cloud.configured}
          onclick={() => void beginCloudEnrollment()}
        >
          {remoteStatus.cloud.desktopId
            ? 'Pair another phone'
            : busy
              ? 'Creating pairing code…'
              : 'Create pairing code'}
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
