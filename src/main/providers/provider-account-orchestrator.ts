import { BrowserWindow } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import type { OfferedProvider } from '../../lib/types'
import { isCodeInOvenCustomProviderId } from '../../lib/custom-provider-id'
import { harnessSupportsMultipleAccounts } from '../agents/harness-registry'
import { findAcpAgent, isAcpAgentId } from '../drivers/acp/acp-agents-store'
import { holdAntigravitySelfUpdate } from '../drivers/antigravity/antigravity-self-update'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'
import type {
  HarnessAuthCapabilities,
  HarnessAuthStatus,
  HarnessLoginHandoff,
  HarnessLoginOptions
} from '../drivers/driver.interface'
import {
  HarnessCommandError,
  prepareHarnessTerminalHandoff,
  runHarnessCommand
} from '../drivers/harness-runtime'
import {
  readOpenCodeV2ActiveCredentialIds,
  readOpenCodeV2StoredCredentials
} from '../drivers/opencode-account-usage'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { acpAgentAuthStatus } from './acp-agent-auth'
import { PiAuthConfigService } from './pi-auth-config'
import { listPiCatalogProviders } from './pi-catalog'
import { listPiProviderAuthInfo, runPiLogin } from './pi-login'
import {
  AUTH_DEFINITIONS,
  type AuthDefinition,
  openCodeAuthDefinition,
  openCodeAuthDefinitionCached
} from './provider-account-auth-definitions'
import { readClineStatus } from './provider-account-cline-store'
import {
  canonicalOpenCodeIntegrationId,
  isBenignOpenCodeLogoutError,
  isUnknownOpenCodeIntegrationError
} from './provider-account-opencode-identity'
import {
  isOpenCodeV2Installed,
  readHiddenProviders,
  writeHiddenProviders
} from './provider-account-opencode-config'
import {
  deleteOpenCodeV2CredentialsFor,
  hasRemainingOpenCodeCredentials,
  openCodeLogoutCandidates,
  removeOpenCodeV1CredentialsFor
} from './provider-account-opencode-store'
import { fileBackedAuth, readPiStatus } from './provider-account-pi-store'
import {
  STATUS_OUTPUT_MAX_BYTES,
  STATUS_TIMEOUT_MS,
  stripAnsi
} from './provider-account-status-parsers'

export {
  OPENCODE_RENAMED_INTEGRATIONS,
  canonicalOpenCodeIntegrationId,
  isBenignOpenCodeLogoutError,
  isUnknownOpenCodeIntegrationError
} from './provider-account-opencode-identity'
export {
  type OpenCodeV2Policy,
  openCodeV2HiddenConfig,
  openCodeV2HiddenPolicies,
  readHiddenProviderIds,
  readHiddenProvidersFromDisabledList,
  readHiddenProvidersFromPolicies
} from './provider-account-opencode-config'

interface CommandResult {
  succeeded: boolean
  stdout: string
  stderr: string
  error?: string
  /** Set when a spawned CLI exited non-zero (as opposed to failing to spawn). */
  exitCode?: number
}

const READ_AND_HANDOFF_ONLY: HarnessAuthCapabilities = {
  status: true,
  loginHandoff: true,
  logout: false,
  accountActivation: false,
  multipleAccounts: false,
  pickerLogin: false,
  apiKeyEntry: false,
  inAppLogin: false
}

/**
 * Stamp the account whose credential the harness itself has active.
 *
 * A native multi-account store (OpenCode V2) knows which credential a turn will
 * use, but `auth list --format json` never reports it, so the flag is read from
 * the store and put on the matching row. Without it the app could list every
 * account the user created inside OpenCode but not say which one is in effect.
 */
async function markNativeActiveAccounts(
  definition: AuthDefinition,
  status: HarnessAuthStatus,
  environment: NodeJS.ProcessEnv
): Promise<HarnessAuthStatus> {
  if (definition.nativeStore !== 'v2' || status.accounts.length === 0) return status
  const active = await readOpenCodeV2ActiveCredentialIds(environment)
  if (active.size === 0) return status
  return {
    ...status,
    accounts: status.accounts.map((account) =>
      active.has(account.id) ? { ...account, active: true } : account
    )
  }
}

