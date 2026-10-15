import { invoke, subscribe } from '$lib/ipc.svelte'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { openSignInPage } from '$lib/open-in-browser'
import type {
  McpOAuthAuthorizeRequest,
  McpOAuthConfig,
  McpOAuthEventPayload,
  McpOAuthStatus,
  UtilityDefinition
} from '$shared/types'

/**
 * What the MCP authorization section needs from the editor that owns it: the
 * saved server it is authorizing, and a way to hand back the definition an
 * enable/disable rewrite produced so the editor and the Utilities list refresh.
 */
export interface McpOAuthHost {
  utility: () => UtilityDefinition | null
  onChanged: (utility: UtilityDefinition) => void
}

/**
 * Authorization state machine for one remote MCP server.
 *
 * Owns the grant status, the interactive browser flow, and the optional client
 * credentials the server needs when it issues no client dynamically. It is the
 * only place the section talks to the main process, and it never holds or shows
 * a token: the status it keeps names what is granted, never what was issued.
 *
 * The event subscription lives on the controller so one `dispose()` tears the
 * whole flow down when the section leaves the editor.
 */
export class McpOAuthController {
  status = $state<McpOAuthStatus | null>(null)
  loading = $state(false)
  /** An invoke is in flight: authorize, cancel, disconnect, or enable/disable. */
  busy = $state(false)
  /** The latest `progress` message while a browser flow runs; `null` otherwise. */
  progress = $state<string | null>(null)
  error = $state<string | null>(null)
  clientId = $state('')
  clientSecret = $state('')
  scope = $state('')
  /** Set while the destructive disconnect confirmation is open. */
  confirmDisconnect = $state(false)

  #host: McpOAuthHost
  #unsubscribe: () => void
  /** The server whose status is on screen; a stale reply for another one is dropped. */
  #utilityId: string | null = null

  constructor(host: McpOAuthHost) {
    this.#host = host
    this.#unsubscribe = subscribe('utilities:mcpOAuthEvent', (payload) => this.handleEvent(payload))
  }

