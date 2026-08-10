<script lang="ts">
  import { Laptop, LogOut, Plus, RefreshCw, ShieldCheck, Trash2 } from '@lucide/svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { currentCloudUser, logoutCloudAccount, signInWithGitHub } from '$lib/remote/cloud-auth'
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

  function normalizeEnrollmentCode(value: string): string {
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '')
      .slice(0, 19)
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

  const enrollmentCodeFromLink = initialEnrollmentCode()

  let user = $state<CloudUser | null>(null)
  let desktops = $state<CloudDesktop[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let errorMessage = $state('')
  let claimCode = $state(enrollmentCodeFromLink)
  let claimFromLink = $state(enrollmentCodeFromLink.length > 0)
  let revokeCandidate = $state<CloudDesktop | null>(null)

  function readableError(error: unknown): string {
    if (!(error instanceof Error)) return 'The request could not be completed.'
    const messages: Record<string, string> = {
      'github-sign-in-failed': 'GitHub sign-in could not be started.',
      'invalid-enrollment-code': 'That desktop code is invalid or has expired.',
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
    try {
      user = await currentCloudUser()
      desktops = await listCloudDesktops()
    } catch {
      user = null
      desktops = []
    } finally {
      loading = false
    }
  }

  async function beginGitHubSignIn(): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    try {
      await signInWithGitHub()
    } catch (error) {
      errorMessage = readableError(error)
      busy = false
    }
  }

  async function refreshDesktops(): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    try {
      desktops = await listCloudDesktops()
    } catch (error) {
      errorMessage = readableError(error)
    } finally {
      busy = false
    }
  }

  async function claimDesktop(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (busy || claimCode.trim().length === 0) return
    busy = true
    errorMessage = ''
    try {
      await claimCloudDesktop(claimCode.trim())
      claimCode = ''
      claimFromLink = false
      clearPersistedEnrollmentCode()
      desktops = await listCloudDesktops()
    } catch (error) {
      errorMessage = readableError(error)
    } finally {
      busy = false
    }
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
    if (busy || !revokeCandidate) return
    busy = true
    errorMessage = ''
    try {
      remoteSession.disconnect()
      await revokeCloudDesktop(revokeCandidate.id)
      desktops = desktops.filter((desktop) => desktop.id !== revokeCandidate?.id)
      revokeCandidate = null
    } catch (error) {
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
      user = null
      desktops = []
    } finally {
      busy = false
    }
  }

  $effect(() => {
    void restoreSession()
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
    <div class="mt-3 flex gap-2">
      <input
        class="h-10 min-w-0 flex-1 rounded-lg border bg-elevated px-3 font-mono text-sm uppercase outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        aria-label="Desktop enrollment code"
        autocomplete="one-time-code"
        placeholder="ABCD-EFGH-IJKL-MNOP"
        bind:value={claimCode}
        maxlength="19"
        required
      />
      <button
        class="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="submit"
        disabled={busy}>Add</button
      >
    </div>
  </form>
{/snippet}

<main class="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-app p-6 pb-12 text-foreground">
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

  {#if loading}
    <section class="rounded-xl border bg-surface p-4 text-sm text-muted" aria-live="polite">
      Restoring your session…
    </section>
  {:else if !user}
    <section class="space-y-4 rounded-xl border bg-surface p-5">
      <div>
        <h2 class="text-sm font-semibold">Create or sign in to your CodeInOven account</h2>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          {claimFromLink
            ? 'Continue with GitHub first. The one-time desktop code will be ready when you return.'
            : 'Your GitHub account is your CodeInOven identity for the GitHub sidebar and remote access.'}
        </p>
      </div>

      {#if errorMessage}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" aria-live="polite">
          {errorMessage}
        </p>
      {/if}

      <button
        class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="button"
        disabled={busy}
        onclick={() => void beginGitHubSignIn()}
      >
        <VendorIcon name="GitHub" size={16} />
        {busy ? 'Opening GitHub…' : 'Continue with GitHub'}
      </button>
      <p class="text-center text-[11px] leading-relaxed text-dimmed">
        Use the same GitHub account you want connected to the GitHub sidebar.
      </p>
    </section>
  {:else}
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

      {#if revokeCandidate}
        <section class="rounded-xl border border-danger/30 bg-danger/5 p-4" aria-live="polite">
          <p class="text-sm font-semibold">Remove {revokeCandidate.name}?</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            This immediately revokes its internet access. Reconnect it later with a new code.
          </p>
          <div class="mt-3 flex justify-end gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-xs font-medium text-muted hover:bg-elevated"
              disabled={busy}
              onclick={() => (revokeCandidate = null)}>Cancel</button
            >
            <button
              type="button"
              class="h-9 rounded-lg bg-danger px-3 text-xs font-semibold text-on-primary disabled:opacity-50"
              disabled={busy}
              onclick={() => void removeDesktop()}>Remove access</button
            >
          </div>
        </section>
      {/if}

      {#if errorMessage}
        <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" aria-live="polite">
          {errorMessage}
        </p>
      {/if}
    </div>
  {/if}
</main>