/**
 * Account status, offered-provider catalogs, and explicit login/logout flows
 * for local harnesses. Login and logout commands are handed to the UI, which
 * runs them inside a user-visible embedded terminal   CodeInOven never mutates
 * a harness credential store on its own.
 */
export class ProviderAccountOrchestrator {
  private statusQueueTail: Promise<void> = Promise.resolve()
  /** Live in-app OAuth sign-ins (Pi), awaiting user prompts / completion. */
  private oauthSessions = new Map<
    string,
    {
      controller: AbortController
      pendingPrompt?: (value: string) => void
      authStore: PiAuthConfigService
    }
  >()

  /**
   * Authentication capabilities for one harness. Account activation is
   * advertised only when the harness declares native multi-account support in
   * its manifest AND the installed line actually exposes a switch command
   * (OpenCode V2's `auth switch`; V1 has none).
   */
  async capabilities(harnessId: string): Promise<HarnessAuthCapabilities | null> {
    // An ACP agent owns its own sign-in: the app asks it, over the protocol,
    // which methods it accepts. There is no login command to hand to a terminal
    // and no provider file to read, so only `status` is advertised here and the
    // sign-in itself runs through the ACP channel.
    if (isAcpAgentId(harnessId)) {
      return { ...READ_AND_HANDOFF_ONLY, loginHandoff: false }
    }
    const definition = await this.resolveDefinitionOrUndefined(harnessId)
    if (!definition) return null
    const multipleAccounts = harnessSupportsMultipleAccounts(harnessId)
    return {
      ...READ_AND_HANDOFF_ONLY,
      logout:
        definition.logoutArgs !== undefined || definition.removeStoredCredential !== undefined,
      multipleAccounts,
      accountActivation: multipleAccounts && definition.activateArgs !== undefined,
      pickerLogin: definition.pickerLogin === true,
      apiKeyEntry: definition.apiKeyEntry === true,
      inAppLogin: definition.inAppLogin === true
    }
  }

  /**
   * The integration a managed account's own credential store reports, for
   * harnesses whose store CodeInOven reads locally (OpenCode V2). Undefined for
   * every other harness, which would need a CLI probe, and when the store does
   * not name exactly one integration.
   *
   * A managed row's provider id is fixed when its container is created, so a
   * release that renames an integration leaves the row naming a provider the
   * command line no longer knows. OpenCode's `OpenCode Zen` became
   * `OpenCode Console` while the id stayed `opencode`, and the row kept the V1
   * slug `opencode-zen`, which `auth login` rejects with "Integration not
   * found". Reading the container's store is what lets the row be repaired
   * without running the harness.
   */
  async storedProviderFor(
    harnessId: string,
    environment: NodeJS.ProcessEnv
  ): Promise<string | undefined> {
    const definition = await this.resolveDefinitionOrUndefined(harnessId)
    if (!definition || definition.nativeStore !== 'v2') return undefined
    const stored = await readOpenCodeV2StoredCredentials(environment)
    const integrations = [...new Set(stored.map((credential) => credential.integrationId))]
    if (integrations.length !== 1) return undefined
    return canonicalOpenCodeIntegrationId(integrations[0] as string)
  }

