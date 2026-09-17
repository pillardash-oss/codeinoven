import { invoke } from '$lib/ipc.svelte'
import { openInBrowser } from '$lib/open-in-browser'
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
        this.status = 'A browser window opened   finish signing in there.'
        void openInBrowser(String(event['url']))
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
