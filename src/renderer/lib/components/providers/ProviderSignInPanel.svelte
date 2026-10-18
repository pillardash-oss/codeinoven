<script lang="ts">
  import CioClose from 'cio-icon/CioClose.svelte'
  import CioSpinner from 'cio-icon/CioSpinner.svelte'
  import { onDestroy, onMount } from 'svelte'

  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
  import { APP_SLUG } from '$shared/brand'
  import type {
    OfferedProvider,
    ProviderAccountAuthCapabilities,
    ProviderAccountLoginHandoff,
    ProviderAccountLoginOptions
  } from '$shared/types'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import Modal from '../ui/Modal.svelte'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import ProviderSignInProgress from './ProviderSignInProgress.svelte'
  import { loginFailureDetail } from './add-provider-modal-helpers'
  import { ProviderSignInController } from './provider-sign-in.svelte'

  /**
   * One harness sign-in, run for whichever surface asked.
   *
   * A harness can expose two mechanisms and this component picks between them
   * from the harness's own capabilities, so no caller has to know which:
   *
   *   - `in-app`: CodeInOven runs the harness's own sign-in flow itself (Pi,
   *     through pi-ai's `login()`). This is the only mechanism a bundled runtime
   *     can offer   it has no CLI to hand to a terminal   and the one that
   *     produces browser URLs, device codes and prompts the panel drives.
   *   - `terminal`: the harness's own login command (`claude auth login`,
   *     `codex login`) handed to an embedded terminal.
   *
   * `in-app` signs in through a dockable panel rather than a modal because its
   * browser handover has to survive: the authorization page is a native view
   * painted above every DOM node, so the panel steps aside to a dock chip while
   * the browser holds the page, exactly as the add-provider panel does.
   *
   * Either way the credential is confirmed against the account's own credential
   * home before `onComplete` fires, so a login that never landed is reported here
   * instead of silently leaving the account signed out.
   */
  interface Props {
    harnessId: string
    /** Harness display name, used when no provider name is known. */
    harnessName: string
    /** Catalog provider the sign-in targets (in-app sign-in cannot start without it). */
    providerId?: string
    providerName?: string
    /** Account whose credential home the sign-in must write into. */
    accountId?: string
    /** Terminal login options (mode, account hint, sso) for the terminal mechanism. */
    terminalOptions?: ProviderAccountLoginOptions
    onClose: () => void
    /** Fired once the credential is confirmed to have landed. */
    onComplete: () => void
  }

  let {
    harnessId,
    harnessName,
    providerId,
    providerName,
    accountId,
    terminalOptions,
    onClose,
    onComplete
  }: Props = $props()

  const targetName = $derived(providerName ?? harnessName)
  const title = $derived(`Sign in to ${targetName}`)
  const storageKey = `${APP_SLUG}.providerSignInPanel.v1`

  /** Which mechanism is running; `unresolved` while capabilities are read. */
  let mechanism = $state<'unresolved' | 'in-app' | 'terminal'>('unresolved')
  let error = $state('')
  let handoff = $state<ProviderAccountLoginHandoff | null>(null)
  let verifying = $state(false)
  /** Guards against an async resolve that settles after the panel was destroyed. */
  let destroyed = false
  const terminalId = `provider-login-${crypto.randomUUID()}`

  const oauth = new ProviderSignInController({
    harnessId: () => harnessId,
    selectedProvider: (): OfferedProvider | null =>
      providerId
        ? { id: providerId, name: providerName ?? providerId, modelCount: 0, authenticated: false }
        : null,
    clearApiKey: () => {},
    clearMessages: () => (error = ''),
    setActionError: (message) => (error = message),
    // The account is already decided by the caller, so the credential lands in
    // its own home rather than in a container this panel invents.
    bindSignInAccount: async () => accountId,
    finishAuthentication: () => finish(),
    discardPendingAccount: async () => {}
  })

  /**
   * Confirm the credential landed for this account, then hand back.
   *
   * Only an explicit "not signed in" blocks: a probe that could not answer
   * (unknown/error) is not proof of a failed sign-in, and whatever was retried
   * still reports the truth. A caller that bound no account has nothing to
   * confirm against, so it is trusted to have succeeded.
   */
  async function finish(): Promise<void> {
    try {
      if (accountId) {
        verifying = true
        const status = await invoke(
          'providerAccounts:getAuthStatus',
          harnessId,
          undefined,
          accountId
        )
        if (status.state === 'unauthenticated') {
          error = `${targetName} did not report a completed sign-in for this account.`
          return
        }
      }
      onComplete()
    } catch (confirmError) {
      error =
        confirmError instanceof Error ? confirmError.message : 'The sign-in could not be verified.'
    } finally {
      verifying = false
    }
  }

  async function startTerminal(): Promise<void> {
    try {
      handoff = await invoke('providerAccounts:beginLogin', harnessId, {
        ...(terminalOptions ?? {}),
        ...(providerId ? { providerId } : {}),
        ...(accountId ? { accountId } : {})
      })
    } catch (startError) {
      error = startError instanceof Error ? startError.message : 'Sign-in could not be started.'
    }
  }

  async function finishTerminal(exitCode: number, output: string): Promise<void> {
    if (exitCode !== 0) {
      // The CLI's own last lines carry the reason, which an exit code alone does
      // not, and the terminal they were printed in is about to be replaced.
      const detail = loginFailureDetail(output)
      error = `Sign-in exited with code ${exitCode}.${detail ? ` ${detail}` : ''}`
      return
    }
    // The process is gone; drop the terminal before confirming so the panel
    // never shows a dead session while it verifies.
    handoff = null
    await finish()
  }

  /**
   * The harness's sign-in capabilities, which decide the mechanism.
   *
   * Read against this account first. A binding the registry no longer knows (a
   * stale thread account) must not block a fresh sign-in, so the harness-level
   * read is the fallback: the mechanism is a property of the harness either way.
   */
  async function resolveCapabilities(): Promise<ProviderAccountAuthCapabilities | null> {
    try {
      const status = await invoke('providerAccounts:getAuthStatus', harnessId, undefined, accountId)
      return status.capabilities
    } catch {
      const status = await invoke('providerAccounts:getAuthStatus', harnessId)
      return status.capabilities
    }
  }

  /**
   * Pick the mechanism from the harness's capabilities, then start it.
   *
   * In-app wins whenever the harness offers it: a bundled runtime has no CLI to
   * hand a terminal, and the in-app flow is the harness's own sign-in either way.
   * A harness that can do neither is reported honestly instead of being handed a
   * command that cannot exist.
   */
  async function start(): Promise<void> {
    error = ''
    try {
      const capabilities = await resolveCapabilities()
      if (destroyed) return
      const canSignInInApp =
        capabilities?.inAppLogin === true &&
        providerId !== undefined &&
        !isCodeInOvenCustomProviderId(providerId)
      if (canSignInInApp) {
        mechanism = 'in-app'
        await oauth.start()
        return
      }
      mechanism = 'terminal'
      if (capabilities !== null && capabilities.loginHandoff === false) {
        error = `${harnessName} does not expose a sign-in flow CodeInOven can run.`
        return
      }
      await startTerminal()
    } catch (resolveError) {
      if (destroyed) return
      mechanism = 'terminal'
      error =
        resolveError instanceof Error ? resolveError.message : 'The sign-in could not be started.'
    }
  }

  function close(): void {
    if (oauth.loginId !== null) void oauth.cancel()
    onClose()
  }

  // The panel is mounted per sign-in, so mounting is what starts it: no effect
  // watches a flag to learn that a sign-in was requested. The subscription is
  // returned as the teardown so events stop being routed once it is gone.
  onMount(() => {
    const unsubscribe = subscribe('providerAccounts:oauthEvent', (payload) =>
      oauth.handlePayload(payload)
    )
    void start()
    return unsubscribe
  })

  onDestroy(() => {
    destroyed = true
    if (oauth.loginId !== null) void oauth.cancel()
  })

  // Docking follows the view, not only the `auth_url` event: a device-code link
  // or a harness-printed URL can reveal the browser without one, and a panel left
  // over the authorization page covers the one thing the user must act on.
  let previousView = rendererRecovery.activeView
  $effect(() => {
    const view = rendererRecovery.activeView
    const enteredBrowser = view !== previousView && view === 'browser'
    previousView = view
    if (!enteredBrowser || oauth.loginId === null) return
    if (!oauth.authPageInAppBrowser) return
    oauth.docked = true
  })

  const signingIn = $derived(oauth.loginId !== null)
  const dockStatus = $derived(
    oauth.deviceCode
      ? `Enter ${oauth.deviceCode.userCode} to finish signing in.`
      : oauth.status || 'Finish signing in in the browser.'
  )
