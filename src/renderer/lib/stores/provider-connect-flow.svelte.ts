/**
 * The app-wide "connect an AI account" flow.
 *
 * A first-run user has nothing connected, so the surfaces they meet first (the
 * send-time setup card and the empty model picker) must be able to open the
 * harness's provider connect flow without owning it. They publish a request
 * here; `ProviderConnectHost` renders the flow above every view.
 */
export interface ProviderConnectRequest {
  /** Harness whose provider catalog the flow manages, e.g. pi. */
  harnessId: string
  /** Provider search the connect list opens with. Empty means unfiltered. */
  search: string
  /** Called once a provider finishes connecting, so the caller can re-probe. */
  onConnected?: () => void
}

/** Provider prefilled for a user who has not connected anything yet. */
export const FIRST_RUN_PROVIDER_SEARCH = 'openai'

class ProviderConnectFlowStore {
  request = $state.raw<ProviderConnectRequest | null>(null)

  /** Open the connect-provider list for a harness, optionally prefiltered. */
  open(harnessId: string, options: { search?: string; onConnected?: () => void } = {}): void {
    if (!harnessId) return
    this.request = {
      harnessId,
      search: options.search ?? '',
      ...(options.onConnected ? { onConnected: options.onConnected } : {})
    }
  }

  close(): void {
    this.request = null
  }
}

export const providerConnectFlow = new ProviderConnectFlowStore()