  /** Store an API key for one catalog provider in a file-backed auth store. */
  async setCredential(
    harnessId: string,
    providerId: string,
    apiKey: string,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<void> {
    const definition = await this.resolveDefinition(harnessId)
    const piAgentDir = environment['PI_CODING_AGENT_DIR']
    if (harnessId === 'pi' && piAgentDir) {
      await new PiAuthConfigService(join(piAgentDir, 'auth.json')).setApiKey(providerId, apiKey)
      return
    }
    if (!definition.setCredential) {
      throw new Error(
        `${harnessId} does not support headless credential storage. Use the harness's own sign-in flow.`
      )
    }
    await definition.setCredential(providerId, apiKey)
  }

  /**
   * Start a fully in-app sign-in for a Pi catalog provider by running the
   * provider's own `login()` from pi-ai   OAuth browser/device flows for the
   * providers that define them, and the provider's real multi-field API-key
   * flow (e.g. Cloudflare's key + account id + gateway id) otherwise. Events
   * and prompts are broadcast to the UI; answers arrive via
   * {@link respondOAuthPrompt}; the resulting credential is stored in Pi's own
   * auth store. Mirrors what Pi's TUI does   without the TUI.
   */
  async beginOAuthLogin(
    harnessId: string,
    providerId: string,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<string> {
    if (isAcpAgentId(harnessId)) {
      throw new Error(
        'An ACP agent signs in through its own protocol. Use the methods it declares in Harnesses.'
      )
    }
    this.requireDefinition(harnessId)
    if (harnessId !== 'pi') {
      throw new Error(`${harnessId} does not support in-app sign-in.`)
    }
    const loginId = `pi-oauth-${crypto.randomUUID()}`
    const controller = new AbortController()
    const piAgentDir = environment['PI_CODING_AGENT_DIR']
    const session: {
      controller: AbortController
      pendingPrompt?: (value: string) => void
      authStore: PiAuthConfigService
    } = {
      controller,
      authStore: piAgentDir
        ? new PiAuthConfigService(join(piAgentDir, 'auth.json'))
        : fileBackedAuth
    }
    this.oauthSessions.set(loginId, session)
    void runPiLogin(
      providerId,
      {
        signal: controller.signal,
        onEvent: (event) => this.broadcastOAuthEvent(loginId, { kind: 'event', event }),
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            const promptId = `${loginId}-p-${crypto.randomUUID()}`
            session.pendingPrompt = resolve
            this.broadcastOAuthEvent(loginId, { kind: 'prompt', promptId, prompt })
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('Sign-in was cancelled.')),
              { once: true }
            )
          })
      },
      // The account's own Pi agent directory names this host: flows that
      // register it (OpenAI's ChatGPT sign-in) then see one stable device per
      // account instead of a new one on every sign-in.
      { hostSeed: piAgentDir ?? 'pi-default' }
    )
      .then(async (credential) => {
        if (credential.type === 'oauth') {
          await session.authStore.setOAuthCredential(providerId, credential)
        } else {
          await session.authStore.setApiKey(providerId, credential.key ?? '', credential.env)
        }
        this.broadcastOAuthEvent(loginId, { kind: 'complete', providerId })
      })
      .catch((error: unknown) => {
        this.broadcastOAuthEvent(loginId, {
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => this.oauthSessions.delete(loginId))
    return loginId
  }

  /** Answer the outstanding prompt of a running OAuth sign-in. */
  respondOAuthPrompt(loginId: string, value: string): void {
    const session = this.oauthSessions.get(loginId)
    const pending = session?.pendingPrompt
    if (!session || !pending) throw new Error('No sign-in prompt is waiting for an answer.')
    session.pendingPrompt = undefined
    pending(value)
  }

  /** Cancel a running OAuth sign-in. */
  cancelOAuthLogin(loginId: string): void {
    this.oauthSessions.get(loginId)?.controller.abort()
    this.oauthSessions.delete(loginId)
  }

  private broadcastOAuthEvent(loginId: string, payload: Record<string, unknown>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, 'providerAccounts:oauthEvent', { loginId, ...payload })
    }
  }

  /**
   * Status for a user-added ACP agent, read from the agent itself.
   *
   * An ACP agent hands CodeInOven a session or refuses one, and that refusal is
   * the whole answer: when it needs a sign-in it says so, and the methods it
   * declared in `initialize` are what the user then picks from. Providers stay
   * inside the agent, so the accounts list names the agent once instead of
   * inventing rows the app cannot act on.
   */
  private async acpStatus(harnessId: string, projectPath?: string): Promise<HarnessAuthStatus> {
    const agent = await findAcpAgent(harnessId)
    if (!agent) {
      return {
        state: 'error',
        accounts: [],
        detail: 'This ACP agent is no longer configured. Add it again in Harnesses.'
      }
    }
    const status = await acpAgentAuthStatus(agent, projectPath)
    if (status.state !== 'authenticated') {
      return {
        state: status.state,
        accounts: [],
        ...(status.detail ? { detail: status.detail } : {})
      }
    }
    return {
      state: 'authenticated',
      accounts: [
        { id: agent.id, providerId: agent.id, label: agent.name, method: 'agent', active: true }
      ]
    }
  }

  async getStatus(
    harnessId: string,
    projectPath?: string,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<HarnessAuthStatus> {
    if (isAcpAgentId(harnessId)) return this.acpStatus(harnessId, projectPath)
    return this.enqueueStatus(async () => {
      const definition = await this.resolveDefinition(harnessId)
      if (definition.readStatus) {
        return markNativeActiveAccounts(
          definition,
          await definition.readStatus(projectPath, environment),
          environment
        )
      }
      const result = await this.run(
        definition.command,
        definition.statusArgs ?? [],
        projectPath,
        environment
      )
      if (!definition.parseStatus) {
        return {
          state: 'error',
          accounts: [],
          detail: `Status parsing is not implemented for harness: ${harnessId}`
        }
      }
      const output = result.stdout.trim() || result.stderr.trim()
      const status = await markNativeActiveAccounts(
        definition,
        definition.parseStatus(output, result.succeeded),
        environment
      )
      if (status.state === 'error' && result.error) {
        return { ...status, detail: result.error }
      }
      return status
    })
  }

  async beginLogin(
    harnessId: string,
    options: HarnessLoginOptions = {},
    environment: NodeJS.ProcessEnv = {},
    /** Account whose credential home this login writes into, when main resolved one. */
    accountId?: string
  ): Promise<HarnessLoginHandoff> {
    if (isAcpAgentId(harnessId)) {
      throw new Error(
        'This ACP agent signs in through its own protocol. Use the sign-in methods it offers instead of a terminal command.'
      )
    }
    const definition = await this.resolveDefinition(harnessId)
    const loginOptions: HarnessLoginOptions = { ...options }
    // Antigravity signs in through an interactive CLI session, which is also
    // where its background auto-updater would start; hold that so a sign-in
    // never changes the harness version behind CodeInOven's back.
    if (harnessId === 'antigravity') {
      await holdAntigravitySelfUpdate({ ...process.env, ...environment })
    }
    // A custom base-URL provider lives in CodeInOven's own id namespace and means
    // nothing to a harness CLI, so it never reaches a login command.
    if (
      loginOptions.providerId !== undefined &&
      isCodeInOvenCustomProviderId(loginOptions.providerId)
    ) {
      delete loginOptions.providerId
    }
    // The account's own store names the integration, so a row whose provider id
    // went stale still signs in against the integration the CLI knows.
    if (loginOptions.providerId !== undefined && definition.resolveStoredIntegration) {
      const resolved = await definition.resolveStoredIntegration(
        loginOptions.providerId,
        environment
      )
      if (resolved) loginOptions.providerId = resolved
    }
    const prepared = await prepareHarnessTerminalHandoff(
      definition.command,
      definition.loginArgs(loginOptions)
    )
    return {
      kind: 'terminal',
      command: prepared.command,
      args: prepared.args,
      ...(accountId ? { accountId } : {}),
      ...(Object.keys(environment).length > 0
        ? { environment: environment as Record<string, string> }
        : {}),
      title: `Sign in to ${definition.name}`,
      mutatesGlobalCredentials: Object.keys(environment).length === 0
    }
  }

  /** Remove a stored harness credential via its CLI logout or auth store. */
  async logout(
    harnessId: string,
    providerId?: string,
    environment: NodeJS.ProcessEnv = {},
    providerHint?: string,
    credentialHint?: string
  ): Promise<void> {
    const definition = await this.resolveDefinition(harnessId)
    const piAgentDir = environment['PI_CODING_AGENT_DIR']
    if (harnessId === 'pi' && piAgentDir) {
      if (!providerId) throw new Error('pi requires a provider to disconnect.')
      await new PiAuthConfigService(join(piAgentDir, 'auth.json')).removeCredential(providerId)
      return
    }
    if (definition.removeStoredCredential) {
      if (!providerId) throw new Error(`${harnessId} requires a provider to disconnect.`)
      await definition.removeStoredCredential(providerId)
      return
    }
    if (!definition.logoutArgs) {
      throw new Error(
        `${harnessId} does not expose a logout command. Remove the credential in the harness itself.`
      )
    }
    let target = providerId
    if (harnessId === 'opencode' && target !== undefined) {
      // A renamed integration must never reach the CLI under its stale id:
      // `opencode-zen` became `opencode`, and every command built from the
      // stale id ends with "Integration not found: opencode-zen".
      target = canonicalOpenCodeIntegrationId(target)
    }
    if (target !== undefined && definition.resolveStoredIntegration) {
      target = (await definition.resolveStoredIntegration(target, environment)) ?? target
      if (harnessId === 'opencode') target = canonicalOpenCodeIntegrationId(target)
    }
    if (definition.resolveLogoutTarget && target !== undefined) {
      target = (await definition.resolveLogoutTarget(target, providerHint)) ?? target
      if (harnessId === 'opencode') target = canonicalOpenCodeIntegrationId(target)
    }
    const credential =
      definition.resolveLogoutCredential && target !== undefined
        ? await definition.resolveLogoutCredential(
            target,
            credentialHint ?? providerHint,
            environment
          )
        : undefined
    const result = await this.run(
      definition.command,
      definition.logoutArgs(target, credential),
      homedir(),
      environment
    )
    if (!result.succeeded) {
      const detail = stripAnsi(
        result.exitCode === undefined
          ? (result.error ?? 'unknown error')
          : result.stderr.trim() || result.stdout.trim()
      )
      // A stale rename leaves credentials the CLI no longer names: the store
      // still holds `opencode-zen` while the binary only knows `opencode`, so
      // its logout dies with "Integration not found". Those legacy keys can
      // never be removed through the CLI. Logout is idempotent, so clean both
      // stores directly and treat it as done once nothing remains for the
      // requested integration, which unblocks removing the account row.
      if (
        harnessId === 'opencode' &&
        (isUnknownOpenCodeIntegrationError(detail) || isBenignOpenCodeLogoutError(detail))
      ) {
        const candidates = openCodeLogoutCandidates(providerId, target)
        if (candidates.size > 0) {
          await removeOpenCodeV1CredentialsFor(environment, candidates)
          await deleteOpenCodeV2CredentialsFor(environment, candidates)
          if (!(await hasRemainingOpenCodeCredentials(environment, candidates))) return
        }
      }
      throw new Error(
        result.exitCode === undefined
          ? `Logout failed: ${detail || 'unknown error'}`
          : `Logout failed (${definition.command} exited with code ${result.exitCode}): ${detail || 'no error output'}`
      )
    }
    await definition.verifyLogout?.(environment)
    if (harnessId === 'opencode') {
      // The CLI removed the canonical integration; a pre-rename alias row
      // (`opencode-zen`) is unknown to the binary and survives. Sweep it
      // best-effort so a successful disconnect leaves no legacy key behind.
      try {
        const candidates = openCodeLogoutCandidates(providerId, target)
        if (candidates.size > 0) {
          await removeOpenCodeV1CredentialsFor(environment, candidates)
          await deleteOpenCodeV2CredentialsFor(environment, candidates)
        }
      } catch (error) {
        Logger.dev('OpenCode stale alias sweep failed:', error)
      }
    }
  }

  /**
   * Make one stored credential the active one for its integration. Only
   * harnesses whose store holds several accounts (OpenCode V2) support this;
   * the credential id comes from the account's `sourceId`.
   */
  async activateAccount(
    harnessId: string,
    providerId: string,
    credentialId: string,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<void> {
    const definition = await this.resolveDefinition(harnessId)
    if (!definition.activateArgs) {
      throw new Error(`${harnessId} does not support switching its active account.`)
    }
    // The stored integration is what the CLI's switch command names, so a row
    // whose provider id went stale still switches the credential it holds.
    const resolved =
      (await definition.resolveStoredIntegration?.(providerId, environment)) ?? providerId
    const target = harnessId === 'opencode' ? canonicalOpenCodeIntegrationId(resolved) : resolved
    const result = await this.run(
      definition.command,
      definition.activateArgs(target, credentialId),
      homedir(),
      environment
    )
    if (!result.succeeded) {
      const detail = stripAnsi(
        result.exitCode === undefined
          ? (result.error ?? 'unknown error')
          : result.stderr.trim() || result.stdout.trim()
      )
      throw new Error(
        result.exitCode === undefined
          ? `Account switch failed: ${detail || 'unknown error'}`
          : `Account switch failed (${definition.command} exited with code ${result.exitCode}): ${detail || 'no error output'}`
      )
    }
  }

  /**
   * The providers a harness offers for connection, surfaced from its catalog.
   * OpenCode's bare login (`opencode auth login`) presents its own interactive
   * picker of every known provider, so there is nothing to enumerate here   the
   * honestly reportable set is whatever the harness is already connected to.
   * The others are small enough to enumerate from their own configuration.
   */
  async listOffered(harnessId: string): Promise<OfferedProvider[]> {
    if (isAcpAgentId(harnessId)) {
      // An ACP agent owns its providers, models and credentials: the honest
      // offered list is the agent itself, with whatever its own probe said.
      const agent = await findAcpAgent(harnessId)
      if (!agent) return []
      const status = await this.acpStatus(harnessId)
      return [
        {
          id: agent.id,
          name: agent.name,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }
      ]
    }
    const definition = this.requireDefinition(harnessId)
    switch (definition.id) {
      case 'opencode': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.providerId,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'claude-code':
        return [{ id: 'anthropic', name: 'Anthropic', modelCount: 0, authenticated: false }]
      case 'codex':
        return [{ id: 'openai', name: 'OpenAI', modelCount: 0, authenticated: false }]
      case 'cline': {
        const status = await readClineStatus()
        return status.accounts.map((account) => ({
          id: account.label,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'pi':
        return this.listPiOffered()
      case 'antigravity': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.providerId,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'muse': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.providerId,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      default:
        return []
    }
  }

  /**
   * Pi offers every catalog provider, not just connected ones. The searchable
   * set is Pi's own built-in provider registry (`@earendil-works/pi-ai`); the
   * RPC `get_available_models` only reports providers that already hold usable
   * credentials, so it is not the connect flow's catalog. Connectivity is a
   * stored auth.json credential or an API-keyed entry in its native models.json.
   * Falls back to the configured-accounts view when the registry cannot load.
   */
  private async listPiOffered(): Promise<OfferedProvider[]> {
    const native = await readPiStatus()
    const keyedNativeIds = new Set(
      native.accounts
        .filter((account) => account.active === true)
        .map((account) => account.providerId)
    )
    let catalog: OfferedProvider[]
    try {
      catalog = await listPiCatalogProviders()
    } catch (catalogError) {
      Logger.info(
        '[provider-accounts] Pi catalog unavailable   falling back to configured accounts:',
        catalogError
      )
      return native.accounts.map((account) => ({
        id: account.providerId,
        name: account.label,
        modelCount: 0,
        authenticated: keyedNativeIds.has(account.providerId)
      }))
    }
    const merged = new Map(catalog.map((provider) => [provider.id, provider]))
    // Native custom providers from models.json are connectable targets too and
    // may not appear in the bundled catalog.
    for (const account of native.accounts) {
      if (!merged.has(account.providerId)) {
        merged.set(account.providerId, {
          id: account.providerId,
          name: account.label,
          modelCount: 0,
          authenticated: false
        })
      }
    }
    const authInfo = await listPiProviderAuthInfo()
    for (const provider of merged.values()) {
      // Sign-in capability comes from the same registry Pi's own TUI uses.
      provider.oauth = authInfo.get(provider.id)?.oauth === true
      if (
        !provider.authenticated &&
        ((await fileBackedAuth.hasCredential(provider.id)) || keyedNativeIds.has(provider.id))
      ) {
        provider.authenticated = true
      }
    }
    return [...merged.values()]
  }

  /** Provider IDs currently hidden from the harness (via its own config). */
  async getHiddenProviders(harnessId: string): Promise<string[]> {
    if (harnessId !== 'opencode') return []
    return readHiddenProviders(await isOpenCodeV2Installed())
  }

  /**
   * Add or remove a provider id from the harness's hidden set. OpenCode V1 uses
   * `disabled_providers`; V2 uses a `provider.use` deny policy. Both land in the
   * same global config file, chosen by the detected install.
   */
  async setProviderHidden(
    harnessId: string,
    providerId: string,
    hidden: boolean
  ): Promise<string[]> {
    if (harnessId !== 'opencode') {
      throw new Error(`${harnessId} does not support hiding providers from its config file.`)
    }
    const v2 = await isOpenCodeV2Installed()
    const current = await readHiddenProviders(v2)
    const next = new Set(current)
    if (hidden) {
      next.add(providerId)
    } else {
      next.delete(providerId)
    }
    const list = Array.from(next)
    await writeHiddenProviders(list, v2)
    return list
  }

  // ─── Offered-provider catalog ──────────────────────────────────────────────

  private definition(harnessId: string): AuthDefinition | undefined {
    if (harnessId === 'opencode') return openCodeAuthDefinitionCached()
    return AUTH_DEFINITIONS.find((definition) => definition.id === harnessId)
  }

  /**
   * Version-aware definition for operations that spawn the CLI. OpenCode's
   * grammar depends on the detected install, so a cold cache resolves it here
   * instead of silently assuming V1.
   */
  private async resolveDefinition(harnessId: string): Promise<AuthDefinition> {
    if (harnessId === 'opencode') return openCodeAuthDefinition()
    return this.requireDefinition(harnessId)
  }

  /** Version-aware definition, or `undefined` for a harness with no auth support. */
  private async resolveDefinitionOrUndefined(
    harnessId: string
  ): Promise<AuthDefinition | undefined> {
    if (harnessId === 'opencode') return openCodeAuthDefinition()
    return AUTH_DEFINITIONS.find((definition) => definition.id === harnessId)
  }

  private requireDefinition(harnessId: string): AuthDefinition {
    const definition = this.definition(harnessId)
    if (!definition) throw new Error(`Authentication is not supported for harness: ${harnessId}`)
    return definition
  }

  private async run(
    command: string,
    args: string[],
    cwd?: string,
    environment: NodeJS.ProcessEnv = {}
  ): Promise<CommandResult> {
    try {
      const result = await runHarnessCommand(command, args, {
        ...(cwd ? { cwd } : {}),
        env: await buildProcessEnvironmentAsync({ ...process.env, ...environment }),
        timeoutMs: STATUS_TIMEOUT_MS,
        maxOutputBytes: STATUS_OUTPUT_MAX_BYTES
      })
      return { succeeded: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof HarnessCommandError) {
        return {
          succeeded: false,
          stdout: error.stdout,
          stderr: error.stderr,
          ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
          error: message
        }
      }
      return {
        succeeded: false,
        stdout: '',
        stderr: '',
        error: message
      }
    }
  }

  /** Serialize status reads and CLI probes across every renderer caller. */
  private enqueueStatus<T>(task: () => Promise<T>): Promise<T> {
    const preceding = this.statusQueueTail
    let release: () => void = () => undefined
    this.statusQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return preceding.then(task).finally(release)
  }
}