</script>

{#if mechanism === 'in-app'}
  <DockableModal
    open
    {title}
    minimized={oauth.docked}
    closable={!signingIn}
    onMinimize={() => (oauth.docked = true)}
    onClose={close}
    {storageKey}
    dragLabel="Drag to move the sign-in panel"
    defaultHeight={420}
  >
    {#snippet dock()}
      <DockRow {storageKey} label="Move docked provider sign-in">
        <div
          class="flex items-center gap-1 border bg-surface p-1.5 shadow-xl"
          data-region="provider-sign-in-dock"
        >
          <button
            type="button"
            class="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
            title="Show the sign-in for {targetName}"
            aria-label="Show the sign-in for {targetName}"
            onclick={() => (oauth.docked = false)}
          >
            <CioSpinner size={14} class="shrink-0 animate-spin text-info" aria-hidden="true" />
            <span class="flex min-w-0 flex-col">
              <span class="text-[0.6875rem] leading-tight font-medium text-foreground">
                Signing in to {targetName}
              </span>
              <span
                class="max-w-56 truncate text-[0.625rem] leading-tight text-muted"
                aria-live="polite"
              >
                {dockStatus}
              </span>
            </span>
          </button>
          <span class="h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Cancel the sign-in"
            title="Cancel the sign-in"
            onclick={close}
          >
            <CioClose size={14} />
          </button>
        </div>
      </DockRow>
    {/snippet}

    {#if oauth.loginId !== null}
      <ProviderSignInProgress {oauth} />
    {:else if error}
      <p class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {error}
      </p>
    {:else if verifying}
      <p class="flex items-center gap-2 text-xs text-muted">
        <CioSpinner size={13} class="animate-spin" />
        Confirming sign-in for this account…
      </p>
    {:else}
      <p class="flex items-center gap-2 text-xs text-muted">
        <CioSpinner size={13} class="animate-spin" />
        Starting sign-in…
      </p>
    {/if}
  </DockableModal>
{:else}
  <Modal open {title} onClose={close}>
    <div class="h-[28rem] overflow-hidden border border-border bg-app">
      {#if handoff}
        <ProviderLoginTerminal
          {terminalId}
          command={handoff.command}
          args={handoff.args}
          environment={handoff.environment}
          startingLabel="Starting sign-in…"
          onExit={(exitCode, output) => void finishTerminal(exitCode, output)}
        />
      {:else if error}
        <div class="flex h-full items-center justify-center p-6">
          <p class="max-w-md text-center text-sm text-danger">{error}</p>
        </div>
      {:else if verifying}
        <div class="flex h-full items-center justify-center gap-2 text-sm text-muted">
          <CioSpinner size={14} class="animate-spin" />
          Confirming sign-in for this account…
        </div>
      {:else}
        <div class="flex h-full items-center justify-center text-sm text-muted">
          Preparing sign-in…
        </div>
      {/if}
    </div>
  </Modal>
{/if}
