import { toast } from 'svelte-sonner'
import { copyText } from '$lib/copy-text'
import { invoke } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { openInGlobalCioBrowser } from '$lib/open-in-browser'
import { isMacPlatform } from '$lib/shortcut-display'
import type { GitHubDeviceCode } from '$shared/types'
import { gitState } from './git.svelte'

/** Where the sign-in stands. Only `starting` and `waiting` are still in flight. */
export type GitHubSignInPhase = 'starting' | 'waiting' | 'authorized' | 'expired' | 'error'

/** How long the copy confirmation stays up before the copy icon comes back. */
const COPIED_FEEDBACK_MS = 1500

/** The paste chord the browser page expects, named for this platform. */
function pasteChord(): string {
  return isMacPlatform() ? '⌘V' : 'Ctrl+V'
}

/**
 * GitHub device-flow sign-in, owned by the app rather than by the panel that
 * starts it.
 *
 * Authorizing happens on github.com, so the flow outlives the surface it was
 * opened from: the user leaves for a browser, and the panel is docked for as
 * long as they are there. Polling, the countdown and the phase therefore live
 * here, and `GitHubSignInDock` is a view of them.
 *
 * The device flow needs no client secret and no callback URL, which is what lets
 * the user authorize in whichever browser they choose, including the app's own.
 * GitHub returns no pre-filled verification URL (checked against the live
 * endpoint: the response carries `device_code`, `user_code`, `verification_uri`,
 * `expires_in` and `interval`, and nothing else), so the code has to reach that
 * page by the user's own paste. That is why the in-app route copies it before
 * the panel steps aside.
 */
class GitHubSignInState {
  /** Whether the panel exists at all. False drops it, and its dock chip with it. */
  open = $state(false)
  /** Whether the panel is collapsed into its dock chip. */
  minimized = $state(false)
  phase = $state<GitHubSignInPhase>('starting')
  /** The code GitHub issued for this attempt, and the page it is entered on. */
  device = $state<GitHubDeviceCode | null>(null)
  /** What the current phase reports when it has something to say. */
  message = $state('')
  /** The code is on the clipboard (shown as confirmation, then reset). */
  copied = $state(false)
  /** The code could not be copied, so it has to be selected by hand. */
  copyError = $state('')
  /** Seconds left before GitHub expires the code, for the countdown. */
  remaining = $state(0)
  /**
   * Whether this attempt's page was opened in the app's own browser.
   *
   * That is what lets the panel step aside while the browser is in front: the
   * page is a native view the compositor paints above every DOM node, so a panel
   * or a dock chip over it would park it (`GitHubSignInDock`). It stays true for
   * the rest of the attempt, so the panel keeps that browser usable even if the
   * user comes back to it later.
   */
  handedOffToAppBrowser = $state(false)

  private authorizedListeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private copyTimer: ReturnType<typeof setTimeout> | undefined
  private polling = false
  /**
   * Identity of the attempt in flight. Every await checks it before writing
   * state, so an answer that arrives after the user restarted or closed the flow
   * cannot land on the attempt that replaced it.
   */
  private attempt = 0

  /** Whether the flow is still in flight, which is when only waiting is left. */
  get waiting(): boolean {
    return this.phase === 'starting' || this.phase === 'waiting'
  }