  /** Read the current grant for one server. A later load for another server wins. */
  async load(utilityId: string): Promise<void> {
    this.#utilityId = utilityId
    this.loading = true
    this.error = null
    try {
      const status = await invoke('utilities:mcpOAuthStatus', utilityId)
      if (this.#utilityId !== utilityId) return
      this.status = status
      this.clientId = status.clientId ?? ''
      // The vault holds the secret; the field is only ever a fresh value to send.
      this.clientSecret = ''
      this.scope = status.scope ?? ''
    } catch (loadError) {
      if (this.#utilityId !== utilityId) return
      this.error = ipcErrorMessage(loadError, 'The authorization status could not be read.')
    } finally {
      if (this.#utilityId === utilityId) this.loading = false
    }
  }

  /** Start the browser flow and resolve when it finishes, fails, or is cancelled. */
  async authorize(): Promise<void> {
    const utilityId = this.#utilityId
    if (!utilityId || this.busy) return
    this.busy = true
    this.error = null
    this.progress = 'Starting authorization…'
    if (this.status) this.status = { ...this.status, state: 'authorizing' }
    try {
      const request = this.#authorizeRequest()
      const status = await invoke('utilities:authorizeMcpOAuth', utilityId, request)
      if (this.#utilityId !== utilityId) return
      this.status = status
    } catch (authorizeError) {
      if (this.#utilityId !== utilityId) return
      this.error = ipcErrorMessage(authorizeError, 'The authorization could not be completed.')
      if (this.status) this.status = { ...this.status, state: 'error' }
    } finally {
      if (this.#utilityId === utilityId) {
        this.busy = false
        this.progress = null
      }
    }
  }

  /** Stop a running browser flow; a stored grant is left untouched. */
  async cancel(): Promise<void> {
    const utilityId = this.#utilityId
    if (!utilityId) return
    try {
      const status = await invoke('utilities:cancelMcpOAuth', utilityId)
      if (this.#utilityId !== utilityId) return
      this.status = status
      this.error = null
    } catch (cancelError) {
      if (this.#utilityId !== utilityId) return
      this.error = ipcErrorMessage(cancelError, 'The authorization could not be cancelled.')
    } finally {
      if (this.#utilityId === utilityId) {
        this.busy = false
        this.progress = null
      }
    }
  }

  /** Forget the grant, the client, and the server's OAuth block. */
  async disconnect(): Promise<void> {
    const utilityId = this.#utilityId
    if (!utilityId) return
    this.confirmDisconnect = false
    this.busy = true
    this.error = null
    try {
      const status = await invoke('utilities:disconnectMcpOAuth', utilityId)
      if (this.#utilityId !== utilityId) return
      this.status = status
      this.progress = null
    } catch (disconnectError) {
      if (this.#utilityId !== utilityId) return
      this.error = ipcErrorMessage(disconnectError, 'The grant could not be removed.')
    } finally {
      if (this.#utilityId === utilityId) this.busy = false
    }
  }

  /** Turn the grant on or off without discarding it. */
  async setEnabled(enabled: boolean): Promise<void> {
    const current = this.#host.utility()
    if (!current || current.kind !== 'mcp' || this.busy) return
    this.busy = true
    this.error = null
    try {
      const updated = await invoke('utilities:update', current.id, {
        config: { ...current.config, oauth: this.#oauthConfig(enabled, current.config.oauth) }
      })
      if (this.#utilityId !== current.id) return
      this.#host.onChanged(updated)
      if (this.status) this.status = { ...this.status, enabled }
    } catch (updateError) {
      if (this.#utilityId !== current.id) return
      this.error = ipcErrorMessage(updateError, 'Authorization could not be changed.')
    } finally {
      if (this.#utilityId === current.id) this.busy = false
    }
  }

  /** Route one main-process event into the section, ignoring other servers. */
  handleEvent(payload: McpOAuthEventPayload): void {
    if (payload.utilityId !== this.#utilityId) return
    switch (payload.kind) {
      case 'authorize':
        void this.#openAuthPage(payload.authUrl)
        break
      case 'progress':
        this.progress = payload.message
        break
      case 'complete':
        this.status = payload.status
        this.busy = false
        this.progress = null
        this.error = null
        break
      case 'failed':
        this.error = payload.error
        this.busy = false
        this.progress = null
        break
    }
  }

  dispose(): void {
    this.#unsubscribe()
  }

  /** The request carries only what the user typed; omitted fields fall back server-side. */
  #authorizeRequest(): McpOAuthAuthorizeRequest | undefined {
    const request: McpOAuthAuthorizeRequest = {}
    const clientId = this.clientId.trim()
    if (clientId) request.clientId = clientId
    const clientSecret = this.clientSecret.trim()
    if (clientSecret) request.clientSecret = clientSecret
    const scope = this.scope.trim()
    if (scope) request.scope = scope
    return Object.keys(request).length > 0 ? request : undefined
  }

  /**
   * The OAuth block to write when authorization is turned on or off.
   *
   * Rebuilt from the freshest status rather than from the editor's saved copy,
   * because the flow just wrote issuer and client fields the saved copy predates:
   * an update that replaced the whole config with the stale block would drop them.
   */
  #oauthConfig(enabled: boolean, existing: McpOAuthConfig | undefined): McpOAuthConfig {
    const status = this.status
    if (!status) return { enabled, ...(existing ?? {}) }
    return {
      enabled,
      ...(status.issuer ? { issuer: status.issuer } : {}),
      ...(status.clientId ? { clientId: status.clientId } : {}),
      ...(status.confidentialClient ? { confidentialClient: true } : {}),
      ...(status.scope ? { scope: status.scope } : {}),
      ...(status.resource ? { resource: status.resource } : {}),
      ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
      ...(status.authorizedAt === undefined ? {} : { authorizedAt: status.authorizedAt })
    }
  }

  /**
   * Open the authorization page where the user's link routing says.
   *
   * A page that opens nowhere is the one failure this flow cannot recover from,
   * so it is reported here instead of escaping as an unhandled rejection.
   */
  async #openAuthPage(url: string): Promise<void> {
    try {
      await openSignInPage(url)
    } catch (openError) {
      this.error = ipcErrorMessage(openError, 'The authorization page could not be opened.')
      this.progress = null
    }
  }
}
