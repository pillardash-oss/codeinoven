<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { Laptop, LogOut, Plus, RefreshCw, ScanLine, ShieldCheck, Trash2, X } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import EnrollmentCodeScanner from '$lib/components/remote/EnrollmentCodeScanner.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import {
    completeCloudAuthCallback,
    currentCloudUser,
    hasCloudAuthCallback,
    logoutCloudAccount,
    signInWithCloudProvider,
    type CloudAuthProvider
  } from '$lib/remote/cloud-auth'
  import {
    claimCloudDesktop,
    cloudDesktopConnection,
    listCloudDesktops,
    revokeCloudDesktop,
    type CloudDesktop,
    type CloudUser
  } from '$lib/remote/cloud-api'
  import { remoteSession } from '$lib/remote/session-store.svelte'

  const PENDING_ENROLLMENT_CODE_KEY = 'codeinoven:pending-remote-enrollment'
  const CLAIM_STATUS_REFRESH_DELAYS_MS = [1_000, 2_000, 3_000, 5_000] as const

  function normalizeEnrollmentCode(value: string): string {
    const compact = value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 16)
    return compact.match(/.{1,4}/g)?.join('-') ?? ''
  }

  function persistEnrollmentCode(code: string): void {
    try {
      window.sessionStorage.setItem(PENDING_ENROLLMENT_CODE_KEY, code)
    } catch {
      // The current component still retains the code when storage is unavailable.
    }
  }

  function readPersistedEnrollmentCode(): string {
    try {
      return window.sessionStorage.getItem(PENDING_ENROLLMENT_CODE_KEY) ?? ''
    } catch {
      return ''
    }
  }

  function clearPersistedEnrollmentCode(): void {
    try {
      window.sessionStorage.removeItem(PENDING_ENROLLMENT_CODE_KEY)
    } catch {
      // The consumed server-side code cannot be reused even if storage cleanup fails.
    }
  }

  function initialEnrollmentCode(): string {
    if (typeof window === 'undefined') return ''
    const hashCode = new URLSearchParams(window.location.hash.slice(1)).get('enroll')
    const normalizedHashCode = hashCode ? normalizeEnrollmentCode(hashCode) : ''
    if (normalizedHashCode) {
      persistEnrollmentCode(normalizedHashCode)
      try {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}`
        )
      } catch {
        // Enrollment can continue even if this browser does not allow cleaning the address bar.
      }
      return normalizedHashCode
    }
    return normalizeEnrollmentCode(readPersistedEnrollmentCode())
  }

  function initialSignInProvider(): CloudAuthProvider | null {
    if (typeof window === 'undefined') return null
    const provider = new URLSearchParams(window.location.hash.slice(1)).get('provider')
    return provider === 'google' || provider === 'apple' ? provider : null
  }

  const signInProviderFromLink = initialSignInProvider()
  const enrollmentCodeFromLink = initialEnrollmentCode()

  let user = $state<CloudUser | null>(null)
  let desktops = $state<CloudDesktop[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let errorMessage = $state('')
  let claimError = $state('')
  let claimCode = $state(enrollmentCodeFromLink)
  let claimFromLink = $state(enrollmentCodeFromLink.length > 0)
  let scannerOpen = $state(false)
  let connectingDesktopId = $state<string | null>(null)
  let activeSignInProvider = $state<CloudAuthProvider | null>(null)
  let revokeCandidate = $state<CloudDesktop | null>(null)
  let automaticSignInStarted = false
  let desktopStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null

  function readableError(error: unknown): string {
    if (!(error instanceof Error)) return 'The request could not be completed.'
    const relayAuthentication = /^Relay device authentication failed: (.+)$/.exec(error.message)
    if (relayAuthentication) {
      const reason = relayAuthentication[1] ?? 'rejected'
      return `The desktop rejected this phone's security proof (${reason}). Pair this desktop again with a new one-time code.`
    }
    if (error.message === 'Relay device authentication timed out') {
      return 'The desktop did not finish authenticating this phone. Try connecting again.'
    }
    const messages: Record<string, string> = {
      'google-sign-in-failed': 'Google sign-in could not be completed.',
      'apple-sign-in-failed': 'Apple sign-in could not be completed.',
      'oauth-session-failed': 'Sign-in completed, but the mobile session could not be established.',
      'invalid-enrollment-code': 'That desktop code is invalid or has expired.',
      'enrollment-conflict':
        'That desktop belongs to another account. Sign in with the same account as the desktop.',
      'device-not-approved':
        'This PWA installation is not approved for that desktop. Add it again with a new code.',
      'rate-limited': 'Too many attempts. Wait a minute and try again.',
      unauthorized: 'Your session expired. Sign in again.',
      'request-failed': 'The remote service is unavailable.'
    }
    return messages[error.message] ?? 'The remote service is unavailable.'
  }

  async function restoreSession(): Promise<void> {
    loading = true
    const returningFromSignIn = hasCloudAuthCallback()
    try {
      await completeCloudAuthCallback()
      user = await currentCloudUser()
      desktops = await listCloudDesktops()
    } catch (error) {
      user = null
      desktops = []
      if (returningFromSignIn) errorMessage = readableError(error)
    } finally {
      loading = false
    }
    if (!user && signInProviderFromLink && !automaticSignInStarted) {
      automaticSignInStarted = true
      void beginAccountSignIn(signInProviderFromLink)
    } else if (user && claimFromLink) {
      void claimDesktopCode()
    }
  }

  async function beginAccountSignIn(provider: CloudAuthProvider): Promise<void> {
    if (busy) return
    busy = true
    activeSignInProvider = provider
    errorMessage = ''
    try {
      await signInWithCloudProvider(provider)
    } catch (error) {
      errorMessage = readableError(error)
      busy = false
      activeSignInProvider = null
    }
  }

  async function refreshDesktops(): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    try {
      desktops = await listCloudDesktops()
      if (
        connectingDesktopId &&
        desktops.some((desktop) => desktop.id === connectingDesktopId && desktop.online)
      ) {
        stopDesktopStatusRefresh()
      }
    } catch (error) {
      errorMessage = readableError(error)
    } finally {
      busy = false
    }
  }

  function stopDesktopStatusRefresh(): void {
    if (desktopStatusRefreshTimer !== null) clearTimeout(desktopStatusRefreshTimer)
    desktopStatusRefreshTimer = null
    connectingDesktopId = null
  }

  function scheduleDesktopStatusRefresh(desktopId: string, attempt = 0): void {
    if (desktopStatusRefreshTimer !== null) clearTimeout(desktopStatusRefreshTimer)
    const delay = CLAIM_STATUS_REFRESH_DELAYS_MS[attempt]
    if (delay === undefined) {
      stopDesktopStatusRefresh()
      return
    }
    desktopStatusRefreshTimer = setTimeout(() => {
      desktopStatusRefreshTimer = null
      void refreshClaimedDesktopStatus(desktopId, attempt)
    }, delay)
  }

  async function refreshClaimedDesktopStatus(desktopId: string, attempt: number): Promise<void> {
    if (connectingDesktopId !== desktopId) return
    try {
      desktops = await listCloudDesktops()
      if (desktops.some((desktop) => desktop.id === desktopId && desktop.online)) {
        stopDesktopStatusRefresh()
        return
      }
    } catch {
      // Keep the newly paired desktop visible while the normal UI handles manual retries.
    }
    if (connectingDesktopId === desktopId) scheduleDesktopStatusRefresh(desktopId, attempt + 1)
  }

  async function claimDesktopCode(): Promise<void> {
    if (busy) return
    const formattedCode = normalizeEnrollmentCode(claimCode)
    claimCode = formattedCode
    if (formattedCode.replaceAll('-', '').length !== 16) {
      claimError = 'Enter all 16 characters from the desktop pairing code.'
      return
    }
    busy = true
    claimError = ''
    try {
      const desktopId = await claimCloudDesktop(formattedCode)
      connectingDesktopId = desktopId
      claimCode = ''
      claimFromLink = false
      clearPersistedEnrollmentCode()
      desktops = await listCloudDesktops()
      if (desktops.some((desktop) => desktop.id === desktopId && desktop.online)) {
        stopDesktopStatusRefresh()
      } else {
        scheduleDesktopStatusRefresh(desktopId)
      }
    } catch (error) {
      claimError = readableError(error)
    } finally {
      busy = false
    }
  }

  function enrollmentCodeFromQr(value: string): string | null {
    let candidate = value
    try {
      const scannedUrl = new URL(value)
      candidate =
        new URLSearchParams(scannedUrl.hash.slice(1)).get('enroll') ??
        scannedUrl.searchParams.get('enroll') ??
        ''
    } catch {
      // A scanner may return the formatted one-time code directly.
    }
    const formatted = normalizeEnrollmentCode(candidate)
    return formatted.replaceAll('-', '').length === 16 ? formatted : null
  }

  function handleScannedEnrollment(value: string): boolean {
    const code = enrollmentCodeFromQr(value)
    if (!code) return false
    claimCode = code
    claimFromLink = true
    claimError = ''
    persistEnrollmentCode(code)
    scannerOpen = false
    void claimDesktopCode()
    return true
  }

  function claimDesktop(event: SubmitEvent): void {
    event.preventDefault()
    void claimDesktopCode()
  }

  async function connectDesktop(desktopId: string): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    try {
      const connection = await cloudDesktopConnection(desktopId)
      let lanTarget
      if (connection.lanEndpoint) {
        const lanUrl = new URL(connection.lanEndpoint)
        lanTarget = {
          host: lanUrl.hostname,
          port: Number(lanUrl.port) || 443,
          scheme: 'wss' as const
        }
      }
      await remoteSession.connectAccountDesktop({
        desktopId,
        mobileDeviceId: connection.mobileDeviceId,
        controlSecret: connection.controlSecret,
        relayPath: connection.relayPath,
        lanTarget
      })
      const route = remoteSession.snapshot.route
      if (route.kind !== 'RELAY_CONNECTED' && route.kind !== 'LAN_CONNECTED') {
        errorMessage =
          route.kind === 'DISCONNECTED' && route.reason === 'desktop-offline'
            ? 'That desktop is offline. Open CodeInOven and enable Remote mode.'
            : 'The desktop relay could not be reached.'
      }
    } catch (error) {
      errorMessage = readableError(error)
    } finally {
      busy = false
    }
  }

  async function removeDesktop(): Promise<void> {
    const candidate = revokeCandidate
    if (busy || !candidate) return
    busy = true
    errorMessage = ''
    try {
      remoteSession.disconnect()
      await revokeCloudDesktop(candidate.id)
      desktops = desktops.filter((desktop) => desktop.id !== candidate.id)
      if (connectingDesktopId === candidate.id) stopDesktopStatusRefresh()
      revokeCandidate = null
    } catch (error) {
      revokeCandidate = null
      errorMessage = readableError(error)
    } finally {
      busy = false
    }
  }

  async function signOut(): Promise<void> {
    if (busy) return
    busy = true
    try {
      remoteSession.disconnect()
      await logoutCloudAccount()
      stopDesktopStatusRefresh()
      user = null
      desktops = []
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void restoreSession()
    return stopDesktopStatusRefresh
  })