  /** The countdown as the panel shows it: "14:59", or plain seconds under a minute. */
  get countdown(): string {
    const total = Math.max(0, this.remaining)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (minutes === 0) return `${seconds} second${seconds === 1 ? '' : 's'}`
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  /**
   * Listen for a completed authorization, and return the unsubscribe.
   *
   * The shared account state is refreshed here already; this is for surfaces
   * that display it from their own copy, which is the Git panel's account menu.
   */
  onAuthorized(listener: () => void): () => void {
    this.authorizedListeners.add(listener)
    return () => this.authorizedListeners.delete(listener)
  }

  /**
   * Open the panel and start a fresh device flow.
   *
   * An attempt GitHub is already watching is kept and the panel is simply brought
   * back: that code is the one the user is being asked to enter, and issuing a
   * second one would only make them wonder which is real. A code is what makes an
   * attempt live, so a panel that was closed and reopened starts a new one.
   */
  start(): void {
    this.open = true
    this.minimized = false
    if (this.phase === 'waiting' && this.device) return
    void this.begin()
  }

  minimize(): void {
    this.minimized = true
  }

  expand(): void {
    this.minimized = false
  }

  /** Close the panel and abandon the attempt: nothing is left polling. */
  close(): void {
    this.attempt += 1
    this.polling = false
    this.stopFlowTimers()
    this.stopCopyFeedback()
    this.open = false
    this.minimized = false
    this.handedOffToAppBrowser = false
    this.phase = 'starting'
    this.device = null
    this.message = ''
    this.copied = false
    this.copyError = ''
    this.remaining = 0
  }

  /**
   * Put the code on the clipboard, and report whether it landed there.
   *
   * The panel's own copy control and the in-app hand-off both go through this,
   * so the confirmation and the failure read the same either way.
   */
  async copyCode(): Promise<boolean> {
    const device = this.device
    if (!device) return false
    this.copyError = ''
    try {
      await copyText(device.userCode)
      this.copied = true
      this.stopCopyFeedback()
      this.copyTimer = setTimeout(() => (this.copied = false), COPIED_FEEDBACK_MS)
      return true
    } catch {
      this.copied = false
      this.copyError = 'The code could not be copied. Select it and copy it by hand.'
      return false
    }
  }

  /**
   * Hand the verification page to the operating system's browser.
   *
   * Deliberately the OS browser rather than the preference-routed
   * `openInBrowser`: the control names that destination, and a user whose
   * preferences route links into the app would otherwise get the app's browser
   * from a button that says "default".
   */
  async openInDefaultBrowser(): Promise<void> {
    const uri = this.device?.verificationUri
    if (!uri) return
    try {
      await invoke('shell:openExternal', uri)
    } catch (failure) {
      toast.error('The GitHub page could not be opened', {
        description: ipcErrorMessage(
          failure,
          'The operating system browser did not accept the URL.'
        )
      })
    }
  }

  /**
   * Sign in inside CodeInOven: open the verification page in the app-wide
   * browser, and copy the code before the panel steps out of the page's way.
   *
   * The page is a native view the compositor paints above every DOM node, so the
   * panel and its dock chip cannot sit over it: they are pulled off screen while
   * that browser is in front (see `GitHubSignInDock`). Copying the code first is
   * what makes that possible, so a copy that fails abandons the hand-off instead
   * of half-doing it: without the clipboard the panel is the only place the code
   * can be read, and it would have to park the page it just opened.
   */
  async openInCioBrowser(): Promise<void> {
    const uri = this.device?.verificationUri
    if (!uri) return
    const firstHandOff = !this.handedOffToAppBrowser
    if (!(await this.copyCode())) {
      toast.error('The code could not be copied', {
        description: 'Select it in the panel and copy it by hand, then open the browser again.'
      })
      return
    }
    this.handedOffToAppBrowser = true
    openInGlobalCioBrowser(uri)
    this.minimize()
    if (!firstHandOff) return
    toast.info('Code copied', {
      description: `Paste it into the GitHub page (${pasteChord()}) and authorize.`
    })
  }

  /** Ask GitHub for a device code and start watching it. */
  private async begin(): Promise<void> {
    const attempt = (this.attempt += 1)
    this.polling = false
    this.stopFlowTimers()
    this.stopCopyFeedback()
    this.handedOffToAppBrowser = false
    this.phase = 'starting'
    this.device = null
    this.message = ''
    this.copied = false
    this.copyError = ''
    this.remaining = 0
    const device = await gitState.startGitHubDeviceFlow()
    if (attempt !== this.attempt || !this.open) return
    if (!device) {
      this.phase = 'error'
      this.message = gitState.error ?? 'GitHub sign-in could not be started'
      return
    }
    this.device = device
    this.phase = 'waiting'
    this.startCountdown(device.expiresIn)
    void this.poll()
  }

  /** One poll of the token endpoint, rescheduling itself while the code is pending. */
  private async poll(): Promise<void> {
    const device = this.device
    if (this.polling || !device) return
    const attempt = this.attempt
    this.polling = true
    try {
      const result = await gitState.pollGitHubDeviceCode(device.deviceCode)
      if (attempt !== this.attempt || !this.open) return
      if (result.status === 'pending') {
        // Still pending: ask again at the interval GitHub asked for.
        this.pollTimer = setTimeout(() => void this.poll(), device.interval * 1000)
        return
      }
      if (result.status === 'error') this.message = result.message
      this.settle(result.status)
    } finally {
      // Only the attempt that owns the flag may clear it: an answer that landed
      // after the user restarted the flow must not release the newer attempt's
      // guard, or that attempt would schedule a second poll beside its own.
      if (attempt === this.attempt) this.polling = false
    }
  }

  /**
   * End the attempt in a phase that is no longer waiting.
   *
   * The panel is brought back on screen in all of them, because the user has to
   * be told: a docked chip that still reads "waiting" would leave a success, an
   * expiry or a failure invisible.
   */
  private settle(phase: 'authorized' | 'expired' | 'error'): void {
    this.stopFlowTimers()
    this.phase = phase
    this.minimized = false
    if (phase !== 'authorized') return
    // The account belongs to the app, not to this panel, so the shared state is
    // refreshed first and the surfaces that keep their own copy are told after.
    void gitState.githubAuthStatus()
    for (const listener of this.authorizedListeners) listener()
  }

  private startCountdown(seconds: number): void {
    if (this.ticker) clearInterval(this.ticker)
    this.remaining = seconds
    this.ticker = setInterval(() => {
      this.remaining = Math.max(0, this.remaining - 1)
      if (this.remaining === 0 && this.ticker) {
        clearInterval(this.ticker)
        this.ticker = undefined
      }
    }, 1000)
  }

  /** Stop polling and the countdown: every terminal phase, and closing, calls this. */
  private stopFlowTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
  }

  private stopCopyFeedback(): void {
    if (this.copyTimer) clearTimeout(this.copyTimer)
    this.copyTimer = undefined
  }
}

export const githubSignIn = new GitHubSignInState()
