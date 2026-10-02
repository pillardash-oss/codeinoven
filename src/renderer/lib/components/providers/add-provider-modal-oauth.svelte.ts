import { invoke } from '$lib/ipc.svelte'
import { openSignInPage, prefersCioBrowser } from '$lib/open-in-browser'
import type { HarnessAccount, OfferedProvider } from '$shared/types'

export interface OAuthDeviceCode {
  userCode: string
  verificationUri: string
}

export interface OAuthPrompt {
  promptId: string
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string }>
}

/**
 * Everything the in-app sign-in flow needs from its host modal: the harness and
 * provider selection it is running for, the shared message line, and the
 * pending-account lifecycle it hands the authenticated result back to.
 */
export interface AddProviderModalOAuthHost {
  harnessId: () => string
  selectedProvider: () => OfferedProvider | null
  clearApiKey: () => void
  clearMessages: () => void
  setActionError: (message: string) => void
  preparePendingAccount: (providerId?: string) => Promise<HarnessAccount>
  finishAuthentication: (providerId: string, providerName: string) => Promise<void>
  discardPendingAccount: () => Promise<void>
}

/**
 * In-app sign-in state machine (Pi: OAuth flows and the provider's own key
 * flows). Owns the login id, progress line, device code, and interactive
 * prompts, and routes the shared `providerAccounts:oauthEvent` payloads into
 * them until the flow completes, fails, or is cancelled.
 */
export class AddProviderModalOAuthController {
  loginId = $state<string | null>(null)
  status = $state('')
  deviceCode = $state<OAuthDeviceCode | null>(null)
  prompt = $state<OAuthPrompt | null>(null)
  promptAnswer = $state('')
  starting = $state(false)
  /**
   * Whether the panel has stood down so the app-wide browser can hold the view.
   *
   * The authorization page is a native `WebContentsView` the compositor paints
   * above every DOM node, so a panel left open during sign-in covers the one page
   * the user has to act on, and a modal scrim would cover all of it. Docking hides
   * this panel's shell without unmounting it, which is what keeps the flow alive:
   * the controller and its event subscription live in the component, not in the
   * shell, so every later device code, prompt and result still arrives while the
   * browser is in front.
   *
   * Set by the flow here (`auth_url` docks before the page is even asked for,
   * `prompt` gives the panel back because the flow is blocked on the user) and by
   * the host, which also docks on the app switching to the browser, since routes
   * to that view exist that emit no event at all.
   */
  docked = $state(false)

  /**
   * Whether the app-wide browser is the one holding the page for this sign-in.
   *
   * Distinct from {@link docked} on purpose. Docking is a presentation decision
   * and the user can override it by hand, whereas this records which application
   * the authorization page is actually in, and it is what lets the host dock on a
   * view switch only when the app browser is where the user has to go. A user who
   * turned the link preference off has the page in their real browser, so the app
   * browser gaining the view is nothing to them and nothing should collapse.
   */
  authPageInAppBrowser = $state(false)

  #host: AddProviderModalOAuthHost
  /**
   * Sign-in events can reach the renderer before the `beginOAuthLogin` invoke
   * resolves and assigns the login id - the main process starts the flow
   * immediately and key-entry prompts arrive within microseconds. Buffer
   * payloads received while the login id is still unknown and replay them once
   * it is set, so the first prompt of a flow is never silently dropped.
   */
  #earlyEvents: Array<Record<string, unknown>> = []
  static #EARLY_EVENT_LIMIT = 50

  constructor(host: AddProviderModalOAuthHost) {
    this.#host = host
  }

  reset(): void {
    this.loginId = null
    this.status = ''
    this.deviceCode = null
    this.prompt = null
    this.promptAnswer = ''
    this.starting = false
    this.docked = false
    this.authPageInAppBrowser = false
  }

  handlePayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') {
      return
    }
    if (this.loginId === null) {
      if (this.#earlyEvents.length < AddProviderModalOAuthController.#EARLY_EVENT_LIMIT) {
        this.#earlyEvents.push(payload as Record<string, unknown>)
      }
      return
    }
    if ((payload as Record<string, unknown>)['loginId'] !== this.loginId) {
      return
    }
    const data = payload as Record<string, unknown>
    if (data['kind'] === 'event') {
      const event = data['event'] as Record<string, unknown> | undefined
      if (!event) return
      if (event['type'] === 'auth_url') {
        // Dock first when the page is going to the app browser: the panel must
        // already be out of the way by the time the browser takes the view, not
        // after the browser reports that it has the page. That answer is not
        // known yet, so the dock is unconditional here and corrected by
        // `#openAuthPage` the moment the page turns out to be going elsewhere.
        this.docked = true
        this.status = 'Finish signing in in the browser.'
        void this.#openAuthPage(String(event['url']))
      } else if (event['type'] === 'device_code') {
        this.deviceCode = {
          userCode: String(event['userCode']),
          verificationUri: String(event['verificationUri'])
        }
        this.status = ''
      } else if (event['type'] === 'progress' || event['type'] === 'info') {
        this.status = String(event['message'])
      }
    } else if (data['kind'] === 'prompt') {
      const prompt = data['prompt'] as Record<string, unknown> | undefined
      if (!prompt) return
      // A prompt is the one event that needs the modal back: the flow is
      // blocked until the user answers it, so the browser can wait while the
      // modal takes the view again.
      this.docked = false
      this.prompt = {
        promptId: String(data['promptId']),
        type:
          prompt['type'] === 'secret' ||
          prompt['type'] === 'select' ||
          prompt['type'] === 'manual_code'
            ? prompt['type']
            : 'text',
        message: String(prompt['message'] ?? 'Continue sign-in'),
        ...(typeof prompt['placeholder'] === 'string'
          ? { placeholder: prompt['placeholder'] }
          : {}),
        ...(Array.isArray(prompt['options'])
          ? {
              options: (prompt['options'] as Array<Record<string, unknown>>).map((option) => ({
                id: String(option['id']),
                label: String(option['label'])
              }))
            }
          : {})
      }
      this.promptAnswer = ''
    } else if (data['kind'] === 'complete') {
      const providerId = String(data['providerId'] ?? '')
      const providerName = this.#host.selectedProvider()?.name ?? providerId
      this.reset()
      this.#host.clearApiKey()
      void this.#host.finishAuthentication(providerId, providerName)
    } else if (data['kind'] === 'failed') {
      this.#host.setActionError(String(data['error'] ?? 'The sign-in failed.'))
      this.reset()
      void this.#host.discardPendingAccount()
    }
  }

  /**
   * Put the provider's authorization page wherever the user's link routing says,
   * and leave the panel consistent with where it landed.
   *
   * The user never chose a destination for this page: there is no context menu to
   * pick from and no button labelled for one browser, so it follows the same
   * preference as any other link. When the app-wide browser takes it, the panel
   * docks and the browser holds the view. When it goes to the operating system,
   * the panel comes back, because the app browser has no page to get out of the way
   * for and the user is being sent somewhere else entirely.
   *
   * That is also why the status line names where the page went. A sign-in the user
   * cannot reach, or one they were sent out of the app for without being told, are
   * both failures, and both are avoided by saying it.
   */
  async #openAuthPage(url: string): Promise<void> {
    // The wait below outlives a flow that finishes or is cancelled underneath
    // it, so the login id is captured first: a fallback for a login that is no
    // longer running would put a stale status line back on a settled flow and
    // open a browser at a page nobody is waiting for.
    const loginId = this.loginId
    const sentToAppBrowser = prefersCioBrowser(url)
    try {
      const destination = await openSignInPage(url)
      if (this.loginId !== loginId) return
      this.docked = destination === 'app-browser'
      this.authPageInAppBrowser = destination === 'app-browser'
      this.status =
        destination === 'app-browser'
          ? 'Finish signing in in the browser.'
          : sentToAppBrowser
            ? 'The app browser could not open the sign-in page. Opening it in your system browser instead.'
            : 'Opening the sign-in page in your system browser.'
    } catch (openError) {
      if (this.loginId !== loginId) return
      this.docked = false
      this.#host.setActionError(
        openError instanceof Error
          ? openError.message
          : 'The sign-in page could not be opened anywhere.'
      )
      this.reset()
      void this.#host.discardPendingAccount()
    }
  }

  /**
   * Open the device-code verification page where the user's link routing says.
   *
   * On the controller rather than in the tab's template for the reason every other
   * side effect lives here: it owns the status line and the error surface, so a page
   * that will not open anywhere is reported in the panel instead of escaping as an
   * unhandled rejection from a discarded promise.
   *
   * The panel does not dock either way. A device code lives in its body and is the
   * one thing the user still has to type into the page being opened, so hiding the
   * panel here would hide the thing they came for.
   */
  async openDeviceCodePage(): Promise<void> {
    const uri = this.deviceCode?.verificationUri
    if (!uri) return
    const loginId = this.loginId
    const sentToAppBrowser = prefersCioBrowser(uri)
    try {
      const destination = await openSignInPage(uri)
      if (this.loginId !== loginId) return
      this.authPageInAppBrowser = destination === 'app-browser'
      this.status =
        destination === 'app-browser'
          ? 'Finish signing in in the browser.'
          : sentToAppBrowser
            ? 'The app browser could not open the verification page. Opening it in your system browser instead.'
            : 'Opening the verification page in your system browser.'
    } catch (openError) {
      if (this.loginId !== loginId) return
      this.#host.setActionError(
        openError instanceof Error
          ? openError.message
          : 'The verification page could not be opened.'
      )
    }
  }

  /** Launch the provider's own in-app sign-in flow (OAuth or guided key entry). */
  async start(): Promise<void> {
    const provider = this.#host.selectedProvider()
    if (!provider || this.starting) return
    this.#host.clearMessages()
    this.starting = true
    this.status = 'Starting sign-in…'
    this.#earlyEvents = []
    try {
      const account = await this.#host.preparePendingAccount(provider.id)
      this.loginId = await invoke(
        'providerAccounts:beginOAuthLogin',
        this.#host.harnessId(),
        provider.id,
        account.id
      )
      const buffered = this.#earlyEvents
      this.#earlyEvents = []
      for (const bufferedPayload of buffered) {
        this.handlePayload(bufferedPayload)
      }
      // The flow may have already finished while the invoke was in flight.
      if (this.loginId === null) return
    } catch (startError) {
      this.#host.setActionError(
        startError instanceof Error ? startError.message : 'The sign-in could not be started.'
      )
      this.reset()
      await this.#host.discardPendingAccount()
    }
  }

  async submitPrompt(): Promise<void> {
    if (!this.loginId || !this.prompt) return
    const answer = this.promptAnswer.trim()
    if (!answer) return
    this.prompt = null
    this.promptAnswer = ''
    this.status = 'Continuing sign-in…'
    try {
      await invoke('providerAccounts:respondOAuthPrompt', this.loginId, answer)
    } catch (answerError) {
      this.#host.setActionError(
        answerError instanceof Error ? answerError.message : 'The answer could not be sent.'
      )
    }
  }

  /** Answer a select prompt by choosing one of its options directly. */
  async answerSelect(optionId: string): Promise<void> {
    if (!this.loginId || !this.prompt) return
    this.prompt = null
    this.status = 'Continuing sign-in…'
    try {
      await invoke('providerAccounts:respondOAuthPrompt', this.loginId, optionId)
    } catch (answerError) {
      this.#host.setActionError(
        answerError instanceof Error ? answerError.message : 'The answer could not be sent.'
      )
    }
  }

  async cancel(): Promise<void> {
    if (!this.loginId) return
    const loginId = this.loginId
    this.reset()
    try {
      await invoke('providerAccounts:cancelOAuthLogin', loginId)
    } catch {
      // The session may have already ended.
    }
    await this.#host.discardPendingAccount()
  }
}