</script>

{#snippet addDesktopForm()}
  <form class="rounded-xl border bg-surface p-4" onsubmit={claimDesktop}>
    <div class="flex items-center gap-1.5">
      <Plus size={14} class="text-muted" />
      <h2 class="text-sm font-semibold">
        {claimFromLink ? 'Finish adding your desktop' : 'Add a desktop'}
      </h2>
    </div>
    <p class="mt-1 text-xs leading-relaxed text-muted">
      {claimFromLink
        ? 'The one-time code from the QR is ready. Tap Add to connect this desktop to your account.'
        : 'Enter the one-time code shown in Remote settings on your desktop.'}
    </p>
    <button
      class="mt-3 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
      type="button"
      disabled={busy}
      onclick={() => {
        claimError = ''
        scannerOpen = true
      }}
    >
      <ScanLine size={16} /> Scan pairing QR
    </button>
    <div class="my-3 flex items-center gap-3" aria-hidden="true">
      <span class="h-px flex-1 bg-border"></span>
      <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">
        Or enter the code
      </span>
      <span class="h-px flex-1 bg-border"></span>
    </div>
    <div class="mt-3 flex gap-2">
      <input
        class="h-10 min-w-0 flex-1 rounded-lg border bg-elevated px-3 font-mono text-sm uppercase outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        aria-label="Desktop enrollment code"
        autocomplete="one-time-code"
        autocapitalize="characters"
        placeholder="ABCD-EFGH-IJKL-MNOP"
        bind:value={claimCode}
        oninput={() => {
          claimCode = normalizeEnrollmentCode(claimCode)
          claimError = ''
        }}
        maxlength="19"
        required
      />
      <button
        class="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="submit"
        disabled={busy || claimCode.replaceAll('-', '').length !== 16}
        >{busy ? 'Adding…' : 'Add'}</button
      >
    </div>
    {#if claimError}
      <p class="mt-2 text-xs leading-relaxed text-danger" role="alert">{claimError}</p>
    {/if}
  </form>
{/snippet}

{#if loading || !user}
  <main class="grid min-h-dvh w-full place-items-center bg-app p-6 text-foreground">
    <section class="flex w-full max-w-xs flex-col items-center text-center">
      <img class="h-24 w-24 rounded-2xl" src="/logo.png" alt="CodeInOven" />
      <h1 class="mt-5 text-lg font-semibold tracking-tight">Remote connection</h1>

      {#if errorMessage}
        <p
          class="mt-4 w-full rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger"
          aria-live="polite"
        >
          {errorMessage}
        </p>
      {/if}

      {#if !loading}
        <div class="mt-6 w-full space-y-2">
          <button
            class="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            type="button"
            disabled={busy}
            onclick={() => void beginAccountSignIn('google')}
          >
            <VendorIcon name="Google" size={16} />
            {activeSignInProvider === 'google' ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <button
            class="flex h-11 w-full items-center justify-center gap-2 rounded-lg border bg-surface px-4 text-sm font-semibold text-foreground hover:bg-elevated disabled:opacity-50"
            type="button"
            disabled={busy}
            onclick={() => void beginAccountSignIn('apple')}
          >
            <VendorIcon name="Apple" size={16} />
            {activeSignInProvider === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
          </button>
        </div>
      {/if}

      <p class="mt-5 text-[11px] text-dimmed">v{__CODEINOVEN_APP_VERSION__}</p>
    </section>
  </main>
{:else}
  <main
    class="mx-auto flex h-dvh w-full max-w-md flex-col overflow-y-auto overscroll-contain bg-app p-6 pb-12 text-foreground"
  >
    <header class="mb-6 flex items-start gap-3">
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary"
      >
        <Laptop size={19} />
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight">Remote workspace</h1>
        <p class="mt-0.5 text-sm text-muted">Connect securely to any of your desktops.</p>
      </div>
    </header>

    <div class="space-y-5">
      <section class="rounded-xl border bg-surface p-4">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">{user.displayName}</p>
            <p class="truncate text-xs text-muted">{user.email}</p>
          </div>
          <button
            type="button"
            class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
            title="Sign out of remote access"
            aria-label="Sign out of remote access"
            disabled={busy}
            onclick={() => void signOut()}
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </section>

      {@render addDesktopForm()}

      <section class="space-y-2" aria-label="Your desktops">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">Your desktops</h2>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-elevated hover:text-foreground"
            title="Refresh desktop status"
            aria-label="Refresh desktop status"
            disabled={busy}
            onclick={() => void refreshDesktops()}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {#each desktops as desktop (desktop.id)}
          <div class="flex min-h-16 w-full items-center gap-1 rounded-xl border bg-surface p-2">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-elevated disabled:opacity-60"
              disabled={busy || !desktop.online}
              onclick={() => void connectDesktop(desktop.id)}
            >
              <div
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
              >
                <Laptop size={16} />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold">{desktop.name}</p>
                <p class="truncate text-xs text-muted">{desktop.platform}</p>
              </div>
              <span
                class={desktop.online
                  ? 'rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary'
                  : 'rounded-full bg-raised px-2 py-1 text-[10px] font-semibold text-dimmed'}
              >
                {desktop.online ? 'Connect' : 'Offline'}
              </span>
            </button>
            <button
              type="button"
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              title={`Remove ${desktop.name}`}
              aria-label={`Remove ${desktop.name}`}
              disabled={busy}
              onclick={() => (revokeCandidate = desktop)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        {:else}
          <div class="rounded-xl border bg-surface p-4 text-center">
            <ShieldCheck class="mx-auto text-muted" size={20} />
            <p class="mt-2 text-sm font-medium">No desktops connected</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              Open Remote settings on a desktop to get a one-time enrollment code.
            </p>
          </div>
        {/each}
      </section>
    </div>
  </main>

  {#if errorMessage}
    <div
      class="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-60 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-danger/30 bg-surface px-4 py-3 text-sm text-danger shadow-xl"
      role="alert"
    >
      <p class="min-w-0 flex-1 leading-5">{errorMessage}</p>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-danger hover:bg-danger/10"
        title="Dismiss error"
        aria-label="Dismiss error"
        onclick={() => (errorMessage = '')}
      >
        <X size={15} />
      </button>
    </div>
  {/if}

  <AlertDialog.Root
    open={revokeCandidate !== null}
    onOpenChange={(open) => {
      if (!open) revokeCandidate = null
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Remove {revokeCandidate?.name ?? 'desktop'}?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          This immediately revokes its internet access. Reconnect it later with a new pairing code.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-9 cursor-pointer rounded-lg border border-border px-3 text-xs font-medium text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-9 cursor-pointer rounded-lg bg-danger px-3 text-xs font-semibold text-on-primary hover:bg-danger-hover disabled:opacity-50"
            disabled={busy}
            onclick={() => void removeDesktop()}
          >
            {busy ? 'Removing…' : 'Remove access'}
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>

  {#if scannerOpen}
    <EnrollmentCodeScanner onScan={handleScannedEnrollment} onClose={() => (scannerOpen = false)} />
  {/if}
{/if}
